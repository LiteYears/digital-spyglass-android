import { describe, it, expect } from "vitest";
import {
  sampleRayleigh,
  sampleExponential,
  shuffle,
  randomInt,
  sleep,
  standardCamouflage,
  paranoidCamouflage,
  standardSurge,
  paranoidSurge,
  shuffleEngines,
  sampleDelay,
  assignSurgeDelays,
  type CamouflageConfig,
  type SurgeConfig,
} from "../camouflage";

/* ------------------------------------------------------------------ *
 * Statistical helpers
 * ------------------------------------------------------------------ */

function sampleStats(samples: number[]): {
  mean: number;
  variance: number;
  min: number;
  max: number;
} {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, variance, min: Math.min(...samples), max: Math.max(...samples) };
}

const N = 50_000;

/* ------------------------------------------------------------------ *
 * Rayleigh distribution
 * ------------------------------------------------------------------ */

describe("sampleRayleigh", () => {
  it("always returns non-negative values", () => {
    for (let i = 0; i < 10_000; i++) {
      const v = sampleRayleigh(250);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("never returns NaN or Infinity", () => {
    for (let i = 0; i < 10_000; i++) {
      const v = sampleRayleigh(500);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("sample mean approximates sigma * sqrt(pi/2)", () => {
    const sigma = 250;
    const theoreticalMean = sigma * Math.sqrt(Math.PI / 2); // ~313.3
    const samples = Array.from({ length: N }, () => sampleRayleigh(sigma));
    const { mean } = sampleStats(samples);
    // 5% tolerance — with N=50k the standard error of the mean is tiny
    expect(mean).toBeGreaterThan(theoreticalMean * 0.95);
    expect(mean).toBeLessThan(theoreticalMean * 1.05);
  });

  it("sample variance approximates (4-pi)/2 * sigma^2", () => {
    const sigma = 250;
    const theoreticalVariance = ((4 - Math.PI) / 2) * sigma ** 2; // ~43,197
    const samples = Array.from({ length: N }, () => sampleRayleigh(sigma));
    const { variance } = sampleStats(samples);
    // 10% tolerance — variance is noisier than mean
    expect(variance).toBeGreaterThan(theoreticalVariance * 0.85);
    expect(variance).toBeLessThan(theoreticalVariance * 1.15);
  });

  it("scales linearly with sigma", () => {
    const sigma1 = 100;
    const sigma2 = 500;
    const samples1 = Array.from({ length: N }, () => sampleRayleigh(sigma1));
    const samples2 = Array.from({ length: N }, () => sampleRayleigh(sigma2));
    const ratio = sampleStats(samples2).mean / sampleStats(samples1).mean;
    // Mean should scale 5x (500/100)
    expect(ratio).toBeGreaterThan(4.7);
    expect(ratio).toBeLessThan(5.3);
  });

  it("with sigma=0 always returns 0", () => {
    for (let i = 0; i < 100; i++) {
      expect(sampleRayleigh(0)).toBe(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Exponential distribution
 * ------------------------------------------------------------------ */

describe("sampleExponential", () => {
  it("always returns non-negative values", () => {
    for (let i = 0; i < 10_000; i++) {
      const v = sampleExponential(1 / 800);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("never returns NaN or Infinity", () => {
    for (let i = 0; i < 10_000; i++) {
      const v = sampleExponential(1 / 1500);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("sample mean approximates 1/lambda", () => {
    const lambda = 1 / 800;
    const theoreticalMean = 1 / lambda; // 800
    const samples = Array.from({ length: N }, () => sampleExponential(lambda));
    const { mean } = sampleStats(samples);
    expect(mean).toBeGreaterThan(theoreticalMean * 0.95);
    expect(mean).toBeLessThan(theoreticalMean * 1.05);
  });

  it("sample variance approximates 1/lambda^2", () => {
    const lambda = 1 / 800;
    const theoreticalVariance = 1 / lambda ** 2; // 640,000
    const samples = Array.from({ length: N }, () => sampleExponential(lambda));
    const { variance } = sampleStats(samples);
    // 15% tolerance — exponential variance is very noisy
    expect(variance).toBeGreaterThan(theoreticalVariance * 0.8);
    expect(variance).toBeLessThan(theoreticalVariance * 1.2);
  });

  it("has the memoryless property (rough check)", () => {
    // P(X > 2*mean) should be approximately e^-2 ≈ 0.135
    const lambda = 1 / 1000;
    const mean = 1 / lambda;
    const samples = Array.from({ length: N }, () => sampleExponential(lambda));
    const fracAbove2Mean = samples.filter((s) => s > 2 * mean).length / N;
    expect(fracAbove2Mean).toBeGreaterThan(0.1);
    expect(fracAbove2Mean).toBeLessThan(0.17);
  });
});

/* ------------------------------------------------------------------ *
 * Shuffle
 * ------------------------------------------------------------------ */

describe("shuffle", () => {
  it("does not mutate the input array", () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = [...input];
    shuffle(input);
    expect(input).toEqual(snapshot);
  });

  it("returns a permutation of the input (same elements)", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = shuffle(input);
    expect(result.sort((a, b) => a - b)).toEqual(input);
  });

  it("returns a new array (different reference)", () => {
    const input = [1, 2, 3];
    const result = shuffle(input);
    expect(result).not.toBe(input);
  });

  it("handles empty array", () => {
    expect(shuffle([])).toEqual([]);
  });

  it("handles single-element array", () => {
    expect(shuffle([42])).toEqual([42]);
  });

  it("produces different orderings across calls (randomness)", () => {
    const input = Array.from({ length: 100 }, (_, i) => i);
    const results = new Set(Array.from({ length: 20 }, () => shuffle(input).join(",")));
    // With 100 elements, 20 shuffles should produce at least 15 distinct orderings
    expect(results.size).toBeGreaterThan(15);
  });
});

/* ------------------------------------------------------------------ *
 * randomInt
 * ------------------------------------------------------------------ */

describe("randomInt", () => {
  it("always returns values within [min, max]", () => {
    for (let i = 0; i < 10_000; i++) {
      const v = randomInt(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
    }
  });

  it("returns min == max correctly", () => {
    for (let i = 0; i < 100; i++) {
      expect(randomInt(5, 5)).toBe(5);
    }
  });

  it("produces all values in range (coverage)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(randomInt(1, 4));
    }
    expect(seen.size).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * sleep
 * ------------------------------------------------------------------ */

describe("sleep", () => {
  it("resolves after approximately the given milliseconds", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(200);
  });

  it("resolves immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await sleep(10_000, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("can be aborted mid-sleep", async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 30);
    await sleep(10_000, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

/* ------------------------------------------------------------------ *
 * Configuration factories
 * ------------------------------------------------------------------ */

describe("standardCamouflage", () => {
  it("returns expected config values", () => {
    const cfg: CamouflageConfig = standardCamouflage();
    expect(cfg.sigmaMs).toBe(250);
    expect(cfg.minDummies).toBe(0);
    expect(cfg.maxDummies).toBe(0);
  });

  it("minDummies <= maxDummies", () => {
    const cfg = standardCamouflage();
    expect(cfg.minDummies).toBeLessThanOrEqual(cfg.maxDummies);
  });
});

describe("paranoidCamouflage", () => {
  it("returns expected config values", () => {
    const cfg: CamouflageConfig = paranoidCamouflage();
    expect(cfg.sigmaMs).toBe(500);
    expect(cfg.minDummies).toBe(3);
    expect(cfg.maxDummies).toBe(6);
  });

  it("is stronger than standard", () => {
    const std = standardCamouflage();
    const par = paranoidCamouflage();
    expect(par.sigmaMs).toBeGreaterThan(std.sigmaMs);
    expect(par.minDummies).toBeGreaterThanOrEqual(std.minDummies);
  });
});

describe("standardSurge", () => {
  it("returns expected config values", () => {
    const cfg: SurgeConfig = standardSurge();
    expect(cfg.surgeSize).toBe(4);
    expect(cfg.pauseLambda).toBe(1 / 800);
    expect(cfg.intraSigmaMs).toBe(150);
  });
});

describe("paranoidSurge", () => {
  it("returns expected config values", () => {
    const cfg: SurgeConfig = paranoidSurge();
    expect(cfg.surgeSize).toBe(3);
    expect(cfg.pauseLambda).toBe(1 / 1500);
    expect(cfg.intraSigmaMs).toBe(250);
  });

  it("has smaller surges and longer pauses than standard", () => {
    const std = standardSurge();
    const par = paranoidSurge();
    expect(par.surgeSize).toBeLessThanOrEqual(std.surgeSize);
    expect(par.pauseLambda).toBeLessThan(std.pauseLambda); // lower rate = longer pauses
  });
});

/* ------------------------------------------------------------------ *
 * shuffleEngines / sampleDelay (public wrappers)
 * ------------------------------------------------------------------ */

describe("shuffleEngines", () => {
  it("returns a permutation of the input", () => {
    const engines = ["ahmia", "torch", "tor66", "oss", "torgle"];
    const result = shuffleEngines(engines);
    expect(result.sort()).toEqual([...engines].sort());
  });

  it("does not mutate input", () => {
    const engines = ["ahmia", "torch", "tor66"];
    const snapshot = [...engines];
    shuffleEngines(engines);
    expect(engines).toEqual(snapshot);
  });
});

describe("sampleDelay", () => {
  it("returns non-negative values from the Rayleigh distribution", () => {
    const cfg = standardCamouflage();
    for (let i = 0; i < 1000; i++) {
      const d = sampleDelay(cfg);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("paranoid delays are stochastically larger than standard", () => {
    const stdCfg = standardCamouflage();
    const parCfg = paranoidCamouflage();
    const stdSamples = Array.from({ length: 5000 }, () => sampleDelay(stdCfg));
    const parSamples = Array.from({ length: 5000 }, () => sampleDelay(parCfg));
    const stdMean = stdSamples.reduce((a, b) => a + b, 0) / 5000;
    const parMean = parSamples.reduce((a, b) => a + b, 0) / 5000;
    expect(parMean).toBeGreaterThan(stdMean);
  });
});

/* ------------------------------------------------------------------ *
 * assignSurgeDelays
 * ------------------------------------------------------------------ */

describe("assignSurgeDelays", () => {
  it("returns one delay per engine", () => {
    const cfg = standardSurge();
    const delays = assignSurgeDelays(14, cfg);
    expect(delays).toHaveLength(14);
  });

  it("all delays are non-negative", () => {
    const cfg = standardSurge();
    const delays = assignSurgeDelays(10, cfg);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles zero engines", () => {
    const cfg = standardSurge();
    expect(assignSurgeDelays(0, cfg)).toEqual([]);
  });

  it("handles single engine (one surge, no pause)", () => {
    const cfg = standardSurge();
    const delays = assignSurgeDelays(1, cfg);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(0);
  });

  it("average delays increase across surge boundaries", () => {
    // With surge shaping, engines in later surges start later on average.
    // Within a surge, delays are surgeStart + Rayleigh, so they're roughly
    // equal — the increase happens at surge boundaries (exponential pause).
    const cfg = standardSurge(); // surgeSize=4
    const trials = 5000;
    const engineCount = 12; // 3 surges of 4
    const sums = Array(engineCount).fill(0);
    for (let t = 0; t < trials; t++) {
      const delays = assignSurgeDelays(engineCount, cfg);
      for (let i = 0; i < engineCount; i++) {
        sums[i]! += delays[i]!;
      }
    }
    const avgs = sums.map((s) => s / trials);
    // First engine of each surge should have higher avg than first of previous
    // surge 0: idx 0, surge 1: idx 4, surge 2: idx 8
    expect(avgs[4]!).toBeGreaterThan(avgs[0]!);
    expect(avgs[8]!).toBeGreaterThan(avgs[4]!);
  });

  it("surge boundaries create visible pauses", () => {
    // With surgeSize=4, the 5th engine (index 4) should have an exponential
    // pause added. On average, the gap between engine 3 and engine 4 should
    // be larger than the gap between engine 0 and engine 1 (intra-surge).
    const cfg = standardSurge(); // surgeSize=4
    const trials = 5000;
    let intraGapSum = 0;
    let interGapSum = 0;
    for (let t = 0; t < trials; t++) {
      const delays = assignSurgeDelays(8, cfg);
      intraGapSum += delays[1]! - delays[0]!;
      interGapSum += delays[4]! - delays[3]!;
    }
    const avgIntraGap = intraGapSum / trials;
    const avgInterGap = interGapSum / trials;
    // Inter-surge gap should be significantly larger than intra-surge gap
    // Intra-surge: Rayleigh(150) mean ~188ms
    // Inter-surge: Rayleigh(150) + Exponential(1/800) mean ~188 + 800 = 988ms
    expect(avgInterGap).toBeGreaterThan(avgIntraGap * 2);
  });
});
