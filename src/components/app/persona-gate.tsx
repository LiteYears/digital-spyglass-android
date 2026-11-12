/**
 * First-run threat-model selection. Appears once after the research-consent
 * disclaimer; the choice is a normal (non-sensitive) preference and is erased
 * by a panic wipe, which brings the chooser back.
 */
import { useGhost } from "@/lib/store/ghost-context";
import { PERSONAS, applyPersona } from "@/lib/store/personas";
import { ActionButton, MicroLabel } from "./primitives";

export function PersonaGate() {
  const { ready, settings, updateSettings } = useGhost();
  if (!ready || !settings.disclaimerAck || settings.persona !== null) return null;

  const choose = (id: (typeof PERSONAS)[number]["id"]) => {
    void updateSettings(applyPersona(id));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose your threat model"
      className="safe-top safe-bottom fixed inset-0 z-[55] overflow-y-auto bg-background/95 backdrop-blur-md"
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-3 px-4 py-5">
        <div className="space-y-1.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
            first run · pick a starting point
          </p>
          <h2 className="text-base font-semibold text-foreground">How do you plan to use Ghost?</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            This only sets defaults — every switch can be changed later in the Security tab. Nothing
            is sent anywhere.
          </p>
        </div>
        <div className="space-y-2">
          {PERSONAS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => choose(p.id)}
              className="tap w-full rounded-md border border-border-subtle bg-panel/50 px-3 py-2 text-left transition-colors hover:border-amber/60"
            >
              <span className="block text-sm font-medium text-foreground">{p.title}</span>
              <span className="mt-0.5 block text-[11px] text-dim">{p.blurb}</span>
              <span className="mt-1.5 block space-y-0.5">
                {p.changes.map((c) => (
                  <span key={c} className="block text-[11px] leading-snug text-muted-foreground">
                    · {c}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
        <MicroLabel>
          one-time choice · stored with your other preferences · panic wipe resets it
        </MicroLabel>
        <ActionButton onClick={() => choose("free")}>Just use the defaults</ActionButton>
      </div>
    </div>
  );
}
