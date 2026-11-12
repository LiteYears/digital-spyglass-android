import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  splitSentences,
  summarizeRows,
  tokenizeContent,
  type SummarySourceRow,
} from "../summarize";

function row(partial: Partial<SummarySourceRow>): SummarySourceRow {
  return {
    key: partial.key ?? "k1",
    url: partial.url ?? "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/1",
    title: partial.title ?? "t",
    snippet: partial.snippet ?? "",
    withheld: partial.withheld ?? false,
  };
}

describe("splitSentences / tokenizeContent", () => {
  it("breaks after ., !, ? followed by whitespace", () => {
    expect(splitSentences("One. Two! Three? Four")).toEqual(["One.", "Two!", "Three?", "Four"]);
  });

  it("collapses whitespace and drops empties", () => {
    expect(splitSentences("  a.\n\n  b.  ")).toEqual(["a.", "b."]);
  });

  it("tokenizes lowercase alphanumerics and removes stopwords", () => {
    expect(tokenizeContent("The Escrow MARKET is not a game!")).toEqual(["escrow", "market", "game"]);
  });
});

describe("summarizeRows", () => {
  it("returns null with fewer than two usable sentences", () => {
    expect(summarizeRows([row({ snippet: "Only one sentence here." })])).toBeNull();
    expect(summarizeRows([])).toBeNull();
    expect(
      summarizeRows([row({ snippet: "Short." }), row({ snippet: "Also short." })]),
    ).toBeNull();
  });

  it("prefers sentences shared across snippets over unrelated ones", () => {
    const rows = [
      row({
        key: "a",
        url: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/a",
        snippet:
          "The escrow market vendor shipped the product with tracking and escrow protection included.",
      }),
      row({
        key: "b",
        url: "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion/b",
        snippet:
          "Escrow vendors on the market provide tracking numbers after shipping the product out.",
      }),
      row({
        key: "c",
        url: "http://cccccccccccccccccccccccccccccccccccccccccccccccccccccccc.onion/c",
        snippet:
          "This forum thread discusses cooking recipes for pasta dinners at home with friends.",
      }),
      row({
        key: "d",
        url: "http://dddddddddddddddddddddddddddddddddddddddddddddddddddddddd.onion/d",
        snippet:
          "The weather forecast predicts rain clouds over the coastal city tonight again.",
      }),
    ];
    const summary = summarizeRows(rows, { maxSentences: 2 })!;
    expect(summary.selected.map((s) => s.key)).toEqual(["a", "b"]);
  });

  it("is deterministic — identical input yields identical output", () => {
    const rows = [
      row({ snippet: "Vendor escrow market tracking product shipping details inside." }),
      row({ snippet: "Escrow market tracking product shipping vendor terms explained." }),
      row({ snippet: "Unrelated sentence about gardening tools and seasonal plants." }),
    ];
    expect(summarizeRows(rows)).toEqual(summarizeRows(rows));
  });

  it("skips withheld (liability-filtered) snippets", () => {
    const rows = [
      row({ key: "w", snippet: "Escrow market vendor tracking product shipping withheld.", withheld: true }),
      row({ snippet: "Vendor escrow market tracking product shipping details inside." }),
      row({ snippet: "Escrow market tracking product shipping vendor terms explained." }),
    ];
    const summary = summarizeRows(rows, { maxSentences: 3 })!;
    expect(summary.selected.every((s) => s.key !== "w")).toBe(true);
  });

  it("deduplicates identical sentences across engines", () => {
    const snippet = "The escrow market vendor shipped the product with tracking protection.";
    const rows = [
      row({ key: "x", snippet }),
      row({ key: "y", snippet }),
      row({ snippet: "Escrow market tracking product shipping vendor terms explained." }),
      row({ snippet: "Vendor escrow market tracking product shipping details inside." }),
    ];
    const summary = summarizeRows(rows, { maxSentences: 4 })!;
    expect(summary.candidateCount).toBe(3);
    expect(new Set(summary.selected.map((s) => s.text)).size).toBe(summary.selected.length);
  });

  it("caps the graph at maxGraphSentences (O(n²) protection)", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({
        key: `k${i}`,
        snippet: `Snippet report ${i}${i}: market escrow vendor tracking shipment quality index.`,
      }),
    );
    const summary = summarizeRows(rows, { maxGraphSentences: 25, maxSentences: 3 })!;
    expect(summary.candidateCount).toBe(25);
  });

  it("returns selected sentences in original reading order", () => {
    const rows = [
      row({ key: "late", snippet: "Escrow market vendor tracking product shipping zebra sentence arrives later." }),
      row({ key: "early", snippet: "Vendor escrow market tracking product shipping alpha sentence comes first." }),
    ];
    const summary = summarizeRows(rows, { maxSentences: 2 })!;
    expect(summary.selected.map((s) => s.position)).toEqual([...summary.selected]
      .map((s) => s.position)
      .sort((a, b) => a - b));
  });

  it("carries the honest extractive caution label", () => {
    const rows = [
      row({ snippet: "Vendor escrow market tracking product shipping details inside." }),
      row({ snippet: "Escrow market tracking product shipping vendor terms explained." }),
    ];
    const summary = summarizeRows(rows)!;
    expect(summary.method).toBe("extractive-textrank-v1");
    expect(summary.caution).toContain("extractive, not semantic");
  });
});

describe("summarizeRows — property checks", () => {
  it("never throws on arbitrary text and stays deterministic", () => {
    const arbitraryRows = fc.array(
      fc.record({
        key: fc.string({ minLength: 1, maxLength: 8 }),
        url: fc.webUrl(),
        title: fc.string({ minLength: 0, maxLength: 120 }),
        snippet: fc.string({ minLength: 0, maxLength: 600 }),
        withheld: fc.boolean(),
      }),
      { maxLength: 25 },
    );
    fc.assert(
      fc.property(arbitraryRows, (rows) => {
        const a = summarizeRows(rows as SummarySourceRow[]);
        const b = summarizeRows(rows as SummarySourceRow[]);
        expect(a).toEqual(b);
        return true;
      }),
      { numRuns: 50 },
    );
  });
});
