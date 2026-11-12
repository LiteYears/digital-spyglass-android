/**
 * The only thing this app persists: non-sensitive UI preferences plus the
 * Tor SOCKS endpoint. No queries, no results, no URLs, no keys.
 */
import { prefsStore } from "../platform/storage";
import type { GhostSettings } from "../ghost/types";

const KEY = "ghost.prefs.v1";

export const defaultGhostSettings: GhostSettings = {
  engines: [],
  snippetFilter: false,
  requireVpn: true,
  disclaimerAck: false,
  torSocksHost: "127.0.0.1",
  torSocksPort: "9050",
  paranoidMode: false,
  fastMode: false,
  qarfMode: false,
  blacklistFilter: false,
  purgeOnScreenOff: true,
  allowClearnet: false,
  persona: null,
};

export async function loadGhostSettings(): Promise<GhostSettings> {
  const stored = await prefsStore.getJson<Partial<GhostSettings>>(KEY, {});
  return { ...defaultGhostSettings, ...stored };
}

export async function saveGhostSettings(settings: GhostSettings): Promise<void> {
  await prefsStore.setJson(KEY, settings);
}

export async function clearGhostSettings(): Promise<void> {
  await prefsStore.remove(KEY);
}
