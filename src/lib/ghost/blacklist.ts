/**
 * Ahmia abuse blacklist filter — opt-in safety filter.
 *
 * Ahmia publishes its public abuse blocklist at `/blacklist/banned/` as a
 * newline-delimited list of 32-character hex MD5 hashes of `.onion` hostnames
 * (e.g. `md5("example.onion")`). For testability and backward compatibility,
 * `parseBlacklist` accepts both 32-char hex MD5 hashes and plaintext `.onion`
 * domains, and `isBlacklisted` checks both direct hostname/subdomain matches
 * and `md5Hex(hostname)`.
 *
 * IMPORTANT: This filter is OFF by default. When enabled, results are MARKED,
 * never removed — consistent with the "maximale Offenheit" principle.
 *
 * A snapshot of the list is bundled (`ahmia-blacklist.snapshot.ts`) and seeds
 * the cache on first use, so the filter works even before — or without — a
 * successful Tor fetch. The runtime fetch overwrites it with fresh data.
 */
import { AHMIA_SNAPSHOT } from "./ahmia-blacklist.snapshot";

const AHMIA_BLACKLIST_URL =
  "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/blacklist/banned/";

const MD5_HEX_RE = /^[a-f0-9]{32}$/;

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, bitLen >>> 0, true);
  view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padLen; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i]! + view.getUint32(offset + g * 4, true)) >>> 0;
      const s = MD5_S[i]!;
      const rotated = ((sum << s) | (sum >>> (32 - s))) >>> 0;
      b = (b + rotated) >>> 0;
      a = temp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

type BlacklistCache = {
  domains: Set<string>;
  fetchedAt: number;
};

let cache: BlacklistCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;
const md5Memo = new Map<string, string>();

function memoizedMd5Hex(host: string): string {
  let digest = md5Memo.get(host);
  if (!digest) {
    digest = md5Hex(host);
    if (md5Memo.size > 4096) md5Memo.clear();
    md5Memo.set(host, digest);
  }
  return digest;
}

export type BlacklistFetchFn = (url: string) => Promise<string>;

function ensureSeeded(): void {
  if (!cache) {
    cache = { domains: parseBlacklist(AHMIA_SNAPSHOT), fetchedAt: 0 };
  }
}

export async function loadAhmiaBlacklist(
  fetchFn: BlacklistFetchFn,
  force = false,
): Promise<{ loaded: boolean; count: number }> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { loaded: true, count: cache.domains.size };
  }

  // Offline baseline: a bundled snapshot keeps the filter non-empty when Tor
  // is unreachable. fetchedAt=0 marks it stale so the next fetch still runs.
  ensureSeeded();

  try {
    const body = await fetchFn(AHMIA_BLACKLIST_URL);
    const domains = parseBlacklist(body);
    if (domains.size === 0) {
      // A 200 with an empty/captcha body must not wipe the live set or the
      // bundled snapshot — treat as a failed fetch, keep the baseline.
      return { loaded: false, count: cache?.domains.size ?? 0 };
    }
    cache = { domains, fetchedAt: Date.now() };
    return { loaded: true, count: domains.size };
  } catch {
    if (force) {
      cache = null;
    }
    return { loaded: false, count: cache?.domains.size ?? 0 };
  }
}

export function parseBlacklist(body: string): Set<string> {
  const domains = new Set<string>();
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (trimmed.endsWith(".onion") || MD5_HEX_RE.test(trimmed)) {
      domains.add(trimmed);
    }
  }
  return domains;
}

export function isBlacklisted(url: string): boolean {
  ensureSeeded();
  if (!cache) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    if (cache.domains.has(hostname)) return true;
    if (cache.domains.has(memoizedMd5Hex(hostname))) return true;
    if (hostname.endsWith(".onion")) {
      const parts = hostname.split(".");
      for (let i = 1; i <= parts.length - 2; i++) {
        const parentDomain = parts.slice(i).join(".");
        if (cache.domains.has(parentDomain) || cache.domains.has(memoizedMd5Hex(parentDomain))) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function blacklistCount(): number {
  ensureSeeded();
  return cache?.domains.size ?? 0;
}

export function clearBlacklistCache(): void {
  cache = null;
  md5Memo.clear();
}
