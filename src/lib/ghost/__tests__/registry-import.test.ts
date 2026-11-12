import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  base64ToSpkiBytes,
  clearImportedRegistry,
  diffRegistries,
  loadImportedRegistry,
  loadTrustedKeys,
  pemToSpkiBytes,
  saveImportedRegistry,
  saveTrustedKey,
  spkiFingerprint,
  spkiToBase64,
  validateEngineRegistry,
  verifyRegistryImport,
} from "../registry-import";
import { canonicalRegistryBytes } from "../registry-signature";
import { applyImportedRegistry, bundledRegistry, resetToBundledRegistry } from "../engines";

/** F3: imports must carry a signed `sequence` — test payloads opt in here. */
function seqRegistry(registry: unknown, sequence = 1): Record<string, unknown> {
  return { ...(registry as Record<string, unknown>), sequence };
}

let keyPair: CryptoKeyPair;
let spki: Uint8Array;
let pem: string;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const b64 = toBase64(spki);
  pem = `-----BEGIN PUBLIC KEY-----\n${b64.replace(/(.{64})/g, "$1\n").trim()}\n-----END PUBLIC KEY-----\n`;
}, 60_000);

async function signRegistry(registry: unknown, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey,
    canonicalRegistryBytes(registry) as BufferSource,
  );
  return JSON.stringify({
    scheme: "registry-sig-v1",
    algo: "RSA-PSS-SHA256",
    keyFingerprint: "testfingerprint",
    signature: toBase64(new Uint8Array(signature)),
  });
}

