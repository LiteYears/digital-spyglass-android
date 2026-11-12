import { describe, it, expect, beforeEach } from "vitest";
import { adaptQuery } from "../query-adapter";
import { computeQarfWeights } from "../qarf";
import { correlateEntities } from "../correlation";
import {
  getDeprecatedEngines,
  getHealth,
  getHealthTrend,
  isDeprecated,
  recordCaptcha,
  recordFailure,
  recordSuccess,
  resetBreaker,
  undeprecate,
} from "../breaker";
import { ENGINES, engineById, enginesForFastMode, engineTier } from "../engines";
import { rankRowsV3, selectEngines } from "../search";
import { resultsToCSV } from "../stix";
import { assessSnippetQuality } from "../snippets";
import { clearBlacklistCache, isBlacklisted, loadAhmiaBlacklist, md5Hex } from "../blacklist";

describe("v3 engine tiers & contracts", () => {
  it("defines queryContract on all 13 engines", () => {
    expect(ENGINES).toHaveLength(13);
    for (const engine of ENGINES) {
      expect(engine.queryContract).toBeDefined();
      expect(engine.queryContract?.maxQueryLength).toBeGreaterThan(0);
      expect(engine.queryContract?.maxTerms).toBeGreaterThan(0);
    }
  });

  it("returns 5 Core + Reinforcement engines for fastMode", () => {
    const fast = enginesForFastMode();
    expect(fast).toEqual(["ahmia", "torch", "tordex", "torgle", "tor66"]);
    expect(selectEngines([], true).map((e) => e.id)).toEqual(fast);
    expect(selectEngines([], false)).toHaveLength(13);
  });

  it("classifies engine tiers accurately", () => {
    expect(engineTier("ahmia")).toBe("core");
    expect(engineTier("torgle")).toBe("reinforcement");
    expect(engineTier("excavator")).toBe("low");
  });

  it("uses calibrated v1 trust weights (Torgle=2, NotEvil=1)", () => {
    expect(engineById("torgle")?.trust).toBe(2);
    expect(engineById("notevil")?.trust).toBe(1);
    expect(engineById("ahmia")?.trust).toBe(3);
  });
});

describe("v3 query-adapter", () => {
  it("strips boolean operators and splits quoted phrases when contract forbids them", () => {
    const ahmia = engineById("ahmia")!;
    const res = adaptQuery('"zero day" AND exploit OR malware', ahmia.queryContract);
    expect(res.operatorsStripped).toBe(true);
    expect(res.query).not.toContain('"');
    expect(res.query).not.toMatch(/\b(AND|OR)\b/);
    expect(res.adaptedTerms).toBe(4);
  });

  it("enforces maxTerms and maxQueryLength deterministically", () => {
    const torgle = engineById("torgle")!;
    const res = adaptQuery("one two three four five six seven eight", torgle.queryContract);
    expect(res.termsDropped).toBe(true);
    expect(res.adaptedTerms).toBe(6);
  });

  it("does not mark operatorsStripped on plain queries without boolean operators or quotes", () => {
    const ahmia = engineById("ahmia")!;
    const res = adaptQuery("hormuz", ahmia.queryContract);
    expect(res.operatorsStripped).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.termsDropped).toBe(false);
  });
});

describe("v3 QARF adaptive weighting", () => {
  it("boosts engines whose top results match rare query terms and clamps at minMultiplier", () => {
    const results = new Map([
      [
        "ahmia",
        [{ title: "CVE-2026-9999 advisory", snippet: "Critical vulnerability patch details" }],
      ],
      ["tor66", [{ title: "Generic directory", snippet: "Links and portals" }]],
    ]);
    const baseTrust = new Map([
      ["ahmia", 3],
      ["tor66", 1],
    ]);
    const weights = computeQarfWeights("CVE-2026-9999 advisory", results, baseTrust);
    expect(weights.get("ahmia")!).toBeGreaterThan(2.5);
    expect(weights.get("tor66")!).toBeGreaterThanOrEqual(0.25);
    expect(weights.get("tor66")!).toBeLessThan(0.5);
  });
});

