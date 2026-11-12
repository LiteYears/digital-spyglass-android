import { describe, it, expect } from "vitest";
import {
  normaliseKey,
  aggregate,
  dedupeByContent,
  textSimilarity,
  flagScams,
  filterAndSort,
} from "../search";
import type { RawResult, ResultRow } from "../types";

/* ------------------------------------------------------------------ *
 * normaliseKey
 * ------------------------------------------------------------------ */

describe("normaliseKey", () => {
  it("lowercases the hostname", () => {
    expect(normaliseKey("http://EXAMPLE.com/path")).toBe("example.com/path");
  });

  it("strips trailing slashes from path", () => {
    expect(normaliseKey("http://example.com/path/")).toBe("example.com/path");
    expect(normaliseKey("http://example.com/")).toBe("example.com");
  });

  it("preserves query string", () => {
    expect(normaliseKey("http://example.com/search?q=test")).toBe("example.com/search?q=test");
  });

  it("normalises same URL with and without trailing slash to same key", () => {
    expect(normaliseKey("http://example.com/page")).toBe(normaliseKey("http://example.com/page/"));
  });

  it("handles invalid URLs gracefully (fallback to lowercase)", () => {
    const key = normaliseKey("not a url at all");
    expect(key).toBe("not a url at all");
  });

  it("handles onion URLs", () => {
    const key = normaliseKey("http://abcdefghijklmnop.onion/page?q=1");
    expect(key).toBe("abcdefghijklmnop.onion/page?q=1");
  });
});

/* ------------------------------------------------------------------ *
 * aggregate
 * ------------------------------------------------------------------ */

function makeRaw(
  url: string,
  title: string,
  snippet: string,
  engineId: string,
  trust = 1,
): RawResult & { trust: number } {
  return { url, title, snippet, engineId, trust };
}

