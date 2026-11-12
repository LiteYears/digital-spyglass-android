/**
 * Snippet safety filter — a liability control, not censorship of the index.
 *
 * A search interface that renders arbitrary onion snippets can end up displaying
 * material that is illegal to display, even transiently. Titles and URLs stay
 * visible; the snippet is replaced with a placeholder when a high-risk term
 * matches, and the user opens the link in Tor Browser instead.
 */

export const SNIPPET_MAX = 150;
export const WITHHELD = "[content withheld — open the link in Tor Browser]";

/** Deliberately narrow: only categories where mere display is the problem. */
const ENCODED_RISK = [
  "Y3A=",
  "Y3NhbQ==",
  "Y2hpbGQ=",
  "Y2hpbGRz",
  "cGVkbw==",
  "cGFlZG8=",
  "cHJldGVlbg==",
  "bG9saQ==",
  "bG9saXRh",
  "amFpbGJhaXQ=",
  "aGViZQ==",
  "aW5jZXN0",
  "cmFwZQ==",
  "c251ZmY=",
  "Z29yZQ==",
  "YmVoZWFkaW5n",
  "aGl0bWFu",
  "bXVyZGVyIGZvciBoaXJl",
  "b3JnYW4=",
  "YmVzdGlhbGl0eQ==",
  "em9vcGhpbGlh",
  "bmVjcm8=",
  "aHVydGNvcmU=",
];

const HIGH_RISK = ENCODED_RISK.map((b64) => atob(b64));

const WORD_RES = HIGH_RISK.map((term) => new RegExp(`(^|[^a-z])${term}([^a-z]|$)`, "i"));

export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isHighRisk(text: string): boolean {
  const haystack = ` ${text.toLowerCase()} `;
  return WORD_RES.some((re) => re.test(haystack));
}

export function safeSnippet(
  raw: string,
  filterOn: boolean,
): { snippet: string; withheld: boolean } {
  const text = stripHtml(raw);
  if (filterOn && isHighRisk(text)) return { snippet: WITHHELD, withheld: true };
  const clipped = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX).trimEnd()}…` : text;
  return { snippet: clipped, withheld: false };
}

const SNIPPET_INSUFFICIENT_LENGTH = 20;
const SNIPPET_INSUFFICIENT_WORDS = 3;
const TITLE_INSUFFICIENT_LENGTH = 5;

export type SnippetQuality = {
  sufficient: boolean;
  reason?: string;
};

export function assessSnippetQuality(
  snippet: string,
  title: string,
  query: string,
): SnippetQuality {
  const snippetText = snippet.trim();
  if (snippetText === WITHHELD) {
    return { sufficient: false, reason: "withheld" };
  }
  const titleText = title.trim();
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (snippetText.length === 0 && titleText.length <= TITLE_INSUFFICIENT_LENGTH) {
    return { sufficient: false, reason: "empty_snippet_and_short_title" };
  }

  if (snippetText.length > 0 && snippetText.length < SNIPPET_INSUFFICIENT_LENGTH) {
    return { sufficient: false, reason: "snippet_too_short" };
  }

  if (snippetText.length > 0) {
    const wordCount = snippetText.split(/\s+/).length;
    if (wordCount < SNIPPET_INSUFFICIENT_WORDS) {
      return { sufficient: false, reason: "snippet_few_words" };
    }
  }

  if (queryTerms.length > 0 && snippetText.length > 0) {
    const lowerSnippet = snippetText.toLowerCase();
    const lowerTitle = titleText.toLowerCase();
    const combined = `${lowerTitle} ${lowerSnippet}`;
    const matches = queryTerms.filter((t) => combined.includes(t)).length;
    const overlap = matches / queryTerms.length;
    if (overlap < 0.15) {
      return { sufficient: false, reason: "low_query_overlap" };
    }
  }

  return { sufficient: true };
}
