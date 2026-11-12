/**
 * Transient Tor-only HTTP transport.
 *
 * All network requests in Ghost are restricted to v3 `.onion` endpoints and
 * routed through `PianoTorHttp` (SOCKS5 via Orbot localhost:9050 with remote
 * `ATYP=DOMAINNAME` DNS resolution). Any non-`.onion` URL is rejected before
 * a network call is attempted — there is no clearnet HTTP fallback.
 *
 * No response body is ever stored. The string is parsed and dropped.
 */
import { isNative, torFetch } from "../platform/bridge";

/**
 * Single fixed User-Agent matching Tor Browser on Android (Firefox ESR 140).
 *
 * Tor Browser's core anti-fingerprinting principle: all Tor users should have
 * the same fingerprint. Rotating between multiple UAs is itself a fingerprint
 * — a site that sees Windows UA on one request and Linux UA on the next from
 * the same exit knows it is the same client with a rotator, which is MORE
 * identifying than either UA alone.
 *
 * Ghost runs on Android, so the honest, least-identifying choice is the UA
 * that a real Tor Browser user on Android would send. No rotation, no
 * spoofing a different OS. Tor Browser spoofs every Android device as
 * "Android 10" and tracks Firefox ESR — keep this constant in lockstep with
 * the Tor Browser stable channel (Firefox ESR 140 as of TB 15.0.x) and bump
 * it on the release train whenever ESR moves.
 */
const TOR_BROWSER_ANDROID_UA =
  "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";

export const CONNECT_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 12_000;
/** JS-side hard timeout — safety net in case native timeout doesn't fire.
 *  Must exceed the Java plugin's connect (20s) + read (40s) = 60s window so
 *  slow Tor engines get the full native socket timeout before JS aborts. */
export const HARD_TIMEOUT_MS = 65_000;

export type FetchTextResult = { status: number; body: string; ms: number };

/**
 * SOCKS5 credentials for per-search Tor circuit isolation.
 * When provided, Tor's IsolateSOCKSAuth (on by default since tor 0.3.5)
 * gives each unique credential pair a separate, unlinkable circuit.
 * A fresh base credential is generated once per search (random UUID);
 * each engine fetch then appends a per-engine suffix
 * (`<uuid>-<engineId>` in search.ts) so every engine gets its own
 * credential pair — and therefore its own circuit — while repeated
 * fetches to the SAME engine within one search (prefetch, POST, retry)
 * share credentials, which the OSS captcha flow relies on.
 * Isolation requires stock tor/Orbot defaults; a user torrc with
 * NoIsolateSOCKSAuth degrades it and is undetectable from the client.
 */
export type SocksAuth = {
  user: string;
  pass: string;
  host?: string | undefined;
  port?: number | undefined;
};

