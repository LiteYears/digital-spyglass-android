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

/* RAM-only session downloads store */
let sessionDownloads: DownloadedFileItem[] = [];
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
  browserEpoch += 1;
  listeners.forEach((fn) => fn());
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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/gi, "'");

  return cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export function prepareSandboxedHtml(
  rawHtml: string,
  baseUrl: string,
  enableJs: boolean,
): string {
  let html = rawHtml;
  if (!enableJs) {
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  }

  const escapedBase = baseUrl.replace(/"/g, "&quot;");
  const injectedHead = `
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base href="${escapedBase}" />
<style>
  :root { color-scheme: dark light; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.55;
    margin: 0;
    padding: 12px;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  img, video, iframe, pre, table { max-width: 100%; }
  pre, code { overflow-x: auto; }
  a { color: #f59e0b; text-decoration: underline; }
</style>
<script>
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
        window.parent.postMessage({ type: "ghost-browser-nav", url: resolved }, "*");
      } catch (err) {}
    }
  }, true);

  document.addEventListener("submit", function(e) {
    var form = e.target;
    if (!form || form.tagName !== "FORM") return;
    var method = (form.getAttribute("method") || "GET").toUpperCase();
    if (method === "GET") {
      e.preventDefault();
      try {
        var action = form.getAttribute("action") || document.baseURI;
        var url = new URL(action, document.baseURI);
        var fd = new FormData(form);
        fd.forEach(function(val, key) {
          if (typeof val === "string") url.searchParams.set(key, val);
        });
        window.parent.postMessage({ type: "ghost-browser-nav", url: url.href }, "*");
      } catch (err) {}
    }
  }, true);
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
): Promise<BrowserPageResponse> {
  const url = normalizeBrowserUrl(rawUrl);
  if (!url) throw new Error("Empty URL");

  const creds = socksCredentialsForUrl(url);
  let res: TorFetchResult | null = null;

  if (await isNative()) {
    res = await torFetch(
      url,
      "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
      {
        method: "GET",
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
        body: JSON.stringify({ url, method: "GET" }),
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
      const direct = await fetch(url);
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
  const body = res.body ?? "";
  const sizeBytes = res.base64
    ? Math.floor((res.base64.length * 3) / 4)
    : new TextEncoder().encode(body).byteLength;
  const downloadable = isBinaryOrAttachment(contentType, url);
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
      ? await fetchBrowserUrl(pageOrUrl, socksConfig)
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
