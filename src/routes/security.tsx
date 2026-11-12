import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Eraser } from "lucide-react";
import { toast } from "sonner";

import { AppShell } from "@/components/app/app-shell";
import {
  ActionButton,
  Chip,
  Dot,
  MicroLabel,
  Panel,
  type Signal,
} from "@/components/app/primitives";
import { openExternal } from "@/lib/ghost/external";
import { Input } from "@/components/ui/input";
import { blacklistCount, loadAhmiaBlacklist } from "@/lib/ghost/blacklist";
import {
  ENGINES,
  activeRegistry,
  isImportedRegistryActive,
  registryAnchorFingerprint,
  registryIntegrity,
} from "@/lib/ghost/engines";
import {
  refreshRegistryChainStatus,
  registryChainStatus,
  type ChainStatus,
} from "@/lib/ghost/registry-chain";
import {
  loadTrustedKeys,
  removeTrustedKey,
  type TrustedKeyEntry,
} from "@/lib/ghost/registry-import";
import { assertRegistryIntact } from "@/lib/ghost/search";
import type { RegistryIntegrity } from "@/lib/ghost/engines";
import { fetchBodyOnly, invalidateTorVerification, verifyTor } from "@/lib/ghost/http";
import { getHealth } from "@/lib/ghost/breaker";
import { haptic, launchOrbot, looksVirtualDevice } from "@/lib/platform/native";
import { useGhost } from "@/lib/store/ghost-context";

export const Route = createFileRoute("/security")({
  head: () => ({
    meta: [
      { title: "Security — Ghost onion search" },
      {
        name: "description",
        content:
          "Transport state, VPN enforcement, snippet filtering and an atomic wipe. Ghost keeps no history, cache or database on the device.",
      },
      { property: "og:title", content: "Security — Ghost onion search" },
      {
        property: "og:description",
        content: "VPN gate, screenshot blocking, snippet filter and atomic wipe.",
      },
    ],
  }),
  component: SecurityScreen,
});

function RegistryIntegrityRow() {
  const [state, setState] = useState<RegistryIntegrity>(registryIntegrity());
  const [fingerprint, setFingerprint] = useState<string | null>(registryAnchorFingerprint());
  useEffect(() => {
    let disposed = false;
    void assertRegistryIntact()
      .catch(() => {})
      .finally(() => {
        if (disposed) return;
        setState(registryIntegrity());
        setFingerprint(registryAnchorFingerprint());
      });
    return () => {
      disposed = true;
    };
  }, []);
  const signal: Signal = state === "verified" ? "green" : state === "failed" ? "red" : "dim";
  return (
    <div className="border-t border-border-subtle px-3 py-2">
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Dot signal={signal} />
          <span className="text-xs font-mono text-foreground">registry signature</span>
        </span>
        <span className="text-[10px] font-mono text-dim">
          {state === "verified" && fingerprint
            ? `${isImportedRegistryActive() ? "import signer" : "signer"} ${fingerprint.slice(0, 8)}…`
            : state === "unchecked"
              ? "web preview"
              : state}
        </span>
      </span>
    </div>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2.5">
      <span className="flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-dim">{hint}</span>
      </span>
      <Chip
        active={value}
        onClick={() => {
          void haptic("light");
          onChange(!value);
        }}
      >
        {value ? "on" : "off"}
      </Chip>
    </div>
  );
}

