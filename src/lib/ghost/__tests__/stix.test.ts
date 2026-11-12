import { describe, it, expect } from "vitest";
import { resultsToCSV, resultsToSTIX } from "../stix";
import type { ResultRow } from "../types";

function makeRow(overrides: Partial<ResultRow> = {}): ResultRow {
  return {
    key: "test-key",
    url: "http://abcdefghijklmnop.onion/test",
    title: "Test Result",
    snippet: "A test snippet",
    withheld: false,
    onion: true,
    engines: ["ahmia", "torch"],
    score: 5,
    ...overrides,
  };
}

describe("resultsToSTIX — basic structure", () => {
  it("produces a valid STIX bundle", () => {
    const json = resultsToSTIX([makeRow()], "test query");
    const bundle = JSON.parse(json);
    expect(bundle.type).toBe("bundle");
    expect(bundle.id).toMatch(/^bundle--/);
    expect(Array.isArray(bundle.objects)).toBe(true);
    expect(bundle.objects.length).toBeGreaterThan(0);
  });

  it("includes URL observable for each result", () => {
    const json = resultsToSTIX([makeRow()], "test");
    const bundle = JSON.parse(json);
    const urls = bundle.objects.filter((o: { type: string }) => o.type === "url");
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls[0].value).toBe("http://abcdefghijklmnop.onion/test");
  });
});

describe("resultsToSTIX — entity conversion", () => {
  it("creates cryptocurrency-wallet for BTC entity", () => {
    const row = makeRow({
      entities: [{ type: "btc", value: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }],
    });
    const json = resultsToSTIX([row], "test");
    const bundle = JSON.parse(json);
    const wallets = bundle.objects.filter(
      (o: { type: string }) => o.type === "cryptocurrency-wallet",
    );
    expect(wallets.length).toBeGreaterThanOrEqual(1);
    expect(wallets[0].currency).toBe("bitcoin");
  });

  it("creates vulnerability for CVE entity", () => {
    const row = makeRow({
      entities: [{ type: "cve", value: "CVE-2024-12345" }],
    });
    const json = resultsToSTIX([row], "test");
    const bundle = JSON.parse(json);
    const vulns = bundle.objects.filter((o: { type: string }) => o.type === "vulnerability");
    expect(vulns.length).toBeGreaterThanOrEqual(1);
    expect(vulns[0].name).toBe("CVE-2024-12345");
  });

  it("creates ipv4-addr for IP entity", () => {
    const row = makeRow({
      entities: [{ type: "ipv4", value: "192.168.1.1" }],
    });
    const json = resultsToSTIX([row], "test");
    const bundle = JSON.parse(json);
    const ips = bundle.objects.filter((o: { type: string }) => o.type === "ipv4-addr");
    expect(ips.length).toBeGreaterThanOrEqual(1);
    expect(ips[0].value).toBe("192.168.1.1");
  });

  it("creates relationship between URL and entity", () => {
    const row = makeRow({
      entities: [{ type: "email", value: "test@example.com" }],
    });
    const json = resultsToSTIX([row], "test");
    const bundle = JSON.parse(json);
    const rels = bundle.objects.filter((o: { type: string }) => o.type === "relationship");
    expect(rels.length).toBeGreaterThanOrEqual(1);
    expect(rels[0].relationship_type).toBe("related-to");
  });
});

describe("resultsToSTIX — edge cases", () => {
  it("handles empty results array", () => {
    const json = resultsToSTIX([], "test");
    const bundle = JSON.parse(json);
    expect(bundle.objects).toHaveLength(0);
  });

  it("deduplicates identical entities across results", () => {
    const rows = [
      makeRow({
        key: "a",
        entities: [{ type: "btc", value: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }],
      }),
      makeRow({
        key: "b",
        entities: [{ type: "btc", value: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }],
      }),
    ];
    const json = resultsToSTIX(rows, "test");
    const bundle = JSON.parse(json);
    const wallets = bundle.objects.filter(
      (o: { type: string }) => o.type === "cryptocurrency-wallet",
    );
    expect(wallets).toHaveLength(1);
  });

  it("produces valid JSON", () => {
    const json = resultsToSTIX([makeRow()], "test");
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("emits unique UUID-shaped ids — distinct objects can never collide", () => {
    const rows = [
      makeRow({ key: "a", entities: [{ type: "email", value: "one@x.onion" }] }),
      makeRow({ key: "b", entities: [{ type: "email", value: "two@x.onion" }] }),
    ];
    const bundle = JSON.parse(resultsToSTIX(rows, "test"));
    const ids = bundle.objects.map((o: { id: string }) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const obj of bundle.objects) {
      expect(obj.id).toMatch(
        /^[a-z-]+--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    // Both distinct observables survive — no hash-collision merging.
    expect(bundle.objects.filter((o: { type: string }) => o.type === "email-addr")).toHaveLength(2);
  });
});

describe("resultsToCSV — formula injection", () => {
  it("neutralizes leading formula characters in engine-controlled fields", () => {
    const row = makeRow({
      title: '=HYPERLINK("http://evil.example","x")',
      snippet: "+cmd|'/C calc'!A0",
    });
    const csv = resultsToCSV([row]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
  });

  it("neutralizes formulas hidden behind leading whitespace", () => {
    const csv = resultsToCSV([makeRow({ title: ' =HYPERLINK("http://evil.example","x")' })]);
    expect(csv).toContain("' =HYPERLINK");
  });

  it("leaves benign cells untouched", () => {
    const csv = resultsToCSV([makeRow({ title: "plain title" })]);
    const line = csv.split("\n")[1];
    expect(line?.split(",")[0]).toBe("plain title");
  });
});

describe("resultsToCSV — control-char formula injection (F5)", () => {
  it("neutralizes formulas behind non-whitespace control chars", () => {
    const csv = resultsToCSV([makeRow({ title: '\x07=HYPERLINK("http://evil.example")' })]);
    expect(csv).toContain("'\x07=HYPERLINK");
  });
});
