import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/lib/ghost/**/*.ts", "src/lib/platform/**/*.ts", "src/lib/store/**/*.tsx"],
      thresholds: {
        // Baseline measured 2026-10-20 (69.4/56.3/65.3/67.2); ratchet
        // upward, never downward. native.ts and ghost-context.tsx are
        // intentionally 0% — they need a live Android WebView.
        lines: 69,
        functions: 65,
        branches: 56,
        statements: 67,
      },
    },
  },
});
