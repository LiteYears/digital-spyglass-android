import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeRegistry,
  canonicalRegistryBytes,
  ensureActiveRegistryVerified,
  ensureRegistryVerified,
  parseRegistrySig,
  registryAnchorFingerprint,
  registryIntegrity,
  resetRegistryVerification,
  verifyRegistrySignature,
  REGISTRY_SIG_SCHEME,
} from "../registry-signature";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const here = dirname(fileURLToPath(import.meta.url));
const ghostDir = join(here, "..");
const repoRoot = join(ghostDir, "..", "..", "..");

const SAMPLE = {
  version: 1,
  engines: [
    {
      id: "x",
      baseUrl: "http://example.onion",
      enabled: true,
      health: { status: "ok", lastVerified: "2026-10-25" },
    },
  ],
};

async function makeKeypair() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { pair, spki };
}

async function signWith(pair: CryptoKeyPair, registry: unknown): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    pair.privateKey,
    canonicalRegistryBytes(registry) as BufferSource,
  );
  return JSON.stringify({
    scheme: REGISTRY_SIG_SCHEME,
    algo: "RSA-PSS-SHA256",
    keyFingerprint: "00".repeat(32),
    signature: Buffer.from(sig).toString("base64"),
  });
}

describe("canonical projection", () => {
  it("drops health at the registry root and engine level only (R5)", () => {
    const out = canonicalizeRegistry(SAMPLE) as typeof SAMPLE;
    expect(out.engines[0]).not.toHaveProperty("health");
    expect(out.engines[0]).toHaveProperty("baseUrl");
    const withRootHealth = { ...SAMPLE, health: { checked: "x" } };
    expect(canonicalizeRegistry(withRootHealth)).not.toHaveProperty("health");
  });

  it("keeps health keys at deeper levels — they are signed content now", () => {
    const nested = {
      version: 1,
      engines: [
        {
          id: "x",
          parser: { type: "selectors", spec: { health: { probe: true } } },
          prepare: { type: "form_introspect", health: { tries: 0 } },
        },
      ],
    };
    const out = canonicalizeRegistry(nested) as typeof nested;
    const engine = out.engines[0] as {
      parser: { spec: { health: unknown } };
      prepare: { health: unknown };
    };
    expect(engine.parser.spec.health).toEqual({ probe: true });
    expect(engine.prepare.health).toEqual({ tries: 0 });
  });

  it("does not strip health under a nested key named engines (F1)", () => {
    const nested = {
      version: 1,
      engines: [
        {
          id: "x",
          prepare: {
            engines: [{ health: { relayer: "evil" } }],
            contract: { engines: { health: { y: 1 } } },
          },
        },
      ],
    };
    const out = canonicalizeRegistry(nested) as {
      engines: Array<{
        prepare: {
          engines: Array<{ health: unknown }>;
          contract: { engines: { health: unknown } };
        };
      }>;
    };
    expect(out.engines[0]!.prepare.engines[0]!.health).toEqual({ relayer: "evil" });
    expect(out.engines[0]!.prepare.contract.engines.health).toEqual({ y: 1 });
  });

  it("is invariant to key order and whitespace", () => {
    const a = { b: 1, a: { y: 2, x: 3 } };
    const b = JSON.parse(JSON.stringify({ a: { x: 3, y: 2 }, b: 1 }));
    expect(Buffer.from(canonicalRegistryBytes(a)).toString("hex")).toBe(
      Buffer.from(canonicalRegistryBytes(b)).toString("hex"),
    );
  });

  it("keeps array order (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), (arr) => {
        const canon = canonicalizeRegistry({ e: arr }) as { e: number[] };
        expect(canon.e).toEqual(arr);
      }),
    );
  });
});

describe("verifyRegistrySignature", () => {
  it("accepts a valid signature", async () => {
    const { pair, spki } = await makeKeypair();
    const sigFile = await signWith(pair, SAMPLE);
    expect(await verifyRegistrySignature(SAMPLE, sigFile, spki)).toBe(true);
  });

  it("rejects a signature over mutated signed fields", async () => {
    const { pair, spki } = await makeKeypair();
    const sigFile = await signWith(pair, SAMPLE);
    const tampered = JSON.parse(JSON.stringify(SAMPLE));
    tampered.engines[0].baseUrl = "http://evil.onion";
    expect(await verifyRegistrySignature(tampered, sigFile, spki)).toBe(false);
  });

  it("still verifies when only health changes", async () => {
    const { pair, spki } = await makeKeypair();
    const sigFile = await signWith(pair, SAMPLE);
    const probed = JSON.parse(JSON.stringify(SAMPLE));
    probed.engines[0].health = { status: "down", lastVerified: "2099-01-01", extra: 1 };
    expect(await verifyRegistrySignature(probed, sigFile, spki)).toBe(true);
  });

  it("rejects a signature made by a different key", async () => {
    const { pair } = await makeKeypair();
    const other = await makeKeypair();
    const sigFile = await signWith(pair, SAMPLE);
    expect(await verifyRegistrySignature(SAMPLE, sigFile, other.spki)).toBe(false);
  });

  it("rejects unknown schemes and malformed sig files", () => {
    expect(() => parseRegistrySig("not json")).toThrow();
    expect(() => parseRegistrySig(JSON.stringify({ scheme: "v0" }))).toThrow();
    expect(() =>
      parseRegistrySig(JSON.stringify({ scheme: REGISTRY_SIG_SCHEME, algo: "x", signature: 1 })),
    ).toThrow();
  });
});

