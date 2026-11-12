import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  FolderDown,
  Globe,
  Lock,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
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
} from "@/lib/browser/browser-service";
import { ENGINES } from "@/lib/ghost/engines";
import { openExternal } from "@/lib/ghost/external";
import { isOnion } from "@/lib/ghost/parse";
import { stripTrackingParams } from "@/lib/ghost/tracking";
import { copyText, purgeTorCookies, shareText } from "@/lib/platform/bridge";
import { useGhost } from "@/lib/store/ghost-context";

type ViewMode = "web" | "reader" | "source";

interface InAppBrowserProps {
  initialUrl?: string;
}

export function InAppBrowser({ initialUrl }: InAppBrowserProps) {
  const { settings, registerPurge, bookmarks } = useGhost();

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
  const [enableJs, setEnableJs] = useState(false);
  const [blockWebgl, setBlockWebgl] = useState(true);
  const [inlineAssets, setInlineAssets] = useState(true);
  const [circuitEpoch, setCircuitEpoch] = useState<number>(() => getBrowserEpoch());
  const [downloading, setDownloading] = useState(false);
  const [showDownloads, setShowDownloads] = useState(false);
  const [showBrowserMenu, setShowBrowserMenu] = useState(false);
  const [showFindBar, setShowFindBar] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [downloads, setDownloads] = useState<DownloadedFileItem[]>(() =>
    getSessionDownloads(),
  );

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
    [historyIndex, socksConfig, inlineAssets],
  );

  useEffect(() => {
    if (initialUrl && initialUrl !== lastInitialRef.current) {
      lastInitialRef.current = initialUrl;
      void loadUrl(initialUrl, true);
    }
  }, [initialUrl, loadUrl]);

  /* Listen for link clicks and GET/POST form submissions inside the sandboxed iframe */
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        url?: string;
        method?: "GET" | "POST";
        body?: string;
      } | null;
      if (data && data.type === "ghost-browser-nav" && typeof data.url === "string") {
        void loadUrl(data.url, true, {
          method: data.method ?? "GET",
          body: data.body,
        });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [loadUrl]);

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

  const handleNewTorIdentity = async () => {
    await purgeTorCookies();
    const nextEpoch = rotateBrowserIdentity();
    setCircuitEpoch(nextEpoch);
    toast.success(`New Tor Circuit Identity (#${nextEpoch}) & Cookie Jar Purged`);
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

  const sandboxedSrcDoc = useMemo(() => {
    if (!page || page.isDownloadable) return "";
    return prepareSandboxedHtml(page.body, page.finalUrl, enableJs, blockWebgl);
  }, [page, enableJs, blockWebgl]);

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

  return (
    <div className="space-y-3">
      {/* Top Address & Navigation Console */}
      <Panel
        title={`tor browser · circuit #${circuitEpoch}`}
        action={
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleNewTorIdentity()}
              aria-label="Rotate Tor circuit identity and clear cookies"
              title="New Tor Circuit Identity"
              className="tap flex items-center gap-1 rounded border border-amber/40 bg-amber/15 px-2 py-0.5 font-mono text-[10px] text-amber hover:bg-amber/25"
            >
              <RotateCcw className="size-2.5" />
              <span>New Circuit</span>
            </button>
            <button
              type="button"
              onClick={() => setBlockWebgl((v) => !v)}
              aria-label="Toggle WebGL & Canvas anti-fingerprinting shield"
              className={`tap flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
                blockWebgl
                  ? "bg-signal-green/15 text-signal-green border border-signal-green/30"
                  : "bg-amber/20 text-amber border border-amber/40"
              }`}
            >
              <Cpu className="size-2.5" />
              <span>{blockWebgl ? "WebGL Shield" : "WebGL On"}</span>
            </button>
            <button
              type="button"
              onClick={() => setEnableJs((v) => !v)}
              aria-label="Toggle JavaScript execution in sandbox"
              className={`tap rounded px-2 py-0.5 font-mono text-[10px] transition-colors ${
                enableJs
                  ? "bg-signal-red/20 text-signal-red border border-signal-red/40"
                  : "bg-signal-green/15 text-signal-green border border-signal-green/30"
              }`}
            >
              {enableJs ? "JS ON" : "JS OFF"}
            </button>
          </div>
        }
      >
        <div className="space-y-2.5 p-3">
          {/* Navigation Bar */}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (addressInput.trim()) void loadUrl(addressInput, true);
            }}
          >
            <button
              type="button"
              onClick={goBack}
              disabled={!canGoBack || loading}
              aria-label="Back"
              className="tap flex size-10 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-elevated text-foreground disabled:opacity-35"
            >
              <ArrowLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={goForward}
              disabled={!canGoForward || loading}
              aria-label="Forward"
              className="tap flex size-10 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-elevated text-foreground disabled:opacity-35"
            >
              <ArrowRight className="size-4" />
            </button>
            <div className="relative flex-1">
              <ConsoleInput
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                placeholder="enter .onion URL, https:// link, or search…"
                inputMode="url"
                enterKeyHint="go"
                className="min-h-10 py-1.5 pl-8 pr-8 text-xs"
              />
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
                {currentIsOnion ? (
                  <ShieldCheck className="size-3.5 text-signal-green" />
                ) : (
                  <Globe className="size-3.5 text-amber" />
                )}
              </span>
              {addressInput.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAddressInput("")}
                  aria-label="Clear URL"
                  className="tap absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <ActionButton
              type="submit"
              disabled={loading || !addressInput.trim()}
              className="min-h-10 px-3 py-1.5"
            >
              {loading ? "…" : "Go"}
            </ActionButton>
          </form>

          {/* Organized Mode Switcher & Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setViewMode("web")}
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ${
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
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ${
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
                className={`tap flex items-center gap-1 rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors ${
                  viewMode === "source"
                    ? "bg-amber/25 text-amber font-medium"
                    : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Code className="size-3.5" />
                <span>Source</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={reloadCurrent}
                disabled={loading || (!page && !addressInput.trim())}
                aria-label="Reload page"
                className="tap flex size-8 items-center justify-center rounded-md bg-elevated text-dim hover:text-foreground disabled:opacity-40"
              >
                <RefreshCw className={`size-3.5 ${loading ? "animate-spin text-amber" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => setShowFindBar((v) => !v)}
                disabled={!page}
                aria-label="Find in page"
                className={`tap flex size-8 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
                  showFindBar ? "bg-amber/25 text-amber" : "bg-elevated text-dim hover:text-foreground"
                }`}
              >
                <Search className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadCurrent()}
                disabled={downloading || (!page && !addressInput.trim())}
                aria-label="Securely download current page or file"
                className="tap flex items-center gap-1 rounded-md bg-amber/20 px-2.5 py-1.5 font-mono text-xs text-amber hover:bg-amber/30 disabled:opacity-40"
              >
                <Download className="size-3.5" />
                <span>{downloading ? "Saving…" : "Download"}</span>
              </button>
              <button
                type="button"
                onClick={() => setShowDownloads((v) => !v)}
                aria-label="Toggle session downloads drawer"
                className={`tap flex items-center gap-1 rounded-md px-2 py-1.5 font-mono text-xs transition-colors ${
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

          {/* Find in Page Bar */}
          {showFindBar && page && (
            <div className="flex items-center gap-2 border-t border-border-subtle pt-2">
              <ConsoleInput
                value={findTerm}
                onChange={(e) => setFindTerm(e.target.value)}
                placeholder="Find in page text or source…"
                className="min-h-9 py-1 text-xs"
              />
              <MicroLabel className="shrink-0">
                {findTerm.trim() ? `${findMatchCount} matches` : "type to search"}
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

          {/* Expandable Browser Tools & Security Menu */}
          {showBrowserMenu && (
            <div className="space-y-2.5 rounded-md border border-border-subtle bg-elevated/50 p-3 animate-rise">
              <div className="flex items-center justify-between">
                <MicroLabel>Browser Security & Transport Controls</MicroLabel>
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
                  <span>Tor CSS/Img Proxy</span>
                  <span>{inlineAssets ? "ON" : "OFF"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBlockWebgl((v) => !v)}
                  className={`tap flex items-center justify-between rounded border p-2 font-mono text-[11px] ${
                    blockWebgl
                      ? "border-signal-green/40 bg-signal-green/15 text-signal-green"
                      : "border-amber/40 bg-amber/15 text-amber"
                  }`}
                >
                  <span>WebGL/WebRTC Lock</span>
                  <span>{blockWebgl ? "LOCKED" : "OPEN"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setEnableJs((v) => !v)}
                  className={`tap flex items-center justify-between rounded border p-2 font-mono text-[11px] ${
                    !enableJs
                      ? "border-signal-green/40 bg-signal-green/15 text-signal-green"
                      : "border-signal-red/40 bg-signal-red/15 text-signal-red"
                  }`}
                >
                  <span>JavaScript Engine</span>
                  <span>{enableJs ? "ENABLED" : "BLOCKED"}</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-2">
                <button
                  type="button"
                  onClick={() => void handleCopyUrl()}
                  disabled={!page && !addressInput.trim()}
                  className="tap flex items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground hover:bg-amber/15 hover:text-amber disabled:opacity-40"
                >
                  <Copy className="size-3.5" />
                  <span>Copy Clean Link</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleShareUrl()}
                  disabled={!page && !addressInput.trim()}
                  className="tap flex items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground hover:bg-amber/15 hover:text-amber disabled:opacity-40"
                >
                  <Share2 className="size-3.5" />
                  <span>Share</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenExternal()}
                  disabled={!page && !addressInput.trim()}
                  className="tap flex items-center gap-1.5 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-foreground hover:bg-amber/15 hover:text-amber disabled:opacity-40"
                >
                  <ExternalLink className="size-3.5" />
                  <span>Open in Tor Browser</span>
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
              No files downloaded this session. Use the Download button on any page or file link.
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {downloads.map((item) => (
                <li key={item.id} className="space-y-1.5 px-3.5 py-2.5">
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
                        Save / Export
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
                        toast.success("SHA-256 hash copied");
                      }}
                      className="tap shrink-0 text-amber hover:underline"
                    >
                      copy hash
                    </button>
                  </div>
                  {item.savedUri && (
                    <p className="truncate font-mono text-[10px] text-signal-green">
                      Saved to device: {item.savedUri}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {/* Error Banner */}
      {error && (
        <ErrorNote>
          <div className="flex items-center justify-between gap-2">
            <span>{error}</span>
            <button
              type="button"
              onClick={reloadCurrent}
              className="tap shrink-0 rounded bg-signal-red/20 px-2 py-1 font-mono text-xs text-signal-red"
            >
              Retry
            </button>
          </div>
        </ErrorNote>
      )}

      {/* Loading Indicator */}
      {loading && (
        <Panel title="fetching over tor socks5 circuit…">
          <div className="flex items-center gap-3 p-4">
            <RefreshCw className="size-4 animate-spin text-amber" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-foreground">{addressInput}</p>
              <p className="mt-0.5 font-mono text-[10px] text-dim">
                Routing via isolated SOCKS5 stream (#{circuitEpoch}) · remote DNS & Tor asset proxy active
              </p>
            </div>
          </div>
        </Panel>
      )}

      {/* Active Page Content */}
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
            <div className="bg-background">
              {/* Note: allow-scripts is enabled so the injected link/form interceptor and WebGL/WebRTC shield execute; site <script> tags are stripped unless JS ON is selected */}
              <iframe
                title={page.title || "Sandboxed Onion Page"}
                srcDoc={sandboxedSrcDoc}
                sandbox="allow-scripts allow-forms"
                referrerPolicy="no-referrer"
                className="min-h-[70dvh] w-full border-0 bg-background"
              />
            </div>
          ) : viewMode === "reader" ? (
            <div className="p-4">
              {page.readerText ? (
                <article className="space-y-3 font-sans text-sm leading-relaxed text-foreground/95 whitespace-pre-wrap">
                  {page.readerText}
                </article>
              ) : (
                <p className="font-mono text-xs text-dim">
                  No readable article text extracted from this page. Switch to Web or Source mode.
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto bg-elevated/50 p-3.5">
              <pre className="font-mono text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-all">
                {page.body}
              </pre>
            </div>
          )}
        </Panel>
      )}

      {/* Speed Dial / Directory when idle */}
      {!page && !loading && (
        <div className="space-y-3">
          <EmptyState
            title="Built-in Tor Browser Ready"
            hint="Browse any .onion or web link directly inside Ghost. Traffic routes through Orbot SOCKS5 with per-host stream isolation, Tor CSS/image inlining, WebGL/WebRTC fingerprint shields, and SHA-256 verified file downloads."
          />

          {bookmarks.length > 0 && (
            <Panel title={`session bookmarks (${bookmarks.length})`}>
              <ul className="divide-y divide-border-subtle">
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

          <Panel title="verified onion indexers & directories">
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
                      <Chip signal="amber">.onion</Chip>
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
