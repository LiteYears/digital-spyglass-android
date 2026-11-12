import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("../../platform/storage", () => ({
  prefsStore: {
    getJson: vi.fn(async (key: string, fallback: unknown) =>
      store.has(key) ? (store.get(key) as unknown) : fallback,
    ),
    setJson: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

import {
  clearGhostSettings,
  defaultGhostSettings,
  loadGhostSettings,
  saveGhostSettings,
} from "../ghost-settings";

describe("ghost settings", () => {
  beforeEach(() => {
    store.clear();
  });

  it("defaults keep screen-off purge ON (historical anti-forensic behavior)", () => {
    expect(defaultGhostSettings.purgeOnScreenOff).toBe(true);
    expect(defaultGhostSettings.requireVpn).toBe(true);
    expect(defaultGhostSettings.paranoidMode).toBe(false);
  });

  it("loadGhostSettings back-fills new keys onto stored prefs", async () => {
    // Simulates a pre-4.2 install: stored settings lack purgeOnScreenOff.
    store.set("ghost.prefs.v1", { requireVpn: false, paranoidMode: true });
    const loaded = await loadGhostSettings();
    expect(loaded.requireVpn).toBe(false);
    expect(loaded.paranoidMode).toBe(true);
    expect(loaded.purgeOnScreenOff).toBe(true);
  });

  it("respects an explicit purgeOnScreenOff=false from storage", async () => {
    store.set("ghost.prefs.v1", { purgeOnScreenOff: false });
    const loaded = await loadGhostSettings();
    expect(loaded.purgeOnScreenOff).toBe(false);
  });

  it("save/load roundtrip preserves every setting", async () => {
    const next = { ...defaultGhostSettings, fastMode: true, purgeOnScreenOff: false };
    await saveGhostSettings(next);
    expect(await loadGhostSettings()).toEqual(next);
  });

  it("clearGhostSettings removes stored prefs", async () => {
    await saveGhostSettings(defaultGhostSettings);
    await clearGhostSettings();
    expect(await loadGhostSettings()).toEqual(defaultGhostSettings);
  });
});