describe("aggregate — deduplication by URL", () => {
  it("deduplicates results with the same normalised URL", () => {
    const raw = [
      makeRaw("http://example.com/page", "Title", "Snippet", "ahmia"),
      makeRaw("http://example.com/page/", "Title", "Snippet", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows).toHaveLength(1);
  });

  it("keeps results with different URLs separate", () => {
    const raw = [
      makeRaw("http://example.com/a", "A", "Snippet A", "ahmia"),
      makeRaw("http://example.com/b", "B", "Snippet B", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows).toHaveLength(2);
  });

  it("merges engine lists for duplicate URLs", () => {
    const raw = [
      makeRaw("http://example.com/page", "Title", "Snippet", "ahmia"),
      makeRaw("http://example.com/page", "Title", "Snippet", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows[0]!.engines).toEqual(["ahmia", "torch"]);
  });

  it("accumulates scores for duplicate URLs", () => {
    const raw = [
      makeRaw("http://example.com/page", "Title", "Snippet", "ahmia", 3),
      makeRaw("http://example.com/page", "Title", "Snippet", "torch", 2),
    ];
    const rows = aggregate(raw, false);
    // score = (trust+1) + (trust+1) = 4 + 3 = 7
    expect(rows[0]!.score).toBe(7);
  });
});

describe("aggregate — title and snippet merging", () => {
  it("replaces URL-only title with real title from later result", () => {
    const raw = [
      makeRaw("http://example.com/page", "http://example.com/page", "Snippet", "ahmia"),
      makeRaw("http://example.com/page", "Real Title", "Snippet", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows[0]!.title).toBe("Real Title");
  });

  it("does not replace real title with URL-only title", () => {
    const raw = [
      makeRaw("http://example.com/page", "Real Title", "Snippet", "ahmia"),
      makeRaw("http://example.com/page", "http://example.com/page", "Snippet", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows[0]!.title).toBe("Real Title");
  });

  it("fills empty snippet with non-empty snippet from later result", () => {
    const raw = [
      makeRaw("http://example.com/page", "Title", "", "ahmia"),
      makeRaw("http://example.com/page", "Title", "A real snippet", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows[0]!.snippet).toBe("A real snippet");
  });
});

describe("aggregate — sorting", () => {
  it("sorts by information quality first (non-withheld > withheld)", () => {
    const raw = [
      makeRaw("http://a.com", "A", "short", "ahmia"), // snippet < 15 chars → not "info"
      makeRaw("http://b.com", "B", "this is a longer snippet", "torch"), // > 15 → "info"
    ];
    const rows = aggregate(raw, false);
    expect(rows[0]!.url).toBe("http://b.com");
  });

  it("sorts by engine count when info quality is equal", () => {
    const raw = [
      makeRaw("http://a.com", "A", "this is a longer snippet", "ahmia"),
      makeRaw("http://b.com", "B", "this is also a longer snippet", "torch"),
      makeRaw("http://b.com", "B", "this is also a longer snippet", "tor66"),
    ];
    const rows = aggregate(raw, false);
    // b.com has 2 engines, a.com has 1 → b.com first
    expect(rows[0]!.url).toBe("http://b.com");
  });

  it("sorts by score when engine count is equal", () => {
    const raw = [
      makeRaw("http://a.com", "A", "this is a longer snippet", "ahmia", 1),
      makeRaw("http://b.com", "B", "this is also a longer snippet", "torch", 3),
    ];
    const rows = aggregate(raw, false);
    // b.com has higher trust → higher score → first
    expect(rows[0]!.url).toBe("http://b.com");
  });
});

describe("aggregate — snippet filter", () => {
  it("withholds high-risk snippets when filter is on", () => {
    const raw = [makeRaw("http://a.com", "A", "this contains csam material here", "ahmia")];
    const rows = aggregate(raw, true);
    expect(rows[0]!.withheld).toBe(true);
  });

  it("does not withhold normal snippets when filter is on", () => {
    const raw = [makeRaw("http://a.com", "A", "this is a normal snippet about markets", "ahmia")];
    const rows = aggregate(raw, true);
    expect(rows[0]!.withheld).toBe(false);
  });

  it("does not withhold high-risk snippets when filter is off", () => {
    const raw = [makeRaw("http://a.com", "A", "this contains csam material here", "ahmia")];
    const rows = aggregate(raw, false);
    expect(rows[0]!.withheld).toBe(false);
  });

  it("does not extract entities from withheld snippets", () => {
    const raw = [
      makeRaw("http://a.com", "A", "this contains csam user@example.com material", "ahmia"),
    ];
    const rows = aggregate(raw, true);
    expect(rows[0]!.entities).toBeUndefined();
  });
});

describe("aggregate — edge cases", () => {
  it("handles empty input", () => {
    expect(aggregate([], false)).toEqual([]);
  });

  it("skips results with empty URL", () => {
    const raw = [
      makeRaw("", "Title", "Snippet", "ahmia"),
      makeRaw("http://example.com", "Title", "Snippet", "torch"),
    ];
    const rows = aggregate(raw, false);
    expect(rows).toHaveLength(1);
  });

  it("uses URL as title when title is empty", () => {
    const raw = [makeRaw("http://example.com/page", "", "Snippet", "ahmia")];
    const rows = aggregate(raw, false);
    expect(rows[0]!.title).toBe("http://example.com/page");
  });
});

/* ------------------------------------------------------------------ *
 * textSimilarity
 * ------------------------------------------------------------------ */

describe("textSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(textSimilarity("hello world foo", "hello world foo")).toBe(1);
  });

  it("returns 0.0 for completely different strings", () => {
    expect(textSimilarity("aaa", "zzz")).toBe(0);
  });

  it("returns 1.0 for empty strings (identical)", () => {
    // "".split(" ") returns [""], so both sets contain one empty string,
    // shared=1, total=1, result=1. Two empty strings are trivially identical.
    expect(textSimilarity("", "")).toBe(1);
  });

  it("returns partial overlap between 0 and 1", () => {
    const sim = textSimilarity("apple banana cherry", "apple banana date");
    // shared: apple, banana = 2; total: 3 + 3 - 2 = 4; 2/4 = 0.5
    expect(sim).toBeCloseTo(0.5, 2);
  });

  it("is symmetric", () => {
    const a = "the quick brown fox";
    const b = "the lazy brown dog";
    expect(textSimilarity(a, b)).toBeCloseTo(textSimilarity(b, a), 10);
  });
});

/* ------------------------------------------------------------------ *
 * dedupeByContent
 * ------------------------------------------------------------------ */

function makeRow(
  url: string,
  title: string,
  snippet: string,
  score: number,
  withheld = false,
): ResultRow {
  return {
    key: url,
    url,
    title,
    snippet,
    withheld,
    onion: true,
    engines: ["ahmia"],
    score,
  };
}

describe("dedupeByContent", () => {
  it("halves score of near-duplicate snippets (>80% similar)", () => {
    const rows = [
      makeRow(
        "http://a.com",
        "Title A",
        "this is a very long snippet about bitcoin marketplace deals",
        10,
      ),
      makeRow(
        "http://b.com",
        "Title B",
        "this is a very long snippet about bitcoin marketplace deals today",
        10,
      ),
    ];
    const result = dedupeByContent(rows);
    // Second row is similar to first → score halved
    expect(result[1]!.score).toBe(5);
    expect(result[0]!.score).toBe(10); // first row unchanged
  });

  it("does not demote dissimilar snippets", () => {
    const rows = [
      makeRow(
        "http://a.com",
        "Title A",
        "this is a very long snippet about bitcoin marketplace deals",
        10,
      ),
      makeRow(
        "http://b.com",
        "Title B",
        "completely different content about tor hidden services",
        10,
      ),
    ];
    const result = dedupeByContent(rows);
    expect(result[1]!.score).toBe(10);
  });

  it("skips withheld results (no comparison)", () => {
    const rows = [
      makeRow(
        "http://a.com",
        "Title A",
        "[content withheld — open the link in Tor Browser]",
        10,
        true,
      ),
      makeRow(
        "http://b.com",
        "Title B",
        "[content withheld — open the link in Tor Browser]",
        10,
        true,
      ),
    ];
    const result = dedupeByContent(rows);
    // Both withheld → no comparison → scores unchanged
    expect(result[0]!.score).toBe(10);
    expect(result[1]!.score).toBe(10);
  });

  it("skips short snippets (<20 chars)", () => {
    const rows = [
      makeRow("http://a.com", "Title A", "short", 10),
      makeRow("http://b.com", "Title B", "short", 10),
    ];
    const result = dedupeByContent(rows);
    expect(result[0]!.score).toBe(10);
    expect(result[1]!.score).toBe(10);
  });

  it("does not compare withheld with non-withheld", () => {
    const rows = [
      makeRow(
        "http://a.com",
        "Title A",
        "this is a very long snippet about bitcoin marketplace deals here",
        10,
        false,
      ),
      makeRow("http://b.com", "Title B", "[content withheld]", 10, true),
    ];
    const result = dedupeByContent(rows);
    expect(result[0]!.score).toBe(10);
  });

  it("handles empty array", () => {
    expect(dedupeByContent([])).toEqual([]);
  });

  it("handles single row", () => {
    const rows = [
      makeRow("http://a.com", "Title", "this is a long enough snippet for testing", 10),
    ];
    const result = dedupeByContent(rows);
    expect(result[0]!.score).toBe(10);
  });
});

/* ------------------------------------------------------------------ *
 * flagScams
 * ------------------------------------------------------------------ */

describe("flagScams", () => {
  it("flags 'official mirror' in title", () => {
    const rows = [makeRow("http://a.com", "Official Mirror of Marketplace", "snippet", 10)];
    const result = flagScams(rows);
    expect(result[0]!.scamFlag).toBeDefined();
    expect(result[0]!.scamFlag).toContain("scam pattern");
  });

  it("flags 'clone of' in title", () => {
    const rows = [makeRow("http://a.com", "Clone of Popular Site", "snippet", 10)];
    const result = flagScams(rows);
    expect(result[0]!.scamFlag).toBeDefined();
  });

  it("detects mirror: same title, different hostname", () => {
    const rows = [
      makeRow("http://aaa.onion", "Popular Marketplace XYZ", "snippet", 10),
      makeRow("http://bbb.onion", "Popular Marketplace XYZ", "snippet", 10),
    ];
    const result = flagScams(rows);
    expect(result[1]!.scamFlag).toBeDefined();
    expect(result[1]!.scamFlag).toContain("mirror of");
  });

  it("does not flag same-hostname results as mirrors", () => {
    const rows = [
      makeRow("http://aaa.onion/page1", "Popular Marketplace XYZ", "snippet", 10),
      makeRow("http://aaa.onion/page2", "Popular Marketplace XYZ", "snippet", 10),
    ];
    const result = flagScams(rows);
    expect(result[1]!.scamFlag).toBeUndefined();
  });

  it("does not flag normal titles", () => {
    const rows = [makeRow("http://a.com", "Normal Marketplace Title", "snippet", 10)];
    const result = flagScams(rows);
    expect(result[0]!.scamFlag).toBeUndefined();
  });

  it("does not flag short titles (<10 chars normalised)", () => {
    const rows = [
      makeRow("http://aaa.onion", "Hi", "snippet", 10),
      makeRow("http://bbb.onion", "Hi", "snippet", 10),
    ];
    const result = flagScams(rows);
    expect(result[1]!.scamFlag).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * filterAndSort
 * ------------------------------------------------------------------ */

describe("filterAndSort", () => {
  it("filters to onion-only when onionOnly is true", () => {
    const rows: ResultRow[] = [
      { ...makeRow("http://a.onion", "Title", "snippet here", 10), onion: true },
      { ...makeRow("http://b.com", "Title", "snippet here", 10), onion: false },
    ];
    const result = filterAndSort(rows, { sort: "best", onionOnly: true, minEngines: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]!.onion).toBe(true);
  });

  it("filters by minimum engine count", () => {
    const rows: ResultRow[] = [
      { ...makeRow("http://a.com", "Title", "snippet here", 10), engines: ["ahmia"] },
      {
        ...makeRow("http://b.com", "Title", "snippet here", 10),
        engines: ["ahmia", "torch", "tor66"],
      },
    ];
    const result = filterAndSort(rows, { sort: "best", onionOnly: false, minEngines: 2 });
    expect(result).toHaveLength(1);
    expect(result[0]!.engines).toHaveLength(3);
  });

  it("sorts by engine count in 'engines' mode", () => {
    const rows: ResultRow[] = [
      {
        ...makeRow("http://a.com", "Title", "this is a long enough snippet for testing", 10),
        engines: ["ahmia"],
      },
      {
        ...makeRow("http://b.com", "Title", "this is a long enough snippet for testing", 10),
        engines: ["ahmia", "torch"],
      },
    ];
    const result = filterAndSort(rows, { sort: "engines", onionOnly: false, minEngines: 1 });
    expect(result[0]!.engines).toHaveLength(2);
    expect(result[1]!.engines).toHaveLength(1);
  });
});
