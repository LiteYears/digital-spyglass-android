/**
 * Engine registry — descriptor-driven.
 *
 * Engine metadata lives in engines.json (data: addresses, URL templates,
 * selector specs, contracts, health). Parser strategies are named code below
 * — onion engines have no stable APIs, so each needs custom extraction.
 * Addresses rotate: the bundled list is the baseline; engine-healthcheck.mjs
 * verifies liveness weekly and CI ships updates via normal releases. When an
 * engine's primary base dies the optional signed `mirrors` array is tried in
 * order (onion-only) — nothing ever falls back to a clearnet mirror.
 */
import { fetchPostBody, type SocksAuth } from "./http";
import {
  parseBySelectors,
  parseByRegex,
  parseDocument,
  cleanText,
  isContentUrl,
  isOnion,
  unwrapRedirect,
  type SelectorSpec,
} from "./parse";
import type { RawResult } from "./types";
import registry from "./engines.json";

export { registryIntegrity, registryAnchorFingerprint } from "./registry-signature";
export type { RegistryIntegrity, RegistryAnchor } from "./registry-signature";

/** Parsed bundled registry — the object the signature verification covers. */
export function bundledRegistry(): unknown {
  return registry;
}

/** Committed detached signature (lazy — never resolved off the native path). */
export async function loadBundledRegistrySig(): Promise<string> {
  const mod = await import("./engines.sig.json");
  return JSON.stringify(mod.default ?? mod);
}

export type QueryContract = {
  maxQueryLength?: number;
  maxTerms?: number;
  matchMode?: "any" | "all" | "majority";
  booleanOperators?: boolean;
  phraseQuotes?: boolean;
  encoding?: "raw" | "url-encoded";
};

export type EngineTier = "core" | "reinforcement" | "low";

export type SearchEngine = {
  id: string;
  name: string;
  /** Ranking weight — higher means the engine's agreement counts for more. */
  trust: number;
  /** Engine host is also reachable without Tor (informational — fetches
   *  always target the .onion address via Tor, never a clearnet mirror). */
  clearnet: boolean;
  /** Per-engine SOCKS5 connect timeout override (ms). */
  connectTimeoutMs?: number;
  /** Verified .onion mirror base URLs — tried in array order when the primary
   *  base fails. Onions only; a mirror that is not a v3 .onion is dropped. */
  mirrors?: string[];
  searchUrl: (query: string, page: number, base?: string) => string;
  parse: (html: string) => Omit<RawResult, "engineId">[];
  note: string;
  prepareSearchUrl?: (
    query: string,
    page: number,
    fetchFn: (url: string) => Promise<string>,
    socksAuth?: SocksAuth,
    postFn?: (url: string, body: string) => Promise<string>,
    base?: string,
  ) => Promise<string>;
  queryContract?: QueryContract;
};

type PrepareDescriptor = {
  type: "hidden_input" | "form_introspect" | "math_captcha";
  /** URL to fetch first; "{searchUrl}" resolves to the engine's search URL. */
  page?: string;
  /** POST target for captcha answers; "{searchUrl}" resolves likewise. */
  postUrl?: string;
  /** POST body template; "{answer}" is the solved math result. */
  body?: string;
  /** Math-problem regex with two capture groups (defaults to "(\d+)\s*\+\s*(\d+)"). */
  mathRe?: string;
};

type EngineDescriptor = {
  id: string;
  name: string;
  trust: number;
  clearnet: boolean;
  connectTimeoutMs?: number;
  baseUrl: string;
  /** Optional .onion mirror bases — see SearchEngine.mirrors. */
  mirrors?: string[];
  /** URL template. Tokens: {base} {q} {page} {start} (start = (page-1)*10). */
  searchUrl: string;
  /** Used when page > 1; falls back to searchUrl otherwise. */
  pagedUrl?: string;
  /** Used by prepare strategies when their prefetch fails (matches legacy fallbacks). */
  fallbackUrl?: string;
  parser:
    { type: "selectors"; spec: Omit<SelectorSpec, "base"> } | { type: "custom"; name: string };
  prepare?: PrepareDescriptor;
  queryContract?: QueryContract;
  note: string;
  enabled?: boolean;
};

