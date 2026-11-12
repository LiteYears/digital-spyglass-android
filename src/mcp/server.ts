#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { NodeTorTransport } from "./node-transport";
import { LLMClient } from "./nim-client";
import type { TransportLayer } from "./transport";

import { ENGINES, engineById } from "../lib/ghost/engines";
import { parseQuery } from "../lib/ghost/query";
import { extractEntities } from "../lib/ghost/entities";
import { safeSnippet } from "../lib/ghost/snippets";
import {
  standardCamouflage,
  paranoidCamouflage,
  sampleDelay,
  shuffleEngines,
  assignSurgeDelays,
  standardSurge,
  paranoidSurge,
  sleep,
} from "../lib/ghost/camouflage";
import {
  isOpen,
  lastError,
  recordSuccess,
  recordFailure,
  getHealth,
  resetBreaker,
} from "../lib/ghost/breaker";

type ServerConfig = {
  torHost: string | undefined;
  torPort: number | undefined;
  nimApiKey: string | undefined;
  nimModel: string | undefined;
  nimBaseUrl: string | undefined;
  ollamaModel: string | undefined;
  ollamaBaseUrl: string | undefined;
};

type SearchParams = {
  query: string;
  engines: string[] | undefined;
  paranoid: boolean;
  snippetFilter: boolean;
  maxResults: number;
  refineQuery: boolean;
  summarize: boolean;
};

function createTransport(config: ServerConfig): TransportLayer {
  return new NodeTorTransport({
    socksHost: config.torHost,
    socksPort: config.torPort,
    userAgent: undefined,
  });
}

function createLLMClient(config: ServerConfig): LLMClient | null {
  if (!config.nimApiKey && !config.ollamaModel) return null;
  return new LLMClient(
    config.nimApiKey,
    config.nimModel ?? "nvidia/nemotron-3-super-120b-a12b",
    config.ollamaModel,
    config.ollamaBaseUrl,
    config.nimBaseUrl,
  );
}

async function executeSearch(
  params: SearchParams,
  transport: TransportLayer,
  nim: LLMClient | null,
): Promise<{
  query: string;
  refined: boolean;
  engineCount: number;
  totalResults: number;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    engine: string;
    entities: Array<{ type: string; value: string }>;
    withheld: boolean;
  }>;
  engineHealth: Record<string, { status: string; results: number }>;
  summary: string | undefined;
}> {
  let queryString = params.query;
  let refined = false;

  if (params.refineQuery && nim) {
    try {
      queryString = await nim.refineQuery(params.query);
      refined = true;
    } catch {
      // Fall back to raw query
    }
  }

  const parsed = parseQuery(queryString);
  const engineIds =
    params.engines ?? ENGINES.map((e) => e.id).filter((id) => !isOpen(id));

  const camouflage = params.paranoid
    ? paranoidCamouflage()
    : standardCamouflage();

  const surge = params.paranoid ? paranoidSurge() : standardSurge();

  const selectedEngines = engineIds
    .map((id) => engineById(id))
    .filter((e): e is NonNullable<typeof e> => e !== null && e !== undefined && !isOpen(e.id));

  if (selectedEngines.length === 0) {
    return {
      query: queryString,
      refined,
      engineCount: 0,
      totalResults: 0,
      results: [],
      engineHealth: {},
      summary: undefined,
    };
  }

  shuffleEngines(selectedEngines);

  const surgeDelays = assignSurgeDelays(selectedEngines.length, surge);

  const allResults: Array<{
    title: string;
    url: string;
    snippet: string;
    engine: string;
    entities: Array<{ type: string; value: string }>;
    withheld: boolean;
  }> = [];

  const engineHealth: Record<string, { status: string; results: number }> = {};

  const searchPromises = selectedEngines.map(async (engine, i) => {
    const delay = surgeDelays[i] ?? 0;
    if (surge.surgeSize > 0 && delay > 0) {
      await sleep(delay);
    } else if (i > 0) {
      await sleep(sampleDelay(camouflage));
    }

    try {
      const socksAuth = {
        user: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        pass: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      };

      const searchUrl = engine.searchUrl(queryString, 1);
      const { status, body } = await transport.torFetch(searchUrl, "", {
        method: "GET",
        socksAuth,
      });

      if (status >= 400) {
        recordFailure(engine.id, `HTTP ${status}`);
        engineHealth[engine.id] = { status: `error_${status}`, results: 0 };
        return;
      }

      const rawResults = engine.parse(body);

      for (const raw of rawResults) {
        const { snippet, withheld } = safeSnippet(
          raw.snippet ?? "",
          params.snippetFilter,
        );

        const entities = extractEntities(`${raw.title} ${snippet}`);

        allResults.push({
          title: raw.title,
          url: raw.url,
          snippet,
          engine: engine.id,
          entities: entities.map((e) => ({ type: e.type, value: e.value })),
          withheld,
        });
      }

      recordSuccess(engine.id);
      engineHealth[engine.id] = { status: "ok", results: rawResults.length };
    } catch (err) {
      recordFailure(engine.id, String(err));
      engineHealth[engine.id] = { status: "error", results: 0 };
    }
  });

  await Promise.allSettled(searchPromises);

  if (transport.purgeCookies) {
    await transport.purgeCookies().catch(() => {});
  }

  const limitedResults = allResults.slice(0, params.maxResults);

  let summary: string | undefined = undefined;
  if (params.summarize && nim && limitedResults.length > 0) {
    try {
      summary = await nim.summarizeResults(
        queryString,
        limitedResults.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      );
    } catch {
      // Summary optional
    }
  }

  return {
    query: queryString,
    refined,
    engineCount: selectedEngines.length,
    totalResults: allResults.length,
    results: limitedResults,
    engineHealth,
    summary,
  };
}

function createServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: "ghost-search",
    version: "0.1.0",
  });

  const transport = createTransport(config);
  const nim = createLLMClient(config);

  server.registerTool(
    "ghost_search",
    {
      description:
        `Search the dark web via Tor through ${ENGINES.length} onion search engines (${ENGINES.map((e) => e.name).join(", ")}). ` +
        "Results are deduplicated, entity-extracted (BTC/XMR/PGP/email/onion), and optionally snippet-filtered for liability. " +
        "Supports camouflage mode (traffic-analysis defense with Rayleigh/Exponential timing). " +
        "Optional LLM query refinement and result summarization via NVIDIA NIM (Nemotron).",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query string"),
        engines: z
          .array(z.string())
          .optional()
          .describe("Specific engine IDs to use (default: all healthy engines). Use ghost_engines to list IDs."),
        paranoid: z
          .boolean()
          .optional()
          .default(false)
          .describe("Enable paranoid camouflage mode (surge shaping, longer delays)"),
        snippetFilter: z
          .boolean()
          .optional()
          .default(true)
          .describe("Replace high-risk snippets with placeholders (liability protection)"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Maximum number of results to return"),
        refineQuery: z
          .boolean()
          .optional()
          .default(false)
          .describe("Use NIM LLM to refine the query before searching (requires NIM_API_KEY)"),
        summarize: z
          .boolean()
          .optional()
          .default(false)
          .describe("Use NIM LLM to generate a summary of the search results (requires NIM_API_KEY)"),
      }),
    },
    async (args) => {
      const params: SearchParams = {
        query: args.query,
        engines: args.engines,
        paranoid: args.paranoid,
        snippetFilter: args.snippetFilter,
        maxResults: args.maxResults,
        refineQuery: args.refineQuery,
        summarize: args.summarize,
      };

      try {
        const result = await executeSearch(params, transport, nim);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search failed: ${String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ghost_health",
    {
      description: `Check the health status of all ${ENGINES.length} onion search engines. Returns per-engine circuit breaker state, success/failure counts, and last status.`,
      inputSchema: z.object({}),
    },
    async () => {
      const health: Record<string, {
        status: string;
        open: boolean;
        successes: number;
        failures: number;
        lastError: string | undefined;
      }> = {};
      for (const engine of ENGINES) {
        const info = getHealth(engine.id);
        const err = lastError(engine.id);
        health[engine.id] = {
          status: info.lastStatus ?? "unknown",
          open: info.open,
          successes: info.successes,
          failures: info.totalFailures,
          lastError: err,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { engines: health, totalEngines: ENGINES.length },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "ghost_engines",
    {
      description:
        "List all available onion search engines with their IDs, names, and capabilities.",
      inputSchema: z.object({}),
    },
    async () => {
      const engines = ENGINES.map((e) => ({
        id: e.id,
        name: e.name,
        trust: e.trust,
        clearnet: e.clearnet,
        hasPrepareSearchUrl: e.prepareSearchUrl !== undefined,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ engines, total: engines.length }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "ghost_reset_engine",
    {
      description:
        "Reset the circuit breaker for a specific engine, allowing it to be queried again after failures.",
      inputSchema: z.object({
        engineId: z.string().describe("Engine ID to reset (e.g., 'ahmia', 'tor66')"),
      }),
    },
    async (args: { engineId: string }) => {
      resetBreaker(args.engineId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Circuit breaker reset for engine: ${args.engineId}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "ghost_classify",
    {
      description:
        "Use LLM (NVIDIA NIM Nemotron with Ollama Qwen3:8B fallback) to classify a search result's category and risk level. " +
        "Categories: marketplace, forum, wiki, blog, service, directory, scam, empty, captcha, other. " +
        "Risk: low, medium, high. Automatic fallback to local Ollama if NIM is unavailable.",
      inputSchema: z.object({
        title: z.string().describe("Result title"),
        snippet: z.string().describe("Result snippet text"),
      }),
    },
    async (args: { title: string; snippet: string }) => {
      if (!nim) {
        return {
          content: [
            {
              type: "text" as const,
              text: "NIM client not configured. Set NIM_API_KEY and NIM_MODEL to enable LLM features.",
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await nim.classifyResult(args.title, args.snippet);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Classification failed: ${String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function main() {
  const env = process.env as Record<string, string | undefined>;
  const config: ServerConfig = {
    torHost: env["GHOST_TOR_HOST"],
    torPort: env["GHOST_TOR_PORT"] ? parseInt(env["GHOST_TOR_PORT"], 10) : undefined,
    nimApiKey: env["NIM_API_KEY"] ?? env["NVIDIA_API_KEY"],
    nimModel: env["NIM_MODEL"] ?? "nvidia/nemotron-3-super-120b-a12b",
    nimBaseUrl: env["NIM_BASE_URL"],
    ollamaModel: env["OLLAMA_MODEL"] ?? "qwen3:8b",
    ollamaBaseUrl: env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434/v1",
  };

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Ghost Search MCP server failed:", err);
  process.exit(1);
});
