import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  ChevronDown,
  Code,
  Compass,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  FileText,
  FolderDown,
  Globe,
  Home,
  Info,
  Lock,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Type,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import {
  ActionButton,
  Chip,
  ConsoleInput,
  EmptyState,
  ErrorNote,
  MicroLabel,
  Panel,
} from "@/components/app/primitives";
import {
  downloadFileSecurely,
  fetchBrowserUrl,
  getBrowserEpoch,
  getSessionDownloads,
  normalizeBrowserUrl,
  prepareSandboxedHtml,
  purgeBrowserDownloads,
  rotateBrowserIdentity,
  subscribeDownloads,
  triggerManualSave,
  type BrowserPageResponse,
  type DownloadedFileItem,
  type WebGLMode,
} from "@/lib/browser/browser-service";
import { ENGINES } from "@/lib/ghost/engines";
import { openExternal } from "@/lib/ghost/external";
import { isOnion } from "@/lib/ghost/parse";
import { stripTrackingParams } from "@/lib/ghost/tracking";
import { copyText, isNative, purgeTorCookies, shareText, torFetch } from "@/lib/platform/bridge";
import { useGhost } from "@/lib/store/ghost-context";

type ViewMode = "web" | "reader" | "source" | "inspect";

interface InAppBrowserProps {
  initialUrl?: string;
}

