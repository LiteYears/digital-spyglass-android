import { describe, it, expect } from "vitest";
import { bm25Rank, type BM25Document } from "../ranking";

describe("bm25Rank — basic ranking", () => {
  it("ranks documents with query term matches higher", () => {
    const query = "marketplace drugs";
    const docs: BM25Document[] = [
      { key: "a", text: "darknet marketplace for drugs", engineCount: 1, trustScore: 1 },
      { key: "b", text: "random onion site about cats", engineCount: 1, trustScore: 1 },
    ];
    const ranked = bm25Rank(query, docs);
    expect(ranked[0]!.key).toBe("a");
    expect(ranked[0]!.bm25).toBeGreaterThan(ranked[1]!.bm25);
  });

  it("returns documents sorted by finalScore descending", () => {
    const docs: BM25Document[] = [
      { key: "a", text: "test query matching", engineCount: 1, trustScore: 1 },
      { key: "b", text: "test query matching test", engineCount: 2, trustScore: 3 },
      { key: "c", text: "test query matching test query", engineCount: 3, trustScore: 5 },
    ];
    const ranked = bm25Rank("test query", docs);
    expect(ranked[0]!.key).toBe("c");
    expect(ranked[1]!.key).toBe("b");
    expect(ranked[2]!.key).toBe("a");
  });
});

describe("bm25Rank — engine agreement boost", () => {
  it("boosts results with more engine agreement", () => {
    const query = "onion";
    const docs: BM25Document[] = [
      { key: "a", text: "onion site", engineCount: 1, trustScore: 1 },
      { key: "b", text: "onion site", engineCount: 5, trustScore: 5 },
    ];
    const ranked = bm25Rank(query, docs);
    expect(ranked[0]!.key).toBe("b");
  });
});

describe("bm25Rank — edge cases", () => {
  it("returns empty array for empty documents", () => {
    expect(bm25Rank("test", [])).toEqual([]);
  });

  it("handles empty query by falling back to engine agreement", () => {
    const docs: BM25Document[] = [
      { key: "a", text: "some content", engineCount: 1, trustScore: 1 },
      { key: "b", text: "other content", engineCount: 3, trustScore: 3 },
    ];
    const ranked = bm25Rank("", docs);
    expect(ranked[0]!.key).toBe("b");
    expect(ranked[0]!.bm25).toBe(0);
  });

  it("handles query with no matching terms", () => {
    const docs: BM25Document[] = [
      { key: "a", text: "completely unrelated content", engineCount: 1, trustScore: 1 },
    ];
    const ranked = bm25Rank("nonexistent", docs);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.bm25).toBe(0);
  });
});

describe("bm25Rank — formal properties", () => {
  it("BM25 score is non-negative", () => {
    const docs: BM25Document[] = [
      { key: "a", text: "test document with query terms", engineCount: 1, trustScore: 1 },
    ];
    const ranked = bm25Rank("test query", docs);
    expect(ranked[0]!.bm25).toBeGreaterThanOrEqual(0);
  });

  it("produces deterministic results (same input → same output)", () => {
    const docs: BM25Document[] = [
      { key: "a", text: "marketplace drugs", engineCount: 2, trustScore: 2 },
      { key: "b", text: "forum marketplace", engineCount: 1, trustScore: 1 },
    ];
    const ranked1 = bm25Rank("marketplace", docs);
    const ranked2 = bm25Rank("marketplace", docs);
    expect(ranked1.map((r) => r.key)).toEqual(ranked2.map((r) => r.key));
    expect(ranked1.map((r) => r.bm25)).toEqual(ranked2.map((r) => r.bm25));
  });
});
