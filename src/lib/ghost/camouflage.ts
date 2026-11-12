/**
 * Traffic-analysis defense layer ("Camouflage Layer").
 *
 * Implements FRONT-inspired request scheduling to break the recognizable
 * "N simultaneous requests" burst pattern that makes Ghost identifiable
 * via website fingerprinting.
 *
 * Research basis:
 * - FRONT (arXiv 2510.11804): 86%→1.6% detection accuracy with Rayleigh-
 *   distributed padding at trace start.
 * - RegulaTor (USENIX Security 2023): burst shaping into decaying surges,
 *   beats DNN-based attacks at <10% time overhead.
 *
 * None of these measures eliminate traffic analysis — they shift the cost
 * from "trivial packet-count heuristic" to "expensive adaptive ML attack
 * with uncertain outcome". See GHOST_V2_PLAN.md Phase 5 for the honest
 * threat model and what we explicitly do NOT promise.
 */
import { CANONICAL_ONION_REGISTRY } from "./authenticity";
import { fetchBodyOnly, type SocksAuth } from "./http";

/* ------------------------------------------------------------------ *
 * CSPRNG-backed distribution primitives
 * ------------------------------------------------------------------ */

const CSPRNG_POOL_SIZE = 1024;
const csprngPool = new Uint32Array(CSPRNG_POOL_SIZE);
let csprngIdx = CSPRNG_POOL_SIZE;

/**
 * Cryptographically secure uniform random float in [0, 1) backed by
 * Web Crypto API `crypto.getRandomValues` with a 1024-word buffer.
 */
export function randomFloat01(): number {
  if (csprngIdx >= CSPRNG_POOL_SIZE) {
    crypto.getRandomValues(csprngPool);
    csprngIdx = 0;
  }
  const u32 = csprngPool[csprngIdx++]!;
  return u32 / 0x1_0000_0000;
}

/** Sample from a Rayleigh distribution with scale parameter sigma. */
export function sampleRayleigh(sigma: number): number {
  if (!Number.isFinite(sigma) || sigma <= 0) return 0;
  const u = randomFloat01();
  return sigma * Math.sqrt(-2 * Math.log(1 - u));
}

/** Sample from an exponential distribution with rate lambda. */
export function sampleExponential(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  const u = randomFloat01();
  return -Math.log(1 - u) / lambda;
}

/** Fisher-Yates shuffle using CSPRNG. Returns a new array, does not mutate input. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(randomFloat01() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Random integer in [min, max] inclusive using CSPRNG. */
export function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(randomFloat01() * (hi - lo + 1));
}

/**
 * Jittered retry backoff. A fixed pause between a failed fetch and its retry
 * is itself a client fingerprint (an engine can clock the exact gap), so the
 * delay is drawn uniformly from [0.75×, 1.75×) of the base.
 */
export function retryBackoffMs(base = 2000): number {
  if (!Number.isFinite(base) || base <= 0) return 0;
  return base * (0.75 + randomFloat01());
}

/* ------------------------------------------------------------------ *
 * Abortable sleep
 * ------------------------------------------------------------------ */

/** Sleep for the given milliseconds. Resolves immediately if signal is already aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export type CamouflageConfig = {
  /** Rayleigh scale parameter for inter-request delays (ms). */
  sigmaMs: number;
  /** Minimum number of dummy decoy requests per search. */
  minDummies: number;
  /** Maximum number of dummy decoy requests per search. */
  maxDummies: number;
};

/**
 * Standard mode: light FRONT-inspired timing padding only (shuffled order +
 * short Rayleigh delays). No decoy traffic by default — dummy requests are a
 * bandwidth/trust trade-off reserved for paranoid mode.
 */
export function standardCamouflage(): CamouflageConfig {
  return { sigmaMs: 250, minDummies: 0, maxDummies: 0 };
}

/** Paranoid mode: stronger padding with more dummies. Higher bandwidth cost. */
export function paranoidCamouflage(): CamouflageConfig {
  return { sigmaMs: 500, minDummies: 3, maxDummies: 6 };
}

/* ------------------------------------------------------------------ *
 * Decoy traffic
 * ------------------------------------------------------------------ */

/**
 * Known harmless .onion endpoints for dummy/cover requests.
 * These are the same engine homepages already queried during normal
 * searches, so decoy traffic is indistinguishable from real prefetch.
 */
export const DECOY_TARGETS = [
  `http://${CANONICAL_ONION_REGISTRY["ahmia"]}.onion/`,
  `http://${CANONICAL_ONION_REGISTRY["torch"]}.onion/`,
  `http://${CANONICAL_ONION_REGISTRY["tor66"]}.onion/`,
  `http://${CANONICAL_ONION_REGISTRY["oss"]}.onion/`,
] as const;