function renderUrl(template: string, base: string, q: string, page: number): string {
  return template
    .replaceAll("{base}", base)
    .replaceAll("{q}", encodeURIComponent(q))
    .replaceAll("{page}", String(page))
    .replaceAll("{start}", String((page - 1) * 10));
}

/* ── custom parser strategies ─────────────────────────────────────────── */

type CustomParser = (html: string, base: string) => Omit<RawResult, "engineId">[];

const parseTor66: CustomParser = (html, base) => {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, base);
  const results: Omit<RawResult, "engineId">[] = [];
  const seen = new Set<string>();
  const sresults = doc.querySelector("div.sresults");
  if (!sresults) return parseByRegex(html, base);
  for (const a of Array.from(sresults.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (!/\.onion/i.test(href)) continue;
    if (!isContentUrl(href, base)) continue;
    const url = unwrapRedirect(href, base);
    if (seen.has(url)) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    const title = cleanText(a.textContent ?? "") || url;
    const parent = a.closest("div") ?? a.parentElement;
    const snippet = cleanText(parent?.textContent ?? "").slice(0, 400);
    results.push({ title, url, snippet });
  }
  return results.length > 0 ? results : parseByRegex(html, base);
};

const parseDeepsearches: CustomParser = (html, base) => {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, base);
  const results: Omit<RawResult, "engineId">[] = [];
  const seen = new Set<string>();
  for (const doc_block of Array.from(doc.querySelectorAll("div.doc"))) {
    if (doc_block.querySelector("span.label-ad")) continue;
    const titleAnchor = doc_block.querySelector("a.title");
    if (!titleAnchor) continue;
    const href = titleAnchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) continue;
    const url = unwrapRedirect(href, base);
    if (!isContentUrl(url, base)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = cleanText(titleAnchor.textContent ?? "") || url;
    const descNode = doc_block.querySelector("p.desc");
    const snippet = cleanText(descNode?.textContent ?? "").slice(0, 400);
    results.push({ title, url, snippet });
  }
  return results.length > 0 ? results : parseByRegex(html, base);
};

const parseOnionway: CustomParser = (html, base) => {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, base);
  const results: Omit<RawResult, "engineId">[] = [];
  for (const item of Array.from(doc.querySelectorAll("article.s_result, a.s_result"))) {
    const titleEl = item.querySelector("h2.title, h5.title, .title");
    const linkEl = item.querySelector('a[href*=".onion"]') ?? titleEl;
    const descEl = item.querySelector("p.desc, .desc");
    const urlEl = item.querySelector(".result-url");
    const href = linkEl?.getAttribute("href") ?? "";
    const url = urlEl ? cleanText(urlEl.textContent ?? "") : href;
    const title = cleanText(titleEl?.textContent ?? "") || url;
    const snippet = cleanText(descEl?.textContent ?? "");
    if (url && /^https?:\/\//i.test(url) && isContentUrl(url, base)) {
      results.push({ title, url, snippet });
    }
  }
  return results.length > 0 ? results : parseByRegex(html, base);
};

const parseOss: CustomParser = (html, base) => {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, base);
  const results: Omit<RawResult, "engineId">[] = [];
  const seen = new Set<string>();
  const resultTd = Array.from(doc.querySelectorAll("td[valign]")).find((td) => {
    const anchors = Array.from(td.querySelectorAll("a[href]"));
    let onionCount = 0;
    for (const a of anchors) {
      if (/\.onion/i.test(a.getAttribute("href") ?? "")) onionCount++;
    }
    return onionCount >= 2;
  });
  if (resultTd) {
    const anchors = Array.from(resultTd.querySelectorAll("a[href]")).filter((a) =>
      /\.onion/i.test(a.getAttribute("href") ?? ""),
    );
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i]!;
      const href = anchor.getAttribute("href") ?? "";
      if (!isContentUrl(href, base)) continue;
      const url = unwrapRedirect(href, base);
      if (seen.has(url) || !/^https?:\/\//i.test(url)) continue;
      seen.add(url);
      const title = cleanText(anchor.textContent ?? "") || url;
      let nextSibling = anchor.nextSibling;
      let snippetText = "";
      while (nextSibling && nextSibling !== anchors[i + 1]) {
        snippetText += nextSibling.textContent ?? "";
        nextSibling = nextSibling.nextSibling;
      }
      const snippet = cleanText(snippetText)
        .replace(/^https?:\/\/\S+\s*/, "")
        .slice(0, 400);
      results.push({ title, url, snippet });
    }
  }
  return results.length > 0 ? results : parseByRegex(html, base);
};

