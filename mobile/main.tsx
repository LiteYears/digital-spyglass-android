/**
 * APK entry point. Plain client-side SPA bootstrap — no SSR, no hydration.
 * Console sinks stay in place: WebView logs are readable via logcat and query
 * traces are investigative metadata.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import "../src/styles.css";
import { getRouter } from "../src/router";

const noop = () => {};
for (const key of ["log", "debug", "info", "trace", "table", "dir"] as const) {
  (console as unknown as Record<string, () => void>)[key] = noop;
}

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);
