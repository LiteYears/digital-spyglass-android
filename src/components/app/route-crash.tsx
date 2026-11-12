/**
 * Route-level error boundary. A field tool must never show a white screen: an
 * unreachable backend, a malformed response or a plugin fault degrades into a
 * readable console panel with a retry that stays inside the app.
 */
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";

import { GhostError } from "@/lib/ghost/types";
import { ActionButton } from "./primitives";

export function RouteCrash({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const kind = error instanceof GhostError ? error.kind : "unexpected";
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="grid-canvas flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-6">
      <span className="flex size-16 items-center justify-center rounded-full border border-signal-amber/50">
        <AlertTriangle className="size-7 text-signal-amber" />
      </span>
      <div className="space-y-2 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-signal-amber">
          screen fault · {kind}
        </p>
        <p className="text-sm leading-relaxed text-muted-foreground">{message}</p>
      </div>
      <div className="w-full max-w-xs space-y-2">
        <ActionButton
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Retry
        </ActionButton>
        <ActionButton variant="default" onClick={() => void router.navigate({ to: "/" })}>
          Back to search
        </ActionButton>
      </div>
    </div>
  );
}