export function InAppBrowser({ initialUrl }: InAppBrowserProps) {
  const { settings, registerPurge, bookmarks, toggleBookmark, isBookmarked } = useGhost();

  const [addressInput, setAddressInput] = useState(initialUrl ?? "");
  const [history, setHistory] = useState<string[]>(() =>
    initialUrl ? [normalizeBrowserUrl(initialUrl)] : [],
  );
  const [historyIndex, setHistoryIndex] = useState<number>(() =>
    initialUrl ? 0 : -1,
  );
  const [page, setPage] = useState<BrowserPageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("web");

  // Advanced Browser Engine Features
  const [enableJs, setEnableJs] = useState(true);
  const [webglMode, setWebglMode] = useState<WebGLMode>("shielded");
  const [inlineAssets, setInlineAssets] = useState(true);
  const [immersiveView, setImmersiveView] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [readerFontSize, setReaderFontSize] = useState<number>(100);
  const [circuitEpoch, setCircuitEpoch] = useState<number>(() => getBrowserEpoch());
  const [downloading, setDownloading] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [showBrowserMenu, setShowBrowserMenu] = useState(false);
  const [showFindBar, setShowFindBar] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [iframeHeight, setIframeHeight] = useState<number | null>(null);

  const [downloads, setDownloads] = useState<DownloadedFileItem[]>(() =>
    getSessionDownloads(),
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastInitialRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    return subscribeDownloads(() => {
      setDownloads([...getSessionDownloads()]);
    });
  }, []);

  useEffect(() => {
    return registerPurge(() => {
      setPage(null);
      setHistory([]);
      setHistoryIndex(-1);
      setAddressInput("");
      setError(null);
      setFindTerm("");
      setShowFindBar(false);
      setFullscreen(false);
      purgeBrowserDownloads();
      setCircuitEpoch(getBrowserEpoch());
    });
  }, [registerPurge]);

  const socksConfig = useMemo(() => {
    const p = Number.parseInt(settings.torSocksPort ?? "", 10);
    return {
      host: settings.torSocksHost?.trim() || undefined,
      port: p >= 1 && p <= 65535 ? p : undefined,
    };
  }, [settings.torSocksHost, settings.torSocksPort]);

  const loadUrl = useCallback(
    async (
      rawTarget: string,
      pushHistory = true,
      reqOptions?: { method?: "GET" | "POST"; body?: string },
    ) => {
      const normalized = normalizeBrowserUrl(rawTarget);
      if (!normalized) return;

      setAddressInput(normalized);
      setLoading(true);
      setError(null);

      if (pushHistory) {
        setHistory((prev) => {
          const sliced = prev.slice(0, historyIndex + 1);
          if (sliced[sliced.length - 1] === normalized) return sliced;
          const next = [...sliced, normalized];
          setHistoryIndex(next.length - 1);
          return next;
        });
      }

      try {
        const res = await fetchBrowserUrl(normalized, socksConfig, {
          method: reqOptions?.method ?? "GET",
          body: reqOptions?.body,
          inlineSubresources: inlineAssets,
          enableJs,
        });
        setPage(res);
        setAddressInput(res.finalUrl);
        if (res.isDownloadable) {
          toast.info(`Detected downloadable file (${formatBytes(res.sizeBytes)})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setLoading(false);
      }
    },
    [historyIndex, socksConfig, inlineAssets, enableJs],
  );

  useEffect(() => {
    if (initialUrl && initialUrl !== lastInitialRef.current) {
      lastInitialRef.current = initialUrl;
      void loadUrl(initialUrl, true);
    }
  }, [initialUrl, loadUrl]);

  /* Handle in-iframe link navigation, form submits, height resize, and transparent AJAX requests */
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        url?: string;
        method?: "GET" | "POST";
        body?: string;
        height?: number;
        id?: string;
      } | null;

      if (!data) return;

      // 1. Link click or form submit inside sandboxed iframe
      if (data.type === "ghost-browser-nav" && typeof data.url === "string") {
        void loadUrl(data.url, true, {
          method: data.method ?? "GET",
          body: data.body,
        });
      }

      // 2. Iframe height report for dynamic card mode
      if (data.type === "ghost-iframe-height" && typeof data.height === "number") {
        setIframeHeight(Math.max(450, data.height));
      }

      // 3. Transparent AJAX / fetch routing over Tor SOCKS5
      if (data.type === "ghost-browser-ajax" && data.id && data.url) {
        const reqId = data.id;
        const targetUrl = data.url;
        const reqMethod = data.method ?? "GET";
        const reqBody = data.body;

        void (async () => {
          try {
            let resStatus = 200;
            let resBody = "";
            let resCt = "application/json";

            if (await isNative()) {
              const r = await torFetch(
                targetUrl,
                "Mozilla/5.0 (Android 10; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
                {
                  method: reqMethod,
                  body: reqBody,
                  allowAnyHttp: true,
                  browserMode: true,
                  socksAuth: {
                    user: `ghost-ajax-${circuitEpoch}`,
                    pass: new URL(targetUrl).hostname.slice(0, 32),
                    host: socksConfig.host,
                    port: socksConfig.port,
                  },
                },
              );
              resStatus = r.status;
              resBody = r.body ?? "";
              resCt = r.contentType ?? "application/json";
            } else {
              const resp = await fetch(targetUrl, {
                method: reqMethod,
                body: reqBody,
              });
              resStatus = resp.status;
              resBody = await resp.text();
              resCt = resp.headers.get("content-type") ?? "application/json";
            }

            iframeRef.current?.contentWindow?.postMessage(
              {
                type: "ghost-browser-ajax-res",
                id: reqId,
                status: resStatus,
                body: resBody,
                contentType: resCt,
              },
              "*",
            );
          } catch (err) {
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: "ghost-browser-ajax-res",
                id: reqId,
                error: err instanceof Error ? err.message : String(err),
              },
              "*",
            );
          }
        })();
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [loadUrl, circuitEpoch, socksConfig]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;

  const goBack = () => {
    if (!canGoBack) return;
    const prevIdx = historyIndex - 1;
    const target = history[prevIdx];
    if (target) {
      setHistoryIndex(prevIdx);
      void loadUrl(target, false);
    }
  };

  const goForward = () => {
    if (!canGoForward) return;
    const nextIdx = historyIndex + 1;
    const target = history[nextIdx];
    if (target) {
      setHistoryIndex(nextIdx);
      void loadUrl(target, false);
    }
  };

  const reloadCurrent = () => {
    const current = page?.finalUrl || addressInput;
    if (current) {
      void loadUrl(current, false);
    }
  };

  const goHome = () => {
    setPage(null);
    setAddressInput("");
    setError(null);
    setShowFindBar(false);
  };

  const handleNewTorIdentity = async () => {
    await purgeTorCookies();
    const nextEpoch = rotateBrowserIdentity();
    setCircuitEpoch(nextEpoch);
    toast.success(`New Tor Circuit (#${nextEpoch}) & Clean Cookie Jar`);
    const current = page?.finalUrl || addressInput;
    if (current) {
      void loadUrl(current, false);
    }
  };

  const handleDownloadCurrent = async () => {
    const target = page ?? addressInput.trim();
    if (!target) return;
    setDownloading(true);
    try {
      const item = await downloadFileSecurely(target, socksConfig);
      toast.success(
        `Downloaded ${item.filename} (${formatBytes(item.sizeBytes)}) · SHA-256 verified`,
      );
      setShowDownloads(true);
    } catch (err) {
      toast.error(
        `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDownloading(false);
    }
  };

  const handleOpenExternal = async () => {
    const target = page?.finalUrl || normalizeBrowserUrl(addressInput);
    if (!target) return;
    const { url } = stripTrackingParams(target);
    if (!isOnion(url)) {
      const proceed = window.confirm(
        "This link is NOT an onion address.\n\nOpening externally may use your default browser outside Tor.\n\nOpen anyway?",
      );
      if (!proceed) return;
    }
    const ok = await openExternal(url);
    if (!ok) {
      toast.error("No external browser available to handle this link");
    }
  };

  const handleCopyUrl = async () => {
    const target = page?.finalUrl || normalizeBrowserUrl(addressInput);
    if (!target) return;
    if (await copyText(target)) {
      toast.success("URL copied to clipboard");
    }
  };

  const handleShareUrl = async () => {
    const target = page?.finalUrl || normalizeBrowserUrl(addressInput);
    if (!target) return;
    await shareText(
      `${page?.title ? `${page.title}\n` : ""}${target}`,
      page?.title ?? "Ghost Browser Link",
    );
  };

  const togglePageBookmark = () => {
    const targetUrl = page?.finalUrl || addressInput.trim();
    if (!targetUrl) return;
    toggleBookmark({
      key: targetUrl,
      url: targetUrl,
      title: page?.title || targetUrl,
      engines: ["browser"],
      onion: isOnion(targetUrl),
    });
    if (isBookmarked(targetUrl)) {
      toast.info("Removed from bookmarks");
    } else {
      toast.success("Saved to session bookmarks");
    }
  };

  const cycleWebGLMode = () => {
    const nextMode: WebGLMode =
      webglMode === "shielded"
        ? "standard"
        : webglMode === "standard"
          ? "disabled"
          : "shielded";
    setWebglMode(nextMode);
    toast.info(
      nextMode === "standard"
        ? "WebGL: Standard (Hardware Accelerated)"
        : nextMode === "shielded"
          ? "WebGL: Shielded (Tor Anti-Fingerprint Spoof)"
          : "WebGL: Disabled",
    );
  };

  const sandboxedSrcDoc = useMemo(() => {
    if (!page || page.isDownloadable) return "";
    return prepareSandboxedHtml(page.body, page.finalUrl, enableJs, webglMode);
  }, [page, enableJs, webglMode]);

  const findMatchCount = useMemo(() => {
    if (!findTerm.trim() || !page) return 0;
    const haystack = (viewMode === "source" ? page.body : page.readerText || page.body).toLowerCase();
    const needle = findTerm.trim().toLowerCase();
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
      count += 1;
      pos += needle.length;
    }
    return count;
  }, [findTerm, page, viewMode]);

  const currentIsOnion = page ? page.isOnion : isOnion(addressInput);
  const isCurrentBookmarked = isBookmarked(page?.finalUrl || addressInput.trim());

  return (
    <div
      className={`space-y-2.5 transition-all duration-200 ${
        fullscreen ? "fixed inset-0 z-50 overflow-hidden bg-background p-2" : ""
      }`}
    >
      {/* Top Address & Unified Browser Console */}
      <Panel
        title={`tor browser · circuit #${circuitEpoch}`}
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleNewTorIdentity()}
              aria-label="Rotate Tor circuit identity and clear cookies"
              title="New Tor Circuit Identity"
              className="tap flex items-center gap-1 rounded border border-amber/40 bg-amber/15 px-2 py-0.5 font-mono text-[10px] text-amber hover:bg-amber/25"
            >
              <RotateCcw className="size-2.5" />
              <span className="hidden sm:inline">New Circuit</span>
            </button>

            {/* WebGL Mode Cycle Button */}
            <button
              type="button"
              onClick={cycleWebGLMode}
              aria-label="Cycle WebGL Mode (Standard / Shielded / Off)"
              title="WebGL graphics mode"
              className={`tap flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] transition-colors border ${
                webglMode === "standard"
                  ? "bg-amber/25 text-amber border-amber/50"
                  : webglMode === "shielded"
                    ? "bg-signal-green/20 text-signal-green border-signal-green/40"
                    : "bg-elevated text-dim border-border-subtle"
              }`}
            >
              <Cpu className="size-2.5" />
              <span>
                {webglMode === "standard"
                  ? "WebGL: Full"
                  : webglMode === "shielded"
                    ? "WebGL: Shield"
                    : "WebGL: Off"}
              </span>
            </button>

            {/* JavaScript Engine Toggle */}
            <button
              type="button"
              onClick={() => {
                setEnableJs((v) => !v);
                toast.info(!enableJs ? "JavaScript Enabled" : "JavaScript Blocked");
              }}
              aria-label="Toggle JavaScript execution in sandbox"
              className={`tap rounded px-2 py-0.5 font-mono text-[10px] font-medium transition-colors border ${
                enableJs
                  ? "bg-amber/20 text-amber border-amber/50"
                  : "bg-signal-green/15 text-signal-green border-signal-green/30"
              }`}
            >
              {enableJs ? "JS ON" : "JS OFF"}
            </button>

            {/* Fullscreen Toggle */}
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen reading"}
              className="tap hidden sm:flex size-6 items-center justify-center rounded border border-border-subtle bg-elevated text-dim hover:text-foreground"
            >
              {fullscreen ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
            </button>
          </div>
        }
      >
        <div className="space-y-2 p-2.5 sm:p-3">
          {/* Omnibar & URL input */}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (addressInput.trim()) void loadUrl(addressInput, true);
            }}
          >
            <button
              type="button"
              onClick={goHome}
              aria-label="Home / Speed Dial"
              title="Return to Directory & Speed Dial"
              className="tap flex size-9 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-elevated text-dim hover:text-foreground"
            >
              <Home className="size-4" />
            </button>

            <button
              type="button"
              onClick={goBack}
              disabled={!canGoBack || loading}
              aria-label="Back"
              className="tap flex size-9 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-elevated text-foreground disabled:opacity-30"
            >
              <ArrowLeft className="size-4" />
            </button>

            <button
              type="button"
              onClick={goForward}
              disabled={!canGoForward || loading}
              aria-label="Forward"
              className="tap flex size-9 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-elevated text-foreground disabled:opacity-30"
            >
              <ArrowRight className="size-4" />
            </button>

            <div className="relative flex-1">
              <ConsoleInput
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                placeholder="enter .onion URL, https:// link, or search term…"
                inputMode="url"
                enterKeyHint="go"
                className="min-h-9 py-1.5 pl-8 pr-16 text-xs"
              />
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
                {currentIsOnion ? (
                  <ShieldCheck className="size-3.5 text-signal-green" />
                ) : addressInput.startsWith("https://") ? (
                  <Lock className="size-3.5 text-signal-cyan" />
                ) : (
                  <Globe className="size-3.5 text-amber" />
                )}
              </span>

              <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                {addressInput.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAddressInput("")}
                    aria-label="Clear URL"
                    className="tap p-1 text-dim hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={togglePageBookmark}
                  aria-label={isCurrentBookmarked ? "Remove bookmark" : "Bookmark this site"}
                  className={`tap p-1 transition-colors ${
                    isCurrentBookmarked ? "text-amber" : "text-dim hover:text-foreground"
                  }`}
                >
                  <Bookmark
                    className="size-3.5"
                    fill={isCurrentBookmarked ? "currentColor" : "none"}
                  />
                </button>
              </div>
            </div>

            <ActionButton
              type="submit"
              disabled={loading || !addressInput.trim()}
              className="min-h-9 px-3 py-1 font-mono text-xs"
            >
              {loading ? <RefreshCw className="size-3.5 animate-spin" /> : "Go"}
            </ActionButton>
          </form>

          {/* Organized View Mode Switcher & Tool Controls */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-border-subtle pt-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setViewMode("web")}
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "web"
                    ? "bg-amber/25 text-amber font-medium"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Globe className="size-3.5" />
                <span>Web</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("reader")}
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "reader"
                    ? "bg-amber/25 text-amber font-medium"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <FileText className="size-3.5" />
                <span>Reader</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("source")}
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "source"
                    ? "bg-amber/25 text-amber font-medium"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Code className="size-3.5" />
                <span>Source</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("inspect")}
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1 font-mono text-xs transition-colors ${
                  viewMode === "inspect"
                    ? "bg-amber/25 text-amber font-medium"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Info className="size-3.5" />
                <span>Inspect</span>
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={reloadCurrent}
                disabled={loading || (!page && !addressInput.trim())}
                aria-label="Reload page"
                className="tap flex size-8 items-center justify-center rounded-md bg-elevated text-dim hover:text-foreground disabled:opacity-30"
              >
                <RefreshCw className={`size-3.5 ${loading ? "animate-spin text-amber" : ""}`} />
              </button>

              <button
                type="button"
                onClick={() => setImmersiveView((v) => !v)}
                title={immersiveView ? "Switch to card layout" : "Switch to immersive scrolling viewport"}
                className={`tap flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${
                  immersiveView
                    ? "bg-amber/20 text-amber border border-amber/40"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Maximize2 className="size-3" />
                <span className="hidden xs:inline">{immersiveView ? "Immersive" : "Card"}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowFindBar((v) => !v)}
                disabled={!page}
                aria-label="Find in page"
                className={`tap flex size-8 items-center justify-center rounded-md transition-colors disabled:opacity-30 ${
                  showFindBar ? "bg-amber/25 text-amber" : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Search className="size-3.5" />
              </button>

              <button
                type="button"
                onClick={() => void handleDownloadCurrent()}
                disabled={downloading || (!page && !addressInput.trim())}
                aria-label="Download page or file"
                className="tap flex items-center gap-1 rounded-md bg-amber/20 px-2 py-1 font-mono text-xs text-amber hover:bg-amber/30 disabled:opacity-30"
              >
                <Download className="size-3.5" />
                <span className="hidden sm:inline">{downloading ? "Saving…" : "Save"}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowDownloads((v) => !v)}
                aria-label="Toggle downloads drawer"
                className={`tap flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs transition-colors ${
                  showDownloads || downloads.length > 0
                    ? "bg-amber/20 text-amber border border-amber/40"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <FolderDown className="size-3.5" />
                <span>{downloads.length}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowBrowserMenu((v) => !v)}
                aria-label="More browser options"
                className={`tap flex size-8 items-center justify-center rounded-md transition-colors ${
                  showBrowserMenu
                    ? "bg-amber/25 text-amber"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </div>
          </div>

          {/* Reader Mode Font Zoom Bar */}
          {viewMode === "reader" && (
            <div className="flex items-center justify-between border-t border-border-subtle pt-2">
              <div className="flex items-center gap-1.5 font-mono text-xs text-dim">
                <Type className="size-3.5" />
                <span>Text Size: {readerFontSize}%</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setReaderFontSize((s) => Math.max(80, s - 10))}
                  className="tap rounded bg-elevated px-2 py-0.5 font-mono text-xs text-foreground"
                >
                  A-
                </button>
                <button
                  type="button"
                  onClick={() => setReaderFontSize(100)}
                  className="tap rounded bg-elevated px-2 py-0.5 font-mono text-xs text-foreground"
                >
                  100%
                </button>
                <button
                  type="button"
                  onClick={() => setReaderFontSize((s) => Math.min(160, s + 10))}
                  className="tap rounded bg-elevated px-2 py-0.5 font-mono text-xs text-foreground"
                >
                  A+
                </button>
              </div>
            </div>
          )}

          {/* Find in Page Bar */}
          {showFindBar && page && (
            <div className="flex items-center gap-2 border-t border-border-subtle pt-2 animate-rise">
              <ConsoleInput
                value={findTerm}
                onChange={(e) => setFindTerm(e.target.value)}
                placeholder="Find text in document…"
                className="min-h-8 py-1 text-xs"
              />
              <MicroLabel className="shrink-0">
                {findTerm.trim() ? `${findMatchCount} matches` : "type to find"}
              </MicroLabel>
              <button
                type="button"
                onClick={() => {
                  setFindTerm("");
                  setShowFindBar(false);
                }}
                className="tap p-1 text-dim hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* Expandable Browser Settings Menu */}
          {showBrowserMenu && (
            <div className="space-y-2.5 rounded-md border border-border-subtle bg-elevated/60 p-3 animate-rise">
              <div className="flex items-center justify-between">
                <MicroLabel>Tor Transport & Browser Configuration</MicroLabel>
                <button
                  type="button"
                  onClick={() => setShowBrowserMenu(false)}
                  className="tap text-dim hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setInlineAssets((v) => !v)}
                  className={`tap flex items-center justify-between rounded border p-2 font-mono text-[11px] ${
                    inlineAssets
                      ? "border-signal-green/40 bg-signal-green/15 text-signal-green"
                      : "border-border-subtle bg-panel text-dim"
                  }`}
                >
                  <span>Tor Asset Proxy</span>
                  <span>{inlineAssets ? "ON" : "OFF"}</span>
                </button>
                <button
                  type="button"
                  onClick={cycleWebGLMode}
                  className={`tap flex items-center justify-between rounded border p-2 font-mono text-[11px] ${
                    webglMode === "standard"
                      ? "border-amber/50 bg-amber/15 text-amber"
                      : webglMode === "shielded"
                        ? "border-signal-green/40 bg-signal-green/15 text-signal-green"
                        : "border-border-subtle bg-panel text-dim"
                  }`}
                >
                  <span>WebGL Engine</span>
                  <span className="uppercase">{webglMode}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEnableJs((v) => !v)}
                  className={`tap flex items-center justify-between rounded border p-2 font-mono text-[11px] ${
                    enableJs
                      ? "border-amber/50 bg-amber/15 text-amber"
                      : "border-signal-green/40 bg-signal-green/15 text-signal-green"
                  }`}
                >
                  <span>JavaScript</span>
                  <span>{enableJs ? "ENABLED" : "BLOCKED"}</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2">
                <button
                  type="button"
                  onClick={() => void handleCopyUrl()}
                  disabled={!page && !addressInput.trim()}
                  className="tap flex items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground hover:bg-amber/15 hover:text-amber disabled:opacity-30"
                >
                  <Copy className="size-3.5" />
                  <span>Copy Link</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleShareUrl()}
                  disabled={!page && !addressInput.trim()}
                  className="tap flex items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground hover:bg-amber/15 hover:text-amber disabled:opacity-30"
                >
                  <Share2 className="size-3.5" />
                  <span>Share</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenExternal()}
                  disabled={!page && !addressInput.trim()}
                  className="tap flex items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground hover:bg-amber/15 hover:text-amber disabled:opacity-30"
                >
                  <ExternalLink className="size-3.5" />
                  <span>External Tor Browser</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </Panel>

      {/* Session Downloads Drawer */}
      {showDownloads && (
        <Panel
          title={`secure downloads (${downloads.length}) · sha-256 verified`}
          action={
            <div className="flex items-center gap-2">
              {downloads.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    purgeBrowserDownloads();
                    toast.info("Cleared session downloads");
                  }}
                  className="tap flex items-center gap-1 font-mono text-[10px] text-signal-red hover:underline"
                >
                  <Trash2 className="size-3" />
                  <span>Purge</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowDownloads(false)}
                className="tap text-dim hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          }
        >
          {downloads.length === 0 ? (
            <div className="p-4 text-center font-mono text-xs text-dim">
              No files downloaded this session. Use the Save button on any page or document link.
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle max-h-64 overflow-y-auto">
              {downloads.map((item) => (
                <li key={item.id} className="space-y-1.5 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-medium text-foreground">
                      {item.filename}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <MicroLabel>
                        {formatBytes(item.sizeBytes)} · {item.mimeType}
                      </MicroLabel>
                      <button
                        type="button"
                        onClick={() => triggerManualSave(item)}
                        className="tap rounded bg-amber/20 px-2 py-0.5 font-mono text-[10px] text-amber hover:bg-amber/30"
                      >
                        Save File
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded bg-elevated/60 px-2 py-1 font-mono text-[10px]">
                    <span className="truncate text-dim">
                      SHA-256: <span className="text-foreground/90">{item.sha256}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void copyText(item.sha256);
                        toast.success("SHA-256 copied");
                      }}
                      className="tap shrink-0 text-amber hover:underline"
                    >
                      copy
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {/* Error Note */}
      {error && (
        <ErrorNote>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono text-xs">{error}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleNewTorIdentity()}
                className="tap rounded bg-amber/20 px-2 py-1 font-mono text-xs text-amber"
              >
                Rotate Circuit
              </button>
              <button
                type="button"
                onClick={reloadCurrent}
                className="tap rounded bg-signal-red/20 px-2.5 py-1 font-mono text-xs text-signal-red"
              >
                Retry
              </button>
            </div>
          </div>
        </ErrorNote>
      )}

      {/* Loading Bar */}
      {loading && (
        <Panel title="routing over isolated tor socks5 circuit…">
          <div className="flex items-center gap-3 p-4">
            <RefreshCw className="size-4 animate-spin text-amber" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-foreground">{addressInput}</p>
              <p className="mt-0.5 font-mono text-[10px] text-dim">
                Isolated SOCKS5 stream (#{circuitEpoch}) · remote DNS resolution active
              </p>
            </div>
          </div>
        </Panel>
      )}

      {/* Active Page Content View */}
      {page && !loading && (
        <Panel
          title={page.title || "untitled document"}
          action={
            <div className="flex items-center gap-1.5">
              {page.isOnion ? (
                <Chip signal="green">
                  <Lock className="size-2.5" />
                  <span>v3 .onion</span>
                </Chip>
              ) : (
                <Chip signal="amber">
                  <ShieldAlert className="size-2.5" />
                  <span>clearnet via Tor</span>
                </Chip>
              )}
              <MicroLabel>
                HTTP {page.status} · {formatBytes(page.sizeBytes)}
              </MicroLabel>
            </div>
          }
        >
          {page.isDownloadable ? (
            <div className="space-y-3 p-5 text-center">
              <Download className="mx-auto size-8 text-amber" />
              <div className="space-y-1">
                <p className="font-mono text-sm font-medium text-foreground">{page.title}</p>
                <p className="font-mono text-xs text-dim">
                  {page.contentType} · {formatBytes(page.sizeBytes)}
                </p>
              </div>
              <div className="flex justify-center gap-2 pt-2">
                <ActionButton
                  onClick={() => void handleDownloadCurrent()}
                  disabled={downloading}
                >
                  <Download className="size-4" />
                  <span>
                    {downloading ? "Verifying & Saving…" : "Download & Verify SHA-256"}
                  </span>
                </ActionButton>
              </div>
            </div>
          ) : viewMode === "web" ? (
            <div
              className={`bg-background transition-all duration-200 ${
                immersiveView
                  ? fullscreen
                    ? "h-[calc(100dvh-120px)]"
                    : "h-[calc(100dvh-230px)] sm:h-[calc(100dvh-250px)]"
                  : ""
              }`}
            >
              <iframe
                ref={iframeRef}
                title={page.title || "Sandboxed Onion Page"}
                srcDoc={sandboxedSrcDoc}
                sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-modals allow-popups"
                referrerPolicy="no-referrer"
                style={{
                  height: immersiveView
                    ? "100%"
                    : iframeHeight
                      ? `${iframeHeight}px`
                      : "75dvh",
                }}
                className="w-full border-0 bg-background touch-pan-y"
              />
            </div>
          ) : viewMode === "reader" ? (
            <div
              className="p-4 overflow-y-auto max-h-[70dvh]"
              style={{ fontSize: `${readerFontSize}%` }}
            >
              {page.readerText ? (
                <article className="space-y-3 font-sans text-sm leading-relaxed text-foreground/95 whitespace-pre-wrap">
                  {page.readerText}
                </article>
              ) : (
                <p className="font-mono text-xs text-dim">
                  No readable article text extracted from this page. Switch to Web or Source view.
                </p>
              )}
            </div>
          ) : viewMode === "source" ? (
            <div className="overflow-x-auto bg-elevated/50 p-3.5 max-h-[70dvh] overflow-y-auto">
              <pre className="font-mono text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-all">
                {page.body}
              </pre>
            </div>
          ) : (
            /* Inspect Mode */
            <div className="space-y-3 p-4 font-mono text-xs">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded border border-border-subtle bg-elevated/40 p-2.5">
                  <p className="text-[10px] text-dim">Target URL</p>
                  <p className="break-all font-medium text-foreground">{page.finalUrl}</p>
                </div>
                <div className="rounded border border-border-subtle bg-elevated/40 p-2.5">
                  <p className="text-[10px] text-dim">HTTP Status</p>
                  <p className="font-medium text-signal-green">{page.status} OK</p>
                </div>
                <div className="rounded border border-border-subtle bg-elevated/40 p-2.5">
                  <p className="text-[10px] text-dim">Content-Type</p>
                  <p className="font-medium text-foreground">{page.contentType}</p>
                </div>
                <div className="rounded border border-border-subtle bg-elevated/40 p-2.5">
                  <p className="text-[10px] text-dim">Payload Size</p>
                  <p className="font-medium text-foreground">{formatBytes(page.sizeBytes)}</p>
                </div>
                <div className="rounded border border-border-subtle bg-elevated/40 p-2.5">
                  <p className="text-[10px] text-dim">Tor Circuit Stream</p>
                  <p className="font-medium text-amber">Circuit #{circuitEpoch} (Stream Isolated)</p>
                </div>
                <div className="rounded border border-border-subtle bg-elevated/40 p-2.5">
                  <p className="text-[10px] text-dim">Active WebGL Engine</p>
                  <p className="font-medium text-foreground uppercase">{webglMode}</p>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <ActionButton onClick={() => void handleCopyUrl()}>
                  <Copy className="size-3.5" />
                  <span>Copy Page URL</span>
                </ActionButton>
                <button
                  type="button"
                  onClick={() => void handleOpenExternal()}
                  className="tap rounded-md border border-border-subtle bg-elevated px-3 py-1 text-foreground hover:bg-elevated/80"
                >
                  Open in External Tor Browser
                </button>
              </div>
            </div>
          )}
        </Panel>
      )}

      {/* Speed Dial & Onion Directory when idle */}
      {!page && !loading && (
        <div className="space-y-3">
          <EmptyState
            title="Ghost Tor Browser Ready"
            hint="Browse .onion services and clearnet links anonymously. Features per-host SOCKS5 circuit isolation, standard & shielded WebGL support, responsive mobile scrolling, and SHA-256 verified downloads."
          />

          {bookmarks.length > 0 && (
            <Panel title={`session bookmarks (${bookmarks.length})`}>
              <ul className="divide-y divide-border-subtle max-h-56 overflow-y-auto">
                {bookmarks.map((bm) => (
                  <li key={bm.key} className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                    <button
                      type="button"
                      onClick={() => void loadUrl(bm.url, true)}
                      className="tap min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-xs font-medium text-foreground">{bm.title}</p>
                      <p className="truncate font-mono text-[11px] text-amber/80">{bm.url}</p>
                    </button>
                    <Chip signal="amber" onClick={() => void loadUrl(bm.url, true)}>
                      Browse
                    </Chip>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="verified onion search indexers">
            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {ENGINES.map((engine) => {
                const origin = (() => {
                  try {
                    return new URL(engine.template).origin;
                  } catch {
                    return engine.template;
                  }
                })();
                return (
                  <button
                    key={engine.id}
                    type="button"
                    onClick={() => void loadUrl(origin, true)}
                    className="tap flex flex-col justify-between rounded-md border border-border-subtle bg-elevated/50 p-3 text-left transition-colors hover:border-amber/50 hover:bg-amber/5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        {engine.name}
                      </span>
                      <Chip signal="green">v3 .onion</Chip>
                    </div>
                    <p className="mt-1 line-clamp-1 font-mono text-[10px] text-amber/80">
                      {origin}
                    </p>
                    <p className="mt-1 line-clamp-1 text-[11px] text-dim">{engine.note}</p>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel title="curated privacy & osint directories">
            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {[
                {
                  name: "Tor Project Onion",
                  url: "http://2gzyxa5ihm7nsggfxnu52r24pvpmfcetudq5u2wwwgnhznqcqqqiojad.onion",
                  desc: "Official Tor Project onion portal and documentation",
                },
                {
                  name: "Dark.fail Directory",
                  url: "http://darkfailenqgahkg1somivo04enqgahkg1somivo04enqgahkg1so.onion",
                  desc: "PGP-verified darknet onion link directory and uptime status",
                },
                {
                  name: "TorTaxi Links",
                  url: "http://tortaxi2dev6xjwqlbihpnugnqqqlbihpnugnqqqlbihpnugnqq.onion",
                  desc: "Cryptographically verified directory of hidden services",
                },
                {
                  name: "ProPublica Onion",
                  url: "http://p53lf57qovyuvwsc6xnrppyply3vtqm7l6pcobkmyqsiofyeznfu5uqd.onion",
                  desc: "Pulitzer-winning investigative journalism publication",
                },
              ].map((site) => (
                <button
                  key={site.name}
                  type="button"
                  onClick={() => void loadUrl(site.url, true)}
                  className="tap flex flex-col justify-between rounded-md border border-border-subtle bg-elevated/40 p-3 text-left transition-colors hover:border-amber/50 hover:bg-amber/5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-foreground">
                      {site.name}
                    </span>
                    <Chip signal="amber">Directory</Chip>
                  </div>
                  <p className="mt-1 line-clamp-1 font-mono text-[10px] text-amber/80">
                    {site.url}
                  </p>
                  <p className="mt-1 text-[11px] text-dim">{site.desc}</p>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}
