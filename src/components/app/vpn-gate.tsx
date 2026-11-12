/**
 * Non-dismissible egress gate.
 *
 * Without an active VPN transport (Orbot in VPN mode) queries would leave the
 * device over the clear net. That is not a warning-level event, so this overlay
 * has no dismiss path — only "Re-check VPN".
 */
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

import { launchOrbot } from "@/lib/platform/native";
import { useGhost } from "@/lib/store/ghost-context";
import { ActionButton, MicroLabel } from "./primitives";

export function VpnGate() {
  const { ready, settings, transport, torOk, egressOk, refreshTransport, updateSettings } =
    useGhost();
  const [checking, setChecking] = useState(false);

  if (!ready || egressOk || !settings.disclaimerAck) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="VPN required"
      className="safe-top safe-bottom fixed inset-0 z-50 overflow-y-auto bg-background/97 backdrop-blur-xl"
    >
      <div className="mx-auto flex min-h-full w-full max-w-xs flex-col items-center justify-center gap-5 px-6 py-10">
        <span
          aria-hidden
          className="relative flex size-20 shrink-0 items-center justify-center rounded-full border border-signal-amber/50"
        >
          <span className="absolute inset-0 animate-ping rounded-full bg-signal-amber/15" />
          <ShieldAlert className="size-9 text-signal-amber" />
        </span>
        <div className="space-y-2 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-signal-amber">
            egress blocked
          </p>
          <h2 className="text-lg text-foreground">Tor transport required</h2>
          <p className="max-w-[40ch] text-sm leading-relaxed text-muted-foreground">
            Orbot&apos;s SOCKS endpoint is not answering a real .onion probe — the daemon is down,
            its circuits are dead, or another VPN is masking its state. Start Orbot, then re-check.
            No query is sent while the probe fails.
          </p>
          <MicroLabel>
            tor {torOk === null ? "checking" : torOk ? "up" : "down"} · transport{" "}
            {transport.connectionType} · vpn{" "}
            {transport.vpnActive === null ? "unknown" : transport.vpnActive ? "up" : "down"}
          </MicroLabel>
          <details className="w-full rounded border border-border-subtle px-3 py-2 text-left">
            <summary className="cursor-pointer list-none text-xs font-mono text-dim">
              Orbot won&apos;t connect? Bridge hints
            </summary>
            <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-dim">
              <li>
                Orbot needs <span className="text-foreground">VPN mode</span> on (the “V” toggle).
                Ghost never sends anything while the tunnel is down.
              </li>
              <li>
                Censored network? Orbot has <span className="text-foreground">obfs4</span> and{" "}
                <span className="text-foreground">Snowflake</span> bridges built in — Settings →
                Bridges. Custom bridges can be pasted in or scanned as a QR code.
              </li>
              <li>
                Orbot does <span className="text-foreground">not</span> offer WebTunnel or Tor
                Browser&apos;s bridge-request captcha. If the built-ins are blocked, get private
                obfs4 bridges from @GetBridgesBot on Telegram or frontdesk@torproject.org — then
                paste them into Orbot.
              </li>
            </ul>
          </details>
        </div>
        <div className="w-full space-y-2">
          <ActionButton
            variant="default"
            onClick={() => void launchOrbot()}
          >
            Launch / Install Orbot (Tor VPN)
          </ActionButton>
          {transport.connectionType === "web" ? (
            <ActionButton
              variant="primary"
              onClick={() => void updateSettings({ requireVpn: false })}
            >
              Enter Web Preview Mode (Continue)
            </ActionButton>
          ) : (
            <ActionButton
              variant="primary"
              pending={checking}
              onClick={() => {
                setChecking(true);
                void refreshTransport().finally(() => setChecking(false));
              }}
            >
              {checking ? "checking transport…" : "Re-check Tor Transport"}
            </ActionButton>
          )}
          <ActionButton
            variant="default"
            onClick={() => void updateSettings({ requireVpn: false })}
          >
            Bypass VPN gate (Continue anyway)
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
