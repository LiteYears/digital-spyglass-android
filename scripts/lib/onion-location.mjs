/**
 * Onion-Location extraction (report-only discovery helper for
 * scripts/engine-healthcheck.mjs).
 *
 * Tor's Onion-Location convention: a site announces a relocation via an
 * `onion-location` HTTP response header or a
 * `<meta http-equiv="onion-location" content="…">` tag. When an engine
 * rotates its address, the old address often keeps serving a page carrying
 * the new one — this lets the weekly healthcheck propose a candidate that
 * the operator promotes into engines.json via MR (pipeline reports, the
 * operator decides; nothing is written automatically).
 */

const V3_HOST_RE = /^[a-z2-7]{56}\.onion$/;

export function isV3OnionUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" && V3_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

/**
 * Extract a relocation candidate. Header wins over meta tag; candidates must
 * be valid http v3 .onion URLs and differ from the engine's current host
 * (self-announcement is not a relocation).
 */
export function extractOnionLocation({ headers, body, baseUrl }) {
  const baseHost = baseUrl ? hostOf(baseUrl) : null;
  const get = (name) => {
    if (!headers) return undefined;
    if (typeof headers.get === "function") return headers.get(name);
    const target = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === target) return v;
    }
    return undefined;
  };
  const fromHeader = typeof get("onion-location") === "string" ? get("onion-location").trim() : "";
  if (fromHeader && isV3OnionUrl(fromHeader) && hostOf(fromHeader) !== baseHost) {
    return { url: fromHeader, source: "header" };
  }
  const meta =
    body?.match(
      /<meta[^>]+http-equiv=["']?onion-location["']?[^>]+content=["']([^"']+)["']/i,
    )?.[1] ??
    body?.match(/<meta[^>]+content=["']([^"']+)["'][^>]+http-equiv=["']?onion-location["']?/i)?.[1];
  if (meta && isV3OnionUrl(meta) && hostOf(meta) !== baseHost) {
    return { url: meta, source: "meta" };
  }
  return null;
}
