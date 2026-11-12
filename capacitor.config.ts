import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.darknetcrawler.mobile",
  appName: "Ghost Search",
  // SPA shell produced by `MOBILE=1 bun run build` (see vite.config.ts).
  webDir: "dist/client",
  loggingBehavior: "none",
  android: {
    // Release builds must never trust user-installed CAs unless a profile opts in.
    allowMixedContent: false,
    // captureInput MUST stay off: it routes key events to the Activity and
    // breaks text entry in the WebView (empty search field on device).
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    StatusBar: {
      style: "DARK",
      backgroundColor: "#0b0f14",
      overlaysWebView: true,
    },
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
