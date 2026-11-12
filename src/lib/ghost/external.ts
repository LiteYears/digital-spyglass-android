/**
 * External link opening.
 *
 * The app never renders onion content. A tap hands the URL to the system, where
 * Tor Browser (or Orbot's chosen handler) claims it. `window.open` inside the
 * WebView would load the page in-process — exactly what this design forbids.
 */
import { isNative } from "../platform/bridge";

export async function openExternal(url: string): Promise<boolean> {
  if (await isNative()) {
    try {
      const { AppLauncher } = await import("@capacitor/app-launcher");
      await AppLauncher.openUrl({ url });
      return true;
    } catch {
      return false;
    }
  }
  if (typeof window === "undefined") return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
