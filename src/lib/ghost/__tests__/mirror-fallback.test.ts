/**
 * B12 — engine mirror arrays + fallback chain.
 *
 * Mocks the bundled registry with a test engine carrying one valid onion
 * mirror and two invalid mirror entries; asserts the endpoint chain
 * (primary → mirrors in order), mirror validation, breaker accounting and
 * the `via` marker on mirror-sourced reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { PRIMARY_HOST, MIRROR_HOST } = vi.hoisted(() => ({
  PRIMARY_HOST: "primarymirrortestonionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion",
  MIRROR_HOST: "goodmirrortestonionbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion",
}));

vi.mock("../engines.json", () => ({
  default: {
    version: 1,
    engines: [
      {
        id: "mirrortest",
        name: "MirrorTest",
        trust: 2,
        clearnet: false,
        baseUrl: `http://${PRIMARY_HOST}`,
        mirrors: [
          `http://${MIRROR_HOST}`,
          "https://clearnet-mirror.example.com/dropped",
          "not a url at all",
        ],
        searchUrl: "{base}/search?q={q}",
        parser: {
          type: "selectors",
          spec: { blocks: ["li.result"], link: "a", snippet: "p" },
        },
        note: "test engine with mirrors",
        enabled: true,
      },
      {
        id: "badmirrorsonly",
        name: "BadMirrorsOnly",
        trust: 1,
        clearnet: false,
        baseUrl: `http://badmirrorsonlyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion`,
        mirrors: ["https://clearnet.example.com/only-invalid"],
        searchUrl: "{base}/search?q={q}",
        parser: { type: "selectors", spec: { blocks: ["li.result"], link: "a" } },
        note: "all mirrors invalid — mirrors must be dropped, engine stays",
        enabled: true,
      },
    ],
  },
}));

import * as httpMod from "../http";
import * as breakerMod from "../breaker";
import { resetBreaker, getHealth } from "../breaker";
import { engineById } from "../engines";
import { searchAllEngines } from "../search";

const RESULT_HTML = `<html><body>
<li class="result"><a href="http://resulttargetonionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/page">Mirror Result Title</a><p>Snippet about mirror fallback behaviour in onion engines.</p></li>
<li class="result"><a href="http://resulttargetonionaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab.onion/page2">Second Result</a><p>Another snippet with enough text for the quality pipeline.</p></li>
</body></html>`;

describe("mirror descriptor validation", () => {
  it("keeps only http(s) .onion mirrors and drops everything else", () => {
    const engine = engineById("mirrortest")!;
    expect(engine.mirrors).toEqual([`http://${MIRROR_HOST}`]);
  });

  it("drops the mirrors field entirely when no entry is valid", () => {
    const engine = engineById("badmirrorsonly")!;
    expect(engine.mirrors).toBeUndefined();
  });

  it("renders searchUrl against a mirror base override", () => {
    const engine = engineById("mirrortest")!;
    const url = engine.searchUrl("q", 1, `http://${MIRROR_HOST}`);
    expect(url).toContain(MIRROR_HOST);
    expect(url).not.toContain(PRIMARY_HOST);
  });
});

describe("searchAllEngines mirror fallback", () => {
  let textSpy: ReturnType<typeof vi.spyOn>;
  let bodySpy: ReturnType<typeof vi.spyOn>;
  const fetchedUrls: string[] = [];

  beforeEach(() => {
    resetBreaker();
    fetchedUrls.length = 0;
    bodySpy = vi.spyOn(httpMod, "fetchBodyOnly").mockRejectedValue(new Error("decoy off"));
  });

  afterEach(() => {
    textSpy?.mockRestore();
    bodySpy.mockRestore();
    resetBreaker();
  });

  it("falls back to the signed mirror when the primary base fails", async () => {
    textSpy = vi.spyOn(httpMod, "fetchText").mockImplementation(async (url, _signal, _auth) => {
      fetchedUrls.push(String(url));
      if (String(url).includes(PRIMARY_HOST)) {
        throw new Error("connect timeout after 30000ms");
      }
      return { status: 200, body: RESULT_HTML, ms: 31 };
    });
    const outcome = await searchAllEngines({
      query: "mirror fallback",
      engineIds: ["mirrortest"],
      snippetFilter: false,
    });
    expect(outcome.rows.length).toBe(2);
    const report = outcome.reports.find((r) => r.id === "mirrortest")!;
    expect(report.state.status).toBe("ok");
    if (report.state.status === "ok") {
      expect(report.state.via).toContain(MIRROR_HOST.slice(0, 12));
    }
    expect(fetchedUrls.some((u) => u.includes(PRIMARY_HOST))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes(MIRROR_HOST))).toBe(true);
    // primary failure counted, mirror success reset the breaker
    expect(getHealth("mirrortest").lastStatus).toBe("ok");
  });

  it("never touches a mirror when the primary answers", async () => {
    textSpy = vi.spyOn(httpMod, "fetchText").mockImplementation(async (url, _signal, _auth) => {
      fetchedUrls.push(String(url));
      return { status: 200, body: RESULT_HTML, ms: 12 };
    });
    const outcome = await searchAllEngines({
      query: "primary healthy",
      engineIds: ["mirrortest"],
      snippetFilter: false,
    });
    expect(outcome.reports.find((r) => r.id === "mirrortest")?.state.status).toBe("ok");
    expect(fetchedUrls.every((u) => !u.includes(MIRROR_HOST))).toBe(true);
    const report = outcome.reports.find((r) => r.id === "mirrortest")!;
    if (report.state.status === "ok") expect(report.state.via).toBeUndefined();
  });

  it("reports failed with the last endpoint error when primary and mirror both die", async () => {
    textSpy = vi.spyOn(httpMod, "fetchText").mockImplementation(async (url, _signal, _auth) => {
      fetchedUrls.push(String(url));
      throw new Error(`timeout after 9000ms @ ${new URL(String(url)).hostname.slice(0, 8)}`);
    });
    await expect(
      searchAllEngines({
        query: "everything dead",
        engineIds: ["mirrortest"],
        snippetFilter: false,
      }),
    ).rejects.toThrow(/All engines failed/);
    // both endpoints were attempted in order: primary first, mirror second
    expect(fetchedUrls.filter((u) => u.includes(PRIMARY_HOST)).length).toBe(1);
    expect(fetchedUrls.filter((u) => u.includes(MIRROR_HOST)).length).toBe(1);
    expect(getHealth("mirrortest").totalFailures).toBeGreaterThanOrEqual(2);
  });

  it("does not retry mirrors after a captcha answer (engine is alive)", async () => {
    const captchaHtml =
      '<html><body><form action="/check" class="captcha-form">are you human? solve 4 + 3</form></body></html>';
    textSpy = vi.spyOn(httpMod, "fetchText").mockImplementation(async (url, _signal, _auth) => {
      fetchedUrls.push(String(url));
      if (String(url).includes(PRIMARY_HOST)) throw new Error("timeout after 5000ms");
      return { status: 200, body: captchaHtml, ms: 20 };
    });
    // captcha on the mirror → engine alive, chain stops, no ok rows → all_failed
    await expect(
      searchAllEngines({
        query: "captcha mirror",
        engineIds: ["mirrortest"],
        snippetFilter: false,
      }),
    ).rejects.toThrow(/All engines failed/);
    expect(fetchedUrls.filter((u) => u.includes(MIRROR_HOST)).length).toBe(1);
  });

  it("skips an open-breaker engine ENTIRELY — mirrors are not probed (F10)", async () => {
    // Worker-level contract: whenever isOpen reports the engine's breaker
    // open (e.g. opened mid-search by concurrent failures — the pool reset
    // only gives a fresh chance at search start), the engine is skipped
    // completely. Probing mirrors anyway burns their timeouts and every
    // recorded failure re-arms openUntil, so the breaker never closes.
    const openSpy = vi.spyOn(breakerMod, "isOpen").mockImplementation((id) => id === "mirrortest");
    textSpy = vi.spyOn(httpMod, "fetchText").mockImplementation(async (url) => {
      fetchedUrls.push(String(url));
      return { status: 200, body: RESULT_HTML, ms: 5 };
    });
    try {
      await expect(
        searchAllEngines({
          query: "breaker open",
          engineIds: ["mirrortest"],
          snippetFilter: false,
        }),
      ).rejects.toThrow(/All engines failed/);
      expect(fetchedUrls.filter((u) => u.includes(PRIMARY_HOST)).length).toBe(0);
      expect(fetchedUrls.filter((u) => u.includes(MIRROR_HOST)).length).toBe(0);
    } finally {
      openSpy.mockRestore();
    }
  });
});
