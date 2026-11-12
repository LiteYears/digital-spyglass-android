import { isOnion } from "@/lib/ghost/parse";
import { stripTrackingParams } from "@/lib/ghost/tracking";
import { isNative, torFetch, type TorFetchResult } from "@/lib/platform/bridge";

export interface BrowserPageResponse {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  base64?: string;
  isOnion: boolean;
  isDownloadable: boolean;
  sizeBytes: number;
  title: string;
  readerText: string;
}

export interface DownloadedFileItem {
  id: string;
  filename: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  savedUri?: string;
  base64Data: string;
  timestamp: number;
}

export type WebGLMode = "standard" | "shielded" | "disabled";

export interface BrowserRenderOptions {
  enableJs: boolean;
  blockWebgl?: boolean;
  webglMode?: WebGLMode;
  inlineTorAssets?: boolean;
}

/* RAM-only session downloads and subresource cache */
let sessionDownloads: DownloadedFileItem[] = [];
const subresourceCache = new Map<string, string>();
let browserEpoch = 1;
const listeners = new Set<() => void>();

export function getSessionDownloads(): DownloadedFileItem[] {
  return sessionDownloads;
}

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function purgeBrowserDownloads(): void {
  sessionDownloads = [];
  subresourceCache.clear();
  browserEpoch += 1;
  listeners.forEach((fn) => fn());
}

export function rotateBrowserIdentity(): number {
  subresourceCache.clear();
  browserEpoch += 1;
  return browserEpoch;
}

export function getBrowserEpoch(): number {
  return browserEpoch;
}

function notifyDownloads() {
  listeners.forEach((fn) => fn());
}

function socksCredentialsForUrl(urlStr: string): { user: string; pass: string } {
  let host = "default";
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch {
    // ignore
  }
  return {
    user: `ghost-br-${browserEpoch}`,
    pass: host.slice(0, 48),
  };
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return stripTrackingParams(trimmed).url;
  }
  if (trimmed.includes(".onion")) {
    return stripTrackingParams(`http://${trimmed}`).url;
  }
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(trimmed)) {
    return stripTrackingParams(`https://${trimmed}`).url;
  }
  return `http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/search/?q=${encodeURIComponent(trimmed)}`;
}

function isBinaryOrAttachment(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase();
  if (
    ct.includes("text/html") ||
    ct.includes("application/xhtml+xml") ||
    ct.includes("text/plain") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("text/xml")
  ) {
    return false;
  }
  if (
    ct.includes("application/pdf") ||
    ct.includes("application/zip") ||
    ct.includes("application/x-") ||
    ct.includes("application/octet-stream") ||
    ct.includes("image/") ||
    ct.includes("audio/") ||
    ct.includes("video/")
  ) {
    return true;
  }
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  return /\.(pdf|zip|tar|gz|7z|rar|asc|sig|pgp|gpg|apk|dmg|iso|epub|csv|db|sqlite|mp3|mp4|png|jpg|jpeg|webp)$/i.test(
    path,
  );
}

function extractTitle(html: string, fallbackUrl: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match?.[1]) {
    return match[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140);
  }
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return fallbackUrl;
  }
}

