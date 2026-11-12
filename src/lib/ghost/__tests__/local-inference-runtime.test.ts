import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNative } from "../../platform/bridge";
import { registerPlugin } from "@capacitor/core";
import {
  createNativeQueryPrivacyRuntime,
  DECOY_SYSTEM_PROMPT,
  DECOY_USER_PROMPT,
  REWRITE_SYSTEM_PROMPT,
  type LocalInferencePluginLike,
} from "../local-inference-runtime";
import { DECOY_REFILL_TIMEOUT_MS, QueryPrivacySession, REWRITE_TIMEOUT_MS } from "../query-privacy";
import { parseDecoyLines } from "../query-privacy-guards";

vi.mock("../../platform/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../platform/bridge")>();
  return { ...actual, isNative: vi.fn(async () => false) };
});

let pluginUnderTest: LocalInferencePluginLike | undefined;
vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => pluginUnderTest),
}));

type CompleteArgs = Parameters<LocalInferencePluginLike["complete"]>[0];

function fakePlugin(handler: (args: CompleteArgs) => Promise<{ text: string }>) {
  const calls: CompleteArgs[] = [];
  const cancels: string[] = [];
  const plugin: LocalInferencePluginLike = {
    complete: (args) => {
      calls.push(args);
      return handler(args);
    },
    cancel: (args) => {
      cancels.push(args.callId);
      return Promise.resolve();
    },
  };
  return { plugin, calls, cancels };
}

const freshSignal = () => new AbortController().signal;

