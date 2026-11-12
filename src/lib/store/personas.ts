/**
 * First-run threat-model presets. Pure mapping onto existing preferences —
 * no new machinery, no network. The persona choice itself is a non-sensitive
 * preference (persisted with the other prefs; erased by panic wipe).
 */
import type { GhostSettings, PersonaId } from "../ghost/types";

export type Persona = {
  id: PersonaId;
  title: string;
  /** One-line description shown on the selection card. */
  blurb: string;
  /** What this preset changes, in plain language. */
  changes: string[];
};

export const PERSONAS: Persona[] = [
  {
    id: "hostile",
    title: "I research in a hostile environment",
    blurb: "Maximum anti-forensics and traffic camouflage out of the box.",
    changes: [
      "Paranoid mode on — decoy traffic + surge-shaped engine requests",
      "Session purged from RAM every time the screen locks",
      "Ahmia abuse-list marking on (flagged results, never removed)",
    ],
  },
  {
    id: "free",
    title: "I research freely",
    blurb: "Ghost's standard posture — strong defaults, no extra latency.",
    changes: [
      "Standard traffic timing (faster searches)",
      "Session purged on screen lock (stays on)",
      "Abuse-list marking off — enable anytime in Security",
    ],
  },
  {
    id: "curious",
    title: "I'm just trying it out",
    blurb: "Fast and simple — the 5 highest-value engines, standard safety.",
    changes: [
      "Fast mode on — Ahmia, Torch, TorDex, Torgle, Tor66 only",
      "Standard traffic timing and wipe behavior",
      "Switch to all engines anytime in the Engines tab",
    ],
  },
];

/** Preference patch a persona applies (includes the persona id itself). */
export function applyPersona(id: PersonaId): Partial<GhostSettings> {
  switch (id) {
    case "hostile":
      return {
        persona: id,
        paranoidMode: true,
        purgeOnScreenOff: true,
        blacklistFilter: true,
        fastMode: false,
      };
    case "curious":
      return {
        persona: id,
        fastMode: true,
        paranoidMode: false,
        purgeOnScreenOff: true,
        blacklistFilter: false,
      };
    case "free":
    default:
      return {
        persona: id,
        fastMode: false,
        paranoidMode: false,
        purgeOnScreenOff: true,
        blacklistFilter: false,
      };
  }
}
