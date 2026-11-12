/**
 * Passive PGP enrichment — fingerprints for public-key blocks that are
 * ALREADY visible in result snippets, plus cross-host key-reuse detection
 * ("same operator?" signal when one key surfaces on multiple hosts).
 *
 * PASSIVE ONLY (task rule): no key fetching, no WKD, no keyserver, no network.
 * openpgp.js is imported lazily so the main bundle only pays for it when a
 * result actually carries PGP armor. Everything here is session-RAM derived
 * from RAM-only rows; nothing is persisted.
 */

/** Hard cap on distinct blocks parsed per enrichment pass — snippet DoS guard. */
export const MAX_PGP_BLOCKS_PER_PASS = 20;

export type PgpEnrichment = {
  /** Lowercase hex fingerprint of the primary key (40 chars v4 / 64 v6). Empty when unparsable. */
  fingerprint: string;
  /** Last 16 fingerprint hex chars, uppercase — the short key id shown on badges. */
  keyIdShort: string;
  /** Distinct result hosts this exact key (by fingerprint) appeared on. */
  hosts: string[];
  /** True when the key surfaced on 2+ hosts — operator-linking signal. */
  crossHost: boolean;
  /** Parse failure reason for malformed armor (honest display, no throw). */
  error?: string;
}

export function normalizePgpBlock(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Parse an armored public key block to its fingerprint; null when unparsable. */
export async function pgpKeyFingerprint(armored: string): Promise<string | null> {
  try {
    const openpgp = await import("openpgp");
    const key = await openpgp.readKey({ armoredKey: armored });
    return key.getFingerprint().toLowerCase();
  } catch {
    return null;
  }
}

export type PgpSourceRow = {
  url: string;
  entities?: Array<{ type: string; value: string }> | undefined;
};

/**
 * Build the session PGP index: normalized block → enrichment. Blocks with the
 * same fingerprint (differing armor headers/whitespace) share one entry, so
 * hosts merge across formatting variants. At most MAX_PGP_BLOCKS_PER_PASS
 * distinct blocks are processed per pass; the rest are left unenriched.
 */
export async function enrichPgpEntities(rows: PgpSourceRow[]): Promise<Map<string, PgpEnrichment>> {
  const byBlock = new Map<string, PgpEnrichment>();
  const byFingerprint = new Map<string, PgpEnrichment>();
  let processedBlocks = 0;

  for (const row of rows) {
    for (const entity of row.entities ?? []) {
      if (entity.type !== "pgp") continue;
      const blockKey = normalizePgpBlock(entity.value);
      if (byBlock.has(blockKey)) {
        const existing = byBlock.get(blockKey)!;
        const host = hostOf(row.url);
        if (host && !existing.hosts.includes(host)) {
          existing.hosts.push(host);
          if (existing.hosts.length >= 2) existing.crossHost = true;
        }
        continue;
      }
      if (processedBlocks >= MAX_PGP_BLOCKS_PER_PASS) continue;
      processedBlocks += 1;

      const fingerprint = await pgpKeyFingerprint(blockKey);
      let entry: PgpEnrichment;
      if (fingerprint === null) {
        entry = {
          fingerprint: "",
          keyIdShort: "unparsed",
          hosts: [],
          crossHost: false,
          error: "unparsable key block",
        };
      } else {
        entry =
          byFingerprint.get(fingerprint) ?? {
            fingerprint,
            keyIdShort: fingerprint.slice(-16).toUpperCase(),
            hosts: [],
            crossHost: false,
          };
        byFingerprint.set(fingerprint, entry);
      }
      const host = hostOf(row.url);
      if (host && !entry.hosts.includes(host)) entry.hosts.push(host);
      if (entry.hosts.length >= 2) entry.crossHost = true;
      byBlock.set(blockKey, entry);
    }
  }
  return byBlock;
}

/** Display form of a fingerprint: uppercase hex grouped in fours. */
export function formatFingerprint(fingerprint: string): string {
  if (fingerprint.length === 0) return "—";
  return fingerprint.toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}