function SecurityScreen() {
  const {
    settings,
    updateSettings,
    transport,
    refreshTransport,
    panicWipe,
    purgeNow,
    lastPurgeAt,
  } = useGhost();
  const [virtual, setVirtual] = useState<boolean | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [torStatus, setTorStatus] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [blLoading, setBlLoading] = useState(false);
  const [blCount, setBlCount] = useState(() => blacklistCount());
  const [signerFp, setSignerFp] = useState<string | null>(registryAnchorFingerprint());
  const [chain, setChain] = useState<ChainStatus | null>(registryChainStatus());
  const [trustedKeys, setTrustedKeys] = useState<TrustedKeyEntry[]>([]);

  useEffect(() => {
    void looksVirtualDevice().then(setVirtual);
  }, []);

  useEffect(() => {
    let disposed = false;
    void assertRegistryIntact()
      .catch(() => {})
      .finally(() => {
        if (!disposed) setSignerFp(registryAnchorFingerprint());
      });
    // Chain status is informational and works off-native too — refresh it
    // against the ACTIVE registry (an import is not part of the bundled
    // chain; showing bundled state while an import runs would lie — F4).
    // With an active import the bundled-chain check is skipped entirely —
    // a foreign signer's own `previous` history would false-positive as
    // "broken" and train operators to ignore real warnings (R8).
    if (!isImportedRegistryActive()) {
      void refreshRegistryChainStatus(activeRegistry())
        .catch(() => {})
        .then((status) => {
          if (!disposed && status) setChain(status);
        });
    }
    void loadTrustedKeys().then((keys) => {
      if (!disposed) setTrustedKeys(keys);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const revokeTrustedKey = async (fingerprint: string) => {
    await removeTrustedKey(fingerprint);
    setTrustedKeys(await loadTrustedKeys());
    if (isImportedRegistryActive()) {
      toast.warning(
        "trusted key revoked — if it signed the active import, search is blocked until the import is removed",
      );
    } else {
      toast.success("trusted key revoked — future imports by this signer will fail");
    }
  };

  const runTorCheck = async () => {
    setTorStatus("checking");
    const p = Number.parseInt(settings.torSocksPort ?? "", 10);
    const ok = await verifyTor(true, {
      host: settings.torSocksHost?.trim() || undefined,
      port: p >= 1 && p <= 65535 ? p : undefined,
    });
    setTorStatus(ok ? "ok" : "fail");
    if (ok) void haptic("light");
  };

  const refreshBlacklist = async () => {
    setBlLoading(true);
    try {
      const p = Number.parseInt(settings.torSocksPort ?? "", 10);
      const socksAuth = {
        user: "ghost-bl",
        pass: crypto.randomUUID(),
        host: settings.torSocksHost?.trim() || undefined,
        port: p >= 1 && p <= 65535 ? p : undefined,
      };
      const res = await loadAhmiaBlacklist((u: string) => fetchBodyOnly(u, socksAuth), true);
      setBlCount(res.count);
      if (res.loaded && res.count > 0)
        toast.success(`Loaded ${res.count} blacklisted domains into RAM`);
      else toast.error("Could not load Ahmia blacklist via Tor");
    } finally {
      setBlLoading(false);
    }
  };

  const torSignal: Signal = torStatus === "ok" ? "green" : torStatus === "fail" ? "red" : "amber";

  const vpnSignal: Signal =
    transport.vpnActive === true ? "green" : transport.vpnActive === false ? "red" : "amber";

  return (
    <AppShell heading="Security posture, transport state and wipe">
      <Panel
        title="am i leaking? (self-check)"
        action={
          <Chip
            onClick={() => {
              void refreshTransport();
              invalidateTorVerification();
              setTorStatus("idle");
            }}
          >
            refresh
          </Chip>
        }
      >
        <ul className="divide-y divide-border-subtle">
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">VPN transport (any tunnel)</span>
            <span className="flex items-center gap-2">
              <Dot signal={vpnSignal} />
              <MicroLabel>
                {transport.vpnActive === true
                  ? "up — informational only"
                  : transport.vpnActive === false
                    ? "down"
                    : "not reportable"}
              </MicroLabel>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Tor probe through SOCKS</span>
            <span className="flex items-center gap-2">
              {torStatus !== "idle" && <Dot signal={torSignal} />}
              <button
                type="button"
                onClick={() => void runTorCheck()}
                disabled={torStatus === "checking"}
                className="tap rounded bg-foreground/10 px-2 py-0.5 text-[10px] font-mono text-foreground/70 disabled:opacity-50"
              >
                {torStatus === "checking"
                  ? "checking…"
                  : torStatus === "ok"
                    ? "verified"
                    : torStatus === "fail"
                      ? "failed · retry"
                      : "run test"}
              </button>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Engine registry signature</span>
            <span className="flex items-center gap-2">
              <Dot signal={signerFp ? "green" : "amber"} />
              <MicroLabel>
                {signerFp
                  ? `${isImportedRegistryActive() ? "import signer" : "signer"} ${signerFp.slice(0, 8)}…`
                  : "resolving…"}
              </MicroLabel>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Purge on screen lock</span>
            <span className="flex items-center gap-2">
              <Dot signal={settings.purgeOnScreenOff ? "green" : "amber"} />
              <MicroLabel>
                {settings.purgeOnScreenOff
                  ? "on — RAM wiped at lock"
                  : "off — results survive lock"}
              </MicroLabel>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Session memory</span>
            <span className="flex items-center gap-2">
              <Dot signal={lastPurgeAt ? "green" : "amber"} />
              <MicroLabel>
                {lastPurgeAt
                  ? `cleared ${Math.max(1, Math.round((Date.now() - lastPurgeAt) / 60000))}m ago`
                  : "not purged this session"}
              </MicroLabel>
            </span>
          </li>
        </ul>
        <div className="border-t border-border-subtle px-3 py-2.5">
          <MicroLabel>
            Read-only status of what this app can see about itself. What no app can check from
            inside — keyboard, clipboard, accessibility, physical observation — is listed honestly
            in “what Ghost cannot protect” below.
          </MicroLabel>
        </div>
      </Panel>

      <Panel
        title="transport"
        action={
          <Chip
            onClick={() => {
              void refreshTransport();
              invalidateTorVerification();
              setTorStatus("idle");
            }}
          >
            re-check
          </Chip>
        }
      >
        <ul className="divide-y divide-border-subtle">
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">VPN tunnel</span>
            <span className="flex items-center gap-2">
              <Dot signal={vpnSignal} />
              <MicroLabel>
                {transport.vpnActive === null
                  ? "not reportable"
                  : transport.vpnActive
                    ? "active"
                    : "down"}
              </MicroLabel>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Connection</span>
            <MicroLabel>{transport.connectionType}</MicroLabel>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Virtual device hint</span>
            <MicroLabel>
              {virtual === null ? "checking…" : virtual ? "emulator-like" : "no indicator"}
            </MicroLabel>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Tor connectivity</span>
            <span className="flex items-center gap-2">
              {torStatus !== "idle" && <Dot signal={torSignal} />}
              <MicroLabel>
                {torStatus === "idle"
                  ? "not checked"
                  : torStatus === "checking"
                    ? "verifying…"
                    : torStatus === "ok"
                      ? "verified"
                      : "failed"}
              </MicroLabel>
              <button
                type="button"
                onClick={() => void runTorCheck()}
                disabled={torStatus === "checking"}
                className="tap rounded bg-foreground/10 px-2 py-0.5 text-[10px] font-mono text-foreground/70 disabled:opacity-50"
              >
                test
              </button>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Orbot Tor service</span>
            <button
              type="button"
              onClick={() => {
                void launchOrbot();
              }}
              className="tap rounded-md border border-amber/40 bg-amber/15 px-2.5 py-1 font-mono text-xs text-amber transition-colors hover:bg-amber/25 active:scale-95"
            >
              Open / Install Orbot
            </button>
          </li>
        </ul>
        <div className="border-t border-border-subtle px-3 py-2.5">
          <MicroLabel>
            The hint is passive: emulator markers are advisory, never a block. Ghost does not
            fingerprint the device beyond this.
          </MicroLabel>
        </div>
      </Panel>

      <Panel title="engine health (this session)">
        <ul className="divide-y divide-border-subtle">
          {ENGINES.map((engine) => {
            const h = getHealth(engine.id);
            const signal: Signal =
              h.open || h.deprecated
                ? "red"
                : h.lastStatus === "ok"
                  ? "green"
                  : h.lastStatus === "captcha"
                    ? "amber"
                    : h.lastStatus === "failed"
                      ? "red"
                      : "dim";
            return (
              <li key={engine.id} className="flex items-center justify-between px-3 py-2">
                <span className="flex items-center gap-2">
                  <Dot signal={signal} />
                  <span className="text-xs font-mono text-foreground">{engine.name}</span>
                </span>
                <span className="flex items-center gap-2 text-[10px] font-mono text-dim">
                  {h.lastMs !== undefined && <span>{h.lastMs}ms</span>}
                  {h.lastCount !== undefined && <span>{h.lastCount} hits</span>}
                  <span className="text-foreground/50">
                    {h.successes}ok/{h.totalFailures}fail
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
        <RegistryIntegrityRow />
        <div className="border-t border-border-subtle px-3 py-2">
          <MicroLabel>Session-only metrics. Reset on app restart. No data is persisted.</MicroLabel>
        </div>
      </Panel>

      <Panel title="policy & ranking (v3)">
        <div className="divide-y divide-border-subtle">
          <Toggle
            label="Require VPN"
            hint="Blocks every query unless a VPN transport is up. Turn off only if the platform cannot report tunnel state."
            value={settings.requireVpn}
            onChange={(next) => void updateSettings({ requireVpn: next })}
          />
          <Toggle
            label="Snippet filter"
            hint="Withholds snippet text on results matching high-risk terms. Titles and URLs stay visible."
            value={settings.snippetFilter}
            onChange={(next) => void updateSettings({ snippetFilter: next })}
          />
          <Toggle
            label="Fast mode (Core + Reinforcement)"
            hint="Queries only the 5 highest-value engines (Ahmia, Torch, TorDex, Torgle, Tor66 — 98.6% unique relevant results, ~60% faster)."
            value={settings.fastMode}
            onChange={(next) => void updateSettings({ fastMode: next })}
          />
          <Toggle
            label="QARF adaptive ranking"
            hint="Query Adaptive Rank Fusion: dynamically weights engines by rare query-term IDF match in top-20 hits. Best for narrow technical queries."
            value={settings.qarfMode}
            onChange={(next) => void updateSettings({ qarfMode: next })}
          />
          <Toggle
            label="Clearnet results (opt-in)"
            hint="Show non-.onion result links. Off by default: only onion destinations are listed. Traffic still transits Tor either way — this controls which destinations are offered."
            value={settings.allowClearnet}
            onChange={(next) => void updateSettings({ allowClearnet: next })}
          />
          <div className="px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <span className="flex-1">
                <span className="block text-sm text-foreground">
                  Ahmia abuse blacklist (opt-in)
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-dim">
                  Marks results matching Ahmia&apos;s public abuse hash list in RAM ({blCount}{" "}
                  hashes loaded). Never removes results.
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void refreshBlacklist()}
                  disabled={blLoading}
                  className="tap rounded bg-foreground/10 px-2 py-1 text-[10px] font-mono text-foreground/70 disabled:opacity-50"
                >
                  {blLoading ? "loading…" : "load via tor"}
                </button>
                <Chip
                  active={settings.blacklistFilter}
                  onClick={() => {
                    void haptic("light");
                    void updateSettings({ blacklistFilter: !settings.blacklistFilter });
                  }}
                >
                  {settings.blacklistFilter ? "on" : "off"}
                </Chip>
              </div>
            </div>
          </div>
          <div className="px-3 py-2.5">
            <span className="block text-sm text-foreground">Tor SOCKS proxy</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-dim">
              Default 127.0.0.1:9050 (Orbot). Point at another Tor daemon or a LAN relay if needed.
            </span>
            <div className="mt-2 flex gap-2">
              <Input
                className="h-8 flex-1 font-mono text-xs"
                value={settings.torSocksHost}
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="127.0.0.1"
                onChange={(e) => void updateSettings({ torSocksHost: e.target.value })}
              />
              <Input
                className="h-8 w-24 font-mono text-xs"
                value={settings.torSocksPort}
                inputMode="numeric"
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="9050"
                onChange={(e) =>
                  void updateSettings({ torSocksPort: e.target.value.replace(/[^\d]/g, "") })
                }
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  void updateSettings({ torSocksHost: "127.0.0.1", torSocksPort: "9050" });
                  toast.success("Tor SOCKS set to Orbot default (127.0.0.1:9050)");
                }}
                className={`tap rounded px-2 py-0.5 text-[10px] font-mono transition-colors ${settings.torSocksPort === "9050" ? "bg-amber/20 text-amber" : "bg-foreground/10 text-foreground/70"}`}
              >
                9050 (Orbot)
              </button>
              <button
                type="button"
                onClick={() => {
                  void updateSettings({ torSocksHost: "127.0.0.1", torSocksPort: "9150" });
                  toast.success("Tor SOCKS set to Tor Browser (127.0.0.1:9150)");
                }}
                className={`tap rounded px-2 py-0.5 text-[10px] font-mono transition-colors ${settings.torSocksPort === "9150" ? "bg-amber/20 text-amber" : "bg-foreground/10 text-foreground/70"}`}
              >
                9150 (Tor Browser)
              </button>
              <button
                type="button"
                onClick={() => void runTorCheck()}
                disabled={torStatus === "checking"}
                className="tap rounded bg-amber/15 px-2 py-0.5 text-[10px] font-mono text-amber hover:bg-amber/25 disabled:opacity-50"
              >
                {torStatus === "checking" ? "testing…" : "test now"}
              </button>
            </div>
          </div>
          <Toggle
            label="Purge on screen lock"
            hint="Wipes results and session state from RAM whenever the screen turns off. On by default — turning it off keeps results while the device locks."
            value={settings.purgeOnScreenOff}
            onChange={(next) => void updateSettings({ purgeOnScreenOff: next })}
          />
          <Toggle
            label="Paranoid mode"
            hint="Stronger traffic-analysis camouflage: RegulaTor surge shaping (3-4 requests per surge with exponential pauses) + more decoy requests. Adds ~2-5s to search time. Reduces fingerprinting accuracy but does not eliminate it."
            value={settings.paranoidMode}
            onChange={(next) => void updateSettings({ paranoidMode: next })}
          />
        </div>
      </Panel>

      <Panel title="what stays on this device">
        <ul className="space-y-2 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <li>
            <span className="text-foreground">Persisted:</span> non-sensitive preferences — engine
            selection, snippet filter, VPN requirement, Tor proxy endpoint,
            fast/QARF/paranoid/blacklist toggles — plus the disclaimer acknowledgement. Nothing
            else.
          </li>
          <li>
            <span className="text-foreground">Never persisted:</span> queries, results, URLs,
            timestamps. No history, no cache, no database, no log file.
          </li>
          <li>
            <span className="text-foreground">On screen lock:</span> results and in-flight requests
            are purged from memory when the screen turns off (screen saver / lock) while “purge on
            screen lock” is on. Normal app switching (HOME key) keeps the session alive.
          </li>
          <li>
            <span className="text-foreground">Screenshots:</span> blocked by the OS via FLAG_SECURE
            in the signed build, so the app never appears in the recents thumbnail.
          </li>
        </ul>
      </Panel>

      <Panel title="what Ghost cannot protect">
        <ul className="space-y-3 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          <li>
            <span className="text-foreground">Your keyboard.</span> The search field is a normal
            input — a keyboard app with “personalized learning” (Gboard & co.) may store or sync
            everything you type. Tip: use a privacy keyboard or disable learning suggestions.
          </li>
          <li>
            <span className="text-foreground">Clipboard history.</span> Copying an onion address
            puts it on the system clipboard; keyboard and Android 13+ keep a history. Tip: clear it
            after pasting sensitive links.
          </li>
          <li>
            <span className="text-foreground">Accessibility services.</span> Any enabled
            accessibility service can read result rows on screen — screenshot blocking does not
            apply to them. Tip: review enabled services if your device is shared.
          </li>
          <li>
            <span className="text-foreground">Your writing style.</span> Queries reach the search
            engines in plain text — that is what search is. Unusual phrasing can identify you to the
            engine operator. Tip: prefer generic phrasing for sensitive topics.
          </li>
          <li>
            <span className="text-foreground">Timing at the Tor guard.</span> The first Tor relay
            (and a global observer) can see the volume and timing of your traffic — the same
            exposure any Tor user has when opening several sites at once. Ghost cannot do better
            than Tor itself here.
          </li>
          <li>
            <span className="text-foreground">Physical observation.</span> Someone watching your
            screen sees what no software can hide. FLAG_SECURE blocks screenshots and recents — not
            eyes.
          </li>
        </ul>
        <div className="border-t border-border-subtle px-3 py-2.5">
          <MicroLabel>
            Named limits, not hidden ones. If a future claim contradicts this list, trust the list.
          </MicroLabel>
        </div>
      </Panel>

      <Panel title="tor browser">
        <div className="space-y-2 px-3 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Ghost never loads page content. Opening a result hands the URL to Tor Browser, which
            isolates the page from this app entirely.
          </p>
          <Chip onClick={() => void openExternal("https://www.torproject.org/download/#android")}>
            get tor browser / orbot
          </Chip>
        </div>
      </Panel>

      <Panel title="verify this build">
        <ul className="divide-y divide-border-subtle">
          <li className="flex items-start justify-between gap-3 px-3 py-2.5">
            <span className="text-sm text-foreground">APK signer anchor</span>
            <span className="text-right font-mono text-[10px] leading-relaxed text-dim">
              {signerFp ? `${signerFp.slice(0, 16)}…` : "resolving…"}
              <span className="block text-foreground/50">compare with SECURITY.md</span>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Engine registry</span>
            <MicroLabel>signed against the APK signer · fails closed</MicroLabel>
          </li>
          <li className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-sm text-foreground">Registry hash chain</span>
            <span
              className={`text-right font-mono text-[10px] leading-relaxed ${
                chain?.status === "broken" ? "text-signal-red" : "text-dim"
              }`}
            >
              {isImportedRegistryActive()
                ? "imported registry — own signer history · n/a"
                : chain === null
                  ? "unknown"
                  : chain.status === "ok"
                    ? `intact · ${chain.detail}`
                    : chain.status === "empty"
                      ? "not initialised"
                      : chain.status === "unlinked"
                        ? "unlinked · informational"
                        : `BROKEN · ${chain.detail}`}
              <span className="block text-foreground/50">rollback visibility · advisory</span>
            </span>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Bundled abuse-list snapshot</span>
            <MicroLabel>{blCount} hashes (build-time)</MicroLabel>
          </li>
          <li className="flex items-center justify-between px-3 py-2.5">
            <span className="text-sm text-foreground">Distribution</span>
            <MicroLabel>F-Droid reproducible · upstream-signed</MicroLabel>
          </li>
        </ul>
        <div className="border-t border-border-subtle px-3 py-2.5">
          <MicroLabel>
            This screen is self-reported — a repackaged app can fake it. Real verification is
            external: compare the APK’s signer fingerprint and SHA-256 against SECURITY.md and the
            rebuild guide in docs/REPRODUCIBLE.md before trusting any build.
          </MicroLabel>
        </div>
      </Panel>

      <Panel title="trusted import keys">
        {trustedKeys.length === 0 ? (
          <div className="px-3 py-2.5">
            <MicroLabel>none — only the APK signer anchor is trusted</MicroLabel>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {trustedKeys.map((key) => (
              <li
                key={key.fingerprint}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <span className="font-mono text-[10px] leading-relaxed text-dim">
                  {key.fingerprint.slice(0, 16)}…
                  <span className="block text-foreground/50">
                    confirmed {new Date(key.confirmedAt).toISOString().slice(0, 10)}
                  </span>
                </span>
                <Chip onClick={() => void revokeTrustedKey(key.fingerprint)}>revoke</Chip>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-border-subtle px-3 py-2.5">
          <MicroLabel>
            Keys you confirmed out-of-band for registry imports (known_hosts style). Revoking a
            compromised signer blocks its future imports — like ssh&apos;s known_hosts -R.
          </MicroLabel>
        </div>
      </Panel>

      <Panel title="wipe">
        <div className="space-y-2 px-3 py-3">
          <ActionButton
            onClick={() => {
              purgeNow();
              void haptic("medium");
              toast.success("Session memory cleared");
            }}
          >
            <Eraser className="size-4" /> Clear session memory
          </ActionButton>
          {confirmWipe ? (
            <div className="space-y-2">
              <MicroLabel className="text-signal-red">
                Erases preferences and closes the app. Not reversible.
              </MicroLabel>
              <div className="flex gap-2">
                <ActionButton
                  variant="danger"
                  className="flex-1"
                  onClick={() => {
                    void haptic("heavy");
                    void panicWipe();
                  }}
                >
                  Wipe now
                </ActionButton>
                <ActionButton className="flex-1" onClick={() => setConfirmWipe(false)}>
                  Cancel
                </ActionButton>
              </div>
            </div>
          ) : (
            <ActionButton variant="danger" onClick={() => setConfirmWipe(true)}>
              Panic wipe
            </ActionButton>
          )}
        </div>
      </Panel>
    </AppShell>
  );
}
