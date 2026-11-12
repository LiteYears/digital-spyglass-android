/**
 * Thin wrappers around the native capabilities the app uses. Everything
 * degrades to a no-op (or a browser fallback) on the web preview.
 */
import { isNative } from "./bridge";

export async function haptic(kind: "light" | "medium" | "heavy" = "light"): Promise<void> {
  if (!(await isNative())) return;
  try {
    const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
    const style =
      kind === "heavy"
        ? ImpactStyle.Heavy
        : kind === "medium"
          ? ImpactStyle.Medium
          : ImpactStyle.Light;
    await Haptics.impact({ style });
  } catch {
    /* haptics unavailable */
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      void haptic("light");
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export type TransportInfo = {
  connected: boolean;
  connectionType: string;
  vpnActive: boolean | null;
};

/**
 * VPN detection.
 *
 * `@capacitor/network` on Android only reports "wifi" and "cellular" — it does
 * NOT check `NetworkCapabilities.TRANSPORT_VPN`. So when Orbot runs in VPN mode
 * the plugin returns "unknown" and our gate stays closed forever.
 *
 * The custom `PianoVpn` Capacitor plugin (PianoVpnPlugin.java) closes that gap
 * by checking TRANSPORT_VPN directly. It is registered in MainActivity and
 * picked up via `registerPlugin("PianoVpn")` at runtime.
 */
type VpnPlugin = {
  isVpnActive: () => Promise<{ active: boolean }>;
  isTorSocksReachable?: (opts?: { host?: string; port?: number }) => Promise<{ reachable: boolean }>;
  isVirtualDevice: () => Promise<{ isVirtual: boolean }>;
};

let vpnPlugin: VpnPlugin | null = null;

export async function checkTorSocks(host = "127.0.0.1", port = 9050): Promise<boolean> {
  if (!(await isNative())) return true;
  try {
    if (!vpnPlugin) {
      const { registerPlugin } = await import("@capacitor/core");
      vpnPlugin = registerPlugin<VpnPlugin>("PianoVpn");
    }
    if (vpnPlugin.isTorSocksReachable) {
      const res = await vpnPlugin.isTorSocksReachable({ host, port });
      return res.reachable;
    }
  } catch {
    /* fallback */
  }
  return false;
}

export async function readTransport(): Promise<TransportInfo> {
  if (!(await isNative())) {
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    return { connected: online, connectionType: "web", vpnActive: null };
  }
  try {
    const { Network } = await import("@capacitor/network");
    const status = await Network.getStatus();
    const type = String(status.connectionType);

    /* Ask the custom plugin whether TRANSPORT_VPN is active on ANY network.
       Orbot runs as a per-app VPN, so getActiveNetwork() may return WiFi for
       apps not in Orbot's allowed list. The plugin checks all networks.

       NOTE: registerPlugin() returns a Proxy with a `then` trap. If we pass it
       through an async function's return, JS treats it as a thenable and calls
       `.then()` — which Capacitor interprets as a plugin method call and throws
       "PianoVpn.then() is not implemented". So we call the plugin method
       directly here, never returning the proxy through a Promise. */
    let vpnActive: boolean | null = null;
    try {
      if (!vpnPlugin) {
        const { registerPlugin } = await import("@capacitor/core");
        vpnPlugin = registerPlugin<VpnPlugin>("PianoVpn");
      }
      const result = await vpnPlugin.isVpnActive();
      vpnActive = result.active;
    } catch {
      /* plugin not available — fall back to heuristic below */
    }
    if (vpnActive === null) {
      /* Heuristic fallback: @capacitor/network only knows wifi/cellular.
         A connected "unknown" transport is most likely a VPN tunnel. */
      vpnActive = status.connected && type === "unknown" ? true : null;
    }
    return { connected: status.connected, connectionType: type, vpnActive };
  } catch {
    return { connected: true, connectionType: "unknown", vpnActive: null };
  }
}

type RegistryAnchorPlugin = {
  getRegistryAnchor: () => Promise<{ spkiBase64: string; certSha256: string }>;
};

let anchorPlugin: RegistryAnchorPlugin | null = null;

/**
 * Registry trust anchor: the public key (SPKI) of whoever signed this APK,
 * read natively via PackageManager. Throws when unavailable — a missing
 * anchor must surface as failure to the caller, never as a pass.
 */
export async function readRegistryAnchor(): Promise<{
  spkiBase64: string;
  certSha256: string;
}> {
  if (!(await isNative())) throw new Error("registry anchor requires native platform");
  if (!anchorPlugin) {
    const { registerPlugin } = await import("@capacitor/core");
    anchorPlugin = registerPlugin<RegistryAnchorPlugin>("PianoRegistryAnchor");
  }
  const result = await anchorPlugin.getRegistryAnchor();
  if (!result?.spkiBase64) throw new Error("registry anchor returned no key");
  return result;
}

export async function shareFile(filename: string, contents: string, title: string): Promise<void> {
  if (!(await isNative())) {
    if (typeof document === "undefined") return;
    const blob = new Blob([contents], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return;
  }
  const fs = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  const dir = "piano/exports";
  // Shared files land in cacheDir — plaintext residue that would otherwise
  // sit on disk until the NEXT cold start's scrub (C1). Scrub leftovers from
  // a share that died mid-flight, then delete ours as soon as the sheet
  // completes. The onCreate scrub and panic wipe remain the backstops.
  try {
    const { files } = await fs.Filesystem.readdir({ path: dir, directory: fs.Directory.Cache });
    for (const file of files) {
      await fs.Filesystem.deleteFile({
        path: `${dir}/${file.name}`,
        directory: fs.Directory.Cache,
      }).catch(() => {});
    }
  } catch {
    /* dir absent — nothing to scrub */
  }
  const written = await fs.Filesystem.writeFile({
    path: `${dir}/${filename}`,
    directory: fs.Directory.Cache,
    encoding: fs.Encoding.UTF8,
    data: contents,
    recursive: true,
  });
  try {
    await Share.share({ title, url: written.uri });
  } finally {
    await fs.Filesystem.deleteFile({
      path: `${dir}/${filename}`,
      directory: fs.Directory.Cache,
    }).catch(() => {});
  }
}

export async function exitApp(): Promise<void> {
  if (!(await isNative())) return;
  try {
    const { App } = await import("@capacitor/app");
    await App.exitApp();
  } catch {
    /* nothing to exit in the browser */
  }
}

export async function onAppStateChange(handler: (active: boolean) => void): Promise<() => void> {
  if (!(await isNative())) {
    if (typeof document === "undefined") return () => {};
    const listener = () => handler(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  }
  const { App } = await import("@capacitor/app");
  const sub = await App.addListener("appStateChange", ({ isActive }) => handler(isActive));
  return () => void sub.remove();
}

type ScreenPlugin = {
  addListener: (event: string, cb: () => void) => Promise<{ remove: () => void }>;
  panicWipeAndKill: () => Promise<void>;
};

let screenPlugin: ScreenPlugin | null = null;

/**
 * Executes the native anti-forensic panic wipe (clears Tor cookie jar, WebView
 * RAM/disk cache, WebStorage, cookies, zeroes & unlinks cacheDir/app_webview,
 * removes task from Android Recents via finishAndRemoveTask, and terminates the
 * process via killProcess + Runtime.halt). Falls back to exitApp() if the native
 * plugin is unavailable.
 */
export async function hardPanicWipeAndKill(): Promise<void> {
  if (!(await isNative())) return;
  try {
    if (!screenPlugin) {
      const { registerPlugin } = await import("@capacitor/core");
      screenPlugin = registerPlugin<ScreenPlugin>("PianoScreen");
    }
    await screenPlugin.panicWipeAndKill();
    return;
  } catch {
    await exitApp();
  }
}

/**
 * Fires `handler` when the Android screen turns off (screen saver / lock).
 * Unlike `onAppStateChange` (which also fires on HOME key), this only fires
 * on genuine screen-off events — so the session stays alive during normal
 * background transitions but is purged when the screen saver activates.
 */
export async function onScreenOff(handler: () => void): Promise<() => void> {
  if (!(await isNative())) return () => {};
  try {
    if (!screenPlugin) {
      const { registerPlugin } = await import("@capacitor/core");
      screenPlugin = registerPlugin<ScreenPlugin>("PianoScreen");
    }
    const sub = await screenPlugin.addListener("screenOff", handler);
    return () => void sub.remove();
  } catch {
    return () => {};
  }
}

/**
 * Heuristic emulator/virtual-device hint.
 *
 * This is NOT root detection: a JS-layer check is trivially defeated by Magisk
 * Hide or Frida, so the app makes no root claim at all. It only surfaces a
 * warn-only note in the Status tab and never blocks anything.
 */
export async function looksVirtualDevice(): Promise<boolean> {
  if (!(await isNative())) return false;
  try {
    if (!vpnPlugin) {
      const { registerPlugin } = await import("@capacitor/core");
      vpnPlugin = registerPlugin<VpnPlugin>("PianoVpn");
    }
    const res = await vpnPlugin.isVirtualDevice();
    if (typeof res?.isVirtual === "boolean") {
      return res.isVirtual;
    }
  } catch {
    /* fall back to UA check below */
  }
  try {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (/\b(sdk_gphone|Android SDK built for|Emulator|generic_x86|goldfish|ranchu)\b/i.test(ua)) {
      return true;
    }
  } catch {
    /* no signal available */
  }
  return false;
}
