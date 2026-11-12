/**
 * Ghost v4.0 — RAM-Only Onion Mirror & Phishing Authenticity Guard.
 *
 * Implements three zero-network, in-memory verification primitives:
 *  1. Tor Rendezvous Specification v3 (§6) cryptographic address verification:
 *     decodes the 56-character base32 .onion hostname into
 *     PUBKEY (32 B) || CHECKSUM (2 B) || VERSION (1 B = 0x03) and verifies
 *     SHA3-256(".onion checksum" || PUBKEY || VERSION)[:2] === CHECKSUM.
 *  2. Vanity-prefix typosquatting / lookalike clone detection against
 *     known canonical .onion endpoints.
 *  3. 64-bit Charikar SimHash content fingerprinting in RAM to cluster
 *     cloned mirror pages across distinct .onion domains.
 */
import enginesData from "./engines.json";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const V3_ONION_LABEL_RE = /^[a-z2-7]{56}$/;

const KECCAK_RC: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const KECCAK_ROT: readonly number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const MASK_64 = 0xffffffffffffffffn;

function rotl64(x: bigint, n: number): bigint {
  if (n === 0) return x & MASK_64;
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK_64;
}

function keccakF1600(state: BigUint64Array): void {
  const b = new BigUint64Array(25);
  const c = new BigUint64Array(5);
  const d = new BigUint64Array(5);

  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] = (state[i]! ^ d[i % 5]!) & MASK_64;
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const srcIdx = x + 5 * y;
        const dstIdx = y + 5 * ((2 * x + 3 * y) % 5);
        b[dstIdx] = rotl64(state[srcIdx]!, KECCAK_ROT[srcIdx]!);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[y + x] = (b[y + x]! ^ (~b[y + ((x + 1) % 5)]! & b[y + ((x + 2) % 5)]!)) & MASK_64;
      }
    }
    state[0] = (state[0]! ^ KECCAK_RC[round]!) & MASK_64;
  }
}

/**
 * Pure-TypeScript FIPS 202 SHA3-256 implementation (rate = 136 bytes, domain = 0x06).
 */
export function sha3_256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const state = new BigUint64Array(25);
  const block = new Uint8Array(rate);

  let offset = 0;
  while (offset + rate <= input.length) {
    const view = new DataView(input.buffer, input.byteOffset + offset, rate);
    for (let i = 0; i < 17; i++) {
      state[i] = (state[i]! ^ view.getBigUint64(i * 8, true)) & MASK_64;
    }
    keccakF1600(state);
    offset += rate;
  }

  const remaining = input.length - offset;
  block.fill(0);
  block.set(input.subarray(offset), 0);
  block[remaining] = 0x06;
  block[rate - 1] = block[rate - 1]! | 0x80;

  const blockView = new DataView(block.buffer);
  for (let i = 0; i < 17; i++) {
    state[i] = (state[i]! ^ blockView.getBigUint64(i * 8, true)) & MASK_64;
  }
  keccakF1600(state);

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    outView.setBigUint64(i * 8, state[i]!, true);
  }
  return out;
}

export function decodeBase32(input: string): Uint8Array | null {
  const clean = input.trim().toLowerCase();
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let idx = 0;

  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_ALPHABET.indexOf(clean[i]!);
    if (val < 0) return null;
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

export type OnionVerificationResult = {
  valid: boolean;
  label: string | null;
  version: number | null;
  reason?: string;
};

/**
 * Extract the 56-char base32 root label of a v3 .onion hostname or URL.
 */
export function extractV3OnionLabel(hostOrUrl: string): string | null {
  let host = hostOrUrl.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  if (!host.endsWith(".onion")) return null;
  const withoutTld = host.slice(0, -".onion".length);
  const parts = withoutTld.split(".");
  const rootLabel = parts[parts.length - 1] ?? "";
  return V3_ONION_LABEL_RE.test(rootLabel) ? rootLabel : null;
}

/**
 * Cryptographically verifies a Tor v3 .onion address per rend-spec-v3 §6:
 *   onion_address = base32(PUBKEY || CHECKSUM || VERSION) + ".onion"
 *   CHECKSUM = SHA3-256(".onion checksum" || PUBKEY || VERSION)[:2]
 *   VERSION = 0x03
 */
export function verifyV3OnionAddress(hostOrUrl: string): OnionVerificationResult {
  const label = extractV3OnionLabel(hostOrUrl);
  if (!label) {
    return { valid: false, label: null, version: null, reason: "not_56_char_v3_label" };
  }
  const decoded = decodeBase32(label);
  if (!decoded || decoded.length !== 35) {
    return { valid: false, label, version: null, reason: "base32_decode_failed" };
  }

  const pubkey = decoded.subarray(0, 32);
  const checksum0 = decoded[32]!;
  const checksum1 = decoded[33]!;
  const version = decoded[34]!;

  if (version !== 0x03) {
    return { valid: false, label, version, reason: "invalid_version_byte" };
  }

  const prefix = new TextEncoder().encode(".onion checksum");
  const payload = new Uint8Array(prefix.length + 32 + 1);
  payload.set(prefix, 0);
  payload.set(pubkey, prefix.length);
  payload[prefix.length + 32] = version;

  const digest = sha3_256(payload);
  if (digest[0] !== checksum0 || digest[1] !== checksum1) {
    return { valid: false, label, version, reason: "checksum_mismatch" };
  }

  return { valid: true, label, version };
}

/**
 * Canonical v3 .onion labels of Ghost's known search engines — derived from
 * the signed engine registry (engines.json `baseUrl`), so the spoof-detection
 * trust anchor is covered by the registry signature instead of being a
 * separate, unverified code constant.
 */
function deriveCanonicalRegistry(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (enginesData as { engines: { id: string; baseUrl: string }[] }).engines) {
    const host = new URL(e.baseUrl).hostname.toLowerCase();
    out[e.id] = host.endsWith(".onion") ? host.slice(0, -".onion".length) : host;
  }
  return Object.freeze(out);
}

