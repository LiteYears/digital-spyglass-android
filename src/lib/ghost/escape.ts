/**
 * HTML escaping utility.
 *
 * Escapes untrusted text before inserting into innerHTML.
 * Used by highlight.ts to prevent XSS from .onion snippet content.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
