/**
 * BM25 (Okapi BM25) ranking algorithm.
 *
 * Replaces the heuristic (engines.length, score) sorting with a formal
 * information-retrieval score. BM25 is the standard ranking function used
 * in search engines, with decades of academic validation.
 *
 * Reference: Robertson & Zaragoza, "The Probabilistic Relevance Framework:
 * BM25 and Beyond" (2009).
 *
 * Formula:
 *   score(D, Q) = Σ_{t ∈ Q} IDF(t) · (f(t, D) · (k1 + 1)) / (f(t, D) + k1 · (1 - b + b · |D| / avgdl))
 *
 * Where:
 *   - f(t, D) = term frequency of t in document D (title + snippet)
 *   - |D| = length of document D (word count)
 *   - avgdl = average document length across the result set
 *   - IDF(t) = ln((N - n(t) + 0.5) / (n(t) + 0.5) + 1)
 *   - N = total number of documents in the result set
 *   - n(t) = number of documents containing term t
 *   - k1 = 1.2 (term frequency saturation parameter)
 *   - b = 0.75 (length normalization parameter)
 *
 * The BM25 score is combined with engine agreement (multi-engine boost)
 * to produce the final ranking. This preserves the "engines agree = higher
 * rank" signal while adding formal text relevance.
 */

export type BM25Document = {
  /** Unique key (normalised URL). */
  key: string;
  /** Text to search in (typically title + snippet). */
  text: string;
  /** Number of engines that returned this result. */
  engineCount: number;
  /** Engine trust-weighted score (sum of trust values). */
  trustScore: number;
};

export type BM25Scored = BM25Document & {
  bm25: number;
  finalScore: number;
};

const K1 = 1.2;
const B = 0.75;
const ENGINE_AGREEMENT_WEIGHT = 2.0;
const TRUST_WEIGHT = 0.5;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function termFrequency(term: string, tokens: string[]): number {
  let count = 0;
  for (const t of tokens) {
    if (t === term) count++;
  }
  return count;
}

/**
 * Compute BM25 scores for a set of documents given a query.
 * Returns documents sorted by final score (descending).
 */
export function bm25Rank(
  query: string,
  documents: BM25Document[],
): BM25Scored[] {
  if (documents.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return documents
      .map((doc) => ({
        ...doc,
        bm25: 0,
        finalScore: doc.engineCount * ENGINE_AGREEMENT_WEIGHT + doc.trustScore * TRUST_WEIGHT,
      }))
      .sort((a, b) => b.finalScore - a.finalScore);
  }

  const N = documents.length;
  const docTokens = documents.map((doc) => tokenize(doc.text));
  const docLengths = docTokens.map((tokens) => tokens.length);
  const avgdl = docLengths.reduce((sum, len) => sum + len, 0) / N;

  const scored = documents.map((doc, i) => {
    const tokens = docTokens[i]!;
    let bm25 = 0;

    for (const term of queryTerms) {
      const tf = termFrequency(term, tokens);
      if (tf === 0) continue;

      let n_t = 0;
      for (const otherTokens of docTokens) {
        if (otherTokens.includes(term)) n_t++;
      }

      const idf = Math.log((N - n_t + 0.5) / (n_t + 0.5) + 1);
      const dl = docLengths[i]!;
      const tfComponent = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl));
      bm25 += idf * tfComponent;
    }

    const finalScore =
      bm25 +
      doc.engineCount * ENGINE_AGREEMENT_WEIGHT +
      doc.trustScore * TRUST_WEIGHT;

    return { ...doc, bm25, finalScore };
  });

  return scored.sort((a, b) => b.finalScore - a.finalScore);
}
