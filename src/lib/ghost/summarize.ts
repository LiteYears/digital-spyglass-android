/**
 * Extractive snippet summarizer — TextRank (Mihalcea & Tarau 2004) over
 * result snippets. Pure local computation: no LLM, no network, no deps.
 * Session-scoped: input rows are RAM-only search results, the summary is
 * derived data and never persisted either.
 *
 * Pipeline: sentence split → content-token extraction (stopworded) →
 * sentence-similarity graph (word overlap, log-length normalised) →
 * power-iteration PageRank (damping 0.85) → top-N sentences restored to
 * their original order. Honest by construction: it SELECTS sentences,
 * it does not understand or rephrase them.
 */

const DAMPING = 0.85;
const ITERATIONS = 24;
const TOLERANCE = 1e-4;
const MAX_SENTENCE_CHARS = 600;

/** Small English stopword list — engine snippets are English-dominant. */
const STOPWORDS = new Set([
  "about", "after", "again", "against", "all", "and", "any", "are", "because", "been",
  "before", "being", "below", "between", "both", "but", "can", "did", "does", "doing",
  "down", "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "here", "hers", "him", "his", "how", "into", "its", "just", "more", "most",
  "not", "now", "off", "only", "our", "out", "over", "own", "same", "she", "should",
  "some", "such", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "too", "under", "until", "very", "was", "were",
  "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "you", "your", "is", "am", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "do", "does", "did", "it", "its", "he", "we", "at", "by", "on", "or",
  "an", "as", "if", "no", "so", "up",
]);

/** Sentence splitter: break after ., !, ? followed by whitespace. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Content tokens: lowercase alphanumeric words, stopwords removed. */
export function tokenizeContent(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export type SummarySourceRow = {
  key: string;
  url: string;
  title: string;
  snippet: string;
  /** Liability-filtered snippets are placeholders — never summarize them. */
  withheld: boolean;
};

export type SummarySentence = {
  text: string;
  score: number;
  url: string;
  key: string;
  /** Global candidate position — used to restore reading order after ranking. */
  position: number;
};

export type ExtractiveSummary = {
  method: "extractive-textrank-v1";
  /** Top sentences in original reading order (not score order). */
  selected: SummarySentence[];
  /** Sentences that entered the graph (after length/dedupe caps). */
  candidateCount: number;
  caution: "extractive, not semantic — sentences are selected, not understood";
};

export type SummaryOptions = {
  /** Sentences in the output. Default 5. */
  maxSentences?: number;
  /** Hard cap on graph nodes — protects O(n²) pairing on huge result sets. Default 200. */
  maxGraphSentences?: number;
  /** Minimum sentence length to be a candidate. Default 25 chars. */
  minSentenceChars?: number;
};

type Candidate = {
  text: string;
  tokens: string[];
  url: string;
  key: string;
  position: number;
};

/**
 * Summarize result rows extractively. Returns null when fewer than two
 * usable sentences exist — TextRank needs a graph, one sentence has none.
 * Deterministic: same rows in, same summary out (stable ordering everywhere).
 */
export function summarizeRows(
  rows: SummarySourceRow[],
  options?: SummaryOptions,
): ExtractiveSummary | null {
  const maxSentences = options?.maxSentences ?? 5;
  const maxGraph = options?.maxGraphSentences ?? 200;
  const minChars = options?.minSentenceChars ?? 25;

  const candidates: Candidate[] = [];
  const seenSentenceKeys = new Set<string>();

  for (const row of rows) {
    if (row.withheld) continue;
    const source = row.snippet.length > 0 ? row.snippet : row.title;
    if (source.length === 0) continue;
    for (const raw of splitSentences(source)) {
      if (candidates.length >= maxGraph) break;
      const text = raw.length > MAX_SENTENCE_CHARS ? `${raw.slice(0, MAX_SENTENCE_CHARS)}…` : raw;
      if (text.length < minChars) continue;
      const tokens = tokenizeContent(text);
      if (tokens.length < 3) continue;
      const dedupeKey = tokens.join(" ");
      if (seenSentenceKeys.has(dedupeKey)) continue;
      seenSentenceKeys.add(dedupeKey);
      candidates.push({ text, tokens, url: row.url, key: row.key, position: candidates.length });
    }
    if (candidates.length >= maxGraph) break;
  }

  if (candidates.length < 2) return null;

  /* Symmetric similarity weights: w(i,j) = |shared| / (log|si| + log|sj|). */
  const n = candidates.length;
  const weights: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  const outSum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ti = new Set(candidates[i]!.tokens);
    for (let j = i + 1; j < n; j++) {
      let shared = 0;
      for (const word of candidates[j]!.tokens) {
        if (ti.has(word)) shared++;
      }
      if (shared === 0) continue;
      const denom = Math.max(
        1,
        Math.log(candidates[i]!.tokens.length) + Math.log(candidates[j]!.tokens.length),
      );
      const w = shared / denom;
      weights[i]![j] = w;
      weights[j]![i] = w;
      outSum[i]! += w;
      outSum[j]! += w;
    }
  }

  let scores = new Float64Array(n).fill(1 / n);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let incoming = 0;
      for (let j = 0; j < n; j++) {
        const w = weights[j]![i]!;
        if (w > 0 && outSum[j]! > 0) {
          incoming += (w / outSum[j]!) * scores[j]!;
        }
      }
      next[i] = (1 - DAMPING) + DAMPING * incoming;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      delta = Math.max(delta, Math.abs(next[i]! - scores[i]!));
    }
    scores = next;
    if (delta < TOLERANCE) break;
  }

  const ranked = candidates
    .map((c, i) => ({ candidate: c, score: scores[i]! }))
    .sort((a, b) => b.score - a.score || a.candidate.position - b.candidate.position)
    .slice(0, Math.min(maxSentences, n))
    .map((entry) => ({
      text: entry.candidate.text,
      score: entry.score,
      url: entry.candidate.url,
      key: entry.candidate.key,
      position: entry.candidate.position,
    }))
    .sort((a, b) => a.position - b.position);

  return {
    method: "extractive-textrank-v1",
    selected: ranked,
    candidateCount: n,
    caution: "extractive, not semantic — sentences are selected, not understood",
  };
}
