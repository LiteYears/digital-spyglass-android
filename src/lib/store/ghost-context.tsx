/**
 * Ghost session state.
 *
 * Holds the transport state, the three persisted preferences and the purge
 * machinery. Session data (queries, results, reports) stays in RAM during
 * normal use and is purged under three conditions:
 *  1. Panic wipe (user presses the panic button)
 *  2. App process death (Android reclaims the RAM)
 *  3. Screen-off (screen saver / lock screen activates)
 *
 * Normal background transitions (HOME key, app switcher) do NOT purge —
 * the session persists so the user can return to their results.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { clearBlacklistCache } from "../ghost/blacklist";
import { resetBreaker } from "../ghost/breaker";
import type { CaseEntity } from "../ghost/case-file";
import { startIdleDecoyScheduler, type IdleDecoyHandle } from "../ghost/camouflage";
import { applyImportedRegistry, resetToBundledRegistry } from "../ghost/engines";
import {
  base64ToSpkiBytes,
  clearImportedRegistry,
  clearRegistryTrust,
  loadImportedRegistry,
  loadTrustedKeys,
  verifyRegistryImport,
} from "../ghost/registry-import";
import { resetRegistryVerification } from "../ghost/registry-signature";
import { invalidateTorVerification, verifyTor } from "../ghost/http";
import { assertRegistryIntact, clearSpoofMemoCache } from "../ghost/search";
import type { FilterState, GhostSettings, ResultRow, SearchOutcome } from "../ghost/types";

/** One executed query in this session — RAM-only timeline building block. */
export type SessionQueryEvent = {
  ts: number;
  query: string;
  resultCount: number;
  entityCount: number;
  engines: string[];
};
import {
  hardPanicWipeAndKill,
  onAppStateChange,
  onScreenOff,
  readRegistryAnchor,
  readTransport,
  type TransportInfo,
} from "../platform/native";
import { secureDeviceVault, wipeMemoryStores } from "../platform/storage";
import {
  clearGhostSettings,
  defaultGhostSettings,
  loadGhostSettings,
  saveGhostSettings,
} from "./ghost-settings";

type GhostContextValue = {
  ready: boolean;
  settings: GhostSettings;
  transport: TransportInfo;
  /** Result of the real .onion probe through SOCKS; null = not resolved yet. */
  torOk: boolean | null;
  /** True when search is allowed to run at all. */
  egressOk: boolean;
  updateSettings: (patch: Partial<GhostSettings>) => Promise<void>;
  refreshTransport: () => Promise<void>;
  /** Register a RAM-only result store so purge (panic / screen lock) can empty it. */
  registerPurge: (purge: () => void) => () => void;
  purgeNow: () => void;
  panicWipe: () => Promise<void>;
  /** Session search state — survives tab switches because it lives in the provider. */
  searchQuery: string;
  searchOutcome: SearchOutcome | null;
  setSearchQuery: (q: string) => void;
  setSearchOutcome: (o: SearchOutcome | null) => void;
  /** Monotonically increasing session epoch — incremented on every purgeNow/panicWipe so in-flight searches from before a purge cannot re-populate state. */
  getSessionEpoch: () => number;
  /** Session-only bookmarks — RAM-only, purged with session. */
  bookmarks: ResultRow[];
  toggleBookmark: (row: ResultRow) => void;
  isBookmarked: (key: string) => boolean;
  /** Session-only filter state — RAM-only, purged with session. */
  filter: FilterState;
  setFilter: (f: Partial<FilterState>) => void;
  /** Chronological log of executed queries this session — RAM-only, purged. */
  sessionLog: SessionQueryEvent[];
  logQuery: (event: SessionQueryEvent) => void;
  /** Case-file entities imported/merged this session — RAM-only, purged.
   *  Import is an explicit user action; there is deliberately no at-rest store. */
  caseEntities: CaseEntity[];
  setCaseEntities: (entities: CaseEntity[]) => void;
  /** When the session memory was last purged (epoch ms), null if never this session. */
  lastPurgeAt: number | null;
};

const GhostContext = createContext<GhostContextValue | null>(null);

