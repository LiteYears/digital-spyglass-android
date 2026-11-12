import type { CorrelationReport } from "./correlation";

export type EntityType = "btc" | "pgp" | "email" | "onion" | "xmr" | "cve" | "ipv4";

export type EntityBadge = {
  type: EntityType;
  value: string;
  /** Optional wallet enrichment (checksum validity / address shape / reuse hint). */
  detail?: string;
};

/**
 * Ghost Mode types.
 *
 * Nothing in here is ever persisted. Every value lives in RAM for the duration
 * of the session and is dropped on panic wipe, screen lock, or app exit.
 */

export type RawResult = {
  title: string;
  /** Target URL as advertised by the engine (may be onion or clearnet). */
  url: string;
  snippet: string;
  engineId: string;
};

export type ResultRow = {
  /** Normalised URL, used as the dedupe key. */
  key: string;
  url: string;
  title: string;
  snippet: string;
  /** True when the snippet was replaced by the liability filter. */
  withheld: boolean;
  onion: boolean;
  engines: string[];
  score: number;
  /** Entities detected in the snippet (BTC, PGP, email, onion links, XMR, CVE, IPv4). */
  entities?: EntityBadge[] | undefined;
  /** Scam/mirror flag — conservative heuristic, advisory only. */
  scamFlag?: string | undefined;
  /** SOTA quality filter score & flags (non-destructive modifier). */
  qualityScore?: number | undefined;
  qualityFlags?: string[] | undefined;
  snippetSufficient?: boolean | undefined;
  snippetQualityReason?: string | undefined;
  /** True when domain matches opt-in Ahmia abuse blacklist (marked, never removed). */
  blacklisted?: boolean | undefined;
  /** Number of other results in this search sharing an extracted entity with this row. */
  correlatedCount?: number | undefined;
  /** v4.0 cryptographic v3 .onion checksum & vanity-prefix spoof verification status. */
  authenticity?:
    "CANONICAL" | "UNVERIFIED_VALID" | "SUSPECTED_VANITY_CLONE" | "INVALID_ONION" | undefined;
};

export type EngineState =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "ok";
      count: number;
      ms: number;
      /** Mirror base host when the answer came via a mirror, not the primary. */ via?: string;
    }
  | { status: "captcha"; url: string }
  | { status: "failed"; error: string }
  | { status: "open"; until: number }
  | { status: "deprecated"; reason: string };

export type EngineReport = {
  id: string;
  name: string;
  state: EngineState;
  adapted?:
    | {
        truncated: boolean;
        termsDropped: boolean;
        operatorsStripped: boolean;
      }
    | undefined;
};

export type SearchOutcome = {
  query: string;
  rows: ResultRow[];
  reports: EngineReport[];
  startedAt: number;
  durationMs: number;
  correlation?: CorrelationReport | undefined;
  fastMode?: boolean | undefined;
  qarfApplied?: boolean | undefined;
};

export type GhostSettings = {
  /** Engine ids to query. Empty = every healthy engine (or 5 Core+Reinforcement in fastMode). */
  engines: string[];
  /** Liability control: replace high-risk snippets with a placeholder. */
  snippetFilter: boolean;
  /** Block search unless a VPN transport (Orbot VPN mode) is active. */
  requireVpn: boolean;
  /** Per-session disclaimer acknowledgement (reset on every app start). */
  disclaimerAck: boolean;
  /** Tor SOCKS5 endpoint — default Orbot localhost. Custom daemon/LAN relay allowed. */
  torSocksHost: string;
  torSocksPort: string;
  /** Paranoid mode: stronger traffic-analysis camouflage (surge shaping + more decoys). */
  paranoidMode: boolean;
  /** Fast mode: query only the 5 Core + Reinforcement engines (-60% latency). */
  fastMode: boolean;
  /** QARF: Query Adaptive Rank Fusion (IDF-based per-query engine weighting). */
  qarfMode: boolean;
  /** Opt-in Ahmia abuse blacklist marking (marks matching domains, never removes). */
  blacklistFilter: boolean;
  /** Purge the session when the screen turns off. Default on — historical
   *  behavior; turning it off trades anti-forensics for session convenience. */
  purgeOnScreenOff: boolean;
  /** Allow clearnet (non-.onion) result links — opt-in, default off.
   *  Engine-supplied redirect params can otherwise surface clearnet URLs
   *  (Beam audit F8). Traffic still transits Tor either way; this only
   *  controls which destinations are offered. */
  allowClearnet: boolean;
  /** Chosen threat-model preset (first-run onboarding). null = not chosen yet. */
  persona: PersonaId | null;
};

export type PersonaId = "hostile" | "free" | "curious";

export type GhostErrorKind =
  "vpn_missing" | "empty_query" | "no_engines" | "all_failed" | "registry_integrity_failed";

export type SortMode = "best" | "engines";

export type FilterState = {
  sort: SortMode;
  onionOnly: boolean;
  minEngines: number;
};

export class GhostError extends Error {
  kind: GhostErrorKind;
  reports?: EngineReport[] | undefined;

  constructor(kind: GhostErrorKind, message: string, reports?: EngineReport[] | undefined) {
    super(message);
    this.name = "GhostError";
    this.kind = kind;
    this.reports = reports;
  }
}