describe("validateEngineRegistry (untrusted input)", () => {
  it("accepts the bundled engines.json", () => {
    expect(() => validateEngineRegistry(bundledRegistry())).not.toThrow();
  });

  it("rejects structural violations", () => {
    expect(() => validateEngineRegistry({ version: 2, engines: [] })).toThrow(/version/);
    expect(() => validateEngineRegistry({ version: 1, engines: [] })).toThrow(/empty/);
    expect(() => validateEngineRegistry({ version: 1 })).toThrow(/engines must be an array/);
  });

  it("rejects duplicate ids, bad trust, clearnet bases and bad mirrors", () => {
    const engine = (overrides: Record<string, unknown>) => ({
      id: "testeng",
      name: "Test",
      trust: 2,
      clearnet: false,
      baseUrl: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
      searchUrl: "{base}/search?q={q}",
      parser: { type: "selectors", spec: { blocks: ["li"] } },
      note: "n",
      ...overrides,
    });
    expect(() =>
      validateEngineRegistry({ version: 1, engines: [engine({}), engine({ name: "Dup" })] }),
    ).toThrow(/duplicate id/);
    expect(() => validateEngineRegistry({ version: 1, engines: [engine({ trust: 99 })] })).toThrow(
      /trust/,
    );
    expect(() =>
      validateEngineRegistry({ version: 1, engines: [engine({ baseUrl: "https://example.com" })] }),
    ).toThrow(/baseUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ mirrors: ["https://clear.net/x"] })],
      }),
    ).toThrow(/mirror/);
    expect(() =>
      validateEngineRegistry({ version: 1, engines: [engine({ parser: { type: "evil" } })] }),
    ).toThrow(/parser/);
  });

  it("rejects forbidden keys at ANY depth — nested objects, arrays, health (F8)", () => {
    // `__proto__`/`constructor`/`prototype` as OWN properties only exist via
    // JSON.parse — object literals treat `__proto__` as the accessor.
    const engine = (overrides: Record<string, unknown>) => ({
      id: "testeng",
      name: "Test",
      trust: 2,
      clearnet: false,
      baseUrl: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
      searchUrl: "{base}/search?q={q}",
      parser: { type: "selectors", spec: { blocks: ["li"] } },
      note: "n",
      ...overrides,
    });
    const nestedPrepare = {
      version: 1,
      engines: [
        engine({
          prepare: JSON.parse('{"type":"hidden_input","fields":{"__proto__":{"polluted":true}}}'),
        }),
      ],
    };
    expect(() => validateEngineRegistry(nestedPrepare)).toThrow(/forbidden key "__proto__"/);

    // health sits OUTSIDE the signed projection — exactly the hole F8 closes
    const inHealth = {
      version: 1,
      engines: [
        engine({
          health: JSON.parse('{"status":"ok","extra":{"constructor":{"x":1}}}'),
        }),
      ],
    };
    expect(() => validateEngineRegistry(inHealth)).toThrow(/forbidden key "constructor"/);

    const inArray = {
      version: 1,
      engines: [
        engine({
          parser: {
            type: "selectors",
            spec: { blocks: ["li"], filters: JSON.parse('[{"prototype":{"y":2}}]') },
          },
        }),
      ],
    };
    expect(() => validateEngineRegistry(inArray)).toThrow(/forbidden key "prototype"/);
  });

  it("rejects onion-looking strings that are not onion HOSTNAMES (F7)", () => {
    const engine = (overrides: Record<string, unknown>) => ({
      id: "testeng",
      name: "Test",
      trust: 2,
      clearnet: false,
      baseUrl: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
      searchUrl: "{base}/search?q={q}",
      parser: { type: "selectors", spec: { blocks: ["li"] } },
      note: "n",
      ...overrides,
    });
    // ".onion" in the PATH, not the host — the old string check accepted this.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ baseUrl: "http://evil.example/x.onion" })],
      }),
    ).toThrow(/baseUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ mirrors: ["http://evil.example/y.onion"] })],
      }),
    ).toThrow(/mirror/);
    // URL templates must stay relative to base — a literal host bypasses the check.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ searchUrl: "http://evil.example/s?q={q}" })],
      }),
    ).toThrow(/searchUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ parser: { type: "custom", name: "nonexistent" } })],
      }),
    ).toThrow(/parser\.name/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ prepare: { type: "math_captcha", mathRe: "(" } })],
      }),
    ).toThrow(/mathRe/);
    // Prototype-pollution keys never survive import. JSON.parse creates
    // "__proto__" as an own property (unlike an object literal).
    const withProto = JSON.parse(
      `{"version":1,"__proto__":{"injected":1},"engines":[${JSON.stringify(engine({}))}]}`,
    );
    expect(() => validateEngineRegistry(withProto)).toThrow(/forbidden key/);
  });

  it("rejects {base} templates that smuggle a host (R1)", () => {
    const engine = (overrides: Record<string, unknown>) => ({
      id: "testeng",
      name: "Test",
      trust: 2,
      clearnet: false,
      baseUrl: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
      searchUrl: "{base}/search?q={q}",
      parser: { type: "selectors", spec: { blocks: ["li"] } },
      note: "n",
      ...overrides,
    });
    // "{base}@host" renders as http://<v3>.onion@host — the onion lands in the
    // userinfo slot and the real host is attacker-chosen via a signed import.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ searchUrl: "{base}@evil.example/s?q={q}" })],
      }),
    ).toThrow(/searchUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ searchUrl: "{base}.evil.example/s?q={q}" })],
      }),
    ).toThrow(/searchUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [
          engine({
            searchUrl:
              "{base}@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion/s?q={q}",
          }),
        ],
      }),
    ).toThrow(/searchUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ pagedUrl: "{base}@evil.example/p" })],
      }),
    ).toThrow(/pagedUrl/);
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ searchUrl: "{base}:8080/s?q={q}" })],
      }),
    ).toThrow(/searchUrl/);
    // Legit shapes still pass: path, query, fragment, the bare base.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ searchUrl: "{base}?q={q}" })],
      }),
    ).not.toThrow();
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ searchUrl: "{base}#frag" })],
      }),
    ).not.toThrow();
    expect(() =>
      validateEngineRegistry({ version: 1, engines: [engine({ searchUrl: "{base}" })] }),
    ).not.toThrow();
    expect(() => validateEngineRegistry({ version: 1, engines: [engine({})] })).not.toThrow();
  });

  it("accepts imported mathRe only when identical to the bundled pattern (R3)", () => {
    const engine = (overrides: Record<string, unknown>) => ({
      id: "testeng",
      name: "Test",
      trust: 2,
      clearnet: false,
      baseUrl: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
      searchUrl: "{base}/search?q={q}",
      parser: { type: "selectors", spec: { blocks: ["li"] } },
      note: "n",
      ...overrides,
    });
    // Compiles and is short — but backtracks exponentially; no input cap helps.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ prepare: { type: "math_captcha", mathRe: "(\\d+)+x" } })],
      }),
    ).toThrow(/mathRe/);
    // Also rejected on torgle — the bundled pattern is per engine id, not a free pass.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [engine({ id: "torgle", prepare: { type: "math_captcha", mathRe: "(\\d+)+x" } })],
      }),
    ).toThrow(/mathRe/);
    // A bundled engine without its own mathRe (oss) may not adopt torgle's.
    expect(() =>
      validateEngineRegistry({
        version: 1,
        engines: [
          engine({
            id: "oss",
            prepare: { type: "math_captcha", mathRe: "Solve this:\\s*(\\d+)\\s*\\+\\s*(\\d+)" },
          }),
        ],
      }),
    ).toThrow(/mathRe/);
    // torgle keeps its own anchored bundled pattern on re-import.
    const torgle = (bundledRegistry() as { engines: Array<Record<string, unknown>> }).engines.find(
      (e) => e["id"] === "torgle",
    );
    expect(() => validateEngineRegistry({ version: 1, engines: [torgle] })).not.toThrow();
  });
});

