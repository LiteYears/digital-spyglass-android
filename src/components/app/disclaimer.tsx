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
      className="safe-top safe-bottom fixed inset-0 z-[60] overflow-y-auto bg-background"
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-5 px-6 py-10">
        <div className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-amber">
            research tool · adult consent
          </p>
          <h2 className="text-lg text-foreground">Onion Search — Research Tool</h2>
          <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li>
              This is an open research tool for the Tor network. It aggregates results from public
              onion search engines. Nothing is filtered — you see everything the engines return.
            </li>
            <li>
              <strong className="text-foreground">
                By continuing, you confirm that you are an adult (18+) using this tool for
                legitimate research purposes — journalism, security research, OSINT, academic study,
                or personal privacy.
              </strong>{" "}
              You accept full responsibility for how you use the results and for complying with the
              laws of your jurisdiction.
            </li>
            <li>
              Page content is never fetched or rendered in this app. Links open externally in Tor
              Browser. What you open there is your decision and your responsibility.
            </li>
            <li>
              Nothing is stored on disk: no history, no cache, no database, no telemetry, no
              accounts. Results stay in RAM for the session and are purged on screen lock, app exit,
              or via the panic button.
            </li>
            <li>
              This tool does not host, produce, or endorse any content. It is a search aggregator —
              like any search engine, it links to what others publish.
            </li>
            <li>Requires a running Tor daemon — Orbot, SOCKS5 on 127.0.0.1:9050.</li>
          </ul>
          <MicroLabel>shown every session · no persistent tracking · no data collected</MicroLabel>
        </div>
        <ActionButton
          variant="primary"
          className="shrink-0"
          onClick={() => void updateSettings({ disclaimerAck: true })}
        >
          I am 18+ — I consent — continue
        </ActionButton>
      </div>
    </div>
  );
}
