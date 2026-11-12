/**
 * Monospace identifier (wallet, PGP fingerprint, hash, onion).
 * Tap copies, long-press expands the full value. Never a blind `truncate`.
 */
import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { copyText, haptic } from "@/lib/platform/native";
import { MicroLabel } from "./primitives";

function shorten(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function Identifier({
  value,
  head = 10,
  tail = 8,
  className,
}: {
  value: string;
  head?: number;
  tail?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const longPress = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    longPress.current = false;
    timer.current = setTimeout(() => {
      longPress.current = true;
      setExpanded((current) => !current);
      void haptic("medium");
    }, 420);
  };

  const end = () => {
    if (timer.current) clearTimeout(timer.current);
  };

  const onClick = async () => {
    if (longPress.current) return;
    const ok = await copyText(value);
    if (!ok) {
      setExpanded(true);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={end}
      onClick={() => void onClick()}
      title="Tap kopiert · Long-Press zeigt den vollen Wert"
      className={cn(
        "inline-flex min-h-11 max-w-full items-center gap-2 border border-border-subtle bg-elevated px-2 text-left",
        "font-mono text-xs text-foreground",
        className,
      )}
      style={{ borderRadius: "var(--radius)" }}
    >
      <span className={expanded ? "break-all" : "whitespace-nowrap"}>
        {expanded ? value : shorten(value, head, tail)}
      </span>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-signal-green" />
      ) : (
        <Copy className="size-3.5 shrink-0 text-dim" />
      )}
    </button>
  );
}

export function IdentifierGroup({ groups }: { groups: Record<string, string[]> }) {
  const entries = Object.entries(groups).filter(([, values]) => values.length > 0);
  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      {entries.map(([kind, values]) => (
        <div key={kind}>
          <MicroLabel>
            {kind} · {values.length}
          </MicroLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {values.map((value) => (
              <Identifier key={`${kind}:${value}`} value={value} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