describe("v3 entity correlation", () => {
  it("clusters results sharing the same BTC address or CVE across different URLs", () => {
    const wallet = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const report = correlateEntities([
      {
        url: "http://siteaaaa11111111.onion/a",
        entities: [{ type: "btc", value: wallet }],
      },
      {
        url: "http://sitebbbb22222222.onion/b",
        entities: [{ type: "btc", value: wallet }],
      },
      {
        url: "http://sitecccc33333333.onion/c",
        entities: [{ type: "cve", value: "CVE-2025-1111" }],
      },
    ]);
    expect(report.totalClusters).toBe(1);
    expect(report.maxClusterSize).toBe(2);
    expect(report.clusters[0]?.entityType).toBe("btc");
    expect(report.clusters[0]?.resultCount).toBe(2);
  });

  it("ignores self-referencing onion hostnames in snippets", () => {
    const report = correlateEntities([
      {
        url: "http://samehost1111111111.onion/page1",
        entities: [{ type: "onion", value: "http://samehost1111111111.onion/page1" }],
      },
      {
        url: "http://samehost1111111111.onion/page2",
        entities: [{ type: "onion", value: "http://samehost1111111111.onion/page1" }],
      },
    ]);
    expect(report.totalClusters).toBe(0);
  });
});

describe("v3 Ahmia MD5 hash blacklist", () => {
  beforeEach(() => {
    clearBlacklistCache();
  });

  it("matches 32-char MD5 hashes from /blacklist/banned/", async () => {
    const targetHost = "bannedhost12345678.onion";
    const hash = md5Hex(targetHost);
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
    await loadAhmiaBlacklist(async () => `${hash}\n# comment\n`, true);
    expect(isBlacklisted(`http://${targetHost}/path`)).toBe(true);
    expect(isBlacklisted("http://cleanhost123456789.onion/path")).toBe(false);
  });
});

describe("v3 circuit breaker deprecation & trends", () => {
  beforeEach(() => {
    resetBreaker();
  });

  it("marks an engine deprecated after 3 consecutive timeouts and allows undeprecate", () => {
    recordFailure("onionland", "timeout after 55s", true);
    recordFailure("onionland", "timeout after 55s", true);
    expect(isDeprecated("onionland")).toBe(false);
    recordFailure("onionland", "timeout after 55s", true);
    expect(isDeprecated("onionland")).toBe(true);
    expect(getDeprecatedEngines()).toContain("onionland");

    undeprecate("onionland");
    expect(isDeprecated("onionland")).toBe(false);
  });

  it("does not open circuit breaker on captcha and tracks health trend", () => {
    recordCaptcha("oss");
    recordCaptcha("oss");
    recordCaptcha("oss");
    expect(getHealth("oss").open).toBe(false);
    recordSuccess("oss", 1200, 14);
    const trend = getHealthTrend("oss");
    expect(trend.eventCount).toBe(4);
    expect(trend.captchaCount).toBe(3);
    expect(trend.okCount).toBe(1);
    expect(trend.meanMs).toBe(1200);
  });
});

describe("v3 rankRowsV3 pipeline & CSV export", () => {
  it("fuses multi-engine hits with RRF, modifies with qualityFilter, and annotates correlatedCount", () => {
    const sharedBtc = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const { rows, correlation } = rankRowsV3(
      [
        {
          url: "http://alpha111111111111.onion/report",
          title: "Security research report on onion routing",
          snippet: `Detailed analysis of node behaviour. Donation BTC ${sharedBtc}`,
          engineId: "ahmia",
          trust: 3,
        },
        {
          url: "http://alpha111111111111.onion/report/",
          title: "Security research report on onion routing",
          snippet: `Detailed analysis of node behaviour. Donation BTC ${sharedBtc}`,
          engineId: "torch",
          trust: 2,
        },
        {
          url: "http://beta2222222222222.onion/mirror",
          title: "Related mirror node archive",
          snippet: `Secondary archive with same operator wallet ${sharedBtc} and notes`,
          engineId: "tordex",
          trust: 2,
        },
      ],
      {
        query: "onion routing security research",
        snippetFilter: false,
        qualityFilter: true,
        qarf: true,
      },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.engines).toEqual(["ahmia", "torch"]);
    expect(rows[0]?.correlatedCount).toBe(1);
    expect(rows[1]?.correlatedCount).toBe(1);
    expect(correlation.totalClusters).toBe(1);

    const csv = resultsToCSV(rows);
    expect(csv).toContain("title,url,snippet,engines,entities,score");
    expect(csv).toContain("ahmia; torch");
    expect(csv).toContain(`btc:${sharedBtc}`);
  });

  it("assesses snippet quality accurately", () => {
    expect(
      assessSnippetQuality(
        "Comprehensive threat intelligence report on ransomware infrastructure",
        "Threat Report",
        "ransomware infrastructure",
      ).sufficient,
    ).toBe(true);
    expect(assessSnippetQuality("short", "Title", "ransomware").sufficient).toBe(false);
  });
});
