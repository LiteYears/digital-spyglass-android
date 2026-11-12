import { describe, it, expect } from "vitest";
import { parseQuery, matchesTerm, highlightTerms, type ParsedTerm } from "../query";

/* ------------------------------------------------------------------ *
 * parseQuery — basic parsing
 * ------------------------------------------------------------------ */

describe("parseQuery — plain terms", () => {
  it("parses a single word", () => {
    const result = parseQuery("bitcoin");
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]!.text).toBe("bitcoin");
    expect(result.terms[0]!.exact).toBe(false);
    expect(result.terms[0]!.excluded).toBe(false);
  });

  it("parses multiple words as separate terms", () => {
    const result = parseQuery("bitcoin marketplace");
    expect(result.terms).toHaveLength(2);
    expect(result.terms[0]!.text).toBe("bitcoin");
    expect(result.terms[1]!.text).toBe("marketplace");
  });

  it("preserves the raw query string", () => {
    const result = parseQuery("  hello world  ");
    expect(result.raw).toBe("hello world");
  });
});

/* ------------------------------------------------------------------ *
 * parseQuery — quoted phrases
 * ------------------------------------------------------------------ */

describe("parseQuery — quoted phrases", () => {
  it("parses a quoted phrase as exact", () => {
    const result = parseQuery('"dark web market"');
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]!.text).toBe("dark web market");
    expect(result.terms[0]!.exact).toBe(true);
  });

  it("parses mixed quoted and unquoted", () => {
    const result = parseQuery('bitcoin "dark web" marketplace');
    expect(result.terms).toHaveLength(3);
    expect(result.terms[0]!.text).toBe("bitcoin");
    expect(result.terms[0]!.exact).toBe(false);
    expect(result.terms[1]!.text).toBe("dark web");
    expect(result.terms[1]!.exact).toBe(true);
    expect(result.terms[2]!.text).toBe("marketplace");
    expect(result.terms[2]!.exact).toBe(false);
  });

  it("handles unclosed quote (graceful)", () => {
    const result = parseQuery('"unclosed phrase');
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]!.text).toBe("unclosed phrase");
    expect(result.terms[0]!.exact).toBe(true);
  });

  it("handles empty quoted phrase", () => {
    const result = parseQuery('""');
    expect(result.terms).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * parseQuery — exclusions
 * ------------------------------------------------------------------ */

describe("parseQuery — exclusions", () => {
  it("parses dash exclusion", () => {
    const result = parseQuery("bitcoin -scam");
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]!.text).toBe("bitcoin");
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]!.text).toBe("scam");
    expect(result.exclusions[0]!.excluded).toBe(true);
  });

  it("parses NOT keyword exclusion", () => {
    const result = parseQuery("bitcoin NOT scam");
    expect(result.terms).toHaveLength(1);
    expect(result.terms[0]!.text).toBe("bitcoin");
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]!.text).toBe("scam");
  });

  it("parses NOT keyword case-insensitively", () => {
    const result = parseQuery("bitcoin not scam");
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]!.text).toBe("scam");
  });

  it("parses NOT keyword in uppercase", () => {
    const result = parseQuery("bitcoin NoT scam");
    expect(result.exclusions).toHaveLength(1);
  });

  it("handles dash before quoted phrase", () => {
    const result = parseQuery('bitcoin -"dark web"');
    expect(result.terms).toHaveLength(1);
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]!.text).toBe("dark web");
    expect(result.exclusions[0]!.exact).toBe(true);
  });

  it("handles multiple exclusions", () => {
    const result = parseQuery("bitcoin -scam -fake NOT spam");
    expect(result.terms).toHaveLength(1);
    expect(result.exclusions).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * parseQuery — boolean operators
 * ------------------------------------------------------------------ */

describe("parseQuery — boolean operators", () => {
  it("skips AND keyword", () => {
    const result = parseQuery("bitcoin AND marketplace");
    expect(result.terms).toHaveLength(2);
    expect(result.terms.map((t) => t.text)).toEqual(["bitcoin", "marketplace"]);
  });

  it("skips OR keyword", () => {
    const result = parseQuery("bitcoin OR monero");
    expect(result.terms).toHaveLength(2);
    expect(result.terms.map((t) => t.text)).toEqual(["bitcoin", "monero"]);
  });

  it("skips lowercase and/or", () => {
    const result = parseQuery("bitcoin and marketplace or monero");
    expect(result.terms.map((t) => t.text)).toEqual(["bitcoin", "marketplace", "monero"]);
  });

  it("does not skip words containing 'and' or 'or'", () => {
    const result = parseQuery("android command");
    expect(result.terms.map((t) => t.text)).toEqual(["android", "command"]);
  });
});

/* ------------------------------------------------------------------ *
 * parseQuery — short term filtering
 * ------------------------------------------------------------------ */

describe("parseQuery — short term filtering", () => {
  it("drops terms shorter than 2 characters", () => {
    const result = parseQuery("a bc def");
    expect(result.terms).toHaveLength(2);
    expect(result.terms.map((t) => t.text)).toEqual(["bc", "def"]);
  });

  it("drops excluded terms shorter than 2 characters", () => {
    const result = parseQuery("bitcoin -a -scam");
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0]!.text).toBe("scam");
  });

  it("keeps 2-character terms", () => {
    const result = parseQuery("ok go");
    expect(result.terms).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * parseQuery — edge cases
 * ------------------------------------------------------------------ */

describe("parseQuery — edge cases", () => {
  it("handles empty string", () => {
    const result = parseQuery("");
    expect(result.terms).toHaveLength(0);
    expect(result.exclusions).toHaveLength(0);
    expect(result.raw).toBe("");
  });

  it("handles whitespace-only string", () => {
    const result = parseQuery("   ");
    expect(result.terms).toHaveLength(0);
    expect(result.exclusions).toHaveLength(0);
    expect(result.raw).toBe("");
  });

  it("handles leading/trailing whitespace", () => {
    const result = parseQuery("  bitcoin  ");
    expect(result.terms).toHaveLength(1);
    expect(result.raw).toBe("bitcoin");
  });

  it("handles multiple spaces between terms", () => {
    const result = parseQuery("bitcoin    marketplace");
    expect(result.terms).toHaveLength(2);
  });

  it("handles only exclusions", () => {
    const result = parseQuery("-scam -fake");
    expect(result.terms).toHaveLength(0);
    expect(result.exclusions).toHaveLength(2);
  });

  it("handles only boolean operators", () => {
    const result = parseQuery("AND OR");
    expect(result.terms).toHaveLength(0);
  });

  it("handles NOT at end of query (no term after)", () => {
    const result = parseQuery("bitcoin NOT");
    expect(result.terms).toHaveLength(1);
    expect(result.exclusions).toHaveLength(0);
  });

  it("handles dash at end of query", () => {
    const result = parseQuery("bitcoin -");
    expect(result.terms).toHaveLength(1);
    expect(result.exclusions).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * matchesTerm
 * ------------------------------------------------------------------ */

describe("matchesTerm", () => {
  it("matches case-insensitively", () => {
    const term: ParsedTerm = { text: "Bitcoin", exact: false, excluded: false };
    expect(matchesTerm("buy bitcoin now", term)).toBe(true);
    expect(matchesTerm("BUY BITCOIN NOW", term)).toBe(true);
    expect(matchesTerm("buy litecoin now", term)).toBe(false);
  });

  it("matches as substring", () => {
    const term: ParsedTerm = { text: "bit", exact: false, excluded: false };
    expect(matchesTerm("bitcoin", term)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * highlightTerms
 * ------------------------------------------------------------------ */

describe("highlightTerms", () => {
  it("returns unique term texts (case-insensitive dedup)", () => {
    const result = parseQuery("Bitcoin bitcoin BITCOIN");
    const highlights = highlightTerms(result);
    expect(highlights).toHaveLength(1);
  });

  it("excludes excluded terms", () => {
    const result = parseQuery("bitcoin -scam");
    const highlights = highlightTerms(result);
    expect(highlights).toEqual(["bitcoin"]);
  });

  it("preserves original casing of first occurrence", () => {
    const result = parseQuery("Bitcoin bitcoin");
    const highlights = highlightTerms(result);
    expect(highlights[0]).toBe("Bitcoin");
  });

  it("returns empty for empty query", () => {
    const result = parseQuery("");
    expect(highlightTerms(result)).toEqual([]);
  });
});
