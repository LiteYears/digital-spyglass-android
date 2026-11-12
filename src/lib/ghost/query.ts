/**
 * Query syntax parser.
 *
 * Parses boolean query syntax (AND, OR, "exact phrases", -exclusions) into
 * structured terms for client-side use (highlighting, relevance scoring).
 * The raw query string is sent as-is to engines — most onion search engines
 * handle their own syntax natively.
 *
 * Pure client-side string processing. No network impact, no persistence.
 */

export type ParsedTerm = {
  /** The term text to match (case-insensitive). */
  text: string;
  /** True if this is an exact-phrase match (quoted). */
  exact: boolean;
  /** True if this term should be excluded from results. */
  excluded: boolean;
};

export type ParsedQuery = {
  /** All positive terms (non-excluded) for highlighting and scoring. */
  terms: ParsedTerm[];
  /** Excluded terms for optional client-side filtering. */
  exclusions: ParsedTerm[];
  /** The raw query string as entered by the user. */
  raw: string;
};

/**
 * Parse a query string into structured terms.
 *
 * Supported syntax:
 * - `word` — plain term
 * - `"exact phrase"` — quoted exact phrase
 * - `-word` or `NOT word` — exclusion
 * - `AND` — ignored (implicit AND between terms)
 * - `OR` — treated as a plain term (engines handle OR natively)
 *
 * Terms shorter than 2 characters are dropped (avoids highlighting
 * single characters like "a" or "I").
 */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  const terms: ParsedTerm[] = [];
  const exclusions: ParsedTerm[] = [];

  const tokens = tokenize(trimmed);

  for (const token of tokens) {
    if (token.excluded) {
      if (token.text.length >= 2) {
        exclusions.push(token);
      }
      continue;
    }
    if (token.text.length >= 2) {
      terms.push(token);
    }
  }

  return { terms, exclusions, raw: trimmed };
}

type Token = ParsedTerm;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && input[i] === " ") i++;
    if (i >= len) break;

    let excluded = false;

    // Check for exclusion prefix
    if (input[i] === "-") {
      excluded = true;
      i++;
      while (i < len && input[i] === " ") i++;
    }

    // Check for NOT keyword
    if (
      i + 3 <= len &&
      input.slice(i, i + 3).toUpperCase() === "NOT" &&
      (i + 3 === len || input[i + 3] === " ")
    ) {
      excluded = true;
      i += 3;
      while (i < len && input[i] === " ") i++;
    }

    if (i >= len) break;

    // Quoted phrase
    if (input[i] === '"') {
      i++;
      let text = "";
      while (i < len && input[i] !== '"') {
        text += input[i];
        i++;
      }
      if (i < len) i++; // skip closing quote
      if (text.length > 0) {
        tokens.push({ text, exact: true, excluded });
      }
      continue;
    }

    // Plain word — skip AND/OR keywords
    let word = "";
    while (i < len && input[i] !== " ") {
      word += input[i];
      i++;
    }

    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "OR") {
      // Boolean operators are handled by engines, skip for client-side
      continue;
    }

    if (word.length > 0) {
      tokens.push({ text: word, exact: false, excluded });
    }
  }

  return tokens;
}

/**
 * Check if a text string contains a term (case-insensitive).
 * For exact phrases, matches the full phrase. For plain terms,
 * matches as a substring.
 */
export function matchesTerm(text: string, term: ParsedTerm): boolean {
  const lower = text.toLowerCase();
  const termLower = term.text.toLowerCase();
  return lower.includes(termLower);
}

/**
 * Get all unique term texts for highlighting (positive terms only).
 * Deduplicates case-insensitively.
 */
export function highlightTerms(parsed: ParsedQuery): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of parsed.terms) {
    const lower = term.text.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(term.text);
    }
  }
  return result;
}