const parseNotevil: CustomParser = (html, base) => {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, base);
  const results: Omit<RawResult, "engineId">[] = [];
  for (const item of Array.from(doc.querySelectorAll("div.result-item"))) {
    const urlEl = item.querySelector("span.result-url");
    const titleEl = item.querySelector("a.result-title");
    const descEl = item.querySelector("p.result-desc");
    const url = cleanText(urlEl?.textContent ?? "");
    const title = cleanText(titleEl?.textContent ?? "") || url;
    const snippet = cleanText(descEl?.textContent ?? "");
    if (url && /^https?:\/\//i.test(url) && isContentUrl(url, base)) {
      results.push({ title, url, snippet });
    }
  }
  return results.length > 0 ? results : parseByRegex(html, base);
};

const parseTorgle: CustomParser = (html, base) => {
  const doc = parseDocument(html);
  if (!doc) return parseByRegex(html, base);
  const results: Omit<RawResult, "engineId">[] = [];
  const seen = new Set<string>();
  for (const tr of Array.from(doc.querySelectorAll("tr"))) {
    const anchor = Array.from(tr.querySelectorAll("a[href]")).find((a) =>
      /\.onion/i.test(a.getAttribute("href") ?? ""),
    );
    if (!anchor) continue;
    const href = anchor.getAttribute("href") ?? "";
    if (!isContentUrl(href, base)) continue;
    const url = unwrapRedirect(href, base);
    if (seen.has(url) || !/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    const td = tr.querySelector("td[valign]");
    const titleEl = td?.querySelector("b");
    const title = cleanText(titleEl?.textContent ?? "") || url;
    const fullText = cleanText(td?.textContent ?? "");
    const snippet = fullText.replace(title, "").slice(0, 400).trim();
    results.push({ title, url, snippet });
  }
  return results.length > 0 ? results : parseByRegex(html, base);
};

/** Names of the built-in custom parsers — used by the import validator. */
export function customParserNames(): string[] {
  return Object.keys(CUSTOM_PARSERS);
}

/** The bundled engine's own mathRe — imports may only reuse this exact pattern. */
export function bundledMathRe(engineId: string): string | null {
  const engines = (registry as { engines?: unknown }).engines;
  if (!Array.isArray(engines)) return null;
  for (const e of engines as Array<Record<string, unknown>>) {
    if (e["id"] === engineId) {
      const mathRe = (e["prepare"] as Record<string, unknown> | undefined)?.["mathRe"];
      return typeof mathRe === "string" ? mathRe : null;
    }
  }
  return null;
}

const CUSTOM_PARSERS: Record<string, CustomParser> = {
  tor66: parseTor66,
  deepsearches: parseDeepsearches,
  onionway: parseOnionway,
  oss: parseOss,
  notevil: parseNotevil,
  torgle: parseTorgle,
};

/* ── prepare strategies (prefetch / captcha) ──────────────────────────── */

type PrepareFn = NonNullable<SearchEngine["prepareSearchUrl"]>;

function makePrepare(
  d: EngineDescriptor,
  prep: PrepareDescriptor,
  resolveSearch: (q: string, page: number, base?: string) => string,
): PrepareFn {
  const pageUrl = (q: string, page: number, base?: string) =>
    prep.page === "{searchUrl}"
      ? resolveSearch(q, page, base)
      : renderUrl(prep.page ?? "{base}/", base ?? d.baseUrl, q, page);
  const resolveFallback = (q: string, page: number, base?: string) =>
    d.fallbackUrl
      ? renderUrl(d.fallbackUrl, base ?? d.baseUrl, q, page)
      : resolveSearch(q, page, base);

  switch (prep.type) {
    case "hidden_input":
      // e.g. Ahmia: homepage carries a hidden anti-abuse token field
      return async (q, page, fetchFn, _socksAuth, _postFn, base) => {
        const fallback = resolveFallback(q, page, base);
        try {
          const homepage = await fetchFn(pageUrl(q, page, base));
          const match = homepage.match(
            /<input\s+type="hidden"\s+name="([a-f0-9]+)"\s+value="([a-f0-9]+)"/i,
          );
          if (match) return `${fallback}&${match[1]}=${match[2]}`;
        } catch {
          /* prefetch failed — fall back to plain search URL */
        }
        return fallback;
      };

    case "form_introspect":
      // e.g. Tor66: discover the search form's action + input names live
      return async (q, _page, fetchFn, _socksAuth, _postFn, base) => {
        const activeBase = base ?? d.baseUrl;
        const fallback = resolveFallback(q, 1, base);
        try {
          const homepage = await fetchFn(pageUrl(q, 1, base));
          for (const formMatch of homepage.matchAll(/<form[^>]*>/gi)) {
            const formTag = formMatch[0];
            const formStart = formMatch.index!;
            const formEnd = homepage.indexOf("</form>", formStart);
            const formHtml = homepage.slice(
              formStart,
              formEnd > 0 ? formEnd + 7 : formStart + 2000,
            );
            const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
            const action = actionMatch ? actionMatch[1] : "/";
            const inputs = [...formHtml.matchAll(/<input[^>]*name=["']([^"']*)["'][^>]*>/gi)];
            const params = new URLSearchParams();
            for (const input of inputs) {
              const name = input[1];
              if (!name) continue;
              const valueMatch = input[0].match(/value=["']([^"']*)["']/i);
              const value = valueMatch ? valueMatch[1] : "";
              if (/^(q|query|search|term|s)$/i.test(name)) params.set(name, q);
              else if (value) params.set(name, value);
            }
            let target: string = action ?? "/";
            if (target.startsWith("/")) target = `${activeBase}${target}`;
            else if (!target.startsWith("http")) target = `${activeBase}/${target}`;
            const sep = target.includes("?") ? "&" : "?";
            return `${target}${sep}${params.toString()}`;
          }
        } catch {
          /* homepage fetch failed — fall back to common pattern */
        }
        return fallback;
      };

    case "math_captcha": {
      // Bounded pattern — an unbounded (\d+)\s*\+ on a digit-flooded page is
      // quadratic and freezes the JS thread (audit P1). The haystack cap bounds
      // input size only — exponential backtracking survives it — so the import
      // validator accepts prep.mathRe only when identical to the bundled pattern.
      const mathRe = new RegExp(prep.mathRe ?? "(\\d{1,6})\\s{0,8}\\+\\s{0,8}(\\d{1,6})", "i");
      return async (q, page, fetchFn, socksAuth, postFn, base) => {
        const search = resolveSearch(q, page, base);
        try {
          const captchaPage = await fetchFn(pageUrl(q, page, base));
          const mathMatch = captchaPage.slice(0, 16_384).match(mathRe);
          if (mathMatch) {
            const answer = parseInt(mathMatch[1]!, 10) + parseInt(mathMatch[2]!, 10);
            const body = (prep.body ?? "captcha_answer={answer}").replace(
              "{answer}",
              String(answer),
            );
            const target =
              prep.postUrl === "{searchUrl}" || !prep.postUrl
                ? search
                : renderUrl(prep.postUrl, base ?? d.baseUrl, q, page);
            if (postFn) await postFn(target, body);
            else await fetchPostBody(target, body, socksAuth);
          }
        } catch {
          /* captcha solve failed — proceed directly */
        }
        return search;
      };
    }
  }
}

/* ── descriptor → SearchEngine ────────────────────────────────────────── */

function toEngine(d: EngineDescriptor): SearchEngine {
  const resolveSearch = (q: string, page: number, base?: string) =>
    renderUrl(page > 1 && d.pagedUrl ? d.pagedUrl : d.searchUrl, base ?? d.baseUrl, q, page);

  let parse: SearchEngine["parse"];
  if (d.parser.type === "selectors") {
    const spec = d.parser.spec;
    parse = (html) => parseBySelectors(html, { ...spec, base: d.baseUrl });
  } else {
    const fn = CUSTOM_PARSERS[d.parser.name]!;
    parse = (html) => fn(html, d.baseUrl);
  }

  const engine: SearchEngine = {
    id: d.id,
    name: d.name,
    trust: d.trust,
    clearnet: d.clearnet,
    note: d.note,
    searchUrl: resolveSearch,
    parse,
  };
  if (d.connectTimeoutMs !== undefined) engine.connectTimeoutMs = d.connectTimeoutMs;
  if (d.queryContract) engine.queryContract = d.queryContract;
  if (d.prepare) engine.prepareSearchUrl = makePrepare(d, d.prepare, resolveSearch);
  // Mirrors are defense-in-depth against a dead primary base: only http(s)
  // .onion bases survive — anything else (clearnet, junk) is silently dropped
  // so one bad mirror cannot break the engine.
  if (Array.isArray(d.mirrors)) {
    const valid = d.mirrors.filter(
      (m): m is string => typeof m === "string" && /^https?:\/\//i.test(m) && isOnion(m),
    );
    if (valid.length > 0) engine.mirrors = Object.freeze(valid) as string[];
  }
  return engine;
}

function enginesFromRegistry(reg: unknown): SearchEngine[] {
  const descriptors = ((reg as { engines?: unknown }).engines ?? []) as EngineDescriptor[];
  return Object.freeze(
    descriptors
      .filter((_e, i) => descriptors[i]!.enabled !== false)
      .map((d) => Object.freeze(toEngine(d))),
  ) as SearchEngine[];
}

let activeRegistryValue: unknown = registry;

/** The registry the runtime currently uses — bundled, or a verified import. */
export function activeRegistry(): unknown {
  return activeRegistryValue;
}

export function isImportedRegistryActive(): boolean {
  return activeRegistryValue !== registry;
}

/**
 * Swap in a verified imported registry (B16). The array binding is live —
 * every consumer reading ENGINES after this call sees the imported engines.
 * Callers must have verified the registry signature first (fail-closed).
 */
export function applyImportedRegistry(reg: unknown): void {
  // Build first — a malformed descriptor must throw BEFORE any state mutates,
  // otherwise the runtime would mark the import active while ENGINES stays bundled.
  const built = enginesFromRegistry(reg);
  activeRegistryValue = reg;
  ENGINES = built;
}

/** Drop a runtime import and return to the bundled registry. */
export function resetToBundledRegistry(): void {
  activeRegistryValue = registry;
  ENGINES = enginesFromRegistry(registry);
}

/** Live binding — reassigned by applyImportedRegistry/resetToBundledRegistry. */
export let ENGINES: SearchEngine[] = enginesFromRegistry(registry);

export function engineById(id: string): SearchEngine | undefined {
  return ENGINES.find((engine) => engine.id === id);
}

export const ENGINE_TIER_CORE = ["ahmia", "torch", "tordex"];
export const ENGINE_TIER_REINFORCEMENT = ["torgle", "tor66"];
export const ENGINE_TIER_LOW = [
  "onionland",
  "excavator",
  "amnesia",
  "deepsearches",
  "torland",
  "onionway",
  "oss",
  "notevil",
];

export function enginesForFastMode(): string[] {
  return [...ENGINE_TIER_CORE, ...ENGINE_TIER_REINFORCEMENT];
}

export function engineTier(id: string): EngineTier {
  if (ENGINE_TIER_CORE.includes(id)) return "core";
  if (ENGINE_TIER_REINFORCEMENT.includes(id)) return "reinforcement";
  return "low";
}
