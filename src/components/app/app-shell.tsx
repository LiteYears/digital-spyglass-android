import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bookmark,
  Flame,
  Globe,
  Menu,
  Network,
  Radio,
  Search,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { launchOrbot } from "@/lib/platform/native";
import { useGhost } from "@/lib/store/ghost-context";
import { Chip, Dot, MicroLabel, type Signal } from "./primitives";
import { VpnGate } from "./vpn-gate";
import { DisclaimerGate } from "./disclaimer";
import { PersonaGate } from "./persona-gate";

const TABS: { to: string; label: string; sub: string; icon: LucideIcon }[] = [
  { to: "/", label: "Search", sub: "Multi-engine RRF", icon: Search },
  { to: "/browser", label: "Browser", sub: "Tor SOCKS5 view", icon: Globe },
  { to: "/graph", label: "Graph", sub: "Entity clusters", icon: Network },
  { to: "/engines", label: "Engines", sub: "13 onion indexers", icon: Radio },
  { to: "/security", label: "Security", sub: "Posture & panic", icon: ShieldCheck },
];

function BottomNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeIndex = Math.max(
    0,
    TABS.findIndex((tab) => (tab.to === "/" ? pathname === "/" : pathname.startsWith(tab.to))),
  );

  return (
    <nav
      aria-label="Primary bottom navigation"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-panel/92 backdrop-blur-xl safe-bottom shadow-lg"
    >
      <span
        aria-hidden
        className="absolute top-0 h-0.5 bg-amber transition-[left] duration-300 ease-out"
        style={{ width: `${100 / TABS.length}%`, left: `${(100 / TABS.length) * activeIndex}%` }}
      />
      <ul className="mx-auto grid max-w-2xl grid-cols-5">
        {TABS.map((tab, index) => {
          const active = index === activeIndex;
          const Icon = tab.icon;
          return (
            <li key={tab.to}>
              <Link
                to={tab.to}
                className={cn(
                  "tap relative flex min-h-13 flex-col items-center justify-center gap-1 py-2 transition-colors",
                  active ? "text-amber" : "text-dim hover:text-foreground",
                )}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-2 inset-y-1 -z-10 bg-amber/12"
                    style={{ borderRadius: "var(--radius)" }}
                  />
                )}
                <Icon
                  className={cn(
                    "size-5 transition-transform duration-200",
                    active ? "scale-110" : "scale-100",
                  )}
                />
                <span className="font-mono text-[10px] font-medium uppercase tracking-wider">
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  const { settings, updateSettings, egressOk, bookmarks, purgeNow } = useGhost();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const vpnSignal: Signal = egressOk ? "green" : settings.requireVpn ? "red" : "amber";

  const handlePanicWipe = async () => {
    await purgeNow();
    setMenuOpen(false);
    toast.success("Session RAM, cookies, and downloads wiped clean");
  };

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border-subtle bg-background/88 backdrop-blur-xl safe-top">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-3.5 py-2">
          <Link to="/" className="tap flex min-h-11 items-center gap-2.5">
            <span
              aria-hidden
              className="relative flex size-7 items-center justify-center rounded-full border border-amber/40 bg-amber/5"
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
              <span className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-amber">
                Ghost
              </span>
              <span className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-dim">
                stateless · ram-only
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-1.5">
            <Link
              to="/security"
              className="tap flex min-h-9 items-center gap-1.5 rounded-md border border-border-subtle bg-elevated/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-foreground/85 hover:border-amber/40 hover:text-amber transition-colors"
              title="Inspect Tor & VPN security status"
            >
              <Dot signal={vpnSignal} />
              <span>{egressOk ? "Tor / VPN" : "No VPN"}</span>
            </Link>

            <button
              type="button"
              onClick={() => void handlePanicWipe()}
              aria-label="Instant Panic Wipe (Purge RAM)"
              title="Instant Panic Wipe (Purge RAM)"
              className="tap flex min-h-9 items-center gap-1 rounded-md border border-signal-red/40 bg-signal-red/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-signal-red hover:bg-signal-red/25 transition-colors"
            >
              <Flame className="size-3.5" />
              <span className="hidden sm:inline">Wipe</span>
            </button>

            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Open quick navigation and posture menu"
              className="tap flex size-9 items-center justify-center rounded-md border border-border-subtle bg-elevated text-foreground hover:border-amber/40 hover:text-amber"
            >
              {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          </div>
        </div>
        {children}
      </header>

      {/* Organized Quick Command & Navigation Menu Drawer */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm animate-rise"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="mx-auto mt-14 max-h-[82dvh] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-lg border border-border-active bg-panel p-4 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border-subtle pb-2.5">
              <div>
                <p className="font-mono text-xs font-semibold uppercase tracking-widest text-amber">
                  Ghost Command Menu
                </p>
                <MicroLabel>Quick navigation, privacy posture & session tools</MicroLabel>
              </div>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="tap flex size-8 items-center justify-center rounded-md bg-elevated text-dim hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Section 1: App Navigation */}
            <div className="space-y-1.5">
              <MicroLabel>Screens & Workspaces</MicroLabel>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {TABS.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <Link
                      key={tab.to}
                      to={tab.to}
                      onClick={() => setMenuOpen(false)}
                      className="tap flex items-center gap-2.5 rounded-md border border-border-subtle bg-elevated/60 p-2.5 hover:border-amber/50 hover:bg-amber/10 transition-colors"
                    >
                      <Icon className="size-4 shrink-0 text-amber" />
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-medium text-foreground">{tab.label}</p>
                        <p className="truncate font-mono text-[9px] text-dim">{tab.sub}</p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Section 2: Privacy & Speed Posture Toggles */}
            <div className="space-y-1.5">
              <MicroLabel>Session Posture Controls</MicroLabel>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void updateSettings({ fastMode: !settings.fastMode })}
                  className={cn(
                    "tap flex items-center justify-between rounded-md border p-2.5 text-left font-mono text-xs transition-colors",
                    settings.fastMode
                      ? "border-amber/50 bg-amber/15 text-amber"
                      : "border-border-subtle bg-elevated/40 text-dim",
                  )}
                >
                  <span>Fast Mode (6)</span>
                  <span>{settings.fastMode ? "ON" : "OFF"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void updateSettings({ paranoidMode: !settings.paranoidMode })}
                  className={cn(
                    "tap flex items-center justify-between rounded-md border p-2.5 text-left font-mono text-xs transition-colors",
                    settings.paranoidMode
                      ? "border-amber/50 bg-amber/15 text-amber"
                      : "border-border-subtle bg-elevated/40 text-dim",
                  )}
                >
                  <span>Paranoid Mode</span>
                  <span>{settings.paranoidMode ? "ON" : "OFF"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void updateSettings({ qarfMode: !settings.qarfMode })}
                  className={cn(
                    "tap flex items-center justify-between rounded-md border p-2.5 text-left font-mono text-xs transition-colors",
                    settings.qarfMode
                      ? "border-amber/50 bg-amber/15 text-amber"
                      : "border-border-subtle bg-elevated/40 text-dim",
                  )}
                >
                  <span>QARF Decoy</span>
                  <span>{settings.qarfMode ? "ON" : "OFF"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void launchOrbot()}
                  className="tap flex items-center justify-between rounded-md border border-amber/40 bg-amber/10 p-2.5 text-left font-mono text-xs text-amber hover:bg-amber/20"
                >
                  <span>Orbot Tor VPN</span>
                  <span>Open</span>
                </button>
              </div>
            </div>

            {/* Section 3: Saved Session Bookmarks */}
            {bookmarks.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <MicroLabel>Session Bookmarks ({bookmarks.length})</MicroLabel>
                  <Bookmark className="size-3 text-amber" />
                </div>
                <ul className="max-h-36 divide-y divide-border-subtle overflow-y-auto rounded-md border border-border-subtle bg-elevated/30">
                  {bookmarks.map((bm) => (
                    <li
                      key={bm.key}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          void navigate({ to: "/browser", search: { url: bm.url } });
                        }}
                        className="tap min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-xs font-medium text-foreground">{bm.title}</p>
                        <p className="truncate font-mono text-[10px] text-amber/80">{bm.url}</p>
                      </button>
                      <Chip
                        signal="amber"
                        onClick={() => {
                          setMenuOpen(false);
                          void navigate({ to: "/browser", search: { url: bm.url } });
                        }}
                      >
                        Browse
                      </Chip>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Section 4: Emergency Session Purge */}
            <div className="border-t border-border-subtle pt-3">
              <button
                type="button"
                onClick={() => void handlePanicWipe()}
                className="tap flex w-full items-center justify-center gap-2 rounded-md border border-signal-red/50 bg-signal-red/20 px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-signal-red hover:bg-signal-red/30"
              >
                <Flame className="size-4" />
                <span>Panic Wipe Session RAM & Cookies Now</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
      <div className="grid-canvas min-h-dvh bg-background pb-24">
        <TopBar>{bar}</TopBar>
        <main className="mx-auto max-w-3xl space-y-3.5 px-3.5 py-3.5">{children}</main>
        <BottomNav />
        <VpnGate />
        <PersonaGate />
        <DisclaimerGate />
      </div>
    </>
  );
}
