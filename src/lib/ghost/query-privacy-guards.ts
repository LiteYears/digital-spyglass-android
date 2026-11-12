export const MAX_PRIVACY_QUERY_LENGTH = 256;
const MAX_MODEL_OUTPUT_LENGTH = 8192;
const MAX_DECOY_LINES = 32;
const NEGATIONS = new Set([
  "no",
  "not",
  "never",
  "without",
  "nicht",
  "kein",
  "keine",
  "keinen",
  "ohne",
  "nie",
  "niemals",
  "sans",
  "sin",
  "pas",
  "non",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

function boundedQuery(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 3 &&
    value.length <= MAX_PRIVACY_QUERY_LENGTH &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>`]/u.test(value)
  );
}

export function parseDecoyLines(output: unknown): string[] {
  if (typeof output !== "string" || output.length > MAX_MODEL_OUTPUT_LENGTH) return [];
  const lines = output.split(/\r?\n/u);
  if (lines.length > MAX_DECOY_LINES) return [];
  return lines
    .map((line) => line.replace(/^\s*(?:\d{1,2}[.)]|[-*])\s+/u, "").trim())
    .filter(boundedQuery);
}

export function areQueriesNearDuplicates(a: string, b: string): boolean {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return true;
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = left.size + right.size - shared;
  return shared / union >= 0.65 || shared / Math.min(left.size, right.size) >= 0.8;
}

function protectedWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const chunk of text.split(/\s+/u)) {
    const word = chunk.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (word.length > 0 && (/\p{N}/u.test(word) || /[._@:/+-]/u.test(word))) {
      words.add(word);
    }
  }
  return words;
}

function isInflectionVariant(token: string, anchor: string): boolean {
  if (token.length < 5 || anchor.length < 5) return false;
  const min = Math.min(token.length, anchor.length);
  let prefix = 0;
  while (prefix < min && token[prefix] === anchor[prefix]) prefix += 1;
  return prefix >= Math.max(5, min - 2) && token.length - prefix + (anchor.length - prefix) <= 3;
}

// A conservative lexical guard, not a semantic-equivalence or stylometry proof.
// Extractive: a rewrite may only drop, reorder, or inflect the original's words.
export function isRewriteAcceptable(original: string, candidate: unknown): candidate is string {
  if (!boundedQuery(original) || !boundedQuery(candidate)) return false;
  if (/"|(?:^|\s)(?:AND|OR|NOT)\b|(?:^|\s)-\S|[\p{L}\p{N}_]+:/u.test(original)) {
    return false;
  }
  const required = protectedWords(original);
  const offered = protectedWords(candidate);
  if (
    ![...required].every((word) => offered.has(word)) ||
    ![...offered].every((word) => required.has(word))
  )
    return false;
  const before = tokens(original);
  const after = tokens(candidate);
  if (after.size === 0) return false;
  if (
    ![...before].filter((token) => NEGATIONS.has(token)).every((token) => after.has(token)) ||
    ![...after].filter((token) => NEGATIONS.has(token)).every((token) => before.has(token))
  )
    return false;
  const anchors = [...before];
  return [...after].every(
    (token) => before.has(token) || anchors.some((anchor) => isInflectionVariant(token, anchor)),
  );
}

export function localInferenceEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    // Literal loopback only: no DNS, LAN endpoints, credentials or redirects.
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/", "/v1", "/v1/"].includes(url.pathname)
    )
      return null;
    return `${url.origin}/v1/chat/completions`;
  } catch {
    return null;
  }
}
