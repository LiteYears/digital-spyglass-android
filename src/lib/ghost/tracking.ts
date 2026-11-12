/**
 * Tracking-parameter stripping for outgoing links.
 *
 * Result URLs can carry session-unique tokens an engine (or the destination)
 * uses to correlate Ghost's anonymous fetch with the later visit in Tor
 * Browser — two otherwise unlinkable clients. Removing well-known tracking
 * parameters breaks the cheapest form of that correlation. Pure string/URL
 * work, no network, no persistence.
 */

/** Exact-name tracking parameters (click/ad identifiers). */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "twclid",
  "igshid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "igsh",
  "snr",
  "vero_id",
  "wickedid",
  "oly_anon_id",
  "oly_enc_id",
]);

/** Session-identifier parameter names worth stripping before opening. */
const SESSION_PARAMS = new Set([
  "sid",
  "session_id",
  "sessionid",
  "phpsessid",
  "jsessionid",
  "scid",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower) || SESSION_PARAMS.has(lower)) return true;
  return lower.startsWith("utm_");
}

export type StripResult = {
  /** The cleaned URL (identical to the input if nothing matched). */
  url: string;
  /** Parameter names that were removed, in order of appearance. */
  stripped: string[];
};

/**
 * Remove tracking parameters from a URL's query string. The path, host,
 * port, and fragment are preserved; if every parameter is removed the
 * trailing "?" is dropped. Anything that fails URL parsing is returned
 * untouched (fail-open for the link, fail-closed for stripping).
 */
export function stripTrackingParams(input: string): StripResult {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { url: input, stripped: [] };
  }
  if (!parsed.search) return { url: input, stripped: [] };

  const stripped: string[] = [];
  const kept = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    if (isTrackingParam(name)) {
      stripped.push(name);
    } else {
      kept.append(name, value);
    }
  }
  if (stripped.length === 0) return { url: input, stripped: [] };

  parsed.search = kept.toString();
  return { url: parsed.toString(), stripped };
}
