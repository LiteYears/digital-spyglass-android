import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  Copy,
  ExternalLink,
  Globe,
  Search as SearchIcon,
  Share2,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AppShell } from "@/components/app/app-shell";
import {
  ActionButton,
  Chip,
  ConsoleInput,
  EmptyState,
  ErrorNote,
  MicroLabel,
  Panel,
} from "@/components/app/primitives";
import { ENGINES, enginesForFastMode } from "@/lib/ghost/engines";
import { isDeprecated, isOpen } from "@/lib/ghost/breaker";
import { openExternal } from "@/lib/ghost/external";
import {
  enrichPgpEntities,
  formatFingerprint,
  normalizePgpBlock,
  type PgpEnrichment,
} from "@/lib/ghost/pgp";
import { stripTrackingParams } from "@/lib/ghost/tracking";
import { entityLabel } from "@/lib/ghost/entities";
import { highlightText } from "@/lib/ghost/highlight";
import { isOnion } from "@/lib/ghost/parse";
import { parseQuery } from "@/lib/ghost/query";
import { filterAndSort, searchAllEngines, type SearchProgress } from "@/lib/ghost/search";
import { resultsToCSV, resultsToSTIX } from "@/lib/ghost/stix";
import { summarizeRows, type ExtractiveSummary } from "@/lib/ghost/summarize";
import {
  GhostError,
  type EntityBadge,
  type EngineReport,
  type ResultRow,
  type SearchOutcome,
} from "@/lib/ghost/types";
import { buildReuseIndex, entityBadgeDetail, lookupReuse } from "@/lib/ghost/wallet";
import { copyText, shareText } from "@/lib/platform/bridge";
import { useGhost } from "@/lib/store/ghost-context";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ghost — transient onion search aggregator" },
      {
        name: "description",
        content:
          "Query several onion search engines at once. Results live in RAM only, links open in Tor Browser, nothing is ever stored on the device.",
      },
      { property: "og:title", content: "Ghost — transient onion search aggregator" },
      {
        property: "og:description",
        content: "Meta search across onion engines. Zero persistence, no content rendering.",
      },
    ],
  }),
  component: SearchScreen,
});

const FAST_ENGINE_SET = new Set(enginesForFastMode());

