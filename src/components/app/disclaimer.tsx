/**
 * Per-session research consent. Shown on every app start; no identity, no
 * telemetry. The user must acknowledge that they are an adult using this tool
 * for research purposes, and that they accept full responsibility for their
 * use. No content is filtered — the user consents to seeing everything.
 */
import { useGhost } from "@/lib/store/ghost-context";
import { ActionButton, MicroLabel } from "./primitives";

export function DisclaimerGate() {
  const { ready, settings, updateSettings } = useGhost();
  if (!ready || settings.disclaimerAck) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Research consent"
      className="safe-top safe-bottom fixed inset-0 z-[60] overflow-y-auto bg-background/95 backdrop-blur-md"
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-3.5 px-4 py-6">
        <div className="space-y-2.5 rounded-xl border border-border-subtle bg-panel/70 p-4 shadow-xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
            research tool · adult consent
          </p>
          <h2 className="text-base font-semibold text-foreground">Onion Search — Research Tool</h2>
          <ul className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            <li>
              Aggregates results from public onion search engines. You see what the engines return.
            </li>
            <li>
              <strong className="text-foreground">
                By continuing, you confirm that you are an adult (18+) using this tool for
                legitimate research purposes.
              </strong>{" "}
              You accept full responsibility for your use and local compliance.
            </li>
            <li>
              Page content is never fetched in this app; links open externally in Tor Browser or via isolated built-in view.
            </li>
            <li>
              Search results are securely encrypted with AES-256-GCM in the device vault (zero unencrypted cleartext on disk, no telemetry, no tracking accounts), with instant zeroing via Panic Wipe.
            </li>
            <li>Requires a running Tor daemon — Orbot, SOCKS5 on 127.0.0.1:9050.</li>
          </ul>
          <MicroLabel className="block pt-1">shown every session · no telemetry collected</MicroLabel>
        </div>
        <ActionButton
          variant="primary"
          className="shrink-0 min-h-11"
          onClick={() => void updateSettings({ disclaimerAck: true })}
        >
          I am 18+ — I consent — continue
        </ActionButton>
      </div>
    </div>
  );
}
