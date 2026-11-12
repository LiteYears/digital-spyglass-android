/**
 * Storage hierarchy.
 *
 * - secure:  API keys, server profiles, cert pins  -> Android Keystore
 * - prefs:   non-secret settings                   -> Capacitor Preferences
 * - vault:   search history / cached results       -> Filesystem (app data dir)
 *
 * localStorage and sessionStorage are NEVER used: they are unencrypted WebView
 * storage that any `adb backup` or rooted device can read in the clear. On the
 * web preview every backend degrades to an in-memory map, so nothing sensitive
 * is ever persisted in a browser.
 *
 * NOTE: Capacitor plugin proxies (registerPlugin) have a `then` trap. Returning
 * them through an async function makes JS treat them as thenables, calling
 * `.then()` which Capacitor interprets as a plugin method and throws
 * "Preferences.then() is not implemented". So we call plugin methods directly
 * inside the dynamic import block, never returning the proxy through a Promise.
 */
import { isNative } from "./bridge";

const memory = new Map<string, string>();

/* -------------------------------- prefs ---------------------------------- */

export const prefsStore = {
  async get(key: string): Promise<string | null> {
    if (!(await isNative())) return memory.get(`prefs:${key}`) ?? null;
    try {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key });
      return value ?? null;
    } catch {
      return memory.get(`prefs:${key}`) ?? null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (!(await isNative())) {
      memory.set(`prefs:${key}`, value);
      return;
    }
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key, value });
    } catch {
      memory.set(`prefs:${key}`, value);
    }
  },
  async remove(key: string): Promise<void> {
    if (!(await isNative())) {
      memory.delete(`prefs:${key}`);
      return;
    }
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.remove({ key });
    } catch {
      memory.delete(`prefs:${key}`);
    }
  },
  async getJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  },
};

export function wipeMemoryStores(): void {
  memory.clear();
}
