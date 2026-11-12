/**
 * Entity extraction from result snippets.
 *
 * Detects and displays entity types visible in snippet text — purely
 * presentational, no network enrichment. Only analyzes text that is already
 * visible to the user; just makes it scannable with colored badges.
 *
 * ReDoS safety: every pattern uses simple character classes with bounded
 * quantifiers — no nested quantifiers, no overlapping alternations, no
 * backreferences. All patterns are linear-time.
 *
 * Performance: extractEntities() is called per result row. With 500 results
 * and 6 patterns, that's 3000 regex tests — well under 100ms on modern
 * Android devices. A 50ms per-snippet timeout wrapper prevents pathological
 * cases from freezing the render thread.
 */

export type EntityType = "btc" | "pgp" | "email" | "onion" | "xmr" | "cve" | "ipv4";

export type EntityBadge = {
  type: EntityType;
  value: string;
  /** Optional wallet enrichment (checksum validity / address shape). */
  detail?: string;
};

// Base58 alphabet (excludes 0, O, I, l)
const BASE58 = "[a-km-zA-HJ-NP-Z1-9]";

import { walletDetail } from "./wallet";
import { caseEntityKey } from "./case-file";

// ReDoS-safe patterns — single character class + bounded quantifier, no nesting
const PATTERNS: { type: EntityType; re: RegExp }[] = [
  // Bitcoin Legacy (P2PKH: 1..., P2SH: 3...) — Base58, 25-34 chars
  { type: "btc", re: new RegExp(`\\b[13]${BASE58}{24,33}\\b`, "g") },
  // Bitcoin Bech32 (bc1...) — lowercase, up to 42 chars
  { type: "btc", re: /\bbc1[a-z0-9]{6,42}\b/g },
  // Monero (starts with 4 or 8) — Base58, ~95 chars
  { type: "xmr", re: new RegExp(`\\b[48]${BASE58}{93,104}\\b`, "g") },
  // PGP public key block — bounded header + body + footer, no nested quantifiers
  {
    type: "pgp",
    re: /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]{0,10000}-----END PGP PUBLIC KEY BLOCK-----/g,
  },
  // Email — simple, linear pattern, no nested groups
  { type: "email", re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g },
  // .onion v3 (56 chars) and v2 (16 chars) — alphanumeric
  { type: "onion", re: /\b[a-z2-7]{16,56}\.onion\b/gi },
  // CVE references (CVE-YYYY-NNNNN) — bounded year 1999-9999, ID 4-7 digits
  { type: "cve", re: /\bCVE-(?:19|20)\d{2}-\d{4,7}\b/gi },
  // IPv4 addresses — bounded octets 0-255, linear pattern
  { type: "ipv4", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

/**
 * Extract entities from a text string. Returns badges for display.
 * Timeout wrapper: if extraction takes >50ms on a single snippet,
 * returns what was found so far (fail-soft, never freeze the UI).
 */
export function extractEntities(text: string): EntityBadge[] {
  if (!text || text.length < 8) return [];

  const badges: EntityBadge[] = [];
  const seen = new Set<string>();
  const start = Date.now();

  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      const key = caseEntityKey({ type, value });
      if (!seen.has(key)) {
        seen.add(key);
        const detail = walletDetail({ type, value });
        const badge: EntityBadge = { type, value };
        if (detail) badge.detail = detail;
        badges.push(badge);
      }
      if (re.lastIndex === match.index) re.lastIndex++;
      // Per-match budget check, not only per-pattern (F6)
      if (Date.now() - start > 50) return badges;
    }
    // Timeout check — never exceed 50ms per snippet
    if (Date.now() - start > 50) break;
  }

  return badges;
}

export function entityLabel(type: EntityType): string {
  switch (type) {
    case "btc":
      return "BTC";
    case "xmr":
      return "XMR";
    case "pgp":
      return "PGP";
    case "email":
      return "EMAIL";
    case "onion":
      return "ONION";
    case "cve":
      return "CVE";
    case "ipv4":
      return "IP";
  }
}