export function withHardTimeout<T>(
  promise: Promise<T>,
  url: string,
  timeoutMs = HARD_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout after ${timeoutMs / 1000}s: ${url.slice(0, 80)}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function isOnionUrl(url: string): boolean {
  try {
    // Case-fold + strip trailing dot, mirroring parse.ts isOnion — an
    // uppercase ".ONION" host must not badge onion then fail the fetch gate.
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host.endsWith(".onion");
  } catch {
    return /\.onion\.?(?:[/:?#]|$)/i.test(url);
  }
}

/** Fetch only the body string — used for homepage prefetch (anti-bot token extraction). */
export async function fetchBodyOnly(url: string, socksAuth?: SocksAuth): Promise<string> {
  const result = await fetchText(url, undefined, socksAuth);
  return result.body;
}

/** POST to an onion URL via Tor and return the body string.
 *  Used by OSS captcha-solving flow: GET captcha page → POST answer → GET search.
 *  Cookies are handled by the Java plugin's per-host cookie jar. */
export async function fetchPostBody(
  url: string,
  body: string,
  socksAuth?: SocksAuth,
): Promise<string> {
  const ua = TOR_BROWSER_ANDROID_UA;
  const native = await isNative();
  const onion = isOnionUrl(url);
  if (!onion) {
    throw new Error("Blocked non-.onion URL in Tor-only mode");
  }

  if (native) {
    const result = await withHardTimeout(
      torFetch(url, ua, { method: "POST", body, socksAuth }),
      url,
    );
    if (result.status === 0 || (result.status >= 400 && result.status < 600)) {
      throw new Error(`HTTP ${result.status} from ${url.slice(0, 60)}`);
    }
    return result.body;
  }

  // Web preview fallback — won't work for .onion but keeps the build valid
  throw new Error("POST via Tor not available in web preview");
}

export async function fetchText(
  url: string,
  signal?: AbortSignal,
  socksAuth?: SocksAuth,
): Promise<FetchTextResult> {
  const startedAt = Date.now();
  const ua = TOR_BROWSER_ANDROID_UA;
  const native = await isNative();
  const onion = isOnionUrl(url);

  if (!onion) {
    throw new Error("Blocked non-.onion URL in Tor-only mode");
  }

  if (native) {
    // .onion → Tor SOCKS5 with remote DNS (bypasses Pi-hole/Google/Cloudflare)
    const result = await withHardTimeout(torFetch(url, ua, { socksAuth }), url);
    if (result.status === 0 || (result.status >= 400 && result.status < 600)) {
      throw new Error(`HTTP ${result.status} from ${url.slice(0, 60)}`);
    }
    // 2xx and 3xx (redirects already followed by the plugin) are OK
    return { status: result.status, body: result.body, ms: Date.now() - startedAt };
  }

  // Web preview fallback — fetch() (onion won't work here, expected)
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "User-Agent": ua,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await withHardTimeout(
      fetch(url, { headers, signal: controller.signal, cache: "no-store" }),
      url,
    );
    return {
      status: response.status,
      body: await response.text(),
      ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify Tor connectivity by fetching a known .onion endpoint through the
 * Tor plugin. This proves end-to-end Tor connectivity without any clearnet
 * traffic — the request never leaves the Tor network.
 *
 * Uses Ahmia's onion homepage as the probe target. Ahmia is one of the most
 * stable onion services and is already an engine we query, so the traffic
 * is indistinguishable from normal search prefetch.
 *
 * Returns true if the .onion endpoint responded with a 2xx/3xx status.
 * Result is cached for the session — re-verify after VPN state changes.
 */
const AHMIA_PROBE_URL = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/";
const TORCH_PROBE_URL = "http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion/";

let torVerifiedCache: { ok: boolean; ts: number } | null = null;
const TOR_VERIFY_CACHE_MS = 60_000;

export async function verifyTor(
  force = false,
  torSocks?: { host?: string | undefined; port?: number | undefined },
): Promise<boolean> {
  if (!force && torVerifiedCache && Date.now() - torVerifiedCache.ts < TOR_VERIFY_CACHE_MS) {
    return torVerifiedCache.ok;
  }
  try {
    const nonce = Date.now().toString(36);
    const makeAuth = (tag: string): SocksAuth => ({
      user: "ghost",
      pass: `probe-${tag}-${nonce}`,
      host: torSocks?.host,
      port: torSocks?.port,
    });
    const result = await Promise.any([
      fetchText(AHMIA_PROBE_URL, undefined, makeAuth("ahmia")),
      fetchText(TORCH_PROBE_URL, undefined, makeAuth("torch")),
    ]);
    const ok = result.status >= 200 && result.status < 400;
    torVerifiedCache = { ok, ts: Date.now() };
    return ok;
  } catch {
    torVerifiedCache = { ok: false, ts: Date.now() };
    return false;
  }
}

/** Invalidate the Tor verification cache — call after VPN state changes. */
export function invalidateTorVerification(): void {
  torVerifiedCache = null;
}