beforeEach(() => {
  vi.mocked(isNative).mockResolvedValue(false);
  pluginUnderTest = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createNativeQueryPrivacyRuntime", () => {
  it("sends the rewrite prompt with a bounded, well-formed payload", async () => {
    const { plugin, calls } = fakePlugin(async () => ({ text: "Find 2026 server logs" }));
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    const result = await runtime.rewrite("please find server logs 2026", freshSignal());
    expect(result).toBe("Find 2026 server logs");
    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args.port).toBe(8080);
    expect(args.system).toBe(REWRITE_SYSTEM_PROMPT);
    expect(args.user).toBe("please find server logs 2026");
    expect(args.maxTokens).toBe(128);
    expect(args.timeoutMs).toBe(REWRITE_TIMEOUT_MS);
    expect(args.callId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("generates decoys without ever seeing the real query", async () => {
    const { plugin, calls } = fakePlugin(async () => ({ text: "museum hours" }));
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    await runtime.rewrite("sensitive real query about cve-2024-3094", freshSignal());
    const output = await runtime.generateDecoys(freshSignal());
    expect(output).toBe("museum hours");
    expect(calls).toHaveLength(2);
    const decoyArgs = calls[1]!;
    expect(decoyArgs.system).toBe(DECOY_SYSTEM_PROMPT);
    expect(decoyArgs.user).toBe(DECOY_USER_PROMPT);
    expect(decoyArgs.maxTokens).toBe(256);
    expect(decoyArgs.timeoutMs).toBe(DECOY_REFILL_TIMEOUT_MS);
    expect(JSON.stringify(decoyArgs)).not.toContain("sensitive");
    expect(JSON.stringify(decoyArgs)).not.toContain("cve-2024-3094");
  });

  it("rejects an already-aborted signal without touching the plugin", async () => {
    const { plugin, calls } = fakePlugin(async () => ({ text: "x" }));
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.rewrite("q", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(runtime.generateDecoys(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toHaveLength(0);
  });

  it("aborts mid-flight: cancels natively and rejects promptly", async () => {
    vi.useFakeTimers();
    const { plugin, calls, cancels } = fakePlugin(() => new Promise<{ text: string }>(() => {}));
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    const controller = new AbortController();
    const pending = runtime.rewrite("server logs", controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection; // resolves without any timer advance — no wait for native
    expect(cancels).toEqual([calls[0]!.callId]);
  });

  it("rejects when the signal aborts while the plugin is still resolving", async () => {
    vi.useFakeTimers();
    const { plugin, calls } = fakePlugin(async () => ({ text: "x" }));
    pluginUnderTest = plugin;
    vi.mocked(isNative).mockImplementation(
      () => new Promise<boolean>((accept) => setTimeout(() => accept(true), 1000)),
    );
    // No injected plugin: exercise the real registerPlugin resolution path.
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080 });
    const controller = new AbortController();
    const pending = runtime.rewrite("server logs", controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000); // isNative resolves -> recheck fires
    await rejection;
    expect(vi.mocked(registerPlugin)).toHaveBeenCalled();
    expect(calls).toHaveLength(0); // complete() was never invoked
  });

  it("rejects when the signal aborts during complete() dispatch", async () => {
    const controller = new AbortController();
    const { plugin, calls, cancels } = fakePlugin(() => {
      controller.abort(); // abort lands inside the dispatch window
      return new Promise<{ text: string }>(() => {});
    });
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    const pending = runtime.rewrite("server logs", controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await rejection;
    expect(cancels).toEqual([calls[0]!.callId]);
  });

  it("settles a synchronous complete() throw and removes the abort listener", async () => {
    const { plugin, cancels } = fakePlugin(() => {
      throw new Error("bridge exploded");
    });
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    const controller = new AbortController();
    await expect(runtime.rewrite("q", controller.signal)).rejects.toThrow("bridge exploded");
    controller.abort(); // if the listener leaked, cancel would fire now
    await Promise.resolve();
    expect(cancels).toHaveLength(0);
  });

  it("ignores a late native resolution after abort", async () => {
    let resolveNative!: (value: { text: string }) => void;
    const { plugin, calls } = fakePlugin(
      () =>
        new Promise<{ text: string }>((accept) => {
          resolveNative = accept;
        }),
    );
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    const controller = new AbortController();
    const pending = runtime.rewrite("server logs", controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejection;
    resolveNative({ text: "late output" });
    await Promise.resolve();
  });

  it("propagates native rejections", async () => {
    const failing = fakePlugin(async () => {
      throw new Error("unavailable");
    });
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin: failing.plugin });
    await expect(runtime.rewrite("q", freshSignal())).rejects.toThrow("unavailable");

    const stringReject = fakePlugin(async () => Promise.reject("timeout"));
    const other = createNativeQueryPrivacyRuntime({ port: 8080, plugin: stringReject.plugin });
    await expect(other.rewrite("q", freshSignal())).rejects.toThrow("timeout");
  });

  it("rejects non-string or missing text results", async () => {
    const missing = fakePlugin(async () => ({}) as unknown as { text: string });
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin: missing.plugin });
    await expect(runtime.rewrite("q", freshSignal())).rejects.toThrow("bad_response");

    const wrongType = fakePlugin(async () => ({ text: 42 }) as unknown as { text: string });
    const second = createNativeQueryPrivacyRuntime({ port: 8080, plugin: wrongType.plugin });
    await expect(second.generateDecoys(freshSignal())).rejects.toThrow("bad_response");
  });

  it("trims the rewrite to its first line", async () => {
    const { plugin } = fakePlugin(async () => ({ text: "  rewritten query\nextra line  " }));
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080, plugin });
    await expect(runtime.rewrite("q", freshSignal())).resolves.toBe("rewritten query");
  });

  it("fails as local_inference_unavailable off the native platform", async () => {
    const runtime = createNativeQueryPrivacyRuntime({ port: 8080 });
    await expect(runtime.rewrite("q", freshSignal())).rejects.toThrow(
      "local_inference_unavailable",
    );
    await expect(runtime.generateDecoys(freshSignal())).rejects.toThrow(
      "local_inference_unavailable",
    );
  });

  it("emits a decoy format parseDecoyLines accepts", () => {
    const sample = [
      "museum opening hours",
      "marine biology basics",
      "berlin tram timetable",
      "fix a leaky faucet",
      "best coffee grinder 2026",
      "usb cable types explained",
    ].join("\n");
    expect(parseDecoyLines(sample)).toEqual([
      "museum opening hours",
      "marine biology basics",
      "berlin tram timetable",
      "fix a leaky faucet",
      "best coffee grinder 2026",
      "usb cable types explained",
    ]);
  });

  it("falls back to the raw query when the runtime fails or aborts", async () => {
    const failing = fakePlugin(async () => {
      throw new Error("unavailable");
    });
    const session = new QueryPrivacySession(
      createNativeQueryPrivacyRuntime({ port: 8080, plugin: failing.plugin }),
    );
    expect(await session.prepare("server logs 2026", { enabled: true })).toEqual({
      status: "ready",
      query: "server logs 2026",
      rewrite: "unavailable",
      decoys: [],
    });

    const hanging = fakePlugin(() => new Promise<{ text: string }>(() => {}));
    const aborted = new QueryPrivacySession(
      createNativeQueryPrivacyRuntime({ port: 8080, plugin: hanging.plugin }),
    );
    const controller = new AbortController();
    const prepared = aborted.prepare("server logs", {
      enabled: true,
      signal: controller.signal,
    });
    controller.abort();
    expect(await prepared).toEqual({ status: "cancelled" });
  });
});