describe("spki fingerprint helpers", () => {
  it("round-trips PEM → bytes → base64 and hashes deterministically", async () => {
    const bytes = pemToSpkiBytes(pem);
    expect(bytes).toEqual(spki);
    expect(spkiToBase64(bytes)).toBe(toBase64(spki));
    expect(base64ToSpkiBytes(spkiToBase64(bytes))).toEqual(bytes);
    const fp = await spkiFingerprint(bytes);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(await spkiFingerprint(bytes)).toBe(fp);
  });

  it("rejects empty PEM material", () => {
    expect(() => pemToSpkiBytes("-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----")).toThrow(
      /no key material/,
    );
  });
});

describe("verifyRegistryImport (fail-closed)", () => {
  it("verifies under the apk anchor key", async () => {
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(true);
  });

  it("verifies under a stored trusted key", async () => {
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [spki],
      anchorSpki: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verifiedBy).toBe("trusted-key");
  });

  it("rejects a tampered registry even with the right key", async () => {
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const tampered = JSON.parse(JSON.stringify(registry)) as { engines: unknown[] };
    (tampered.engines[0] as Record<string, unknown>)["trust"] = 9;
    const result = await verifyRegistryImport({
      registry: tampered,
      sigText: sig,
      trustedSpkis: [spki],
      anchorSpki: null,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects signatures under NO trusted key", async () => {
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: null,
    });
    expect(result.ok).toBe(false);
  });

  it("candidate key without confirmation fails closed and names the fingerprint", async () => {
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: null,
      candidatePem: pem,
      confirmCandidateKey: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/confirm fingerprint [0-9a-f]{64}/);
  });

  it("candidate key WITH out-of-band confirmation verifies as candidate", async () => {
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: null,
      candidatePem: pem,
      confirmCandidateKey: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedBy).toBe("candidate");
      expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("F1 regression: anchor-verified import + foreign candidate key does NOT become 'candidate'", async () => {
    // Attack: operator-signed registry + attacker's PEM. Verification succeeds
    // under the anchor — the candidate must NOT be credited with the signature.
    const registry = seqRegistry(bundledRegistry());
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
      candidatePem: pem,
      confirmCandidateKey: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedBy).toBe("apk-anchor");
      // Anchor wins first — verifiedBy must never be "candidate" here, so the
      // apply path has no basis to persist the foreign key as trusted.
      expect(result.verifiedBy).not.toBe("candidate");
    }
  });

  it("rejects a malformed signature file early", async () => {
    const result = await verifyRegistryImport({
      registry: seqRegistry(bundledRegistry()),
      sigText: "not json",
      trustedSpkis: [spki],
      anchorSpki: null,
    });
    expect(result.ok).toBe(false);
  });
});

