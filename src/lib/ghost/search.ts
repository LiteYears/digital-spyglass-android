/**
 * Search orchestrator (v3.0.0 Engine Core).
 *
 * Fans out to every healthy engine in parallel with per-engine query contract
 * adaptation, per-engine SOCKS5 stream isolation, camouflage delays, and
 * trust-weighted Reciprocal Rank Fusion (RRF k=10) with SOTA quality-filter
 * score modification, optional QARF weighting, and RAM-only entity correlation.
 */
import { detectOnionSpoof } from "./authenticity";
import { isBlacklisted } from "./blacklist";
import {
  isDeprecated,
  isOpen,
  openUntil,
  recordCaptcha,
  recordFailure,
  recordSuccess,
  resetBreaker,
} from "./breaker";
import {
  assignSurgeDelays,
  fireDecoys,
  paranoidCamouflage,
  paranoidSurge,
  retryBackoffMs,
  sampleDelay,
  shuffleEngines,
  sleep,
  standardCamouflage,
  type CamouflageConfig,
} from "./camouflage";
import { correlateEntities, type CorrelationReport } from "./correlation";
import {
  aggregate,
  dedupeByContent,
  filterAndSort,
  flagScams,
  normaliseKey,
  textSimilarity,
} from "./dedup";
import {
  ENGINES,
  activeRegistry,
  bundledRegistry,
  engineById,
  enginesForFastMode,
  isImportedRegistryActive,
  loadBundledRegistrySig,
  type SearchEngine,
} from "./engines";
import { extractEntities } from "./entities";
import { isJunkResult } from "./filter";
import { fetchBodyOnly, fetchPostBody, fetchText, type SocksAuth } from "./http";
import { isOnion, looksLikeCaptcha } from "./parse";
import { PRODUCTION_V1 } from "./profiles";
import { computeQarfWeights } from "./qarf";
import {
  applyQualityFilter,
  DEFAULT_QUALITY_PARAMS,
  type QualityFilterParams,
} from "./quality-filter";
import { adaptQuery } from "./query-adapter";
import { assessSnippetQuality, safeSnippet } from "./snippets";
import {
  GhostError,
  type EngineReport,
  type RawResult,
  type ResultRow,
  type SearchOutcome,
} from "./types";
import { purgeTorCookies, isNative } from "../platform/bridge";
import { readRegistryAnchor } from "../platform/native";
import {
  ensureActiveRegistryVerified,
  ensureRegistryVerified,
  registryIntegrity,
  resetRegistryVerification,
} from "./registry-signature";
import { base64ToSpkiBytes, loadImportedRegistry, loadTrustedKeys } from "./registry-import";
import { refreshRegistryChainStatus } from "./registry-chain";

export { normaliseKey, aggregate, dedupeByContent, textSimilarity, flagScams, filterAndSort };

export function selectEngines(ids: string[], fastMode = false): SearchEngine[] {
  if (ids.length > 0) {
    return ENGINES.filter((engine) => ids.includes(engine.id));
  }
  if (fastMode) {
    return enginesForFastMode()
      .map((id) => engineById(id))
      .filter((engine): engine is SearchEngine => engine !== undefined);
  }
  return ENGINES;
}

export type RankV3Options = {
  query: string;
  snippetFilter: boolean;
  qualityFilter?: boolean | undefined;
  qarf?: boolean | undefined;
  blacklistFilter?: boolean | undefined;
  rrfK?: number | undefined;
  maxPerDomain?: number | undefined;
};

/**
 * Deterministic v3 ranking pipeline:
 * 1. Per-engine RRF (k=10) with calibrated engine trust (or QARF adaptive trust)
 * 2. Info-quality priority (non-withheld snippets > 15 chars first)
 * 3. SOTA Quality Filter as non-destructive RRF modifier (penalized: *0.1, clean: +qf*0.01)
 * 4. Scam/mirror advisory flags + optional Ahmia abuse blacklist marking
 * 5. RAM-only cross-result entity correlation
 */
const spoofMemoCache = new Map<string, ReturnType<typeof detectOnionSpoof>>();

