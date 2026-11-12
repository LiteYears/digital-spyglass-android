/**
 * Wallet-address enrichment — client-side, no network.
 *
 * bech32/bech32m checksum verification for BTC bc1 addresses (BIP-173/350
 * polymod, ~30 lines, no hash dependency), Monero address-shape classification
 * (primary/integrated/subaddress by network prefix + length; Monero base58
 * checksum needs keccak, so no validity claim there), and reused-wallet
 * detection built on correlation clusters.
 */

import { caseEntityKey } from "./case-file";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** Verify a full bech32/bech32m string (BIP-173 constant 1 / BIP-350 0x2bc830a3). */
function verifyBech32String(addr: string): "bech32" | "bech32m" | null {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const lower = addr.toLowerCase();
  if (lower.length < 8 || lower.length > 90) return null;
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const c of lower.slice(sep + 1)) {
    const d = BECH32_CHARSET.indexOf(c);
    if (d === -1) return null;
    data.push(d);
  }
  const values = [...bech32HrpExpand(hrp), ...data];
  const chk = bech32Polymod(values);
  if (chk === 1) return "bech32";
  if (chk === 0x2bc830a3) return "bech32m";
  return null;
}

export type BtcAddressInfo = {
  shape: "bech32-segwit" | "bech32m-taproot" | "base58-legacy";
  /** Checksum-verified for bech32/bech32m; null = not claimed for base58. */
  valid: boolean | null;
};

export function classifyBtc(addr: string): BtcAddressInfo | null {
  const lower = addr.toLowerCase();
  if (lower.startsWith("bc1") || lower.startsWith("tb1")) {
    const enc = verifyBech32String(addr);
    if (enc === "bech32" && lower.startsWith("bc1q")) {
      return { shape: "bech32-segwit", valid: true };
    }
    if (enc === "bech32m" && lower.startsWith("bc1p")) {
      return { shape: "bech32m-taproot", valid: true };
    }
    return { shape: lower.startsWith("bc1p") ? "bech32m-taproot" : "bech32-segwit", valid: false };
  }
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,33}$/.test(addr)) {
    // Bitcoin base58check would need double-SHA256 to verify — length/charset
    // classification only, no validity claim.
    return { shape: "base58-legacy", valid: null };
  }
  return null;
}

export type XmrAddressInfo = {
  shape: "primary" | "integrated" | "subaddress";
  /** Monero base58 needs keccak for the checksum — shape only, no validity claim. */
  valid: null;
};

export function classifyXmr(addr: string): XmrAddressInfo | null {
  if (!/^[48][a-km-zA-HJ-NP-Z1-9]{93,105}$/.test(addr)) return null;
  if (addr.startsWith("8")) return { shape: "subaddress", valid: null };
  if (addr.length >= 104) return { shape: "integrated", valid: null };
  return { shape: "primary", valid: null };
}

/**
 * Wallet-reuse lookup index over correlation clusters, keyed
 * `${entityType}:${entityValue}` — caseEntityKey semantics: base58 wallets
 * keep case, bech32 and non-wallet types fold (correlateEntities keys the
 * same way). O(1) badge lookups in the virtualized result list;
 * session-RAM only.
 */
export type ReuseIndex = Map<string, number>;

export function buildReuseIndex(
  clusters: Array<{
    entityType: string;
    entityValue: string;
    resultCount: number;
    walletReuse?: boolean;
  }>,
): ReuseIndex {
  const index: ReuseIndex = new Map();
  for (const cluster of clusters) {
    if (cluster.walletReuse === true) {
      index.set(`${cluster.entityType}:${cluster.entityValue}`, cluster.resultCount);
    }
  }
  return index;
}

/** Result-count for a badge's wallet address if reused across results, else undefined. */
export function lookupReuse(
  index: ReuseIndex,
  badge: { type: string; value: string },
): number | undefined {
  return index.get(caseEntityKey(badge));
}

/**
 * Compact badge text next to the entity type label: address-shape detail
 * (prefix stripped — the label already says the coin) plus a reuse marker.
 * Returns undefined when there is nothing to add.
 */
export function entityBadgeDetail(
  badge: { type: string; value: string; detail?: string },
  reuseCount?: number,
): string | undefined {
  const parts: string[] = [];
  const shape = badge.detail?.replace(/^[A-Z]{2,4} · /, "");
  if (shape) parts.push(shape);
  if (reuseCount !== undefined && reuseCount >= 2) parts.push(`reuse ${reuseCount}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Short human label for a badge, e.g. "BTC · segwit ✓" / "BTC · bad checksum". */
export function walletDetail(badge: { type: string; value: string }): string | undefined {
  if (badge.type === "btc") {
    const info = classifyBtc(badge.value);
    if (!info) return "BTC · unknown shape";
    if (info.valid === true) {
      return `BTC · ${info.shape === "bech32m-taproot" ? "taproot" : "segwit"} ✓`;
    }
    if (info.valid === false) return "BTC · bad checksum";
    return "BTC · legacy";
  }
  if (badge.type === "xmr") {
    const info = classifyXmr(badge.value);
    if (!info) return undefined;
    if (info.shape === "subaddress") return "XMR · subaddress";
    if (info.shape === "integrated") return "XMR · integrated";
    return "XMR · primary";
  }
  return undefined;
}