export function extractReaderText(html: string): string {
  if (!html) return "";
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<(h[1-6]|p|li|blockquote|pre|div|br|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/gi, "'");

  return cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

/**
 * Fetches external `<link rel="stylesheet">`, `<script src="...">`, and `<img>` assets over
 * the Tor SOCKS5 bridge so `.onion` stylesheets, scripts, and images render inside
 * the Android WebView without clearnet or DNS leaks.
 */
async function inlineOnionSubresources(
  rawHtml: string,
  baseUrl: string,
  socksConfig?: { host?: string; port?: number },
  enableJs = true,
): Promise<string> {
  const native = await isNative();
  let html = rawHtml;
  const creds = socksCredentialsForUrl(baseUrl);
  const ua = "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0";

  const fetchAsset = async (assetUrl: string): Promise<TorFetchResult | null> => {
    if (native) {
      try {
        return await torFetch(assetUrl, ua, {
          method: "GET",
          allowAnyHttp: true,
          browserMode: true,
          socksAuth: {
            user: creds.user,
            pass: creds.pass,
            host: socksConfig?.host,
            port: socksConfig?.port,
          },
        });
      } catch {
        return null;
      }
    } else {
      try {
        const proxyResp = await fetch("/api/tor-fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: assetUrl, method: "GET" }),
        });
        if (proxyResp.ok) {
          const json = (await proxyResp.json()) as { status?: number; body?: string; contentType?: string };
          return {
            status: json.status ?? 200,
            body: json.body ?? "",
            contentType: json.contentType ?? "text/plain",
          };
        }
      } catch {
        // ignore
      }
      return null;
    }
  };

  // 1. Inline up to 10 external stylesheets
  const linkRegex = /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi;
  const linkMatches = Array.from(html.matchAll(linkRegex)).slice(0, 10);
  await Promise.all(
    linkMatches.map(async (m) => {
      const fullTag = m[0];
      const hrefMatch = /href=["']([^"']+)["']/i.exec(fullTag);
      if (!hrefMatch?.[1]) return;
      try {
        const resolved = new URL(hrefMatch[1], baseUrl).href;
        let cssText = subresourceCache.get(resolved);
        if (cssText === undefined) {
          const res = await fetchAsset(resolved);
          if (res && res.status >= 200 && res.status < 400 && res.body) {
            cssText = res.body.replace(/<\/style/gi, "<\\/style");
            subresourceCache.set(resolved, cssText);
          }
        }
        if (cssText) {
          html = html.replace(fullTag, `<style data-tor-href="${resolved}">${cssText}</style>`);
        }
      } catch {
        // Leave original tag if fetch fails
      }
    }),
  );

  // 2. Inline external scripts when JavaScript is enabled (up to 8 essential scripts)
  if (enableJs) {
    const scriptRegex = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>([\s\S]*?)<\/script>/gi;
    const scriptMatches = Array.from(html.matchAll(scriptRegex)).slice(0, 8);
    await Promise.all(
      scriptMatches.map(async (m) => {
        const fullTag = m[0];
        const rawSrc = m[1];
        if (!rawSrc || rawSrc.startsWith("data:") || rawSrc.startsWith("blob:")) return;
        try {
          const resolved = new URL(rawSrc, baseUrl).href;
          let scriptContent = subresourceCache.get(resolved);
          if (scriptContent === undefined) {
            const res = await fetchAsset(resolved);
            if (res && res.status >= 200 && res.status < 400 && res.body) {
              scriptContent = res.body.replace(/<\/script/gi, "<\\/script");
              subresourceCache.set(resolved, scriptContent);
            }
          }
          if (scriptContent) {
            html = html.replace(
              fullTag,
              `<script data-tor-src="${resolved}">${scriptContent}</script>`,
            );
          }
        } catch {
          // Leave original script tag if fetch fails
        }
      }),
    );
  }

  // 3. Inline up to 20 images (including captchas and icons)
  const imgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const imgMatches = Array.from(html.matchAll(imgRegex)).slice(0, 20);
  await Promise.all(
    imgMatches.map(async (m) => {
      const fullTag = m[0];
      const rawSrc = m[1];
      if (!rawSrc || rawSrc.startsWith("data:") || rawSrc.startsWith("blob:")) return;
      try {
        const resolved = new URL(rawSrc, baseUrl).href;
        let dataUri = subresourceCache.get(resolved);
        if (!dataUri) {
          const res = await fetchAsset(resolved);
          if (res && res.status >= 200 && res.status < 400 && res.base64) {
            const mime =
              res.contentType?.split(";")[0]?.trim() ||
              (resolved.endsWith(".svg")
                ? "image/svg+xml"
                : resolved.endsWith(".gif")
                  ? "image/gif"
                  : resolved.endsWith(".webp")
                    ? "image/webp"
                    : "image/png");
            dataUri = `data:${mime};base64,${res.base64}`;
            subresourceCache.set(resolved, dataUri);
          }
        }
        if (dataUri) {
          const updatedTag = fullTag.replace(rawSrc, dataUri);
          html = html.replace(fullTag, updatedTag);
        }
      } catch {
        // Leave original image tag if fetch fails
      }
    }),
  );

  return html;
}

/**
 * Prepares HTML for safe rendering inside a sandboxed iframe:
 * - Injects WebGL, Canvas, and WebRTC fingerprint controls according to webglMode ("standard", "shielded", "disabled")
 * - Injects `<base href="...">`, responsive typography and touch-smooth scrolling
 * - Injects AJAX / fetch postMessage bridge so in-page requests route through Tor
 * - Intercepts `<a>` clicks and both GET/POST `<form>` submissions so all navigation stays inside Tor
 * - Injects ResizeObserver for auto-height calculation
 */