export function clearSpoofMemoCache(): void {
  spoofMemoCache.clear();
}

export function rankRowsV3(
  raw: (RawResult & { trust: number })[],
  options: RankV3Options,
): { rows: ResultRow[]; correlation: CorrelationReport } {
  const rrfK = options.rrfK ?? PRODUCTION_V1.rrfK;
  const qualityFilterEnabled = options.qualityFilter ?? PRODUCTION_V1.qualityFilterEnabled;
  const maxPerDomain = options.maxPerDomain ?? PRODUCTION_V1.maxPerDomain;

  const rrfScores = new Map<string, number>();
  const engineRankCounters = new Map<string, number>();

  let qarfWeights: Map<string, number> | undefined;
  if (options.qarf && raw.length > 0) {
    const engineResultMap = new Map<string, Array<{ title: string; snippet: string }>>();
    const trustMap = new Map<string, number>();
    for (const item of raw) {
      if (!engineResultMap.has(item.engineId)) {
        engineResultMap.set(item.engineId, []);
        trustMap.set(item.engineId, item.trust);
      }
      engineResultMap.get(item.engineId)!.push({ title: item.title, snippet: item.snippet });
    }
    qarfWeights = computeQarfWeights(options.query, engineResultMap, trustMap);
  }

  const byKey = new Map<string, ResultRow>();

  for (const item of raw) {
    if (!item.url) continue;
    const key = normaliseKey(item.url);
    const rank = engineRankCounters.get(item.engineId) ?? 0;
    engineRankCounters.set(item.engineId, rank + 1);

    const trust = qarfWeights?.get(item.engineId) ?? item.trust;
    const rrfDelta = (1 / (rrfK + rank + 1)) * trust;
    const nextScore = (rrfScores.get(key) ?? 0) + rrfDelta;
    rrfScores.set(key, nextScore);

    const existing = byKey.get(key);
    if (existing) {
      if (!existing.engines.includes(item.engineId)) {
        existing.engines.push(item.engineId);
      }
      existing.score = nextScore;
      if (existing.title.startsWith("http") && !item.title.startsWith("http")) {
        existing.title = item.title;
      }
      if (existing.snippet.length === 0 && item.snippet.length > 0) {
        const safe = safeSnippet(item.snippet, options.snippetFilter);
        const sq = assessSnippetQuality(safe.snippet, existing.title, options.query);
        existing.snippet = safe.snippet;
        existing.withheld = safe.withheld;
        existing.snippetSufficient = sq.sufficient;
        existing.snippetQualityReason = sq.reason;
        if (!safe.withheld) {
          const entities = extractEntities(`${existing.title} ${safe.snippet}`);
          existing.entities = entities.length > 0 ? entities : undefined;
        }
      }
      continue;
    }

    const safe = safeSnippet(item.snippet, options.snippetFilter);
    const title = item.title || item.url;
    const sq = assessSnippetQuality(safe.snippet, title, options.query);
    const entities = safe.withheld ? [] : extractEntities(`${title} ${safe.snippet}`);

    byKey.set(key, {
      key,
      url: item.url,
      title,
      snippet: safe.snippet,
      withheld: safe.withheld,
      onion: isOnion(item.url),
      engines: [item.engineId],
      score: nextScore,
      entities: entities.length > 0 ? entities : undefined,
      snippetSufficient: sq.sufficient,
      snippetQualityReason: sq.reason,
      blacklisted: options.blacklistFilter ? isBlacklisted(item.url) : undefined,
    });
  }

  let rows = Array.from(byKey.values()).sort((a, b) => {
    const aInfo = !a.withheld && a.snippet.length > 15;
    const bInfo = !b.withheld && b.snippet.length > 15;
    if (aInfo !== bInfo) return aInfo ? -1 : 1;
    return b.score - a.score || b.engines.length - a.engines.length;
  });

  if (qualityFilterEnabled && rows.length > 0) {
    const qfParams: QualityFilterParams = {
      ...DEFAULT_QUALITY_PARAMS,
      enabled: true,
      maxPerDomain,
      simHashThreshold: PRODUCTION_V1.simHashThreshold,
      semanticDedupThreshold: PRODUCTION_V1.semanticDedupThreshold,
    };
    const scored = applyQualityFilter(
      rows.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.snippet,
        engine: r.engines[0] ?? "",
        entities: r.entities,
        withheld: r.withheld,
        score: r.score,
      })),
      options.query,
      qfParams,
    );
    const scoredByKey = new Map(scored.map((s) => [normaliseKey(s.url), s]));
    rows = rows.map((row) => {
      const qf = scoredByKey.get(row.key);
      const qfScore = qf?.qualityScore ?? 0;
      const qfFlags = qf?.qualityFlags ?? [];
      const hasPenalty = qfFlags.some(
        (f) =>
          f.includes("duplicate") ||
          f.includes("mirror") ||
          f.includes("domain_") ||
          f.includes("spam") ||
          f.includes("commercial") ||
          f.includes("directory"),
      );
      const combinedScore = hasPenalty ? row.score * 0.1 : row.score + qfScore * 0.01;
      return {
        ...row,
        score: combinedScore,
        qualityScore: qfScore,
        qualityFlags: qfFlags.length > 0 ? qfFlags : undefined,
      };
    });

    rows.sort((a, b) => {
      const aInfo = !a.withheld && a.snippet.length > 15;
      const bInfo = !b.withheld && b.snippet.length > 15;
      if (aInfo !== bInfo) return aInfo ? -1 : 1;
      return b.score - a.score || b.engines.length - a.engines.length;
    });
  }

  rows = flagScams(rows);

  for (const row of rows) {
    if (row.onion) {
      try {
        let hostKey = row.url;
        try {
          hostKey = new URL(row.url).hostname.toLowerCase();
        } catch {
          /* keep full url as cache key */
        }
        let check = spoofMemoCache.get(hostKey);
        if (!check) {
          check = detectOnionSpoof(row.url);
          if (spoofMemoCache.size > 4096) spoofMemoCache.clear();
          spoofMemoCache.set(hostKey, check);
        }
        row.authenticity = check.status;
        if (check.status === "SUSPECTED_VANITY_CLONE" && !row.scamFlag) {
          row.scamFlag = `Suspected vanity-prefix clone of ${check.spoofedCanonicalId ?? "known service"}`;
        } else if (check.status === "INVALID_ONION" && !row.scamFlag) {
          row.scamFlag = "Invalid v3 .onion cryptographic checksum";
        }
      } catch {
        /* never let a single malformed URL abort the ranking pipeline */
      }
    }
  }

  const correlation = correlateEntities(
    rows.map((r) => ({
      url: r.url,
      entities: (r.entities ?? []).map((e) => ({ type: e.type, value: e.value })),
    })),
  );

  if (correlation.totalClusters > 0) {
    const linkedUrls = new Map<string, Set<string>>();
    for (const cluster of correlation.clusters) {
      for (const u of cluster.resultUrls) {
        if (!linkedUrls.has(u)) linkedUrls.set(u, new Set());
        for (const other of cluster.resultUrls) {
          if (other !== u) linkedUrls.get(u)!.add(other);
        }
      }
    }
    for (const row of rows) {
      const peers = linkedUrls.get(row.url);
      if (peers && peers.size > 0) {
        row.correlatedCount = peers.size;
      }
    }
  }

  return { rows, correlation };
}

