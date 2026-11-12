import { describe, expect, it } from "vitest";
import {
  buildCaseFile,
  caseEntityKey,
  MAX_CASE_ENTITIES,
  MAX_CASE_FILE_BYTES,
  MAX_CASE_URLS_PER_ENTITY,
  mergeCaseFiles,
  parseCaseFile,
  type CaseEntity,
  type CaseFileV1,
} from "../case-file";
import { encryptExportBundle } from "../crypto-export";

const NOW = 1_760_000_000_000;

function entity(partial: Partial<CaseEntity> & Pick<CaseEntity, "type" | "value">): CaseEntity {
  return {
    updatedAt: NOW,
    urls: [],
    ...partial,
  };
}

function caseJson(file: Partial<CaseFileV1> & Pick<CaseFileV1, "entities">): string {
  return JSON.stringify({
    format: "case-file-v1",
    exportedAt: NOW,
    caseName: "test case",
    ...file,
  });
}

const URL_A = "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/a";
const URL_B = "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion/b";

describe("buildCaseFile", () => {
  it("collects entities from rows, dedupes by type:value(lowercase), caps urls", () => {
    const file = buildCaseFile(
      [
        {
          url: URL_A,
          entities: [
            { type: "btc", value: "bc1qx" },
            { type: "email", value: "X@Y.onion" },
          ],
        },
        { url: URL_A, entities: [{ type: "email", value: "x@y.onion" }] },
        { url: URL_B, entities: [{ type: "email", value: "x@y.onion" }] },
      ],
      [],
      "case",
      NOW,
    );
    const email = file.entities.find((e) => e.type === "email")!;
    expect(email.urls).toEqual([URL_A, URL_B]);
    expect(file.entities.length).toBe(2);
    expect(file.format).toBe("case-file-v1");
  });

  it("merges existing case entities and keeps output sorted + capped", () => {
    const existing = Array.from({ length: MAX_CASE_ENTITIES - 1 }, (_, i) =>
      entity({ type: "email", value: `old${i}@x.onion`, updatedAt: NOW - 5000 }),
    );
    const rows = Array.from({ length: 10 }, (_, i) => ({
      url: `${URL_A}/${i}`,
      entities: [{ type: "cve", value: `CVE-2026-${1000 + i}` }],
    }));
    const file = buildCaseFile(rows, existing, "big", NOW);
    expect(file.entities.length).toBeLessThanOrEqual(MAX_CASE_ENTITIES);
    const keys = file.entities.map(caseEntityKey);
    expect([...keys].sort((a, b) => a.localeCompare(b))).toEqual(keys);
  });
});

describe("caseEntityKey — case folding by type (F9)", () => {
  it("keeps base58 wallets case-SENSITIVE — case variants are distinct entities", () => {
    // Old code lowercased everything: two different base58 wallets collapsed.
    expect(caseEntityKey({ type: "btc", value: "1AbcDeF" })).toBe("btc:1AbcDeF");
    expect(caseEntityKey({ type: "btc", value: "1AbcDeF" })).not.toBe(
      caseEntityKey({ type: "btc", value: "1abcdef" }),
    );
    expect(caseEntityKey({ type: "xmr", value: "4AbCdEf" })).toBe("xmr:4AbCdEf");
    expect(caseEntityKey({ type: "xmr", value: "4AbCdEf" })).not.toBe(
      caseEntityKey({ type: "xmr", value: "4abcdef" }),
    );
  });

  it("folds bech32 (bc1…) — BIP-173 mandates a single case", () => {
    expect(caseEntityKey({ type: "btc", value: "BC1QXYRES" })).toBe(
      caseEntityKey({ type: "btc", value: "bc1qxyres" }),
    );
  });

  it("folds intrinsically case-insensitive types", () => {
    for (const [type, value] of [
      ["email", "A@B.ONION"],
      ["onion", "ABC.ONION"],
      ["cve", "CVE-2026-1"],
      ["pgp", "DEADBEEF"],
      ["ipv4", "1.2.3.4"],
    ] as const) {
      expect(caseEntityKey({ type, value })).toBe(`${type}:${value.toLowerCase()}`);
    }
  });

  it("does not collapse case-variant base58 wallets in build/merge", () => {
    const file = buildCaseFile(
      [
        {
          url: URL_A,
          entities: [
            { type: "btc", value: "1AbcDeF" },
            { type: "btc", value: "1abcdef" },
          ],
        },
      ],
      [],
      "case",
      NOW,
    );
    expect(file.entities.length).toBe(2);
    const upper = entity({ type: "xmr", value: "4AbCdEf", updatedAt: NOW });
    const lower = entity({ type: "xmr", value: "4abcdef", updatedAt: NOW });
    const { entities } = mergeCaseFiles([upper], [lower]);
    expect(entities.length).toBe(2);
  });
});