/** Fire a single dummy request to a random .onion endpoint. Failures are silent. */
async function fireDecoy(socksAuth: SocksAuth): Promise<void> {
  const target = DECOY_TARGETS[randomInt(0, DECOY_TARGETS.length - 1)]!;
  try {
    await fetchBodyOnly(target, socksAuth);
  } catch {
    // Decoy failures are expected and harmless — the point is traffic, not content.
  }
}

/**
 * Fire a batch of dummy decoy requests alongside the real search.
 * Each decoy gets a Rayleigh-distributed delay so they don't all fire
 * at the same instant. All dummies use the same SOCKS5 auth (same circuit)
 * so they blend into the search traffic.
 */
export async function fireDecoys(
  config: CamouflageConfig,
  socksAuth: SocksAuth,
  signal?: AbortSignal,
): Promise<void> {
  const count = randomInt(config.minDummies, config.maxDummies);
  const tasks = Array.from({ length: count }, async () => {
    await sleep(sampleRayleigh(config.sigmaMs), signal);
    if (signal?.aborted) return;
    await fireDecoy(socksAuth);
  });
  await Promise.allSettled(tasks);
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/** Shuffle the engine pool to randomize request order. */
export function shuffleEngines<T>(engines: readonly T[]): T[] {
  return shuffle(engines);
}

/** Sample an inter-request delay from the Rayleigh distribution. */
export function sampleDelay(config: CamouflageConfig): number {
  return sampleRayleigh(config.sigmaMs);
}

/* ------------------------------------------------------------------ *
 * RegulaTor-style burst shaping (P5-3)
 * ------------------------------------------------------------------ */

export type SurgeConfig = {
  /** Number of requests per surge (3-4 per RegulaTor paper). */
  surgeSize: number;
  /** Exponential rate for inter-surge pauses (higher = shorter pauses). */
  pauseLambda: number;
  /** Rayleigh sigma for intra-surge delays. */
  intraSigmaMs: number;
};

/** Standard surge config: 3-4 requests per surge, moderate pauses. */
export function standardSurge(): SurgeConfig {
  return { surgeSize: 4, pauseLambda: 1 / 800, intraSigmaMs: 150 };
}

/** Paranoid surge config: smaller surges, longer pauses. */
export function paranoidSurge(): SurgeConfig {
  return { surgeSize: 3, pauseLambda: 1 / 1500, intraSigmaMs: 250 };
}

/**
 * Assign each engine a start delay using RegulaTor-style surge shaping.
 * Engines are split into surges of `surgeSize` requests. Within a surge,
 * each request gets a Rayleigh delay. Between surges, there is an
 * exponentially distributed pause. This breaks the "N simultaneous
 * streams" signature with <10% time overhead.
 */
export function assignSurgeDelays(engineCount: number, config: SurgeConfig): number[] {
  const delays: number[] = [];
  let surgeStart = 0;
  for (let i = 0; i < engineCount; i++) {
    const positionInSurge = i % config.surgeSize;
    if (positionInSurge === 0 && i > 0) {
      // Inter-surge pause (exponential)
      surgeStart += sampleExponential(config.pauseLambda);
    }
    // Intra-surge delay (Rayleigh)
    delays.push(surgeStart + sampleRayleigh(config.intraSigmaMs));
  }
  return delays;
}

/* ------------------------------------------------------------------ *
 * Idle-state decoy scheduler (P5-2)
 * ------------------------------------------------------------------ */

/**
 * Handle for a running idle decoy scheduler. Call `stop()` to cancel it.
 */
export type IdleDecoyHandle = {
  stop: () => void;
};

/**
 * Fire a single idle decoy with fresh SOCKS5 credentials (own circuit).
 * Idle decoys must NOT share a circuit with any search — each gets its
 * own random nonce so they are unlinkable to each other and to searches.
 */
async function fireIdleDecoy(): Promise<void> {
  const socksAuth: SocksAuth = {
    user: "ghost-idle",
    pass: crypto.randomUUID(),
  };
  const target = DECOY_TARGETS[randomInt(0, DECOY_TARGETS.length - 1)]!;
  try {
    await fetchBodyOnly(target, socksAuth);
  } catch {
    // Idle decoy failures are expected and harmless.
  }
}

/**
 * Start a background scheduler that fires idle decoy requests at
 * exponentially distributed intervals. This prevents an observer from
 * correlating "traffic burst = active search" 1:1, because traffic
 * exists in the idle state too.
 *
 * Only active in paranoid mode. Must be stopped when paranoid mode is
 * turned off, the app goes to background, or the screen turns off.
 *
 * @param meanIntervalMs Mean interval between decoys (exponential distribution).
 * @returns Handle with a stop() method.
 */
export function startIdleDecoyScheduler(meanIntervalMs: number): IdleDecoyHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lambda = 1 / meanIntervalMs;

  const scheduleNext = () => {
    if (stopped) return;
    const delay = sampleExponential(lambda);
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await fireIdleDecoy();
      } catch {
        // M2 fix: a decoy failure must never kill the scheduler silently.
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
