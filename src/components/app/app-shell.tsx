import { Link, useRouterState } from "@tanstack/react-router";
import { Network, Radio, Search, ShieldCheck, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useGhost } from "@/lib/store/ghost-context";
import { Dot, type Signal } from "./primitives";
import { VpnGate } from "./vpn-gate";
import { DisclaimerGate } from "./disclaimer";
import { PersonaGate } from "./persona-gate";

const TABS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Search", icon: Search },
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/engines", label: "Engines", icon: Radio },
  { to: "/security", label: "Security", icon: ShieldCheck },
];

function BottomNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeIndex = Math.max(
    0,
    TABS.findIndex((tab) => (tab.to === "/" ? pathname === "/" : pathname.startsWith(tab.to))),
  );

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-panel/85 backdrop-blur-xl safe-bottom">
      <span
        aria-hidden
        className="absolute top-0 h-px bg-amber transition-[left] duration-300 ease-out"
        style={{ width: `${100 / TABS.length}%`, left: `${(100 / TABS.length) * activeIndex}%` }}
      />
      <ul className="grid grid-cols-4">
        {TABS.map((tab, index) => {
          const active = index === activeIndex;
          const Icon = tab.icon;
          return (
            <li key={tab.to}>
              <Link
                to={tab.to}
                className={cn(
                  "tap relative flex min-h-touch flex-col items-center justify-center gap-1 py-2",
                  active ? "text-amber" : "text-dim",
                )}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 inset-y-1 -z-10 bg-amber/10"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                )}
                <Icon
                  className={cn(
                    "size-5 transition-transform duration-300",
                    active ? "scale-110" : "scale-100",
                  )}
                />
                <span className="font-mono text-[10px] uppercase tracking-widest">{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  const { settings, egressOk } = useGhost();

  const vpnSignal: Signal = egressOk ? "green" : settings.requireVpn ? "red" : "amber";

  return (
    <header className="sticky top-0 z-20 border-b border-border-subtle bg-background/80 backdrop-blur-xl safe-top">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <Link to="/" className="tap flex min-h-11 items-center gap-2">
          <span
            aria-hidden
            className="relative flex size-6 items-center justify-center rounded-full border border-amber/40"
          >
            <span
              className="absolute inset-0 rounded-full animate-radar"
              style={{
                background:
                  "conic-gradient(from 0deg, color-mix(in oklab, var(--amber) 45%, transparent), transparent 55%)",
              }}
            />
            <span className="relative size-1.5 rounded-full bg-amber" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-amber">Ghost</span>
            <span className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-dim">
              transient · nothing stored
            </span>
          </span>
        </Link>
        <Link
          to="/security"
          className="tap flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-dim hover:text-amber transition-colors"
          title="Inspect Tor & VPN security status"
        >
          <Dot signal={vpnSignal} /> vpn
        </Link>
      </div>
      {children}
    </header>
  );
}

export function AppShell({
  children,
  bar,
  heading,
}: {
  children: ReactNode;
  bar?: ReactNode;
  heading: string;
}) {
  return (
    <>
      <h1 className="sr-only">{heading}</h1>
      <div className="grid-canvas min-h-screen bg-background pb-24">
        <TopBar>{bar}</TopBar>
        <main className="space-y-3 px-3 py-3">{children}</main>
        <BottomNav />
        <VpnGate />
        <PersonaGate />
        <DisclaimerGate />
      </div>
    </>
  );
}
