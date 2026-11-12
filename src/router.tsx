import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteCrash } from "./components/app/route-crash";
import { GhostError } from "./lib/ghost/types";

/**
 * Zero-persistence cache policy.
 *
 * `gcTime: 0` and `staleTime: 0` mean nothing survives an unmount: no result
 * set lingers in the query cache waiting to be recovered from a memory dump.
 * Retrying is pointless for terminal faults (no query, no engine, hard block).
 */
const TERMINAL = new Set(["empty_query", "no_engines", "vpn_missing"]);

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (attempt, error) => {
          if (error instanceof GhostError && TERMINAL.has(error.kind)) return false;
          return attempt < 1;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
        staleTime: 0,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false, gcTime: 0 },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: false,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteCrash,
  });

  return router;
};
