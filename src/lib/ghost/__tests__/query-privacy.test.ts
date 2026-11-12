import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECOY_POOL_CAPACITY,
  DECOY_REFILL_TIMEOUT_MS,
  QueryPrivacySession,
  REWRITE_TIMEOUT_MS,
  type QueryPrivacyRuntime,
} from "../query-privacy";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function runtime(): QueryPrivacyRuntime {
  return {
    rewrite: vi.fn(async () => "Find 2026 server logs"),
    generateDecoys: vi.fn(async () => "museum opening hours\nmarine biology\nrail timetables"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("QueryPrivacySession", () => {
  it("does not start the runtime on construction or when disabled", async () => {
    const model = runtime();
    const session = new QueryPrivacySession(model);
    expect(await session.prepare("server logs", { enabled: false })).toEqual({
      status: "ready",
      query: "server logs",
      rewrite: "disabled",
      decoys: [],
    });
    expect(model.rewrite).not.toHaveBeenCalled();
    expect(model.generateDecoys).not.toHaveBeenCalled();
  });

  it("degrades without a configured model", async () => {
    const session = new QueryPrivacySession();
    expect(await session.refill()).toBe(0);
    expect(await session.prepare("server logs", { enabled: true })).toEqual({
      status: "ready",
      query: "server logs",
      rewrite: "unavailable",
      decoys: [],
    });
  });

  it("prepares a checked rewrite and consumes only prefetched decoys", async () => {
    const model = runtime();
    const session = new QueryPrivacySession(model);
    expect(await session.refill()).toBe(3);
    expect(await session.prepare("please find server logs 2026", { enabled: true })).toEqual({
      status: "ready",
      query: "Find 2026 server logs",
      rewrite: "applied",
      decoys: ["museum opening hours", "marine biology", "rail timetables"],
    });
    expect(session.poolSize).toBe(0);
    await session.prepare("server logs 2026", { enabled: true });
    expect(model.generateDecoys).toHaveBeenCalledTimes(1);
    const refillCall = vi.mocked(model.generateDecoys).mock.calls[0]!;
    expect(refillCall).toHaveLength(1);
    expect(refillCall[0]).toBeInstanceOf(AbortSignal);
  });

  it("bounds the pool and rejects duplicates across refills", async () => {
    const model = runtime();
    vi.mocked(model.generateDecoys).mockResolvedValue(
      ["museum hours", "MUSEUM hours", "museum hours on weekends"].join("\n"),
    );
    const session = new QueryPrivacySession(model);
    expect(await session.refill()).toBe(1);
    expect(await session.refill()).toBe(0);
    vi.mocked(model.generateDecoys).mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => `topic${i} archive${i}`).join("\n"),
    );
    expect(await session.refill()).toBe(DECOY_POOL_CAPACITY - 1);
    expect(session.poolSize).toBe(DECOY_POOL_CAPACITY);
    expect(await session.refill()).toBe(0);
    expect(model.generateDecoys).toHaveBeenCalledTimes(3);
  });

  it("drops pool entries too close to the real query before consumption", async () => {
    const model = runtime();
    vi.mocked(model.generateDecoys).mockResolvedValue("server logs 2026\nmarine biology");
    const session = new QueryPrivacySession(model);
    await session.refill();
    expect(await session.prepare("server logs 2026", { enabled: true })).toMatchObject({
      decoys: ["marine biology"],
    });
    expect(session.poolSize).toBe(0);
  });

  it("rejects a changed year instead of silently changing search intent", async () => {
    const model = runtime();
    vi.mocked(model.rewrite).mockResolvedValue("server logs 2027");
    const session = new QueryPrivacySession(model);
    expect(await session.prepare("server logs 2026", { enabled: true })).toMatchObject({
      status: "ready",
      query: "server logs 2026",
      rewrite: "rejected",
    });
  });

  it("does not send oversized queries to the runtime", async () => {
    const model = runtime();
    const session = new QueryPrivacySession(model);
    expect(await session.prepare("a".repeat(257), { enabled: true })).toMatchObject({
      rewrite: "rejected",
    });
    expect(model.rewrite).not.toHaveBeenCalled();
  });

  it("fails soft on synchronous runtime exceptions", async () => {
    const model = runtime();
    vi.mocked(model.rewrite).mockImplementation(() => {
      throw new Error("unavailable");
    });
    vi.mocked(model.generateDecoys).mockRejectedValue(new Error("unavailable"));
    const session = new QueryPrivacySession(model);
    expect(await session.refill()).toBe(0);
    expect(await session.prepare("server logs", { enabled: true })).toMatchObject({
      query: "server logs",
      rewrite: "unavailable",
    });
  });

  it("bounds rewrite latency even when the runtime ignores abort", async () => {
    vi.useFakeTimers();
    const model = runtime();
    const pending = deferred<string>();
    vi.mocked(model.rewrite).mockReturnValue(pending.promise);
    const session = new QueryPrivacySession(model);
    const prepared = session.prepare("server logs", { enabled: true });
    await vi.advanceTimersByTimeAsync(REWRITE_TIMEOUT_MS);
    expect(await prepared).toEqual({
      status: "ready",
      query: "server logs",
      rewrite: "timeout",
      decoys: [],
    });
    expect(vi.mocked(model.rewrite).mock.calls[0]![1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve("late model output");
    await Promise.resolve();
    expect(session.poolSize).toBe(0);
  });

  it("cancels instead of falling back to a raw query after purge", async () => {
    const model = runtime();
    const pending = deferred<string>();
    vi.mocked(model.rewrite).mockReturnValue(pending.promise);
    const session = new QueryPrivacySession(model);
    await session.refill();
    const prepared = session.prepare("server logs", { enabled: true });
    await Promise.resolve();
    session.purge();
    expect(await prepared).toEqual({ status: "cancelled" });
    expect(session.poolSize).toBe(0);
    expect(vi.mocked(model.rewrite).mock.calls[0]![1].aborted).toBe(true);
    pending.resolve("server logs");
  });

  it("cancels parent-aborted requests without retaining event listeners", async () => {
    vi.useFakeTimers();
    const model = runtime();
    vi.mocked(model.rewrite).mockReturnValue(new Promise(() => {}));
    const session = new QueryPrivacySession(model);
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const prepared = session.prepare("server logs", { enabled: true, signal: parent.signal });
    parent.abort();
    expect(await prepared).toEqual({ status: "cancelled" });
    expect(remove).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no work for a pre-aborted request", async () => {
    const model = runtime();
    const session = new QueryPrivacySession(model);
    const signal = AbortSignal.abort();
    expect(await session.prepare("server logs", { enabled: true, signal })).toEqual({
      status: "cancelled",
    });
    expect(await session.refill(signal)).toBe(0);
    expect(model.rewrite).not.toHaveBeenCalled();
    expect(model.generateDecoys).not.toHaveBeenCalled();
  });

  it("coalesces idle refills and ignores stale output after purge", async () => {
    const model = runtime();
    const pending = deferred<string>();
    vi.mocked(model.generateDecoys).mockReturnValueOnce(pending.promise);
    const session = new QueryPrivacySession(model);
    const first = session.refill();
    expect(session.refill()).toBe(first);
    await Promise.resolve();
    session.purge();
    expect(await first).toBe(0);
    expect(await session.refill()).toBe(3);
    pending.resolve("old session query");
    await Promise.resolve();
    expect(session.poolSize).toBe(3);
  });

  it("bounds idle generation time independently of rewrite latency", async () => {
    vi.useFakeTimers();
    const model = runtime();
    vi.mocked(model.generateDecoys).mockReturnValue(new Promise(() => {}));
    const session = new QueryPrivacySession(model);
    const refilled = session.refill();
    await vi.advanceTimersByTimeAsync(DECOY_REFILL_TIMEOUT_MS);
    expect(await refilled).toBe(0);
    expect(vi.mocked(model.generateDecoys).mock.calls[0]![0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
