/**
 * Lazy Capacitor bridge.
 *
 * Every native plugin is imported dynamically and only after we know we run in
 * a browser/WebView. This keeps SSR and the Lovable web preview working while
 * the real APK gets the native implementations.
 */

let corePromise: Promise<typeof import("@capacitor/core")> | null = null;

async function core() {
  corePromise ??= import("@capacitor/core");
  return corePromise;
}

export function hasWindow(): boolean {
  return typeof window !== "undefined";
}

let nativeFlag: boolean | null = null;
let nativePromise: Promise<boolean> | null = null;

/**
 * Resolves once and caches the result. Subsequent calls return the cached
 * value synchronously via getNativeFlag().
 */
export async function isNative(): Promise<boolean> {
  if (nativeFlag !== null) return nativeFlag;
  if (nativePromise) return nativePromise;
  nativePromise = (async () => {
    if (!hasWindow()) {
      nativeFlag = false;
      return false;
    }
    try {
      const { Capacitor } = await core();
      nativeFlag = Capacitor.isNativePlatform();
      return nativeFlag;
    } catch {
      nativeFlag = false;
      return false;
    }
  })();
  return nativePromise;
}

/** Synchronous access to the cached isNative() result (null if not yet resolved). */
export function getNativeFlag(): boolean | null {
  return nativeFlag;
}

export async function platformName(): Promise<"android" | "ios" | "web"> {
  if (!hasWindow()) return "web";
  try {
    const { Capacitor } = await core();
    return Capacitor.getPlatform() as "android" | "ios" | "web";
  } catch {
    return "web";
  }
}

export type TorFetchOptions = {
  url: string;
  userAgent?: string;
  method?: "GET" | "POST";
  body?: string;
  socksUser?: string;
  socksPass?: string;
  socksHost?: string;
  socksPort?: number;
  browserMode?: boolean;
  allowAnyHttp?: boolean;
};

export type TorFetchResult = {
  status: number;
  body: string;
  base64?: string;
  contentType?: string;
  location?: string;
};

type TorHttpPlugin = {
  fetch: (opts: TorFetchOptions) => Promise<TorFetchResult>;
  purgeCookies: () => Promise<void>;
};

let torHttpPlugin: TorHttpPlugin | null = null;

/**
 * Fetch via Tor SOCKS5 proxy (Orbot localhost:9050) with remote DNS.
 * Bypasses system DNS entirely — Tor resolves the hostname.
 * Required for .onion addresses which no system DNS can resolve.
 * Supports GET and POST with a per-host cookie jar for captcha flows.
 */
export async function torFetch(
  url: string,
  userAgent: string,
  options?: {
    method?: "GET" | "POST";
    body?: string;
    browserMode?: boolean;
    allowAnyHttp?: boolean;
    socksAuth?:
      | { user: string; pass: string; host?: string | undefined; port?: number | undefined }
      | undefined;
  },
): Promise<TorFetchResult> {
  if (!torHttpPlugin) {
    const { registerPlugin } = await core();
    torHttpPlugin = registerPlugin<TorHttpPlugin>("PianoTorHttp");
  }
  const { socksAuth, ...rest } = options ?? {};
  return torHttpPlugin.fetch({
    url,
    userAgent,
    ...rest,
    ...(socksAuth
      ? {
          socksUser: socksAuth.user,
          socksPass: socksAuth.pass,
          ...(socksAuth.host ? { socksHost: socksAuth.host } : {}),
          ...(socksAuth.port ? { socksPort: socksAuth.port } : {}),
        }
      : {}),
  });
}

/**
 * Purge the per-host cookie jar in the native Tor HTTP plugin.
 * Called after each search completes to prevent cross-search cookie
 * correlation by onion sites. No-op on web preview (no plugin registered).
 */
export async function purgeTorCookies(): Promise<void> {
  if (!torHttpPlugin) {
    try {
      const { registerPlugin } = await core();
      torHttpPlugin = registerPlugin<TorHttpPlugin>("PianoTorHttp");
    } catch {
      return;
    }
  }
  await torHttpPlugin.purgeCookies();
}

/**
 * Share text via Android share sheet. Used for exporting bookmarks/results.
 * Falls back to clipboard copy on web preview.
 */
export async function shareText(text: string, title?: string): Promise<void> {
  if (await isNative()) {
    const { registerPlugin } = await core();
    const share = registerPlugin<{
      share: (opts: { title?: string | undefined; text: string }) => Promise<void>;
    }>("Share");
    await share.share({ title, text });
  } else if (hasWindow() && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
}

/**
 * Copy text to the clipboard. In the native WebView navigator.clipboard is a
 * secure-context API on https://localhost. Falls back to the share sheet
 * (which has its own copy target) when the clipboard is unavailable.
 * Returns true when the clipboard path was used.
 */
export async function copyText(text: string): Promise<boolean> {
  if (hasWindow() && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  await shareText(text);
  return false;
}