describe("parseCaseFile — hard validation (sneakernet threat)", () => {
  it("accepts a well-formed plaintext case", async () => {
    const parsed = await parseCaseFile(
      caseJson({ entities: [entity({ type: "btc", value: "bc1qx" })] }),
    );
    expect(parsed.caseName).toBe("test case");
    expect(parsed.entities.length).toBe(1);
  });

  it("rejects non-JSON input", async () => {
    await expect(parseCaseFile("this is not json")).rejects.toThrow(/not valid JSON/);
    await expect(parseCaseFile("")).rejects.toThrow(/empty input/);
  });

  it("rejects report-only exports (STIX) explicitly", async () => {
    await expect(parseCaseFile(JSON.stringify({ type: "bundle", id: "stix" }))).rejects.toThrow(
      /report-only/,
    );
  });

  it("rejects oversize input", async () => {
    await expect(parseCaseFile(" ".repeat(MAX_CASE_FILE_BYTES + 1))).rejects.toThrow(/larger than/);
  });

  it("rejects unknown entity types and malformed values", async () => {
    await expect(
      parseCaseFile(caseJson({ entities: [entity({ type: "evil", value: "x" })] })),
    ).rejects.toThrow(/unknown type/);
    await expect(
      parseCaseFile(
        caseJson({
          entities: [{ type: "btc", value: "x".repeat(2049), updatedAt: NOW, urls: [] }],
        }),
      ),
    ).rejects.toThrow(/value/);
  });

  it("rejects non-http(s) urls inside entities", async () => {
    await expect(
      parseCaseFile(
        caseJson({
          entities: [entity({ type: "onion", value: "abc.onion", urls: ["ftp://x.onion/f"] })],
        }),
      ),
    ).rejects.toThrow(/not http/);
  });

  it("rejects timestamps too far in the future (clock-skew guard)", async () => {
    await expect(
      parseCaseFile(
        caseJson({
          entities: [
            entity({
              type: "email",
              value: "future@x.onion",
              updatedAt: Date.now() + 3 * 24 * 3600 * 1000,
            }),
          ],
        }),
      ),
    ).rejects.toThrow(/future/);
  });

  it("rejects more entities than the cap", async () => {
    const entities = Array.from({ length: MAX_CASE_ENTITIES + 1 }, (_, i) =>
      entity({ type: "email", value: `u${i}@x.onion` }),
    );
    await expect(parseCaseFile(caseJson({ entities }))).rejects.toThrow(/more than/);
  });

  it("rejects more urls per entity than the cap", async () => {
    const urls = Array.from({ length: MAX_CASE_URLS_PER_ENTITY + 1 }, (_, i) => `${URL_A}/${i}`);
    await expect(
      parseCaseFile(caseJson({ entities: [entity({ type: "onion", value: "abc.onion", urls })] })),
    ).rejects.toThrow(/urls/);
  });

  it("round-trips through the existing encrypted export envelope", async () => {
    const plaintext = caseJson({ entities: [entity({ type: "pgp", value: "KEYBLOCK" })] });
    const envelope = await encryptExportBundle(plaintext, "correct horse battery", 10_000);
    await expect(parseCaseFile(envelope)).rejects.toThrow(/passphrase required/);
    await expect(parseCaseFile(envelope, "wrong pass phrase")).rejects.toThrow(/decryption failed/);
    const parsed = await parseCaseFile(envelope, "correct horse battery");
    expect(parsed.entities[0]?.value).toBe("KEYBLOCK");
  });

  it("rejects nested encrypted envelopes with a clear message (C6)", async () => {
    const plaintext = caseJson({ entities: [entity({ type: "pgp", value: "KEYBLOCK" })] });
    const inner = await encryptExportBundle(plaintext, "correct horse battery", 10_000);
    const outer = await encryptExportBundle(inner, "correct horse battery", 10_000);
    await expect(parseCaseFile(outer, "correct horse battery")).rejects.toThrow(/nested/);
  });

  it("rejects prototype-pollution keys anywhere in the payload (F4 parity)", async () => {
    const raw =
      '{"format":"case-file-v1","exportedAt":1,"entities":[{"type":"btc","value":"x","updatedAt":1,"urls":[],"__proto__":{"polluted":true}}]}';
    await expect(parseCaseFile(raw)).rejects.toThrow(/forbidden key/);
    const nested =
      '{"format":"case-file-v1","exportedAt":1,"caseName":{"__proto__":{"x":1}},"entities":[]}';
    await expect(parseCaseFile(nested)).rejects.toThrow(/forbidden key/);
  });

  it("rejects urls containing control characters (F9)", async () => {
    await expect(
      parseCaseFile(
        caseJson({
          entities: [entity({ type: "onion", value: "abc.onion", urls: ["https://x.onion/a\nb"] })],
        }),
      ),
    ).rejects.toThrow(/control characters/);
  });
});

