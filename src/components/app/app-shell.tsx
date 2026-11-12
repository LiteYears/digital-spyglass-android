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
  Sliders,
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
  { to: "/security", label: "Security", sub: "Vault & security", icon: ShieldCheck },
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
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-panel/95 backdrop-blur-xl safe-bottom shadow-lg"
    >
      <span
        aria-hidden
        className="absolute top-0 h-0.5 bg-amber transition-[left] duration-300 ease-out"
        style={{ width: `${100 / TABS.length}%`, left: `${(100 / TABS.length) * activeIndex}%` }}
      />
      <ul className="mx-auto grid max-w-xl grid-cols-5">
        {TABS.map((tab, index) => {
          const active = index === activeIndex;
          const Icon = tab.icon;
          return (
            <li key={tab.to}>
              <Link
                to={tab.to}
                className={cn(
                  "tap relative flex min-h-12 flex-col items-center justify-center gap-0.5 py-1.5 transition-colors",
                  active ? "text-amber" : "text-dim hover:text-foreground",
                )}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-1.5 inset-y-1 -z-10 bg-amber/12 rounded"
                  />
                )}
                <Icon
                  className={cn(
                    "size-4.5 transition-transform duration-200",
                    active ? "scale-105" : "scale-100",
                  )}
                />
                <span className="font-mono text-[9px] font-medium uppercase tracking-wider">
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
  const { settings, updateSettings, egressOk, bookmarks, panicWipe } = useGhost();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showConfirmWipe, setShowConfirmWipe] = useState(false);
  const [menuTab, setMenuTab] = useState<"nav" | "tools" | "saved">("nav");

  const vpnSignal: Signal = egressOk ? "green" : settings.requireVpn ? "red" : "amber";

  const handlePanicWipe = async () => {
    await panicWipe();
    setShowConfirmWipe(false);
    setMenuOpen(false);
    toast.success("Encrypted vault, cookies, and app data zeroed clean");
  };

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-border-subtle bg-background/95 backdrop-blur-xl safe-top">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-1.5">
          <Link to="/" className="tap flex min-h-10 items-center gap-2">
            <span
              aria-hidden
              className="relative flex size-6.5 items-center justify-center rounded-full border border-amber/40 bg-amber/5 shrink-0"
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
              <span className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-amber">
                Ghost
              </span>
              <span className="mt-0.5 font-mono text-[8.5px] uppercase tracking-wider text-dim">
                Encrypted Vault
              </span>
            </span>
          </Link>

          <div className="flex items-center gap-1.5">
            <Link
              to="/security"
              className="tap flex min-h-8 items-center gap-1 rounded border border-border-subtle bg-elevated/60 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-foreground/85 hover:border-amber/40 hover:text-amber transition-colors"
              title="Inspect Tor & VPN security status"
            >
              <Dot signal={vpnSignal} />
              <span className="hidden xs:inline">{egressOk ? "Tor" : "No VPN"}</span>
            </Link>

            <button
              type="button"
              onClick={() => setShowConfirmWipe(true)}
              aria-label="Instant Panic Wipe (Zero Vault)"
              title="Instant Panic Wipe (Zero Vault)"
              className="tap flex min-h-8 items-center gap-1 rounded border border-signal-red/40 bg-signal-red/15 px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-signal-red hover:bg-signal-red/25 transition-colors"
            >
              <Flame className="size-3" />
              <span className="hidden sm:inline">Panic</span>
            </button>

            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Open quick navigation and posture menu"
              className="tap flex size-8 items-center justify-center rounded border border-border-subtle bg-elevated text-foreground hover:border-amber/40 hover:text-amber transition-colors"
            >
              {menuOpen ? <X className="size-3.5" /> : <Menu className="size-3.5" />}
            </button>
          </div>
        </div>
        {children}
      </header>

      {/* Confirmation Modal for Panic Wipe to prevent accidental trigger */}
      {showConfirmWipe && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-3 backdrop-blur-xs animate-rise"
          onClick={() => setShowConfirmWipe(false)}
        >
          <div
            className="w-full max-w-xs rounded-xl border border-signal-red/60 bg-panel p-4 shadow-2xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-signal-red">
              <Flame className="size-4.5 shrink-0" />
              <p className="font-mono text-xs font-semibold uppercase tracking-wider">
                Emergency Panic Wipe?
              </p>
            </div>
            <p className="font-mono text-[11px] text-dim leading-relaxed">
              This will cryptographically zero all encrypted search results on device storage, bookmarks, cookies, and close the session.
            </p>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowConfirmWipe(false)}
                className="tap rounded border border-border-subtle bg-elevated px-2.5 py-1 font-mono text-xs text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handlePanicWipe()}
                className="tap flex items-center gap-1 rounded border border-signal-red/60 bg-signal-red/30 px-2.5 py-1 font-mono text-xs font-semibold text-signal-red hover:bg-signal-red/40"
              >
                <Flame className="size-3" />
                <span>Zero Vault</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Optimized Compact Android Menu Drawer (Max 58vh, tabbed, clean) */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/70 backdrop-blur-xs animate-rise flex flex-col justify-end sm:justify-start"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="mx-auto w-full max-w-md max-h-[62vh] overflow-hidden rounded-t-xl sm:rounded-xl sm:mt-12 border border-border-active bg-panel shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header with Segmented Tabs */}
            <div className="border-b border-border-subtle p-3 bg-elevated/40">
              <div className="flex items-center justify-between pb-2">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-amber">
                  Ghost Console
                </span>
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  className="tap flex size-6.5 items-center justify-center rounded bg-elevated text-dim hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              {/* Segmented Pill Selector */}
              <div className="grid grid-cols-3 gap-1 bg-background/60 p-1 rounded-md border border-border-subtle text-center">
                <button
                  type="button"
                  onClick={() => setMenuTab("nav")}
                  className={cn(
                    "tap py-1 font-mono text-[10px] font-medium uppercase tracking-wider rounded transition-colors",
                    menuTab === "nav"
                      ? "bg-amber/20 text-amber"
                      : "text-dim hover:text-foreground",
                  )}
                >
                  Navigate
                </button>
                <button
                  type="button"
                  onClick={() => setMenuTab("tools")}
                  className={cn(
                    "tap py-1 font-mono text-[10px] font-medium uppercase tracking-wider rounded transition-colors",
                    menuTab === "tools"
                      ? "bg-amber/20 text-amber"
                      : "text-dim hover:text-foreground",
                  )}
                >
                  Tools
                </button>
                <button
                  type="button"
                  onClick={() => setMenuTab("saved")}
                  className={cn(
                    "tap py-1 font-mono text-[10px] font-medium uppercase tracking-wider rounded transition-colors flex items-center justify-center gap-1",
                    menuTab === "saved"
                      ? "bg-amber/20 text-amber"
                      : "text-dim hover:text-foreground",
                  )}
                >
                  <span>Saved</span>
                  {bookmarks.length > 0 && (
                    <span className="size-3.5 rounded-full bg-amber/30 text-[9px] flex items-center justify-center text-amber">
                      {bookmarks.length}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Scrollable Tab Content Area with Smooth Touch Scroll */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3 touch-pan-y overscroll-contain">
              {menuTab === "nav" && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    {TABS.map((tab) => {
                      const Icon = tab.icon;
                      return (
                        <Link
                          key={tab.to}
                          to={tab.to}
                          onClick={() => setMenuOpen(false)}
                          className="tap flex items-center gap-2 rounded-md border border-border-subtle bg-elevated/40 p-2 hover:border-amber/40 hover:bg-amber/10 transition-colors"
                        >
                          <Icon className="size-4 shrink-0 text-amber" />
                          <div className="min-w-0">
                            <p className="font-mono text-xs font-medium text-foreground">{tab.label}</p>
                            <p className="truncate font-mono text-[8.5px] text-dim">{tab.sub}</p>
                          </div>
                        </Link>
                      );
                    })}
                  </div>

                  <div className="pt-1">
                    <MicroLabel className="block mb-1 text-dim">Quick Onion Engines</MicroLabel>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { name: "Ahmia Search", url: "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion" },
                        { name: "Torch Indexer", url: "http://torchde3p3spjgaroxmngafla Enum6o2r42xgepjx.onion" },
                        { name: "Haystak Deep", url: "http://haystak5njsmn2hqkewecpaxetaqwhsxdpdqlxspjfdmgodnbgahopyd.onion" },
                        { name: "Excava Engine", url: "http://excavator5c6x2vsxfnax5fq7ezgaheb3umgg7hxauvdqeuipfcvpjyd.onion" },
                      ].map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          onClick={() => {
                            setMenuOpen(false);
                            void navigate({ to: "/browser", search: { url: item.url } });
                          }}
                          className="tap flex items-center justify-between rounded border border-border-subtle bg-elevated/30 px-2 py-1.5 text-left font-mono text-[11px] hover:border-amber/40 hover:text-amber transition-colors"
                        >
                          <span className="truncate">{item.name}</span>
                          <Globe className="size-2.5 text-amber shrink-0 ml-1" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {menuTab === "tools" && (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => void updateSettings({ fastMode: !settings.fastMode })}
                      className={cn(
                        "tap flex items-center justify-between rounded border px-2.5 py-2 font-mono text-[11px] transition-colors",
                        settings.fastMode
                          ? "border-amber/50 bg-amber/15 text-amber"
                          : "border-border-subtle bg-elevated/30 text-dim",
                      )}
                    >
                      <span>Fast Mode (5)</span>
                      <span className="font-semibold">{settings.fastMode ? "ON" : "OFF"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void updateSettings({ paranoidMode: !settings.paranoidMode })}
                      className={cn(
                        "tap flex items-center justify-between rounded border px-2.5 py-2 font-mono text-[11px] transition-colors",
                        settings.paranoidMode
                          ? "border-amber/50 bg-amber/15 text-amber"
                          : "border-border-subtle bg-elevated/30 text-dim",
                      )}
                    >
                      <span>Paranoid Mode</span>
                      <span className="font-semibold">{settings.paranoidMode ? "ON" : "OFF"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void updateSettings({ qarfMode: !settings.qarfMode })}
                      className={cn(
                        "tap flex items-center justify-between rounded border px-2.5 py-2 font-mono text-[11px] transition-colors",
                        settings.qarfMode
                          ? "border-amber/50 bg-amber/15 text-amber"
                          : "border-border-subtle bg-elevated/30 text-dim",
                      )}
                    >
                      <span>QARF Decoy</span>
                      <span className="font-semibold">{settings.qarfMode ? "ON" : "OFF"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void launchOrbot()}
                      className="tap flex items-center justify-between rounded border border-amber/40 bg-amber/10 px-2.5 py-2 font-mono text-[11px] text-amber hover:bg-amber/20"
                    >
                      <span>Orbot Tor VPN</span>
                      <span className="font-semibold">Launch</span>
                    </button>
                  </div>

                  <div className="rounded border border-border-subtle bg-elevated/30 p-2.5 space-y-1">
                    <div className="flex items-center gap-1.5 text-foreground font-mono text-xs">
                      <Sliders className="size-3 text-amber" />
                      <span>Encrypted Device Storage</span>
                    </div>
                    <p className="font-mono text-[10px] text-dim leading-relaxed">
                      Search results, query state and bookmarks are encrypted with AES-256-GCM and stored in device storage rather than RAM, surviving process reclaims.
                    </p>
                  </div>
                </div>
              )}

              {menuTab === "saved" && (
                <div className="space-y-2">
                  {bookmarks.length === 0 ? (
                    <div className="py-6 text-center">
                      <Bookmark className="size-5 mx-auto text-dim mb-1" />
                      <p className="font-mono text-xs text-dim">No bookmarks saved yet</p>
                      <p className="font-mono text-[10px] text-dim/70 mt-0.5">
                        Tap the bookmark icon on any search result to save it here.
                      </p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-border-subtle rounded border border-border-subtle bg-elevated/30">
                      {bookmarks.map((bm) => (
                        <li key={bm.key} className="flex items-center justify-between gap-2 px-2.5 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              setMenuOpen(false);
                              void navigate({ to: "/browser", search: { url: bm.url } });
                            }}
                            className="tap min-w-0 flex-1 text-left"
                          >
                            <p className="truncate text-xs font-medium text-foreground">{bm.title}</p>
                            <p className="truncate font-mono text-[9px] text-amber/80">{bm.url}</p>
                          </button>
                          <Chip
                            signal="amber"
                            className="min-h-7 px-2 py-0.5 text-[10px]"
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
                  )}
                </div>
              )}
            </div>

            {/* Footer with Compact Panic Wipe */}
            <div className="border-t border-border-subtle p-2.5 bg-elevated/20 flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-dim">Emergency</span>
              <button
                type="button"
                onClick={() => setShowConfirmWipe(true)}
                className="tap flex items-center gap-1.5 rounded border border-signal-red/50 bg-signal-red/15 px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-signal-red hover:bg-signal-red/25 transition-colors"
              >
                <Flame className="size-3" />
                <span>Zero Vault & Purge</span>
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
  fullBleed = false,
}: {
  children: ReactNode;
  bar?: ReactNode;
  heading: string;
  fullBleed?: boolean;
}) {
  return (
    <>
      <h1 className="sr-only">{heading}</h1>
      <div className="grid-canvas min-h-dvh bg-background pb-18 sm:pb-22">
        <TopBar>{bar}</TopBar>
        <main
          className={cn(
            "mx-auto touch-pan-y",
            fullBleed
              ? "max-w-5xl px-2 py-2 sm:px-3 sm:py-2.5"
              : "max-w-3xl space-y-3 px-3 py-2.5 sm:px-3.5 sm:py-3.5",
          )}
        >
          {children}
        </main>
        <BottomNav />
        <VpnGate />
        <PersonaGate />
        <DisclaimerGate />
      </div>
    </>
  );
}