export function GhostProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<GhostSettings>(defaultGhostSettings);
  const [transport, setTransport] = useState<TransportInfo>({
    connected: true,
    connectionType: "unknown",
    vpnActive: null,
  });
  const purgers = useRef(new Set<() => void>());
  const sessionEpochRef = useRef(0);
  const idleDecoyRef = useRef<IdleDecoyHandle | null>(null);
  const paranoidModeRef = useRef(false);
  const purgeOnScreenOffRef = useRef(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOutcome, setSearchOutcome] = useState<SearchOutcome | null>(null);
  const [bookmarks, setBookmarks] = useState<ResultRow[]>([]);
  const [filter, setFilterState] = useState<FilterState>({
    sort: "best",
    onionOnly: false,
    minEngines: 1,
  });
  const [sessionLog, setSessionLog] = useState<SessionQueryEvent[]>([]);
  const [caseEntities, setCaseEntities] = useState<CaseEntity[]>([]);
  const [lastPurgeAt, setLastPurgeAt] = useState<number | null>(null);
  const [torOk, setTorOk] = useState<boolean | null>(null);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /* Egress truth is a real .onion probe through the configured SOCKS
     endpoint — vpnActive only means SOME tunnel is up (any VPN satisfies
     TRANSPORT_VPN, while Orbot's circuits may still be dead). */
  const probeTor = useCallback(async (override?: GhostSettings) => {
    const s = override ?? settingsRef.current;
    const p = Number.parseInt(s.torSocksPort ?? "", 10);
    const ok = await verifyTor(true, {
      host: s.torSocksHost?.trim() || undefined,
      port: p >= 1 && p <= 65535 ? p : undefined,
    });
    setTorOk(ok);
  }, []);

  const purgeNow = useCallback(() => {
    sessionEpochRef.current += 1;
    idleDecoyRef.current?.stop();
    idleDecoyRef.current = null;
    for (const purge of purgers.current) {
      try {
        purge();
      } catch {
        /* never let one purger block remaining purgers */
      }
    }
    queryClient.clear();
    queryClient.removeQueries();
    wipeMemoryStores();
    clearBlacklistCache();
    clearSpoofMemoCache();
    invalidateTorVerification();
    setSearchQuery("");
    setSearchOutcome(null);
    void secureDeviceVault.remove("search_query");
    void secureDeviceVault.remove("search_outcome");
    setBookmarks([]);
    void secureDeviceVault.remove("bookmarks");
    setFilterState({ sort: "best", onionOnly: false, minEngines: 1 });
    setSessionLog([]);
    void secureDeviceVault.remove("session_log");
    setCaseEntities([]);
    setLastPurgeAt(Date.now());
    // Breaker history holds lastError strings with full search URLs incl.
    // query text — wipe it too or queries survive the screen-off purge.
    resetBreaker();
  }, [queryClient]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stored, t, savedQ, savedO, savedB, savedL] = await Promise.all([
        loadGhostSettings(),
        readTransport(),
        secureDeviceVault.get<string>("search_query", ""),
        secureDeviceVault.get<SearchOutcome | null>("search_outcome", null),
        secureDeviceVault.get<ResultRow[]>("bookmarks", []),
        secureDeviceVault.get<SessionQueryEvent[]>("session_log", []),
      ]);
      if (cancelled) return;
      if (savedQ) setSearchQuery(savedQ);
      if (savedO) setSearchOutcome(savedO);
      if (savedB && savedB.length > 0) setBookmarks(savedB);
      if (savedL && savedL.length > 0) setSessionLog(savedL);
      // Reset disclaimer on every app start — user must acknowledge each session.
      const withResetAck = { ...stored, disclaimerAck: false };
      setSettings(withResetAck);
      setTransport(t);
      setReady(true);
      void probeTor();
      // Kick registry-integrity verification early so the security screen can
      // show the resolved state; the search gate enforces it independently.
      void assertRegistryIntact().catch(() => {});
      // B16: prefer a stored registry import IF it still verifies under a
      // trusted key (anchor or operator-confirmed). Anything else falls back
      // to the bundled registry — fail-closed, never a silent switch.
      void (async () => {
        try {
          const stored = await loadImportedRegistry();
          if (!stored) return;
          const anchor = await readRegistryAnchor().catch(() => null);
          const trusted = (await loadTrustedKeys()).map((key) => base64ToSpkiBytes(key.spkiBase64));
          const result = await verifyRegistryImport({
            registry: stored.registry,
            sigText: stored.sigText,
            trustedSpkis: trusted,
            anchorSpki: anchor?.spkiBase64 ? base64ToSpkiBytes(anchor.spkiBase64) : null,
          });
          if (result.ok) {
            applyImportedRegistry(stored.registry);
            resetRegistryVerification();
          } else {
            console.warn(
              `[ghost] stored registry import rejected (${result.reason}) — bundled registry active`,
            );
            await clearImportedRegistry().catch(() => {});
            resetToBundledRegistry();
          }
          void assertRegistryIntact().catch(() => {});
        } catch {
          // Verify or apply threw — the stored import is malformed, so drop it
          // instead of retry-failing on every boot.
          void clearImportedRegistry().catch(() => {});
          resetToBundledRegistry();
        }
      })();
    })();
    return () => {
      cancelled = true;
    };
  }, [probeTor]);

  /* Refresh transport when returning from background. No purge on background
     — results stay in RAM for the duration of the session. Purge happens via
     panic button, when Android kills the process (RAM is gone anyway), or
     when the screen turns off (screen saver / lock screen). */
  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const unsub = await onAppStateChange((active) => {
        if (disposed) return;
        if (active) {
          void readTransport().then(setTransport);
          void probeTor();
          if (paranoidModeRef.current && !idleDecoyRef.current) {
            idleDecoyRef.current = startIdleDecoyScheduler(20_000);
          }
        } else {
          idleDecoyRef.current?.stop();
          idleDecoyRef.current = null;
        }
      });
      if (disposed) {
        unsub();
      } else {
        dispose = unsub;
      }
    })();
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [probeTor]);

  /* Purge session data when the screen turns off (screen saver / lock).
     This is distinct from a normal background transition (HOME key): the
     screen-off broadcast only fires when the display actually powers down,
     not when the user switches apps. This keeps the session alive during
     normal multitasking but wipes it when the device locks. Configurable
     via settings.purgeOnScreenOff — default on (historical behavior). */
  useEffect(() => {
    purgeOnScreenOffRef.current = settings.purgeOnScreenOff;
  }, [settings.purgeOnScreenOff]);
  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const unsub = await onScreenOff(() => {
        if (!disposed && purgeOnScreenOffRef.current) purgeNow();
      });
      if (disposed) {
        unsub();
      } else {
        dispose = unsub;
      }
    })();
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [purgeNow]);

  /* Idle decoy traffic (P5-2): when paranoid mode is ON, fire harmless
     cover requests at exponentially distributed intervals (~20s mean)
     to prevent "idle silence vs active burst" traffic correlation.
     Each idle decoy gets its own fresh SOCKS5 credentials (own circuit)
     so it is unlinkable to searches and to other idle decoys.
     Stopped when paranoid mode is off, on purge, and on screen-off
     (via the purge effect above which clears the session). */
  useEffect(() => {
    paranoidModeRef.current = settings.paranoidMode;
    if (settings.paranoidMode) {
      idleDecoyRef.current = startIdleDecoyScheduler(20_000);
    }
    return () => {
      idleDecoyRef.current?.stop();
      idleDecoyRef.current = null;
    };
  }, [settings.paranoidMode]);

  const value = useMemo<GhostContextValue>(() => {
    const egressOk =
      !settings.requireVpn ||
      torOk === true ||
      transport.vpnActive === true ||
      transport.connectionType === "web";
    return {
      ready,
      settings,
      transport,
      torOk,
      egressOk,
      async updateSettings(patch) {
        const next = { ...settings, ...patch };
        if (
          (patch.torSocksHost !== undefined && patch.torSocksHost !== settings.torSocksHost) ||
          (patch.torSocksPort !== undefined && patch.torSocksPort !== settings.torSocksPort)
        ) {
          invalidateTorVerification();
          void probeTor(next);
        }
        setSettings(next);
        await saveGhostSettings(next);
      },
      async refreshTransport() {
        setTransport(await readTransport());
        await probeTor();
      },
      registerPurge(purge) {
        purgers.current.add(purge);
        return () => purgers.current.delete(purge);
      },
      purgeNow,
      async panicWipe() {
        purgeNow();
        resetBreaker();
        try {
          await secureDeviceVault.clearAll();
          await clearGhostSettings();
          // Registry import + trusted keys too — the native wipe shreds
          // shared_prefs wholesale, but if that call fails the exitApp
          // fallback must not leave a re-applying import on disk (R2).
          await clearRegistryTrust();
        } catch {
          /* ensure native hard wipe always executes even if storage removal throws */
        }
        setSettings(defaultGhostSettings);
        await hardPanicWipeAndKill();
      },
      searchQuery,
      searchOutcome,
      setSearchQuery(q: string) {
        setSearchQuery(q);
        void secureDeviceVault.set("search_query", q);
      },
      setSearchOutcome(o: SearchOutcome | null) {
        setSearchOutcome(o);
        void secureDeviceVault.set("search_outcome", o);
      },
      getSessionEpoch: () => sessionEpochRef.current,
      bookmarks,
      toggleBookmark(row) {
        setBookmarks((prev) => {
          const exists = prev.some((b) => b.key === row.key);
          const next = exists ? prev.filter((b) => b.key !== row.key) : [...prev, row];
          void secureDeviceVault.set("bookmarks", next);
          return next;
        });
      },
      isBookmarked(key) {
        return bookmarks.some((b) => b.key === key);
      },
      filter,
      setFilter(patch) {
        setFilterState((prev) => ({ ...prev, ...patch }));
      },
      sessionLog,
      logQuery(event) {
        setSessionLog((prev) => {
          const next = [...prev, { ...event }];
          void secureDeviceVault.set("session_log", next);
          return next;
        });
      },
      caseEntities,
      setCaseEntities(entities) {
        setCaseEntities([...entities]);
      },
      lastPurgeAt,
    };
  }, [
    ready,
    settings,
    transport,
    torOk,
    probeTor,
    purgeNow,
    searchQuery,
    searchOutcome,
    bookmarks,
    filter,
    sessionLog,
    caseEntities,
    lastPurgeAt,
  ]);

  return <GhostContext.Provider value={value}>{children}</GhostContext.Provider>;
}

export function useGhost(): GhostContextValue {
  const context = useContext(GhostContext);
  if (!context) throw new Error("useGhost must be used inside <GhostProvider>");
  return context;
}