export type SearchInput = {
  query: string;
  engineIds: string[];
  page?: number;
  snippetFilter: boolean;
  torSocks?: { host?: string | undefined; port?: number | undefined };
  signal?: AbortSignal;
  /** Fires after each engine completes with partial results + live reports. */
  onProgress?: (progress: SearchProgress) => void;
  /** Paranoid mode enables stronger camouflage parameters. Default: false. */
  paranoidMode?: boolean;
  /** Fast mode queries only the 5 Core + Reinforcement engines when engineIds is empty. */
  fastMode?: boolean;
  /** QARF adaptive RRF weighting. Default: false. */
  qarfMode?: boolean;
  /** Allow clearnet (non-.onion) result links. Default: false — opt-in only. */
  allowClearnet?: boolean;
  /** SOTA quality filter modifier. Default: true (PRODUCTION_V1). */
  qualityFilter?: boolean;
  /** Opt-in Ahmia abuse blacklist marking. Default: false. */
  blacklistFilter?: boolean;
};

export type SearchProgress = {
  rows: ResultRow[];
  reports: EngineReport[];
  done: number;
  total: number;
};

/**
 * Fail-closed registry-integrity gate. On native builds the bundled engine
 * registry must verify against the APK signer's key before any engine fetch
 * is dispatched. Off-native contexts (web preview, vitest, MCP) consume the
 * repo's own file where CI is the enforcement point — the gate stays open.
 * Dev builds carry a debug key, so DEV mode downgrades to a loud warning.
 */