export const CANONICAL_ONION_REGISTRY: Readonly<Record<string, string>> = deriveCanonicalRegistry();

export type SpoofCheckResult = {
  status: "CANONICAL" | "UNVERIFIED_VALID" | "SUSPECTED_VANITY_CLONE" | "INVALID_ONION";
  canonicalId?: string;
  spoofedCanonicalId?: string;
  sharedPrefixLen?: number;
};

function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

/**
 * Checks whether a .onion URL/host is canonical, a valid unknown service,
 * a suspected vanity-prefix clone of a canonical service (>= 5 matching
 * leading characters with a different 56-char key), or cryptographically invalid.
 */
export function detectOnionSpoof(
  hostOrUrl: string,
  registry: Readonly<Record<string, string>> = CANONICAL_ONION_REGISTRY,
): SpoofCheckResult {
  const verified = verifyV3OnionAddress(hostOrUrl);
  if (!verified.valid || !verified.label) {
    return { status: "INVALID_ONION" };
  }

  for (const [id, canonLabel] of Object.entries(registry)) {
    if (verified.label === canonLabel) {
      return { status: "CANONICAL", canonicalId: id };
    }
  }

  for (const [id, canonLabel] of Object.entries(registry)) {
    const prefixLen = commonPrefixLength(verified.label, canonLabel);
    const suffixLen = commonPrefixLength(
      [...verified.label].reverse().join(""),
      [...canonLabel].reverse().join(""),
    );
    if (prefixLen >= 5 || (prefixLen >= 4 && suffixLen >= 4)) {
      return {
        status: "SUSPECTED_VANITY_CLONE",
        spoofedCanonicalId: id,
        sharedPrefixLen: prefixLen,
      };
    }
  }

  return { status: "UNVERIFIED_VALID" };
}

/**
 * Computes a 64-bit Charikar SimHash over 3-character shingles of normalized
 * text for RAM-only mirror/clone page clustering.
 */
export function computeSimHash64(text: string): bigint {
  const norm = text
    .toLowerCase()
    .replace(/https?:\/\/[^\s]+/g, " ")
    .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff]+/g, " ")
    .trim();

  if (!norm) return 0n;

  const weights = new Int32Array(64);
  const padded = norm.length < 3 ? norm.padEnd(3, "_") : norm;

  for (let i = 0; i <= padded.length - 3; i++) {
    const shingle = padded.slice(i, i + 3);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let c = 0; c < shingle.length; c++) {
      const code = shingle.charCodeAt(c);
      h1 ^= code;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= code + c * 31;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    for (let bit = 0; bit < 32; bit++) {
      weights[bit]! += (h1 >>> bit) & 1 ? 1 : -1;
      weights[bit + 32]! += (h2 >>> bit) & 1 ? 1 : -1;
    }
  }

  let simhash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit]! > 0) {
      simhash |= 1n << BigInt(bit);
    }
  }
  return simhash;
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK_64;
  let count = 0;
  while (x > 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

export type MirrorClusterItem = {
  url: string;
  title: string;
  snippet: string;
};

export type MirrorCluster = {
  representativeUrl: string;
  mirrorUrls: string[];
  simhashHex: string;
};

/**
 * Groups near-duplicate result items installed across distinct .onion domains
 * when their 64-bit SimHash Hamming distance is <= maxHammingDistance.
 */
export function clusterMirrorResults(
  items: readonly MirrorClusterItem[],
  maxHammingDistance = 6,
): MirrorCluster[] {
  const entries = items.map((item) => ({
    item,
    hash: computeSimHash64(`${item.title} ${item.snippet}`),
    assigned: false,
  }));

  const clusters: MirrorCluster[] = [];
  for (let i = 0; i < entries.length; i++) {
    const base = entries[i]!;
    if (base.assigned) continue;
    base.assigned = true;
    const mirrors: string[] = [base.item.url];

    for (let j = i + 1; j < entries.length; j++) {
      const cand = entries[j]!;
      if (cand.assigned) continue;
      if (hammingDistance64(base.hash, cand.hash) <= maxHammingDistance) {
        cand.assigned = true;
        if (!mirrors.includes(cand.item.url)) {
          mirrors.push(cand.item.url);
        }
      }
    }

    clusters.push({
      representativeUrl: base.item.url,
      mirrorUrls: mirrors,
      simhashHex: base.hash.toString(16).padStart(16, "0"),
    });
  }

  return clusters;
}
