import { describe, expect, it } from "vitest";
import { PERSONAS, applyPersona } from "../personas";
import { defaultGhostSettings } from "../ghost-settings";

describe("personas", () => {
  it("offers exactly the three presets with plain-language change lists", () => {
    expect(PERSONAS.map((p) => p.id)).toEqual(["hostile", "free", "curious"]);
    for (const p of PERSONAS) {
      expect(p.changes.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("hostile preset turns on paranoid mode, screen-lock purge and abuse marking", () => {
    const patch = applyPersona("hostile");
    expect(patch).toMatchObject({
      persona: "hostile",
      paranoidMode: true,
      purgeOnScreenOff: true,
      blacklistFilter: true,
    });
  });

  it("free preset equals the shipped defaults (no surprise switches)", () => {
    const patch = applyPersona("free");
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (key === "persona") continue;
      expect(patch[key]).toBe(defaultGhostSettings[key]);
    }
  });

  it("curious preset only adds fast mode on top of the defaults", () => {
    const patch = applyPersona("curious");
    expect(patch.fastMode).toBe(true);
    expect(patch.paranoidMode).toBe(false);
    expect(patch.purgeOnScreenOff).toBe(true);
  });

  it("every patch includes the persona id and keeps screen-lock purge on", () => {
    for (const p of PERSONAS) {
      const patch = applyPersona(p.id);
      expect(patch.persona).toBe(p.id);
      expect(patch.purgeOnScreenOff).toBe(true);
    }
  });
});
