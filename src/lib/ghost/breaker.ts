/**
 * Circuit breaker. In-memory only: restarting the app resets every engine.
 * Three consecutive failures open the circuit for five minutes so a dead onion
 * address does not cost 15 seconds on every single query.
 *
 * Also tracks per-engine health metrics (latency, success/failure counts,
 * last result count), a bounded 50-entry RAM ring buffer for trend analysis,
 * and 3-timeout deprecation tracking. All session-only, never persisted.
 */
const THRESHOLD = 3;
const OPEN_MS = 5 * 60_000;
const DEPRECATION_THRESHOLD = 3;
const HEALTH_HISTORY_MAX = 50;

type HealthEvent = {
  ts: number;
  status: "ok" | "captcha" | "failed" | "timeout";
  ms?: number | undefined;
  count?: number | undefined;
  error?: string | undefined;
};

type Entry = {
  failures: number;
  openUntil: number;
  lastError?: string | undefined;
  successes: number;
  totalFailures: number;
  lastMs?: number | undefined;
  lastCount?: number | undefined;
  lastStatus?: "ok" | "captcha" | "failed" | "open" | "deprecated" | undefined;
  consecutiveTimeouts: number;
  deprecated: boolean;
  deprecatedAt?: number | undefined;
  deprecatedReason?: string | undefined;
  history: HealthEvent[];
};

const state = new Map<string, Entry>();

function entry(id: string): Entry {
  let current = state.get(id);
  if (!current) {
    current = {
      failures: 0,
      openUntil: 0,
      successes: 0,
      totalFailures: 0,
      consecutiveTimeouts: 0,
      deprecated: false,
      history: [],
    };
    state.set(id, current);
  }
  return current;
}

function pushHistory(e: Entry, ev: HealthEvent): void {
  e.history.push(ev);
  if (e.history.length > HEALTH_HISTORY_MAX) {
    e.history.shift();
  }
}

export function isOpen(id: string): boolean {
  return entry(id).openUntil > Date.now();
}

export function openUntil(id: string): number {
  return entry(id).openUntil;
}

export function lastError(id: string): string | undefined {
  return entry(id).lastError;
}

export function recordSuccess(id: string, ms?: number, count?: number): void {
  const current = entry(id);
  current.failures = 0;
  current.openUntil = 0;
  current.consecutiveTimeouts = 0;
  current.successes += 1;
  if (ms !== undefined) current.lastMs = ms;
  if (count !== undefined) current.lastCount = count;
  current.lastStatus = current.deprecated ? "deprecated" : "ok";
  pushHistory(current, { ts: Date.now(), status: "ok", ms, count });
}

export function recordFailure(id: string, error: string, isTimeout?: boolean): void {
  const current = entry(id);
  current.failures += 1;
  current.totalFailures += 1;
  current.lastError = error;
  current.lastStatus = "failed";
  pushHistory(current, {
    ts: Date.now(),
    status: isTimeout ? "timeout" : "failed",
    error,
  });

  if (isTimeout) {
    current.consecutiveTimeouts += 1;
    if (current.consecutiveTimeouts >= DEPRECATION_THRESHOLD && !current.deprecated) {
      current.deprecated = true;
      current.deprecatedAt = Date.now();
      current.deprecatedReason = `${current.consecutiveTimeouts} consecutive timeouts`;
      current.lastStatus = "deprecated";
    }
  } else {
    current.consecutiveTimeouts = 0;
  }

  if (current.failures >= THRESHOLD && !current.deprecated) {
    current.openUntil = Date.now() + OPEN_MS;
    current.lastStatus = "open";
  }
}

export function recordCaptcha(id: string): void {
  const current = entry(id);
  current.lastStatus = "captcha";
  pushHistory(current, { ts: Date.now(), status: "captcha" });
}

export function isDeprecated(id: string): boolean {
  return entry(id).deprecated;
}

export function undeprecate(id: string): void {
  const current = entry(id);
  current.deprecated = false;
  current.deprecatedAt = undefined;
  current.deprecatedReason = undefined;
  current.consecutiveTimeouts = 0;
  current.failures = 0;
  current.openUntil = 0;
  current.lastStatus = "ok";
}

export function getDeprecatedEngines(): string[] {
  const result: string[] = [];
  for (const [id, e] of state) {
    if (e.deprecated) result.push(id);
  }
  return result;
}

export type HealthInfo = {
  successes: number;
  totalFailures: number;
  lastMs?: number | undefined;
  lastCount?: number | undefined;
  lastStatus?: "ok" | "captcha" | "failed" | "open" | "deprecated" | undefined;
  open: boolean;
  deprecated: boolean;
  consecutiveTimeouts: number;
  deprecatedReason?: string | undefined;
};

export function getHealth(id: string): HealthInfo {
  const e = entry(id);
  return {
    successes: e.successes,
    totalFailures: e.totalFailures,
    lastMs: e.lastMs,
    lastCount: e.lastCount,
    lastStatus: e.lastStatus,
    open: e.openUntil > Date.now(),
    deprecated: e.deprecated,
    consecutiveTimeouts: e.consecutiveTimeouts,
    deprecatedReason: e.deprecatedReason,
  };
}

export type HealthHistoryEntry = HealthEvent;

export function getHealthHistory(id: string): HealthHistoryEntry[] {
  return entry(id).history;
}

export type HealthTrend = {
  engine: string;
  eventCount: number;
  okCount: number;
  failCount: number;
  timeoutCount: number;
  captchaCount: number;
  okRate: number;
  meanMs?: number | undefined;
  medianMs?: number | undefined;
  p95Ms?: number | undefined;
  lastN: number;
};

export function getHealthTrend(id: string, lastN = 20): HealthTrend {
  const hist = entry(id).history;
  const slice = hist.slice(-lastN);
  let okCount = 0;
  let failCount = 0;
  let timeoutCount = 0;
  let captchaCount = 0;
  const latencies: number[] = [];
  for (const ev of slice) {
    if (ev.status === "ok") {
      okCount++;
      if (ev.ms !== undefined) latencies.push(ev.ms);
    } else if (ev.status === "failed") failCount++;
    else if (ev.status === "timeout") timeoutCount++;
    else if (ev.status === "captcha") captchaCount++;
  }
  latencies.sort((a, b) => a - b);
  const mean =
    latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : undefined;
  const median =
    latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : undefined;
  const p95 =
    latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : undefined;
  return {
    engine: id,
    eventCount: slice.length,
    okCount,
    failCount,
    timeoutCount,
    captchaCount,
    okRate: slice.length > 0 ? okCount / slice.length : 0,
    meanMs: mean,
    medianMs: median,
    p95Ms: p95,
    lastN,
  };
}

export function resetBreaker(id?: string): void {
  if (id) state.delete(id);
  else state.clear();
}
