import {
  areQueriesNearDuplicates,
  isRewriteAcceptable,
  MAX_PRIVACY_QUERY_LENGTH,
  parseDecoyLines,
} from "./query-privacy-guards";

export const REWRITE_TIMEOUT_MS = 15_000;
export const DECOY_REFILL_TIMEOUT_MS = 60_000;
export const DECOY_POOL_CAPACITY = 10;

// Implementations must run on-device; no production transport is wired yet.
export interface QueryPrivacyRuntime {
  rewrite(query: string, signal: AbortSignal): Promise<string>;
  generateDecoys(signal: AbortSignal): Promise<string>;
}

type RewriteState = "applied" | "disabled" | "unavailable" | "timeout" | "rejected";

export type PreparedPrivateQuery =
  | { status: "cancelled" }
  | { status: "ready"; query: string; rewrite: RewriteState; decoys: string[] };

type Completion =
  { status: "ok"; text: string } | { status: "cancelled" | "timeout" | "unavailable" };

export class QueryPrivacySession {
  private pool: string[] = [];
  private epoch = 0;
  private operations = new Set<AbortController>();
  private refillTask: Promise<number> | null = null;

  constructor(private readonly runtime: QueryPrivacyRuntime | null = null) {}

  get poolSize(): number {
    return this.pool.length;
  }

  purge(): void {
    this.epoch++;
    this.pool = [];
    for (const operation of this.operations) operation.abort();
    this.refillTask = null;
  }

  // Called by a future idle hook, never by prepare(). No real query is provided.
  refill(signal?: AbortSignal): Promise<number> {
    if (!this.runtime || signal?.aborted || this.pool.length >= DECOY_POOL_CAPACITY) {
      return Promise.resolve(0);
    }
    if (this.refillTask) return this.refillTask;
    const runtime = this.runtime;
    const epoch = this.epoch;
    const task = this.complete(
      (abortSignal) => runtime.generateDecoys(abortSignal),
      DECOY_REFILL_TIMEOUT_MS,
      signal,
    ).then((result) => {
      if (epoch !== this.epoch || result.status !== "ok") return 0;
      let admitted = 0;
      for (const candidate of parseDecoyLines(result.text)) {
        if (this.pool.length >= DECOY_POOL_CAPACITY) break;
        if (this.pool.some((entry) => areQueriesNearDuplicates(entry, candidate))) continue;
        this.pool.push(candidate);
        admitted++;
      }
      return admitted;
    });
    this.refillTask = task;
    void task.finally(() => {
      if (this.refillTask === task) this.refillTask = null;
    });
    return task;
  }

  async prepare(
    query: string,
    options: { enabled: boolean; signal?: AbortSignal },
  ): Promise<PreparedPrivateQuery> {
    if (options.signal?.aborted) return { status: "cancelled" };
    if (!options.enabled) return { status: "ready", query, rewrite: "disabled", decoys: [] };
    const epoch = this.epoch;
    let rewrite: RewriteState = "unavailable";
    let outgoing = query;
    if (query.trim().length < 3 || query.length > MAX_PRIVACY_QUERY_LENGTH) {
      rewrite = "rejected";
    } else if (this.runtime) {
      const runtime = this.runtime;
      const result = await this.complete(
        (signal) => runtime.rewrite(query, signal),
        REWRITE_TIMEOUT_MS,
        options.signal,
      );
      if (epoch !== this.epoch || result.status === "cancelled" || options.signal?.aborted) {
        return { status: "cancelled" };
      }
      if (result.status === "ok") {
        if (isRewriteAcceptable(query, result.text)) {
          outgoing = result.text.trim();
          rewrite = "applied";
        } else {
          rewrite = "rejected";
        }
      } else {
        rewrite = result.status;
      }
    }
    return { status: "ready", query: outgoing, rewrite, decoys: this.takeDecoys(query, outgoing) };
  }

  private takeDecoys(original: string, outgoing: string): string[] {
    this.pool = this.pool.filter(
      (candidate) =>
        !areQueriesNearDuplicates(original, candidate) &&
        !areQueriesNearDuplicates(outgoing, candidate),
    );
    return this.pool.splice(0, 3);
  }

  private complete(
    generate: (signal: AbortSignal) => Promise<string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Completion> {
    if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
    const controller = new AbortController();
    this.operations.add(controller);
    return new Promise((resolve) => {
      let settled = false;
      const onParentAbort = () => controller.abort();
      const finish = (result: Completion) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
        controller.signal.removeEventListener("abort", onAbort);
        this.operations.delete(controller);
        resolve(result);
      };
      const onAbort = () => finish({ status: "cancelled" });
      const timer = setTimeout(() => {
        finish({ status: "timeout" });
        controller.abort();
      }, timeoutMs);
      signal?.addEventListener("abort", onParentAbort, { once: true });
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return "";
          return generate(controller.signal);
        })
        .then(
          (text) => finish({ status: "ok", text }),
          () => finish({ status: "unavailable" }),
        );
    });
  }
}
