import { describe, expect, it } from "vitest";
import { retryBackoffMs, sampleDelay, shuffleEngines, standardCamouflage } from "../camouflage";

describe("retryBackoffMs (jittered, non-fingerprinting)", () => {
  it("stays within [0.75x, 1.75x) of the base delay", () => {
    for (let i = 0; i < 500; i++) {
      const ms = retryBackoffMs(2000);
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(ms).toBeLessThan(3500);
    }
  });

  it("produces a spread distribution, not a constant (N runs)", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 200; i++) samples.add(Math.round(retryBackoffMs()));
    // 200 draws over ~2000 possible rounded values must not collapse to a few
    expect(samples.size).toBeGreaterThan(100);
  });

  it("mean over N runs lies near the band center (~2500 for base 2000)", () => {
    const N = 400;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += retryBackoffMs(2000);
    const mean = sum / N;
    expect(mean).toBeGreaterThan(2200);
    expect(mean).toBeLessThan(2800);
  });

  it("returns 0 for degenerate base values", () => {
    expect(retryBackoffMs(0)).toBe(0);
    expect(retryBackoffMs(Number.NaN)).toBe(0);
    expect(retryBackoffMs(-5)).toBe(0);
  });
});

describe("engine fetch interleaving (order + start delays randomized)", () => {
  it("engine order varies across searches", () => {
    const engines = Array.from({ length: 13 }, (_, i) => `e${i}`);
    const firsts = new Set<string>();
    for (let i = 0; i < 60; i++) firsts.add(shuffleEngines(engines)[0]!);
    // A constant or near-constant first engine would be a fixed fetch
    // signature; 13 engines over 60 shuffles must spread widely.
    expect(firsts.size).toBeGreaterThan(5);
  });

  it("start delays are not constant across engines/runs", () => {
    const cfg = standardCamouflage();
    const samples = new Set<number>();
    for (let i = 0; i < 100; i++) samples.add(Math.round(sampleDelay(cfg)));
    expect(samples.size).toBeGreaterThan(40);
  });
});
