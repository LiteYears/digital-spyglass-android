import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app/app-shell";
import { InAppBrowser } from "@/components/browser/in-app-browser";

interface BrowserSearch {
  url?: string;
}

export const Route = createFileRoute("/browser")({
  validateSearch: (search: Record<string, unknown>): BrowserSearch => ({
    url: typeof search.url === "string" ? search.url : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Browser — Ghost onion browser" },
      {
        name: "description",
        content:
          "Built-in RAM-only Tor browser with per-host SOCKS5 circuit isolation, Reader mode, HTML source inspector, and SHA-256 verified file downloads.",
      },
    ],
  }),
  component: BrowserScreen,
});

function BrowserScreen() {
  const { url } = Route.useSearch();
  return (
    <AppShell heading="Ghost built-in Tor browser and secure file downloader" fullBleed>
      <InAppBrowser initialUrl={url} />
    </AppShell>
  );
}
