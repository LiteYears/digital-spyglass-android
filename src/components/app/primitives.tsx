/**
 * Console primitives. All colors come from the token layer in styles.css —
 * never a hex value or a literal color utility in here.
 */
import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({
  children,
  className,
  title,
  action,
  pending,
}: {
  children?: ReactNode;
  className?: string;
  title?: string;
  action?: ReactNode;
  /** Renders an ambient light sweep across the header while work is in flight. */
  pending?: boolean;
}) {
  return (
    <section
      className={cn(
        "surface hairline animate-rise overflow-hidden border border-border-subtle",
        className,
      )}
      style={{ borderRadius: "var(--radius)" }}
    >
      {(title || action) && (
        <header
          className={cn(
            "flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2",
            pending && "sweep",
          )}
        >
          <span className="label-micro flex items-center gap-2">
            <span
              aria-hidden
              className={cn("h-3 w-px bg-amber", pending ? "animate-breathe" : "opacity-60")}
            />
            {title}
          </span>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function MicroLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("label-micro", className)}>{children}</span>;
}

export type Signal = "green" | "amber" | "red" | "dim";

const signalText: Record<Signal, string> = {
  green: "text-signal-green",
  amber: "text-signal-amber",
  red: "text-signal-red",
  dim: "text-dim",
};

const signalBg: Record<Signal, string> = {
  green: "bg-signal-green",
  amber: "bg-signal-amber",
  red: "bg-signal-red",
  dim: "bg-dim",
};

export function Dot({
  signal,
  className,
  pulse = true,
}: {
  signal: Signal;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex size-2 items-center justify-center", className)}
    >
      {pulse && signal !== "dim" && (
        <span className={cn("absolute inset-0 rounded-full animate-ping-slow", signalBg[signal])} />
      )}
      <span className={cn("relative inline-block size-2 rounded-full", signalBg[signal])} />
    </span>
  );
}

export function Chip({
  children,
  signal = "dim",
  onClick,
  active,
  className,
}: {
  children: ReactNode;
  signal?: Signal;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const Component = onClick ? "button" : "span";
  return (
    <Component
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "tap inline-flex min-h-8 items-center gap-1.5 border px-2 font-mono text-[11px] uppercase tracking-wider",
        active
          ? "glow-ring border-amber/60 bg-amber/10 text-amber"
          : "border-border-subtle text-muted-foreground hover:border-border-active hover:text-foreground",
        !active && signal !== "dim" && signalText[signal],
        className,
      )}
      style={{ borderRadius: "var(--radius)" }}
    >
      {children}
    </Component>
  );
}

export const ConsoleInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function ConsoleInput({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      className={cn(
        "min-h-11 w-full border border-border-subtle bg-elevated/70 px-3 font-mono text-sm text-foreground",
        "transition-[box-shadow,border-color] duration-200",
        "placeholder:text-dim focus:border-amber/60 focus:outline-none focus:glow-ring",
        className,
      )}
      style={{ borderRadius: "var(--radius)" }}
      {...props}
    />
  );
});

export function ActionButton({
  children,
  onClick,
  variant = "default",
  disabled,
  className,
  type = "button",
  pending,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
  pending?: boolean;
  "aria-label"?: string;
}) {
  const variants = {
    default: "border-border-subtle bg-elevated/70 text-foreground hover:border-border-active",
    primary: "border-transparent text-primary-foreground glow-ring",
    danger: "border-signal-red/60 text-signal-red hover:bg-signal-red/10",
  } as const;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "tap inline-flex min-h-11 items-center justify-center gap-2 border px-3 font-mono text-xs uppercase tracking-wider",
        "disabled:opacity-40",
        variants[variant],
        pending && "sweep",
        className,
      )}
      style={{
        borderRadius: "var(--radius)",
        ...(variant === "primary" ? { background: "var(--gradient-amber)" } : {}),
      }}
    >
      {children}
    </button>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="animate-rise px-4 py-10 text-center">
      <span
        aria-hidden
        className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full border border-border-subtle"
      >
        <span className="size-2 rounded-full bg-amber/70 animate-breathe" />
      </span>
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{title}</p>
      {hint && <p className="mx-auto mt-2 max-w-[36ch] text-xs text-dim">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      className="animate-rise border border-signal-red/50 bg-signal-red/5 px-3 py-2 font-mono text-xs text-signal-red"
      style={{ borderRadius: "var(--radius)" }}
    >
      {message}
    </div>
  );
}
