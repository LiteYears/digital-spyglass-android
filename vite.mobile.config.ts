/**
 * Capacitor/APK build only.
 *
 * The web deployment is server-rendered by TanStack Start. Inside the APK there
 * is no server, and Start's client entry *hydrates* — pointed at a hand-written
 * empty shell it throws "Invariant failed" and the WebView stays black.
 *
 * So the APK gets its own plain-SPA entry (mobile/main.tsx) that mounts the same
 * route tree with RouterProvider. No Start plugin, no SSR, no remote fonts.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "mobile",
  publicDir: "../public",
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 3200,
    rolldownOptions: {
      external: ["linkedom"],
    },
  },
});