export async function assertRegistryIntact(): Promise<void> {
  if (!(await isNative())) return;
  if (isImportedRegistryActive()) {
    // An import is active: verify the ACTIVE content against the anchor OR
    // any operator-confirmed trusted key, using the import's own signature.
    const stored = await loadImportedRegistry();
    const state = await ensureActiveRegistryVerified(
      activeRegistry(),
      async () => {
        if (!stored) throw new Error("active import is missing its persisted signature");
        return stored.sigText;
      },
      readRegistryAnchor,
      async () => (await loadTrustedKeys()).map((key) => base64ToSpkiBytes(key.spkiBase64)),
    );
    // Chain status is intentionally NOT refreshed for imports — the bundled
    // chain tracks the release lineage only; a foreign signer's `previous`
    // would false-positive "broken" on every search (F3/R8).
    if (state === "verified") return;
    if (import.meta.env?.DEV) {
      console.error(
        "[ghost] imported registry integrity check",
        state,
        "— allowed because this is a dev build",
      );
      return;
    }
    throw new GhostError(
      "registry_integrity_failed",
      "Imported engine registry failed its integrity check — search disabled. Remove the import or reinstall from a trusted source.",
    );
  }
  const state = await ensureRegistryVerified(
    bundledRegistry(),
    loadBundledRegistrySig,
    readRegistryAnchor,
  );
  // Chain status is informational (warn, never block) — compute it off the
  // critical path so the fail-closed signature gate stays the only blocker.
  void refreshRegistryChainStatus(bundledRegistry()).catch(() => {});
  if (state === "verified") return;
  if (import.meta.env?.DEV) {
    console.error(
      "[ghost] registry integrity check",
      registryIntegrity(),
      "— allowed because this is a dev build",
    );
    return;
  }
  throw new GhostError(
    "registry_integrity_failed",
    "Engine registry integrity check failed — search disabled. Reinstall from a trusted source.",
  );
}

