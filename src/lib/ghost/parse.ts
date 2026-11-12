/**
 * HTML → results, without ever rendering anything.
 *
 * DOMParser builds a detached document: no scripts run, no resources load, no
 * images are fetched. If a parser cannot make sense of the markup (engines
 * change layouts constantly) it falls back to a link regex.
 */

const ONION_RE = /https?:\/\/[a-z2-7]{16,56}\.onion(?:[^\s"'<>]*)?/gi;
const NON_CONTENT_RE =
  /\.(?:css|js|mjs|png|jpe?g|gif|ico|svg|woff2?|ttf|eot|webp|bmp|avif|webmanifest|xml|rss|atom)(?:[?#]|$)/i;

export function isContentUrl(href: string, base?: string): boolean {
  if (NON_CONTENT_RE.test(href)) return false;
  if (base) {
    try {
      const url = new URL(href);
      const baseUrl = new URL(base);
      if (url.hostname === baseUrl.hostname) return false;
    } catch {
      /* ignore */
    }
  }
  return true;
}
/** Captcha detection — requires structural signals (form/class/id with
 *  captcha/challenge keywords), not just the word "captcha" in body text.
 *  Avoids false positives on engines that mention "captcha" in nav/footer. */
const CAPTCHA_RE =
  /(?:<form[^>]*(?:captcha|challenge|verify)[^>]*>)|(?:class=["'][^"']*(?:captcha|challenge-form)[^"']*["'])|(?:id=["'][^"']*(?:captcha|challenge-form)[^"']*["'])|(?:are you human)|(?:verify you are)|(?:ddos-guard)/i;

export function looksLikeCaptcha(html: string): boolean {
  return CAPTCHA_RE.test(html.slice(0, 6000));
}

export function parseDocument(html: string): Document | null {
  if (typeof DOMParser !== "undefined") {
    try {
      return new DOMParser().parseFromString(html, "text/html");
    } catch {
      return null;
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseHTML } = require("linkedom");
    const { document } = parseHTML(html);
    return document as unknown as Document;
  } catch {
    return null;
  }
}

export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Some engines wrap targets in a redirect: /redirect?url=…, ?u=…, ?redir=… */
export function unwrapRedirect(href: string, base?: string): string {
  let candidate = href;
  try {
    const url = new URL(href, base ?? "http://engine.invalid");
    for (const key of ["redirect_url", "url", "u", "redir", "redirect", "target", "q"]) {
      const value = url.searchParams.get(key);
      if (value && /^https?:\/\//i.test(value)) {
        candidate = value;
        break;
      }
    }
  } catch {
    /* keep as-is */
  }
  return candidate.trim();
}

export function isOnion(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return hostname.endsWith(".onion");
  } catch {
    return /\.onion\.?(?:[/:?#]|$)/i.test(url);
  }
}

export type SelectorSpec = {
  /** Result container selectors, tried in order. */
  blocks: string[];
  /** Anchor selector inside a block; defaults to the first http(s) anchor. */
  link?: string;
  /** Snippet selector inside a block; defaults to the block text. */
  snippet?: string;
  base?: string;
};

export function parseBySelectors(
  html: string,
  spec: SelectorSpec,
): Omit<import("./types").RawResult, "engineId">[] {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, spec.base);

  let blocks: Element[] = [];
  for (const selector of spec.blocks) {
    blocks = Array.from(doc.querySelectorAll(selector));
    if (blocks.length > 0) break;
  }
  if (blocks.length === 0) return parseByRegex(html, spec.base);

  const results: Omit<import("./types").RawResult, "engineId">[] = [];
  for (const block of blocks) {
    const anchor =
      (spec.link ? block.querySelector(spec.link) : null) ??
      Array.from(block.querySelectorAll("a[href]")).find(
        (node) =>
          /^https?:\/\//i.test(node.getAttribute("href") ?? "") ||
          /\.onion/i.test(node.getAttribute("href") ?? ""),
      ) ??
      block.querySelector("a[href]");
    if (!anchor) continue;

    const href = unwrapRedirect(anchor.getAttribute("href") ?? "", spec.base);
    if (!/^https?:\/\//i.test(href)) continue;
    if (!isContentUrl(href, spec.base)) continue;

    const snippetNode = spec.snippet ? block.querySelector(spec.snippet) : null;
    const title = cleanText(anchor.textContent) || href;
    const snippet = cleanText(snippetNode?.textContent ?? block.textContent).slice(0, 400);
    results.push({ title, url: href, snippet });
  }

  return results.length > 0 ? results : parseByRegex(html, spec.base);
}

/** Last resort: pull every onion link out of the markup. */
export function parseByRegex(
  html: string,
  base?: string,
): Omit<import("./types").RawResult, "engineId">[] {
  const seen = new Set<string>();
  const out: Omit<import("./types").RawResult, "engineId">[] = [];
  for (const match of html.matchAll(ONION_RE)) {
    const url = match[0].replace(/["'<>].*$/, "");
    if (seen.has(url)) continue;
    if (!isContentUrl(url, base)) continue;
    seen.add(url);
    out.push({ title: url, url, snippet: "" });
  }
  return out;
}
