import { beforeAll, describe, expect, it } from "vitest";
import {
  enrichPgpEntities,
  formatFingerprint,
  MAX_PGP_BLOCKS_PER_PASS,
  normalizePgpBlock,
  pgpKeyFingerprint,
} from "../pgp";

const HOST_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion";
const HOST_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion";

let armoredPublicKey = "";
let fingerprint = "";

beforeAll(async () => {
  const openpgp = await import("openpgp");
  const generated = await openpgp.generateKey({
    type: "ecc",
    curve: "ed25519Legacy",
    userIDs: [{ name: "Ghost Test", email: "ghost@test.onion" }],
    format: "armored",
  });
  armoredPublicKey = generated.publicKey;
  fingerprint = (await pgpKeyFingerprint(armoredPublicKey)) ?? "";
  expect(fingerprint).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
}, 30_000);

function rowWith(host: string, block: string) {
  return {
    url: `http://${host}/page`,
    entities: [{ type: "pgp", value: block }],
  };
}

describe("normalizePgpBlock / formatFingerprint", () => {
  it("normalizes CRLF and surrounding whitespace", () => {
    expect(normalizePgpBlock(`\r\n${armoredPublicKey}\r\n`)).toBe(
      normalizePgpBlock(armoredPublicKey),
    );
  });

  it("formats a fingerprint as uppercase groups of four", () => {
    const formatted = formatFingerprint("abcd1234abcd1234");
    expect(formatted).toBe("ABCD 1234 ABCD 1234");
    expect(formatFingerprint("")).toBe("—");
  });
});

describe("pgpKeyFingerprint", () => {
  it("parses a real armored public key", async () => {
    const fp = await pgpKeyFingerprint(armoredPublicKey);
    expect(fp).toBe(fingerprint);
  });

  it("returns null for garbage instead of throwing", async () => {
    expect(await pgpKeyFingerprint("-----BEGIN PGP PUBLIC KEY BLOCK-----\ngarbage")).toBeNull();
    expect(await pgpKeyFingerprint("")).toBeNull();
  });
});

describe("enrichPgpEntities", () => {
  it("indexes a single-host key without a cross-host flag", async () => {
    const index = await enrichPgpEntities([rowWith(HOST_A, armoredPublicKey)]);
    const entry = index.get(normalizePgpBlock(armoredPublicKey))!;
    expect(entry.fingerprint).toBe(fingerprint);
    expect(entry.keyIdShort).toBe(fingerprint.slice(-16).toUpperCase());
    expect(entry.hosts).toEqual([HOST_A]);
    expect(entry.crossHost).toBe(false);
  });

  it("flags the same key on multiple hosts as crossHost (same operator?)", async () => {
    const index = await enrichPgpEntities([
      rowWith(HOST_A, armoredPublicKey),
      rowWith(HOST_B, armoredPublicKey),
    ]);
    const entry = index.get(normalizePgpBlock(armoredPublicKey))!;
    expect(entry.crossHost).toBe(true);
    expect(entry.hosts.sort()).toEqual([HOST_A, HOST_B].sort());
  });

  it("merges hosts across armor variants with the same fingerprint", async () => {
    // Variant B carries an extra armor Comment header — same key, different bytes.
    const variant = armoredPublicKey.replace(
      /-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n/,
      (m) => `${m}Comment: ghost variant\n`,
    );
    expect(variant).not.toBe(armoredPublicKey);
    const index = await enrichPgpEntities([
      rowWith(HOST_A, armoredPublicKey),
      rowWith(HOST_B, variant),
    ]);
    const a = index.get(normalizePgpBlock(armoredPublicKey))!;
    const b = index.get(normalizePgpBlock(variant))!;
    expect(a).toBe(b); // shared enrichment object — deduped by fingerprint
    expect(a.crossHost).toBe(true);
  });

  it("records unparsable blocks honestly instead of throwing", async () => {
    const bogus = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nnot a key\n-----END PGP PUBLIC KEY BLOCK-----";
    const index = await enrichPgpEntities([rowWith(HOST_A, bogus)]);
    const entry = index.get(normalizePgpBlock(bogus))!;
    expect(entry.fingerprint).toBe("");
    expect(entry.keyIdShort).toBe("unparsed");
    expect(entry.error).toBeDefined();
  });

  it("ignores rows without pgp entities", async () => {
    const index = await enrichPgpEntities([
      { url: `http://${HOST_A}/x`, entities: [{ type: "btc", value: "bc1qx" }] },
      { url: `http://${HOST_A}/y`, entities: [] },
      { url: `http://${HOST_A}/z` },
    ]);
    expect(index.size).toBe(0);
  });

  it("caps distinct blocks per pass (snippet DoS guard)", async () => {
    const rows = Array.from({ length: MAX_PGP_BLOCKS_PER_PASS + 5 }, (_, i) =>
      rowWith(HOST_A, `-----BEGIN PGP PUBLIC KEY BLOCK-----\nbogus ${i}\n-----END PGP PUBLIC KEY BLOCK-----`),
    );
    const index = await enrichPgpEntities(rows);
    expect(index.size).toBe(MAX_PGP_BLOCKS_PER_PASS);
  });
});