describe("mergeCaseFiles — last-write-wins", () => {
  const local: CaseEntity[] = [
    entity({ type: "btc", value: "bc1qA", updatedAt: NOW, urls: [URL_A] }), // stays local (import older)
    entity({ type: "email", value: "keep@x.onion", updatedAt: NOW, urls: [URL_A] }), // identical
    entity({ type: "onion", value: "old.onion", updatedAt: NOW - 1000, urls: [URL_A] }), // import newer → updated
  ];
  const imported: CaseEntity[] = [
    entity({ type: "btc", value: "bc1qa", updatedAt: NOW - 999, urls: [URL_B] }), // same key, older → kept local
    entity({ type: "email", value: "keep@x.onion", updatedAt: NOW, urls: [URL_A] }), // identical
    entity({ type: "onion", value: "old.onion", updatedAt: NOW, urls: [URL_B] }), // newer → wins
    entity({ type: "cve", value: "CVE-2026-1234", updatedAt: NOW, urls: [URL_B] }), // new
  ];

  it("reports added/updated/keptLocal/unchanged and conflicts with winners", () => {
    const { entities, report } = mergeCaseFiles(local, imported);
    expect(report.added).toBe(1);
    expect(report.updated).toBe(1);
    expect(report.keptLocal).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.conflicts.length).toBe(2);
    const onion = entities.find((e) => e.value === "old.onion")!;
    expect(onion.urls).toEqual([URL_B]); // import won
    const btc = entities.find((e) => e.value === "bc1qA")!;
    expect(btc.urls).toEqual([URL_A]); // local won
    const winners = new Map(report.conflicts.map((c) => [c.key, c.winner]));
    expect(winners.get("onion:old.onion")).toBe("import");
    expect(winners.get("btc:bc1qa")).toBe("local");
    expect(report.totalOut).toBe(entities.length);
  });

  it("is deterministic — same input, same output", () => {
    expect(mergeCaseFiles(local, imported)).toEqual(mergeCaseFiles(local, imported));
  });

  it("equal timestamps with differing payload count as conflict; local wins (strict >)", () => {
    const a = entity({ type: "cve", value: "CVE-2026-1", updatedAt: NOW, urls: [URL_A] });
    const b = entity({ type: "cve", value: "CVE-2026-1", updatedAt: NOW, urls: [URL_B] });
    const { report, entities } = mergeCaseFiles([a], [b]);
    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0]?.winner).toBe("local"); // import must be strictly newer
    expect(entities[0]?.urls).toEqual([URL_A]);
  });

  it("caps the merged output at MAX_CASE_ENTITIES", () => {
    const many = Array.from({ length: MAX_CASE_ENTITIES + 50 }, (_, i) =>
      entity({ type: "email", value: `cap${i}@x.onion` }),
    );
    const { entities, report } = mergeCaseFiles([], many);
    expect(entities.length).toBe(MAX_CASE_ENTITIES);
    expect(report.totalOut).toBe(MAX_CASE_ENTITIES);
  });
});