describe("integrity cache — content-keyed, signer-keyed (F4/F5)", () => {
  const anchorOf =
    (spki: Uint8Array, cert = "cc".repeat(32)) =>
    async () => ({
      spkiBase64: bytesToBase64(spki),
      certSha256: cert,
    });

  it("caches per content — same bytes return the verdict without re-verifying", async () => {
    resetRegistryVerification();
    const { pair, spki } = await makeKeypair();
    const sigFile = await signWith(pair, SAMPLE);
    const loadSig = async () => sigFile;
    expect(await ensureRegistryVerified(SAMPLE, loadSig, anchorOf(spki))).toBe("verified");
    const boom = async (): Promise<string> => {
      throw new Error("sig must not be reloaded for identical content");
    };
    expect(await ensureRegistryVerified(SAMPLE, boom, anchorOf(spki))).toBe("verified");
    resetRegistryVerification();
  });

  it("does not let a stale 'verified' stick to DIFFERENT content", async () => {
    resetRegistryVerification();
    const { pair, spki } = await makeKeypair();
    const sigFile = await signWith(pair, SAMPLE);
    const loadSig = async () => sigFile;
    expect(await ensureRegistryVerified(SAMPLE, loadSig, anchorOf(spki))).toBe("verified");
    // An active-registry swap (or a forgotten resetRegistryVerification) must
    // re-verify: the old verdict is bound to the old canonical bytes.
    const tampered = { ...SAMPLE, comment: "different content, same sig file" };
    expect(await ensureRegistryVerified(tampered, loadSig, anchorOf(spki))).toBe("failed");
    expect(registryIntegrity()).toBe("failed");
    resetRegistryVerification();
  });

  it("records WHICH key verified — trusted key reports its SPKI hash, the anchor its cert hash", async () => {
    resetRegistryVerification();
    const trusted = await makeKeypair();
    const anchor = await makeKeypair();
    const trustedSig = await signWith(trusted.pair, SAMPLE);
    const noTrusted: Array<Uint8Array> = [];

    // Signed by the operator-confirmed import key → fingerprint is the SPKI hash
    await ensureActiveRegistryVerified(
      SAMPLE,
      async () => trustedSig,
      anchorOf(anchor.spki),
      async () => [trusted.spki],
    );
    expect(registryIntegrity()).toBe("verified");
    const expectedSpkiHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", trusted.spki as BufferSource),
    ).toString("hex");
    expect(registryAnchorFingerprint()).toBe(expectedSpkiHash);

    // Signed by the APK anchor → fingerprint is the signing CERT hash
    resetRegistryVerification();
    const anchorSig = await signWith(anchor.pair, SAMPLE);
    await ensureActiveRegistryVerified(
      SAMPLE,
      async () => anchorSig,
      anchorOf(anchor.spki, "dd".repeat(32)),
      async () => noTrusted,
    );
    expect(registryIntegrity()).toBe("verified");
    expect(registryAnchorFingerprint()).toBe("dd".repeat(32));
    resetRegistryVerification();
  });
});

const sigPath = join(ghostDir, "engines.sig.json");
const pemPath = join(repoRoot, "scripts", "registry-release.spki.pem");

describe.skipIf(!existsSync(sigPath) || !existsSync(pemPath))(
  "committed registry fixture (CI gate)",
  () => {
    it("engines.json verifies against the committed release SPKI", async () => {
      const registry = JSON.parse(readFileSync(join(ghostDir, "engines.json"), "utf8"));
      const sigFile = readFileSync(sigPath, "utf8");
      const pem = readFileSync(pemPath, "utf8");
      const spkiDer = new Uint8Array(
        Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"),
      );
      expect(await verifyRegistrySignature(registry, sigFile, spkiDer)).toBe(true);
    });
  },
);
