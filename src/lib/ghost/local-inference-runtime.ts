import { isNative } from "../platform/bridge";
import {
  DECOY_REFILL_TIMEOUT_MS,
  REWRITE_TIMEOUT_MS,
  type QueryPrivacyRuntime,
} from "./query-privacy";

/**
 * QueryPrivacyRuntime backed by the PianoLocalInference Capacitor plugin.
 *
 * The plugin speaks raw HTTP/1.1 over a java.net.Socket to literal
 * 127.0.0.1 (WebView fetch is blocked by the cleartext policy). This module
 * only chooses the port and the prompts — the host is fixed in native code.
 */

export const REWRITE_SYSTEM_PROMPT =
  "You rewrite web search queries to strip author style while preserving meaning. " +
  "Rewrite the query in the SAME language it was written in; never translate. " +
  "You may only delete words, reorder words, or apply minimal inflection to existing words. " +
  "Never add words, never use synonyms, never translate. " +
  "Keep every number, version, identifier, hostname, path, quoted phrase and negation " +
  "exactly unchanged. Output only the rewritten query on a single line: no quotes, " +
  "no explanation, no preamble.";

export const DECOY_SYSTEM_PROMPT =
  "You generate plausible decoy web search queries for a privacy tool. " +
  "Output exactly 6 diverse plausible web search queries on unrelated everyday " +
  "and technical topics, one per line, 2-8 words each. " +
  "No numbering, no bullets, no quotes, no duplicates, no explanations.";

// Decoys are generated blind — the real query never enters this prompt.
export const DECOY_USER_PROMPT = "Generate the 6 decoy queries now.";

export type LocalInferencePluginLike = {
  complete(args: {
    port: number;
    system: string;
    user: string;
    maxTokens: number;
    timeoutMs: number;
    callId: string;
  }): Promise<{ text: string }>;
  cancel(args: { callId: string }): Promise<void>;
};

function abortError(): DOMException {
  return new DOMException("The request was aborted", "AbortError");
}

function freshCallId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createNativeQueryPrivacyRuntime(opts: {
  port: number;
  plugin?: LocalInferencePluginLike;
}): QueryPrivacyRuntime {
  let cached: LocalInferencePluginLike | null = null;
  const resolvePlugin = async (): Promise<LocalInferencePluginLike> => {
    if (opts.plugin) return opts.plugin;
    if (!(await isNative())) throw new Error("local_inference_unavailable");
    if (!cached) {
      const { registerPlugin } = await import("@capacitor/core");
      cached = registerPlugin<LocalInferencePluginLike>("PianoLocalInference");
    }
    return cached;
  };

  const call = async (
    payload: { system: string; user: string; maxTokens: number; timeoutMs: number },
    signal: AbortSignal,
  ): Promise<string> => {
    if (signal.aborted) throw abortError();
    const plugin = await resolvePlugin();
    // The signal may have fired while resolvePlugin was pending — bail before
    // any native call instead of waiting on one nobody wants.
    if (signal.aborted) throw abortError();
    const callId = freshCallId();
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () =>
        settle(() => {
          // Fire and forget: native closes the socket; we reject immediately
          // rather than waiting for the socket teardown to surface.
          try {
            void Promise.resolve(plugin.cancel({ callId })).catch(() => {});
          } catch {
            /* cancel is best-effort */
          }
          reject(abortError());
        });
      signal.addEventListener("abort", onAbort, { once: true });
      // Abort may have landed between the pre-checks and listener
      // registration — run the abort path so no unhandled window remains.
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        plugin
          .complete({ port: opts.port, callId, ...payload })
          .then((result) =>
            settle(() => {
              if (typeof result?.text !== "string") {
                reject(new Error("bad_response"));
              } else {
                resolve(result.text);
              }
            }),
          )
          .catch((error: unknown) =>
            settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
          );
      } catch (error) {
        // A synchronous throw from the bridge must still remove the listener.
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  };

  return {
    async rewrite(query: string, signal: AbortSignal): Promise<string> {
      const text = await call(
        {
          system: REWRITE_SYSTEM_PROMPT,
          user: query,
          maxTokens: 128,
          timeoutMs: REWRITE_TIMEOUT_MS,
        },
        signal,
      );
      return text.trim().split("\n")[0]?.trim() ?? "";
    },
    async generateDecoys(signal: AbortSignal): Promise<string> {
      return await call(
        {
          system: DECOY_SYSTEM_PROMPT,
          user: DECOY_USER_PROMPT,
          maxTokens: 256,
          timeoutMs: DECOY_REFILL_TIMEOUT_MS,
        },
        signal,
      );
    },
  };
}
