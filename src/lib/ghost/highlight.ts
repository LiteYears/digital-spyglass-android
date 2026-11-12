/**
 * Query term highlighting.
 *
 * Wraps matched query terms in <mark> tags for visual highlighting in
 * result titles and snippets. Pure presentational — no network impact,
 * no persistence.
 *
 * Uses dangerouslySetInnerHTML in the consumer. Input is escaped before
 * highlighting to prevent XSS from untrusted snippet text.
 */
import { escapeHtml } from "./escape";
import { type ParsedQuery, highlightTerms } from "./query";

/**
 * Highlight query terms in a text string.
 *
 * Returns HTML-safe string with <mark> tags around matched terms.
 * The input text is HTML-escaped first, then terms are wrapped.
 *
 * Terms are matched case-insensitively. Longer terms are matched first
 * to avoid partial overlaps (e.g. "security" before "sec").
 */
export function highlightText(text: string, parsed: ParsedQuery): string {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const terms = highlightTerms(parsed);
  if (terms.length === 0) return escaped;

  // Sort by length descending — match longer terms first
  const sorted = [...terms].sort((a, b) => b.length - a.length);

  // Build a single regex that matches any term (case-insensitive)
  // Escape regex special characters in terms
  const escapedPatterns = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escapedPatterns.join("|")})`, "gi");

  return escaped.replace(
    pattern,
    '<mark class="bg-amber/20 text-foreground rounded px-0.5">$1</mark>',
  );
}