export function prepareSandboxedHtml(
  rawHtml: string,
  baseUrl: string,
  enableJs: boolean,
  webglModeOrBlock: WebGLMode | boolean = "shielded",
): string {
  const mode: WebGLMode =
    typeof webglModeOrBlock === "boolean"
      ? webglModeOrBlock
        ? "shielded"
        : "standard"
      : webglModeOrBlock;

  let html = rawHtml;
  if (!enableJs) {
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  }

  const escapedBase = baseUrl.replace(/"/g, "&quot;");

  let webglScript = "";
  if (mode === "shielded") {
    // Tor Browser hardened WebGL / Canvas / WebRTC spoofing & anti-fingerprinting
    webglScript = `
    // WebGL Shield (Tor Browser standard: context allowed, GPU unmasked strings spoofed)
    try {
      var origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        var ctx = origGetContext.call(this, type, attrs);
        if (!ctx) return ctx;
        if (type && /webgl|experimental-webgl|webgl2/i.test(String(type))) {
          var origGetParam = ctx.getParameter ? ctx.getParameter.bind(ctx) : null;
          if (origGetParam) {
            ctx.getParameter = function(pname) {
              if (pname === 0x9245) return "Google Inc. (Tor Browser)";
              if (pname === 0x9246) return "ANGLE (Software Rasterizer Direct3D11 / Mesa DRI)";
              if (pname === 0x1F00) return "WebKit";
              if (pname === 0x1F01) return "WebKit WebGL";
              return origGetParam(pname);
            };
          }
          var origGetExt = ctx.getExtension ? ctx.getExtension.bind(ctx) : null;
          if (origGetExt) {
            ctx.getExtension = function(name) {
              var ext = origGetExt(name);
              if (name === "WEBGL_debug_renderer_info" && ext) {
                return {
                  UNMASKED_VENDOR_WEBGL: 0x9245,
                  UNMASKED_RENDERER_WEBGL: 0x9246
                };
              }
              return ext;
            };
          }
        }
        return ctx;
      };
      // Block WebRTC local IP leak vectors
      window.RTCPeerConnection = undefined;
      window.webkitRTCPeerConnection = undefined;
      window.RTCDataChannel = undefined;
      // Baseline browser fingerprint normalization
      try {
        Object.defineProperty(navigator, "hardwareConcurrency", { get: function() { return 4; } });
        Object.defineProperty(navigator, "deviceMemory", { get: function() { return 4; } });
        Object.defineProperty(navigator, "webdriver", { get: function() { return false; } });
      } catch (e) {}
    } catch (e) {}
    `;
  } else if (mode === "disabled") {
    webglScript = `
    try {
      var origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, attrs) {
        if (type && /webgl|experimental-webgl|webgl2|webgpu/i.test(String(type))) {
          return null;
        }
        return origGetContext.call(this, type, attrs);
      };
      window.RTCPeerConnection = undefined;
      window.webkitRTCPeerConnection = undefined;
    } catch (e) {}
    `;
  } else {
    // standard: Native WebGL and Canvas enabled without interception
    webglScript = `
    try {
      // Standard WebGL enabled — protect WebRTC from IP leakage
      window.RTCPeerConnection = undefined;
      window.webkitRTCPeerConnection = undefined;
    } catch (e) {}
    `;
  }

  const injectedHead = `
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
<base href="${escapedBase}" />
<style>
  :root { color-scheme: dark light; }
  html, body {
    margin: 0;
    padding: 12px;
    min-height: 100%;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
    overscroll-behavior-y: contain;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: break-word;
    color: #e2e8f0;
    background-color: #0b0f17;
  }
  img, video, canvas, svg, iframe, pre, table { max-width: 100%; height: auto; }
  pre, code { overflow-x: auto; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.9em; }
  a { color: #f59e0b; text-decoration: underline; }
  :where(input, select, textarea, button) {
    font: inherit;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid rgba(245, 158, 11, 0.4);
    background: rgba(15, 23, 42, 0.85);
    color: #f8fafc;
  }
  :where(button, input[type="submit"]) {
    background: #f59e0b;
    color: #090d16;
    font-weight: 600;
    cursor: pointer;
  }
</style>
<script>
  ${webglScript}

  // Transparent in-page fetch bridge routing through Tor parent container
  (function() {
    var origFetch = window.fetch;
    window.fetch = function(resource, init) {
      try {
        var urlStr = typeof resource === "string" ? resource : (resource && resource.url ? resource.url : "");
        if (!urlStr) return origFetch ? origFetch.apply(this, arguments) : Promise.reject(new Error("Empty fetch URL"));
        var resolved = new URL(urlStr, document.baseURI).href;
        var method = (init && init.method ? init.method : "GET").toUpperCase();
        var body = init && init.body ? (typeof init.body === "string" ? init.body : JSON.stringify(init.body)) : undefined;
        var reqId = "req_" + Math.random().toString(36).slice(2, 9);
        return new Promise(function(resolve, reject) {
          var timer = setTimeout(function() {
            window.removeEventListener("message", onFetchMsg);
            reject(new Error("Tor fetch timeout"));
          }, 35000);
          function onFetchMsg(ev) {
            if (ev.data && ev.data.type === "ghost-browser-ajax-res" && ev.data.id === reqId) {
              clearTimeout(timer);
              window.removeEventListener("message", onFetchMsg);
              if (ev.data.error) {
                reject(new Error(ev.data.error));
              } else {
                resolve(new Response(ev.data.body || "", {
                  status: ev.data.status || 200,
                  headers: { "Content-Type": ev.data.contentType || "application/json" }
                }));
              }
            }
          }
          window.addEventListener("message", onFetchMsg);
          window.parent.postMessage({
            type: "ghost-browser-ajax",
            id: reqId,
            url: resolved,
            method: method,
            body: body
          }, "*");
        });
      } catch (err) {
        return origFetch ? origFetch.apply(this, arguments) : Promise.reject(err);
      }
    };
  })();

  // Intercept anchor clicks to keep browsing inside Tor
  document.addEventListener("click", function(e) {
    var target = e.target;
    while (target && target.tagName !== "A") {
      target = target.parentElement;
    }
    if (target && target.tagName === "A") {
      var href = target.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        var resolved = new URL(href, document.baseURI).href;
        window.parent.postMessage({ type: "ghost-browser-nav", url: resolved, method: "GET" }, "*");
      } catch (err) {}
    }
  }, true);

  // Intercept GET and POST forms to keep requests inside Tor
  document.addEventListener("submit", function(e) {
    var form = e.target;
    if (!form || form.tagName !== "FORM") return;
    e.preventDefault();
    e.stopPropagation();
    try {
      var method = (form.getAttribute("method") || "GET").toUpperCase();
      var action = form.getAttribute("action") || document.baseURI;
      var url = new URL(action, document.baseURI);
      var fd = new FormData(form);
      var params = new URLSearchParams();
      fd.forEach(function(val, key) {
        if (typeof val === "string") params.append(key, val);
      });
      if (method === "POST") {
        window.parent.postMessage({
          type: "ghost-browser-nav",
          url: url.href,
          method: "POST",
          body: params.toString()
        }, "*");
      } else {
        params.forEach(function(val, key) {
          url.searchParams.set(key, val);
        });
        window.parent.postMessage({
          type: "ghost-browser-nav",
          url: url.href,
          method: "GET"
        }, "*");
      }
    } catch (err) {}
  }, true);

  // Auto-report document height for seamless iframe expansion
  if (typeof ResizeObserver !== "undefined") {
    var resizeTimer;
    var ro = new ResizeObserver(function() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function() {
        var h = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
        window.parent.postMessage({ type: "ghost-iframe-height", height: h }, "*");
      }, 60);
    });
    ro.observe(document.documentElement);
  }
</script>
`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}${injectedHead}`);
  }
  return `<!DOCTYPE html><html><head>${injectedHead}</head><body>${html}</body></html>`;
}

export async function fetchBrowserUrl(
  rawUrl: string,
  socksConfig?: { host?: string; port?: number },
  requestOptions?: {
    method?: "GET" | "POST";
    body?: string;
    inlineSubresources?: boolean;
    enableJs?: boolean;
  },
): Promise<BrowserPageResponse> {
  const url = normalizeBrowserUrl(rawUrl);
  if (!url) throw new Error("Empty URL");

  const method = requestOptions?.method ?? "GET";
  const postBody = requestOptions?.body;
  const creds = socksCredentialsForUrl(url);
  let res: TorFetchResult | null = null;

  if (await isNative()) {
    res = await torFetch(
      url,
      "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
      {
        method,
        body: postBody,
        allowAnyHttp: true,
        browserMode: true,
        socksAuth: {
          user: creds.user,
          pass: creds.pass,
          host: socksConfig?.host,
          port: socksConfig?.port,
        },
      },
    );
  } else {
    try {
      const proxyResp = await fetch("/api/tor-fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method, body: postBody }),
      });
      if (proxyResp.ok) {
        const json = (await proxyResp.json()) as {
          status?: number;
          body?: string;
          contentType?: string;
        };
        res = {
          status: json.status ?? 200,
          body: json.body ?? "",
          contentType: json.contentType ?? "text/html",
        };
      }
    } catch {
      // Fallback
    }
    if (!res) {
      const direct = await fetch(url, {
        method,
        body: method === "POST" ? postBody : undefined,
        headers:
          method === "POST"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : undefined,
      });
      const text = await direct.text();
      res = {
        status: direct.status,
        body: text,
        contentType: direct.headers.get("content-type") ?? "text/html",
      };
    }
  }

  if (!res) {
    throw new Error("Tor transport failed to fetch URL — verify Orbot is active.");
  }

  const contentType = res.contentType ?? "text/html; charset=utf-8";
  let body = res.body ?? "";
  const downloadable = isBinaryOrAttachment(contentType, url);

  if (!downloadable && (requestOptions?.inlineSubresources ?? true)) {
    body = await inlineOnionSubresources(
      body,
      url,
      socksConfig,
      requestOptions?.enableJs ?? true,
    );
  }

  const sizeBytes = res.base64
    ? Math.floor((res.base64.length * 3) / 4)
    : new TextEncoder().encode(body).byteLength;
  const title = downloadable
    ? guessFilename(url, contentType)
    : extractTitle(body, url);
  const readerText = downloadable ? "" : extractReaderText(body);

  return {
    url,
    finalUrl: url,
    status: res.status,
    contentType,
    body,
    base64: res.base64,
    isOnion: isOnion(url),
    isDownloadable: downloadable,
    sizeBytes,
    title,
    readerText,
  };
}

export function guessFilename(url: string, contentType: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.length <= 80 && /\.[a-zA-Z0-9]{1,8}$/.test(last)) {
      return decodeURIComponent(last).replace(/[^a-zA-Z0-9._-]/g, "_");
    }
  } catch {
    // ignore
  }
  const ct = contentType.toLowerCase();
  let ext = "bin";
  if (ct.includes("html")) ext = "html";
  else if (ct.includes("pdf")) ext = "pdf";
  else if (ct.includes("json")) ext = "json";
  else if (ct.includes("plain")) ext = "txt";
  else if (ct.includes("zip")) ext = "zip";
  else if (ct.includes("png")) ext = "png";
  else if (ct.includes("jpeg") || ct.includes("jpg")) ext = "jpg";
  return `ghost-download-${Date.now().toString(36)}.${ext}`;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function calculateSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function downloadFileSecurely(
  pageOrUrl: BrowserPageResponse | string,
  socksConfig?: { host?: string; port?: number },
): Promise<DownloadedFileItem> {
  const page =
    typeof pageOrUrl === "string"
      ? await fetchBrowserUrl(pageOrUrl, socksConfig, { inlineSubresources: false })
      : pageOrUrl;

  const bytes = page.base64
    ? base64ToUint8Array(page.base64)
    : new TextEncoder().encode(page.body);
  const base64Data = page.base64 ?? uint8ArrayToBase64(bytes);
  const sha256 = await calculateSha256(bytes);
  const filename = guessFilename(page.finalUrl, page.contentType);

  let savedUri: string | undefined;
  if (await isNative()) {
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const written = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Documents,
      });
      savedUri = written.uri;
    } catch {
      try {
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const writtenCache = await Filesystem.writeFile({
          path: filename,
          data: base64Data,
          directory: Directory.Cache,
        });
        savedUri = writtenCache.uri;
      } catch {
        // Fallback to RAM-only session store
      }
    }
  } else {
    const blob = new Blob([bytes.buffer as ArrayBuffer], {
      type: page.contentType || "application/octet-stream",
    });
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  }

  const item: DownloadedFileItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    filename,
    url: page.finalUrl,
    sizeBytes: bytes.byteLength,
    sha256,
    mimeType: page.contentType.split(";")[0]?.trim() || "application/octet-stream",
    savedUri,
    base64Data,
    timestamp: Date.now(),
  };

  sessionDownloads = [item, ...sessionDownloads];
  notifyDownloads();
  return item;
}

export function triggerManualSave(item: DownloadedFileItem): void {
  const bytes = base64ToUint8Array(item.base64Data);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: item.mimeType });
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = item.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
}