describe("sequence gate — F3 rollback protection", () => {
  const engine = {
    id: "seqeng",
    name: "Seq",
    trust: 2,
    clearnet: false,
    baseUrl: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
    searchUrl: "{base}/s?q={q}",
    parser: { type: "selectors", spec: { blocks: ["li"] } },
    note: "n",
  };
  const reg = (sequence?: number) =>
    sequence === undefined
      ? { version: 1, engines: [engine] }
      : { version: 1, sequence, engines: [engine] };

  afterEach(() => {
    resetToBundledRegistry();
  });

  it("schema: sequence is optional but must be a non-negative integer", () => {
    expect(() => validateEngineRegistry(reg(0))).not.toThrow();
    expect(() => validateEngineRegistry(reg(7))).not.toThrow();
    expect(() => validateEngineRegistry({ version: 1, sequence: "1", engines: [engine] })).toThrow(
      /sequence/,
    );
    expect(() => validateEngineRegistry(reg(-1))).toThrow(/sequence/);
    expect(() => validateEngineRegistry(reg(1.5))).toThrow(/sequence/);
  });

  it("rejects oversized payloads — unsigned blobs would persist and re-verify every boot (R6)", () => {
    const bloated = {
      version: 1,
      engines: [
        {
          ...engine,
          health: { blob: "x".repeat(600 * 1024) },
        },
      ],
    };
    expect(() => validateEngineRegistry(bloated)).toThrow(/exceeds|serialized/);
    expect(() => validateEngineRegistry(reg(1))).not.toThrow();
  });

  it("rejects a signed registry without sequence — unsigned-era payloads are unorderable", async () => {
    const registry = reg();
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/sequence/);
  });

  it("accepts a signed registry with sequence above the bundled floor", async () => {
    const registry = reg(2);
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a sequence below the active import's floor — the F3 rollback vector", async () => {
    applyImportedRegistry(reg(3));
    const registry = reg(2);
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/below the active floor 3/);
  });

  it("accepts re-import at the same sequence (idempotent level)", async () => {
    applyImportedRegistry(reg(3));
    const registry = reg(3);
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects same-sequence DIFFERENT content — the equal-seq unordered rewrite (R1)", async () => {
    // v_a (seq 5, onion A) is active; a same-seq payload with different
    // content can only come from re-signing without a bump — the artifact
    // class the floor exists to reject (a stale seq-5 could displace v_b).
    applyImportedRegistry(reg(5));
    const rewritten = {
      version: 1,
      sequence: 5,
      engines: [
        {
          ...engine,
          baseUrl: "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion",
        },
      ],
    };
    const sig = await signRegistry(rewritten, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry: rewritten,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/same-sequence|unordered/);
  });

  it("still accepts a higher sequence over the same-seq active floor", async () => {
    applyImportedRegistry(reg(5));
    const registry = reg(6);
    const sig = await signRegistry(registry, keyPair.privateKey);
    const result = await verifyRegistryImport({
      registry,
      sigText: sig,
      trustedSpkis: [],
      anchorSpki: spki,
    });
    expect(result.ok).toBe(true);
  });
});

describe("diffRegistries (health excluded)", () => {
  const base = {
    version: 1,
    engines: [
      { id: "keep", name: "Keep", trust: 1, health: { status: "unknown" } },
      { id: "drop", name: "Drop", trust: 1 },
    ],
  };
  const incoming = {
    version: 1,
    engines: [
      { id: "keep", name: "Keep Renamed", trust: 2, health: { status: "ok" } },
      { id: "new", name: "New", trust: 3 },
    ],
  };

  it("lists added/removed/changed with changed field names", () => {
    const diff = diffRegistries(base, incoming);
    expect(diff.added).toEqual([{ id: "new", name: "New" }]);
    expect(diff.removed).toEqual([{ id: "drop", name: "Drop" }]);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0]?.id).toBe("keep");
    expect(diff.changed[0]?.fields).toContain("name");
    expect(diff.changed[0]?.fields).toContain("trust");
  });

  it("ignores health-only changes (CI bookkeeping, not operator intent)", () => {
    const withHealth = JSON.parse(JSON.stringify(base)) as typeof base;
    (withHealth.engines[0] as Record<string, unknown>)["health"] = { status: "ok", other: 1 };
    const diff = diffRegistries(base, withHealth);
    expect(diff.changed).toEqual([]);
  });
});

describe("import & trusted-key persistence (prefs memory fallback)", () => {
  afterEach(async () => {
    await clearImportedRegistry();
  });

  it("round-trips a stored import", async () => {
    await saveImportedRegistry({
      registry: bundledRegistry(),
      sigText: "{}",
      verifiedByFingerprint: "abc",
      importedAt: 123,
    });
    const stored = await loadImportedRegistry();
    expect(stored?.verifiedByFingerprint).toBe("abc");
    expect(stored?.importedAt).toBe(123);
  });

  it("stores trusted keys deduped by fingerprint and lists them", async () => {
    const fp = await spkiFingerprint(spki);
    await saveTrustedKey({ fingerprint: fp, spkiBase64: spkiToBase64(spki), confirmedAt: 1 });
    await saveTrustedKey({ fingerprint: fp, spkiBase64: spkiToBase64(spki), confirmedAt: 2 });
    const keys = await loadTrustedKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]?.confirmedAt).toBe(1);
  });
});