export async function searchAllEngines(input: SearchInput): Promise<SearchOutcome> {
  const query = input.query.trim();
  if (query.length === 0) throw new GhostError("empty_query", "Enter a query first.");

  await assertRegistryIntact();

  const pool = selectEngines(input.engineIds, input.fastMode ?? false);
  if (pool.length === 0) throw new GhostError("no_engines", "No engine selected.");

  const startedAt = Date.now();
  const reports: EngineReport[] = [];
  const collected: (RawResult & { trust: number })[] = [];
  let done = 0;
  const total = pool.length;

  const socksAuth: SocksAuth = {
    user: "ghost",
    pass: crypto.randomUUID(),
    host: input.torSocks?.host,
    port: input.torSocks?.port,
  };

  for (const engine of pool) {
    if (isOpen(engine.id)) resetBreaker(engine.id);
  }

  const rankOptions: RankV3Options = {
    query,
    snippetFilter: input.snippetFilter,
    qualityFilter: input.qualityFilter ?? true,
    qarf: input.qarfMode ?? false,
    blacklistFilter: input.blacklistFilter ?? false,
  };

  // Clearnet results are opt-in (GhostSettings.allowClearnet): engines can
  // surface non-onion links via redirect params — hidden by default.
  const applyClearnet = (rs: ResultRow[]): ResultRow[] =>
    input.allowClearnet ? rs : rs.filter((r) => isOnion(r.url));

  let emitTimer: ReturnType<typeof setTimeout> | undefined;
  const flushEmit = () => {
    if (emitTimer !== undefined) {
      clearTimeout(emitTimer);
      emitTimer = undefined;
    }
    if (input.signal?.aborted || !input.onProgress) return;
    const partialOptions: RankV3Options =
      done < total ? { ...rankOptions, qualityFilter: false } : rankOptions;
    input.onProgress({
      rows: applyClearnet(rankRowsV3(collected, partialOptions).rows),
      reports: [...reports].sort((a, b) => a.name.localeCompare(b.name)),
      done,
      total,
    });
  };

  const emit = () => {
    if (input.signal?.aborted || !input.onProgress) return;
    if (done >= total) {
      flushEmit();
      return;
    }
    if (emitTimer === undefined) {
      emitTimer = setTimeout(() => {
        emitTimer = undefined;
        flushEmit();
      }, 80);
    }
  };

  const camouflage: CamouflageConfig = input.paranoidMode
    ? paranoidCamouflage()
    : standardCamouflage();
  const shuffledPool = shuffleEngines(pool);

  const startDelays = input.paranoidMode
    ? assignSurgeDelays(shuffledPool.length, paranoidSurge())
    : shuffledPool.map(() => sampleDelay(camouflage));

  const decoyController = new AbortController();
  const onAbortDecoy = () => decoyController.abort();
  input.signal?.addEventListener("abort", onAbortDecoy, { once: true });
  void fireDecoys(camouflage, socksAuth, decoyController.signal).catch(() => {});

  await Promise.allSettled(
    shuffledPool.map(async (engine, idx) => {
      await sleep(startDelays[idx]!, input.signal);
      if (input.signal?.aborted) return;

      const mirrors = engine.mirrors ?? [];
      if (isDeprecated(engine.id)) {
        reports.push({
          id: engine.id,
          name: engine.name,
          state: { status: "deprecated", reason: "3 consecutive timeouts" },
        });
        done++;
        emit();
        return;
      }

      /* An open breaker skips the engine ENTIRELY — mirrors included (F10).
         Every endpoint attempt feeds the same per-engine breaker, so "open"
         already reflects that primary and mirrors recently failed; retrying
         mirrors anyway would burn their timeouts on every query and keep
         re-extending openUntil forever. */
      if (isOpen(engine.id)) {
        reports.push({
          id: engine.id,
          name: engine.name,
          state: { status: "open", until: openUntil(engine.id) },
        });
        done++;
        emit();
        return;
      }

      const adapted = adaptQuery(query, engine.queryContract);
      const engineQuery = adapted.query || query;
      const adaptedMeta =
        adapted.truncated || adapted.termsDropped || adapted.operatorsStripped
          ? {
              truncated: adapted.truncated,
              termsDropped: adapted.termsDropped,
              operatorsStripped: adapted.operatorsStripped,
            }
          : undefined;

      const engineSocksAuth: SocksAuth = {
        ...socksAuth,
        pass: `${socksAuth.pass}-${engine.id}`,
      };

      /* Mirror chain: primary base first, then signed mirrors in array order.
         Each dead endpoint records a failure towards the breaker; a captcha
         answer means the engine is alive and stops the chain. */
      const attemptBases: Array<string | undefined> = [undefined, ...mirrors];

      let okReport: EngineReport | undefined;
      let lastErrorMessage = "no attempt made";

      for (let attempt = 0; attempt < attemptBases.length; attempt++) {
        if (input.signal?.aborted) break;
        const base = attemptBases[attempt];
        if (attempt > 0) await sleep(retryBackoffMs(300), input.signal);

        const url = engine.searchUrl(engineQuery, input.page ?? 1, base);
        const resolveTargetUrl = async (): Promise<string> =>
          engine.prepareSearchUrl
            ? engine.prepareSearchUrl(
                engineQuery,
                input.page ?? 1,
                (u: string) => fetchBodyOnly(u, engineSocksAuth),
                engineSocksAuth,
                (u: string, b: string) => fetchPostBody(u, b, engineSocksAuth),
                base,
              )
            : url;

        try {
          let finalUrl = await resolveTargetUrl();
          let fetched: { status: number; body: string; ms: number };
          try {
            fetched = await fetchText(finalUrl, input.signal, engineSocksAuth);
          } catch (firstErr) {
            const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
            if (msg.includes("HTTP 400") && !input.signal?.aborted) {
              await sleep(retryBackoffMs(), input.signal);
              finalUrl = await resolveTargetUrl();
              fetched = await fetchText(finalUrl, input.signal, engineSocksAuth);
            } else {
              throw firstErr;
            }
          }
          const { body, ms } = fetched;
          if (looksLikeCaptcha(body)) {
            recordCaptcha(engine.id);
            okReport = {
              id: engine.id,
              name: engine.name,
              state: { status: "captcha", url },
              adapted: adaptedMeta,
            };
            break;
          }
          const parsed = engine.parse(body);
          const cleanParsed = parsed.filter((r) => !isJunkResult(r.url));
          const sortedEngineParsed = [...cleanParsed].sort((a, b) => {
            const aInfo = (a.snippet ?? "").length > 15;
            const bInfo = (b.snippet ?? "").length > 15;
            if (aInfo !== bInfo) return aInfo ? -1 : 1;
            return 0;
          });
          recordSuccess(engine.id, ms, sortedEngineParsed.length);
          for (const item of sortedEngineParsed) {
            collected.push({ ...item, engineId: engine.id, trust: engine.trust });
          }
          const okState: Extract<EngineReport["state"], { status: "ok" }> = {
            status: "ok",
            count: sortedEngineParsed.length,
            ms,
          };
          if (base !== undefined) {
            try {
              okState.via = new URL(base).hostname;
            } catch {
              okState.via = base;
            }
          }
          okReport = {
            id: engine.id,
            name: engine.name,
            state: okState,
            adapted: adaptedMeta,
          };
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isTimeout = message.toLowerCase().includes("timeout");
          lastErrorMessage = message;
          recordFailure(engine.id, message, isTimeout);
        }
      }

      if (okReport) {
        reports.push(okReport);
      } else {
        reports.push({
          id: engine.id,
          name: engine.name,
          state: { status: "failed", error: lastErrorMessage },
          adapted: adaptedMeta,
        });
      }
      done++;
      emit();
    }),
  );

  if (emitTimer !== undefined) {
    clearTimeout(emitTimer);
    emitTimer = undefined;
  }
  input.signal?.removeEventListener("abort", onAbortDecoy);
  decoyController.abort();

  await purgeTorCookies().catch(() => {});

  const { rows: allRows, correlation } = rankRowsV3(collected, rankOptions);
  const rows = applyClearnet(allRows);
  const anyOk = reports.some((report) => report.state.status === "ok");
  if (!anyOk && rows.length === 0) {
    const sorted = reports.sort((a, b) => a.name.localeCompare(b.name));
    const detail = sorted
      .map((r) => {
        if (r.state.status === "failed") return `${r.name}: ${r.state.error}`;
        if (r.state.status === "captcha") return `${r.name}: captcha`;
        if (r.state.status === "open") return `${r.name}: circuit open`;
        if (r.state.status === "deprecated") return `${r.name}: deprecated`;
        return `${r.name}: ${r.state.status}`;
      })
      .join(" | ");
    throw new GhostError(
      "all_failed",
      `All engines failed. ${detail || "Check Orbot (VPN mode)."}`,
      sorted,
    );
  }

  return {
    query,
    rows,
    reports: reports.sort((a, b) => a.name.localeCompare(b.name)),
    startedAt,
    durationMs: Date.now() - startedAt,
    correlation,
    fastMode: input.fastMode ?? false,
    qarfApplied: input.qarfMode ?? false,
  };
}