function SearchScreen() {
  const {
    settings,
    updateSettings,
    egressOk,
    registerPurge,
    searchQuery,
    searchOutcome,
    setSearchQuery,
    setSearchOutcome,
    getSessionEpoch,
    bookmarks,
    toggleBookmark,
    isBookmarked,
    filter,
    setFilter,
    logQuery,
  } = useGhost();
  const navigate = useNavigate();
  const query = searchQuery;
  const outcome = searchOutcome;
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
  /* RAM-only extractive summary derived from the current outcome rows. */
  const [summary, setSummary] = useState<ExtractiveSummary | null>(null);
  /* RAM-only passive PGP index (fingerprints + cross-host reuse) — async. */
  const [pgpIndex, setPgpIndex] = useState<Map<string, PgpEnrichment> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const parsedQuery = useMemo(() => parseQuery(query), [query]);

  /* RAM-only progress store: registered so panic purge can empty it. */
  useEffect(
    () =>
      registerPurge(() => {
        setProgress(null);
        setSummary(null);
        setPgpIndex(null);
        setResultsCollapsed(false);
        abortRef.current?.abort();
        abortRef.current = null;
      }),
    [registerPurge],
  );

  /* Passive PGP enrichment: fingerprints for key blocks already in the
     snippets — no fetching, local parse only, recomputed per outcome. */
  useEffect(() => {
    setPgpIndex(null);
    if (!outcome) return;
    let disposed = false;
    void enrichPgpEntities(outcome.rows)
      .then((index) => {
        if (!disposed) setPgpIndex(index);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [outcome]);

  const run = useMutation({
    mutationFn: async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const startEpoch = getSessionEpoch();
      const data = await searchAllEngines({
        query,
        engineIds: settings.engines,
        snippetFilter: settings.snippetFilter,
        torSocks: {
          host: settings.torSocksHost?.trim() || undefined,
          port: (() => {
            const p = Number.parseInt(settings.torSocksPort ?? "", 10);
            return p >= 1 && p <= 65535 ? p : undefined;
          })(),
        },
        paranoidMode: settings.paranoidMode,
        fastMode: settings.fastMode,
        qarfMode: settings.qarfMode,
        blacklistFilter: settings.blacklistFilter,
        allowClearnet: settings.allowClearnet,
        signal: controller.signal,
        onProgress: (prog) => {
          if (!controller.signal.aborted && getSessionEpoch() === startEpoch) {
            setProgress(prog);
          }
        },
      });
      return { data, startEpoch, aborted: controller.signal.aborted };
    },
    onMutate: () => {
      setProgress(null);
      setSearchOutcome(null);
      setSummary(null);
    },
    onSuccess: ({ data, startEpoch, aborted }) => {
      if (aborted || getSessionEpoch() !== startEpoch) return;
      setSearchOutcome(data);
      setProgress(null);
      /* Append to the RAM-only session timeline (graph tab). */
      const entityCount = new Set(
        data.rows.flatMap((r) =>
          (r.entities ?? []).map((e) => `${e.type}:${e.value.toLowerCase()}`),
        ),
      ).size;
      logQuery({
        ts: data.startedAt,
        query: data.query,
        resultCount: data.rows.length,
        entityCount,
        engines: data.reports.filter((r) => r.state.status === "ok").map((r) => r.id),
      });
    },
  });

  const rawRows = useMemo(
    () => outcome?.rows ?? progress?.rows ?? [],
    [outcome?.rows, progress?.rows],
  );
  const rows = useMemo(
    () => (outcome ? filterAndSort(rawRows, filter) : rawRows),
    [rawRows, filter, outcome],
  );
  /* Wallet-reuse lookup over the final correlation report (outcome only —
     streaming progress carries rows, not correlation). */
  const reuseIndex = useMemo(
    () => buildReuseIndex(outcome?.correlation?.clusters ?? []),
    [outcome?.correlation],
  );
  const liveReports = progress?.reports ?? outcome?.reports ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 124,
    overscan: 6,
  });

  const toggleEngine = (id: string) => {
    const active =
      settings.engines.length === 0
        ? settings.fastMode
          ? enginesForFastMode()
          : ENGINES.map((e) => e.id)
        : settings.engines;
    const next = active.includes(id) ? active.filter((entry) => entry !== id) : [...active, id];
    void updateSettings({
      engines: next.length === ENGINES.length ? [] : next,
      fastMode: false,
    });
  };

  const exportResults = async (
    rowsToExport: ResultRow[],
    label: string,
    format: "txt" | "csv" | "stix" = "txt",
  ) => {
    if (format === "stix") {
      const stixJson = resultsToSTIX(rowsToExport, outcome?.query ?? query);
      await shareText(stixJson, `Ghost STIX 2.1 — ${label}`);
      toast.success(`Exported ${rowsToExport.length} results (STIX 2.1)`);
      return;
    }
    if (format === "csv") {
      const csv = resultsToCSV(rowsToExport);
      await shareText(csv, `Ghost CSV — ${label}`);
      toast.success(`Exported ${rowsToExport.length} results (CSV)`);
      return;
    }
    const lines = rowsToExport.map(
      (r) => `${r.title}\n${r.url}\n${r.snippet}\n[${r.engines.join(", ")}]\n`,
    );
    const text = `Ghost — ${label} (${rowsToExport.length})\n${"=".repeat(40)}\n\n${lines.join("\n")}`;
    await shareText(text, `Ghost — ${label}`);
    toast.success(`Exported ${rowsToExport.length} results`);
  };

  const openInBuiltinBrowser = (rawUrl: string) => {
    const { url, stripped } = stripTrackingParams(rawUrl);
    if (stripped.length > 0) {
      toast.info(
        `Stripped ${stripped.length} tracking parameter${stripped.length > 1 ? "s" : ""} before opening`,
      );
    }
    navigate({ to: "/browser", search: { url } });
  };

  const openExternalHandler = async (rawUrl: string) => {
    const { url, stripped } = stripTrackingParams(rawUrl);
    if (stripped.length > 0) {
      toast.info(
        `Stripped ${stripped.length} tracking parameter${stripped.length > 1 ? "s" : ""} before opening`,
      );
    }
    if (!isOnion(url)) {
      const proceed = window.confirm(
        "This link is NOT an onion address.\n\nIt will open outside Tor in your default browser and expose your real IP address to that site.\n\nOpen anyway?",
      );
      if (!proceed) return;
    }
    const ok = await openExternal(url);
    if (!ok) {
      toast.info("No external Tor Browser found — opening in built-in browser");
      navigate({ to: "/browser", search: { url } });
    }
  };

  const open = openInBuiltinBrowser;

  const copyUrl = async (url: string) => {
    const { url: clean, stripped } = stripTrackingParams(url);
    if (stripped.length > 0) {
      toast.info(
        `Stripped ${stripped.length} tracking parameter${stripped.length > 1 ? "s" : ""} before copying`,
      );
    }
    if (await copyText(clean)) toast.success("Link copied");
  };

  const shareLink = (title: string, url: string) => {
    const { url: clean, stripped } = stripTrackingParams(url);
    if (stripped.length > 0) {
      toast.info(
        `Stripped ${stripped.length} tracking parameter${stripped.length > 1 ? "s" : ""} before sharing`,
      );
    }
    void shareText(`${title}\n${clean}`, title);
  };

  const selected = (id: string) => {
    if (settings.engines.length > 0) return settings.engines.includes(id);
    if (settings.fastMode) return FAST_ENGINE_SET.has(id);
    return true;
  };

  return (
    <AppShell
      heading="Ghost — transient onion search across multiple engines"
      bar={
        <form
          className="flex items-center gap-2 px-3 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim().length > 0) run.mutate();
          }}
        >
          <div className="relative flex-1">
            <ConsoleInput
              value={query}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="query · nothing is stored"
              inputMode="search"
              enterKeyHint="search"
              className={query.length > 0 ? "pr-8" : ""}
            />
            {query.length > 0 && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear query"
                className="tap absolute right-2.5 top-1/2 -translate-y-1/2 text-dim hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <ActionButton
            type="submit"
            variant="primary"
            disabled={!egressOk || run.isPending}
            pending={run.isPending}
            aria-label="Run search"
          >
            <SearchIcon className="size-4" />
          </ActionButton>
          {run.isPending && (
            <ActionButton
              type="button"
              variant="default"
              onClick={() => {
                abortRef.current?.abort();
                abortRef.current = null;
                run.reset();
                setProgress(null);
                toast.info("Search stopped");
              }}
              aria-label="Stop search"
            >
              <Square className="size-4" />
            </ActionButton>
          )}
        </form>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1 px-3 pb-0.5">
          <Chip
            active={settings.fastMode && settings.engines.length === 0}
            signal={settings.fastMode ? "amber" : "dim"}
            onClick={() =>
              void updateSettings({
                fastMode: !settings.fastMode,
                engines: [],
              })
            }
            className="shrink-0 px-2 py-0.5 text-[10px]"
          >
            {settings.fastMode ? "fast 5" : "all 13"}
          </Chip>
          {ENGINES.map((engine) => (
            <Chip
              key={engine.id}
              active={selected(engine.id)}
              signal={isOpen(engine.id) || isDeprecated(engine.id) ? "red" : "dim"}
              onClick={() => toggleEngine(engine.id)}
              className="shrink-0 px-2 py-0.5 text-[10px]"
            >
              {engine.name}
            </Chip>
          ))}
        </div>

        {run.error && <ErrorNote error={run.error} />}

        {run.error && run.error instanceof GhostError && run.error.reports && (
          <Panel title="engine report (failed)">
            <ul className="divide-y divide-border-subtle">
              {run.error.reports.map((report) => (
                <li key={report.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="font-mono text-xs text-foreground">{report.name}</span>
                  <EngineStateLabel
                    state={report.state}
                    adapted={report.adapted}
                    onOpenCaptcha={open}
                  />
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {run.isPending && progress && (
          <Panel pending title={`searching · ${progress.done}/${progress.total} engines done`}>
            <div className="space-y-1 p-2">
              {progress.rows.length > 0 && (
                <MicroLabel>{progress.rows.length} results so far</MicroLabel>
              )}
              <ul className="divide-y divide-border-subtle">
                {liveReports.map((report) => (
                  <li
                    key={report.id}
                    className="flex items-center justify-between gap-2 px-1 py-1.5"
                  >
                    <span className="font-mono text-xs text-foreground">{report.name}</span>
                    <LiveEngineBadge state={report.state} />
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        )}

        {run.isPending && !progress && (
          <Panel pending title="starting search">
            <div className="p-3">
              <MicroLabel>
                results held in memory only · dropped on screen lock or panic wipe
              </MicroLabel>
            </div>
          </Panel>
        )}

        {rows.length > 0 && (outcome || progress) && (
          <Panel
            title={`${rows.length} results${outcome ? "" : " · streaming"}`}
            action={
              <div className="flex items-center gap-1">
                {outcome && (
                  <button
                    type="button"
                    onClick={() => setResultsCollapsed((c) => !c)}
                    aria-label={resultsCollapsed ? "Expand results" : "Collapse results"}
                    className="tap min-h-11 px-1 text-dim hover:text-foreground"
                  >
                    {resultsCollapsed ? "+" : "−"}
                  </button>
                )}
                {outcome && (
                  <button
                    type="button"
                    onClick={() => setSearchOutcome(null)}
                    aria-label="Purge results from memory"
                    className="tap min-h-11 px-1 text-dim hover:text-signal-red"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            }
          >
            {outcome && !resultsCollapsed && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-3 py-2">
                <button
                  type="button"
                  onClick={() => setFilter({ sort: filter.sort === "best" ? "engines" : "best" })}
                  aria-label="Toggle sort mode"
                  className={`tap rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${filter.sort === "engines" ? "bg-amber/30 text-amber" : "bg-foreground/10 text-foreground/70"}`}
                >
                  sort: {filter.sort}
                </button>
                <button
                  type="button"
                  onClick={() => setFilter({ onionOnly: !filter.onionOnly })}
                  aria-label="Toggle onion-only filter"
                  className={`tap rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${filter.onionOnly ? "bg-amber/30 text-amber" : "bg-foreground/10 text-foreground/70"}`}
                >
                  .onion only
                </button>
                <button
                  type="button"
                  onClick={() => setFilter({ minEngines: filter.minEngines > 1 ? 1 : 2 })}
                  aria-label="Toggle multi-engine filter"
                  className={`tap rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${filter.minEngines > 1 ? "bg-amber/30 text-amber" : "bg-foreground/10 text-foreground/70"}`}
                >
                  2+ engines
                </button>
                {bookmarks.length > 0 && (
                  <span className="text-[10px] font-mono text-amber/60">
                    {bookmarks.length} saved
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const next = summarizeRows(
                        rows.map((r) => ({
                          key: r.key,
                          url: r.url,
                          title: r.title,
                          snippet: r.snippet,
                          withheld: r.withheld,
                        })),
                      );
                      if (!next) {
                        toast.info("Not enough snippet text for a summary");
                        return;
                      }
                      setSummary(next);
                    }}
                    aria-label="Build extractive summary from results"
                    className="tap rounded-md bg-foreground/10 px-2 py-1 text-xs font-mono text-foreground/70 transition-colors hover:bg-foreground/20"
                  >
                    sum
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void exportResults(
                        bookmarks.length > 0 ? bookmarks : rows,
                        bookmarks.length > 0 ? "bookmarks" : "results",
                        "txt",
                      )
                    }
                    aria-label="Export results as text"
                    className="tap rounded-md bg-foreground/10 px-2 py-1 text-xs font-mono text-foreground/70 transition-colors hover:bg-foreground/20"
                  >
                    txt
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void exportResults(
                        bookmarks.length > 0 ? bookmarks : rows,
                        bookmarks.length > 0 ? "bookmarks" : "results",
                        "csv",
                      )
                    }
                    aria-label="Export results as CSV"
                    className="tap rounded-md bg-foreground/10 px-2 py-1 text-xs font-mono text-foreground/70 transition-colors hover:bg-foreground/20"
                  >
                    csv
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void exportResults(
                        bookmarks.length > 0 ? bookmarks : rows,
                        bookmarks.length > 0 ? "bookmarks" : "results",
                        "stix",
                      )
                    }
                    aria-label="Export results as STIX 2.1 JSON"
                    className="tap rounded-md bg-foreground/10 px-2 py-1 text-xs font-mono text-foreground/70 transition-colors hover:bg-foreground/20"
                  >
                    stix
                  </button>
                </div>
              </div>
            )}
            {outcome?.correlation && outcome.correlation.totalClusters > 0 && !resultsCollapsed && (
              <div className="border-b border-border-subtle bg-amber/5 px-3 py-1.5 font-mono text-[10px] text-amber">
                {outcome.correlation.totalClusters} shared-entity cluster
                {outcome.correlation.totalClusters > 1 ? "s" : ""} (max{" "}
                {outcome.correlation.maxClusterSize} linked results)
              </div>
            )}
            {!resultsCollapsed && (
              <div ref={scrollRef} className="max-h-[58vh] overflow-y-auto overscroll-contain">
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = rows[item.index]!;
                    const bookmarked = isBookmarked(row.key);
                    return (
                      <div
                        key={row.key}
                        ref={virtualizer.measureElement}
                        data-index={item.index}
                        className="absolute inset-x-0 border-b border-border-subtle px-3.5 py-3 transition-colors hover:bg-amber/5"
                        style={{ transform: `translateY(${item.start}px)` }}
                      >
                        <div className="flex flex-wrap items-center gap-1.5 pb-1">
                          {row.onion && <Chip signal="amber">.onion</Chip>}
                          {row.engines.map((id) => (
                            <MicroLabel key={id}>{id}</MicroLabel>
                          ))}
                          {row.correlatedCount && row.correlatedCount > 0 && (
                            <span className="rounded bg-amber/15 px-1.5 py-0.5 font-mono text-[9px] text-amber">
                              linked ({row.correlatedCount})
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openInBuiltinBrowser(row.url)}
                              aria-label="Browse in built-in browser"
                              className="tap flex items-center gap-1 rounded bg-amber/20 px-2 py-1 font-mono text-[11px] font-medium text-amber transition-colors hover:bg-amber/30 active:scale-95"
                            >
                              <Globe className="size-3" />
                              <span>Browse</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleBookmark(row)}
                              aria-label={bookmarked ? "Remove bookmark" : "Bookmark result"}
                              className={`tap flex size-7 items-center justify-center rounded transition-colors ${
                                bookmarked
                                  ? "text-amber hover:bg-amber/10"
                                  : "text-dim hover:bg-foreground/10 hover:text-foreground"
                              }`}
                            >
                              <Bookmark
                                className="size-3.5"
                                fill={bookmarked ? "currentColor" : "none"}
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => void copyUrl(row.url)}
                              aria-label="Copy link"
                              className="tap flex size-7 items-center justify-center rounded text-dim transition-colors hover:bg-foreground/10 hover:text-foreground"
                            >
                              <Copy className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => shareLink(row.title, row.url)}
                              aria-label="Share link"
                              className="tap flex size-7 items-center justify-center rounded text-dim transition-colors hover:bg-foreground/10 hover:text-foreground"
                            >
                              <Share2 className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void openExternalHandler(row.url)}
                              aria-label="Open in external Tor Browser"
                              title="Open in external Tor Browser"
                              className="tap flex size-7 items-center justify-center rounded text-dim transition-colors hover:bg-foreground/10 hover:text-foreground"
                            >
                              <ExternalLink className="size-3.5" />
                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void open(row.url)}
                          className="tap block w-full text-left"
                        >
                          <p
                            className="mt-1 line-clamp-1 text-sm text-foreground"
                            dangerouslySetInnerHTML={{
                              __html: highlightText(row.title, parsedQuery),
                            }}
                          />
                          <p
                            className="mt-0.5 line-clamp-1 break-all font-mono text-[11px] text-amber/80"
                            title={row.url}
                          >
                            {row.url}
                          </p>
                          {row.withheld ? (
                            <p className="mt-0.5 line-clamp-2 font-mono text-[11px] text-signal-amber">
                              {row.snippet || "no snippet"}
                            </p>
                          ) : (
                            <p
                              className="mt-0.5 line-clamp-2 text-[11px] text-dim"
                              dangerouslySetInnerHTML={{
                                __html: highlightText(row.snippet || "no snippet", parsedQuery),
                              }}
                            />
                          )}
                          {row.scamFlag && (
                            <div className="mt-1 rounded bg-signal-red/10 px-1.5 py-0.5 font-mono text-[9px] text-signal-red">
                              ⚠ {row.scamFlag}
                            </div>
                          )}
                          {row.blacklisted && (
                            <div className="mt-1 rounded bg-signal-red/15 px-1.5 py-0.5 font-mono text-[9px] text-signal-red">
                              ⚠ ahmia abuse blacklist match
                            </div>
                          )}
                        </button>
                        {row.entities && row.entities.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {row.entities.map((entity, i) => (
                              <EntityBadgeChip
                                key={`${entity.type}-${i}`}
                                entity={entity}
                                reuseCount={lookupReuse(reuseIndex, entity)}
                                pgp={
                                  entity.type === "pgp"
                                    ? (pgpIndex?.get(normalizePgpBlock(entity.value)) ??
                                      (pgpIndex ? UNPARSED_PGP : undefined))
                                    : undefined
                                }
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Panel>
        )}

        {summary && (
          <Panel
            title="summary · extractive, not semantic"
            action={
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void shareSummary(summary, outcome?.query ?? query)}
                  className="tap rounded-md bg-foreground/10 px-2 py-1 text-xs font-mono text-foreground/70 transition-colors hover:bg-foreground/20"
                >
                  share
                </button>
                <button
                  type="button"
                  onClick={() => setSummary(null)}
                  aria-label="Dismiss summary"
                  className="tap min-h-11 px-1 text-dim hover:text-signal-red"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            }
          >
            <div className="space-y-2 p-3">
              <MicroLabel>
                textrank over {summary.candidateCount} candidate sentences · no LLM, local only
              </MicroLabel>
              <ol className="space-y-2">
                {summary.selected.map((sentence, i) => (
                  <li key={sentence.position} className="text-xs leading-relaxed text-foreground">
                    <span className="mr-1 font-mono text-dim">{i + 1}.</span>
                    {sentence.text}
                    <span className="mt-0.5 block break-all font-mono text-[9px] text-amber/70">
                      {hostOf(sentence.url)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </Panel>
        )}

        {!outcome && !run.isPending && (
          <div className="space-y-3">
            <EmptyState
              title="No session data"
              hint="Type a query. Results are aggregated from onion search engines, ranked by RRF agreement, and never written to disk."
            />
            <div className="rounded-md border border-border-subtle bg-elevated/40 p-3">
              <MicroLabel className="mb-2 block text-dim">Quick query templates</MicroLabel>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "site:.onion",
                  "PGP key",
                  "cybersecurity",
                  "threat intel",
                  "mirrors",
                  "whonix",
                ].map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => {
                      setSearchQuery(sample);
                    }}
                    className="tap rounded-md border border-border-subtle bg-panel/70 px-2.5 py-1 font-mono text-xs text-foreground/80 transition-colors hover:border-amber/50 hover:text-amber"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {outcome && rows.length === 0 && (
          <EmptyState title="No results" hint="Try fewer engines, or a broader query." />
        )}

        {outcome && (
          <Panel title="engine report">
            <ul className="divide-y divide-border-subtle">
              {liveReports.map((report) => (
                <li key={report.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="font-mono text-xs text-foreground">{report.name}</span>
                  <EngineStateLabel
                    state={report.state}
                    adapted={report.adapted}
                    onOpenCaptcha={open}
                  />
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function shareSummary(summary: ExtractiveSummary, query: string): Promise<void> {
  const lines = summary.selected.map((s, i) => `${i + 1}. ${s.text}\n   ${hostOf(s.url)}`);
  const text = [
    `Ghost — extractive summary (${summary.selected.length} of ${summary.candidateCount} sentences)`,
    `query: ${query}`,
    "",
    ...lines,
    "",
    `caution: ${summary.caution}`,
  ].join("\n");
  await shareText(text, "Ghost — extractive summary");
  toast.success("Summary shared");
}

/** Sentinel for PGP blocks the enrichment pass did not parse (cap or drop). */
const UNPARSED_PGP: PgpEnrichment = {
  fingerprint: "",
  keyIdShort: "unparsed",
  hosts: [],
  crossHost: false,
  error: "not parsed in this pass (per-pass cap or block dropped)",
};

/**
 * Expandable entity badge. Collapsed: type label + wallet enrichment
 * (address shape / checksum) + reuse marker, or PGP key-id + host-reuse
 * marker. Tap expands to the entity value / fingerprint and the
 * operator-linking hints. Lives outside the row's open-in-Tor button so
 * nested interactive elements stay valid HTML.
 */
function EntityBadgeChip({
  entity,
  reuseCount,
  pgp,
}: {
  entity: EntityBadge;
  reuseCount: number | undefined;
  pgp: PgpEnrichment | undefined;
}) {
  const [open, setOpen] = useState(false);
  const isPgp = entity.type === "pgp";
  const suffix = isPgp
    ? pgp === undefined
      ? "…"
      : pgp.crossHost
        ? `${pgp.keyIdShort} · 2+ hosts`
        : pgp.keyIdShort
    : entityBadgeDetail(entity, reuseCount);
  const reused = reuseCount !== undefined && reuseCount >= 2;
  const flagged = reused || pgp?.crossHost === true;
  return (
    <div className={open ? "basis-full" : undefined}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${entityLabel(entity.type)} entity — ${flagged ? "cross-host key, " : ""}expand for value`}
        className={`tap rounded px-1 py-0.5 font-mono text-[9px] ${
          flagged ? "bg-signal-red/15 text-signal-red" : "bg-amber/10 text-amber"
        }`}
      >
        {entityLabel(entity.type)}
        {suffix ? ` · ${suffix}` : ""}
      </button>
      {open && (
        <div className="mt-1 rounded border border-border-subtle bg-elevated/70 px-1.5 py-1 font-mono text-[9px] leading-relaxed">
          {isPgp ? (
            <>
              <p className="break-all text-dim">{formatFingerprint(pgp?.fingerprint ?? "")}</p>
              {pgp?.error && <p className="mt-0.5 text-signal-red">{pgp.error}</p>}
              {pgp && pgp.hosts.length > 0 && (
                <p className="mt-0.5 break-all text-amber/80">hosts: {pgp.hosts.join(" · ")}</p>
              )}
              {pgp?.crossHost && (
                <p className="mt-0.5 text-signal-red">
                  same PGP key on {pgp.hosts.length} hosts — same operator?
                </p>
              )}
            </>
          ) : (
            <>
              <p className="break-all text-dim">{entity.value}</p>
              {entity.detail && <p className="mt-0.5 text-amber/80">{entity.detail}</p>}
              {reused && (
                <p className="mt-0.5 text-signal-red">
                  wallet reuse — same address on {reuseCount} results (operator-linking signal)
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LiveEngineBadge({ state }: { state: EngineReport["state"] }) {
  if (state.status === "ok")
    return (
      <MicroLabel>
        {state.count} hits · {state.ms} ms{state.via ? ` · via ${state.via.slice(0, 10)}…` : ""}
      </MicroLabel>
    );
  if (state.status === "captcha") return <Chip signal="amber">captcha</Chip>;
  if (state.status === "open")
    return <MicroLabel className="text-signal-red">circuit open</MicroLabel>;
  if (state.status === "deprecated")
    return <MicroLabel className="text-signal-red">deprecated</MicroLabel>;
  if (state.status === "failed") return <MicroLabel className="text-signal-red">failed</MicroLabel>;
  return <MicroLabel className="text-dim">pending</MicroLabel>;
}

function EngineStateLabel({
  state,
  adapted,
  onOpenCaptcha,
}: {
  state: SearchOutcome["reports"][number]["state"];
  adapted?: EngineReport["adapted"];
  onOpenCaptcha: (url: string) => void | Promise<void>;
}) {
  const adaptedBadge = adapted ? (
    <span className="mr-1.5 font-mono text-[9px] text-amber/70">adapted</span>
  ) : null;
  if (state.status === "ok")
    return (
      <span className="flex items-center">
        {adaptedBadge}
        <MicroLabel>
          {state.count} hits · {state.ms} ms
          {state.via ? ` · via ${state.via.slice(0, 10)}…` : ""}
        </MicroLabel>
      </span>
    );
  if (state.status === "captcha")
    return (
      <Chip signal="amber" onClick={() => void onOpenCaptcha(state.url)}>
        captcha · open in tor
      </Chip>
    );
  if (state.status === "open")
    return <MicroLabel className="text-signal-red">circuit open</MicroLabel>;
  if (state.status === "deprecated")
    return <MicroLabel className="text-signal-red">deprecated ({state.reason})</MicroLabel>;
  if (state.status === "failed")
    return <MicroLabel className="text-signal-red">unreachable</MicroLabel>;
  return <MicroLabel>idle</MicroLabel>;
}
