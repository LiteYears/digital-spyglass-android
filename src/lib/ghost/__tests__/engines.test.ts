import { describe, it, expect } from "vitest";
import { engineById, ENGINES } from "../engines";
import registry from "../engines.json";

const ONION = "http://abcdefghijklmnopabcdefghijklmnop.onion";

describe("engine registry", () => {
  it("has 13 engines (Torgol removed — requires JS)", () => {
    expect(ENGINES.length).toBe(13);
    expect(ENGINES.find((e) => e.id === "torgol")).toBeUndefined();
  });

  it("every engine has unique id", () => {
    const ids = ENGINES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("engines.json descriptor schema", () => {
  type RawDescriptor = {
    id: unknown;
    name: unknown;
    trust: unknown;
    baseUrl: unknown;
    parser?: { type?: unknown; name?: unknown };
    enabled?: unknown;
    connectTimeoutMs?: unknown;
  };
  // The registry ships as data and is rewritten by the weekly CI probe —
  // validate it as untrusted input instead of trusting the JSON import's type.
  const descriptors = registry.engines as RawDescriptor[];

  it("is a non-empty array", () => {
    expect(Array.isArray(descriptors)).toBe(true);
    expect(descriptors.length).toBeGreaterThan(0);
  });

  it("every descriptor has a non-empty, unique string id", () => {
    const seen = new Set<string>();
    for (const d of descriptors) {
      expect(typeof d.id, JSON.stringify(d)).toBe("string");
      const id = d.id as string;
      expect(id.length).toBeGreaterThan(0);
      expect(seen.has(id), `duplicate id "${id}"`).toBe(false);
      seen.add(id);
    }
  });

  it("every descriptor has a non-empty string name", () => {
    for (const d of descriptors) {
      expect(typeof d.name, `name of ${String(d.id)}`).toBe("string");
      expect((d.name as string).length, `name of ${String(d.id)}`).toBeGreaterThan(0);
    }
  });

  it("trust is a finite number in a sane range (> 0, <= 10)", () => {
    for (const d of descriptors) {
      expect(Number.isFinite(d.trust), `trust of ${String(d.id)}`).toBe(true);
      const trust = d.trust as number;
      expect(trust).toBeGreaterThan(0);
      expect(trust).toBeLessThanOrEqual(10);
    }
  });

  it("baseUrl is a bare v3 onion address", () => {
    for (const d of descriptors) {
      expect(d.baseUrl, `baseUrl of ${String(d.id)}`).toMatch(/^http:\/\/[a-z2-7]{56}\.onion$/);
    }
  });

  it("custom parser names resolve to a strategy in engines.ts", () => {
    for (const d of descriptors) {
      if (d.parser?.type !== "custom") continue;
      if (d.enabled === false) continue; // disabled descriptors are hidden from ENGINES by design
      const engine = engineById(d.id as string);
      expect(engine, `engine "${String(d.id)}" missing from ENGINES`).toBeDefined();
      // An unresolvable name leaves parse() calling undefined — it throws on first use.
      expect(
        () => engine!.parse(""),
        `custom parser "${String(d.parser.name)}" of ${String(d.id)}`,
      ).not.toThrow();
    }
  });

  it("enabled, when present, is a boolean", () => {
    for (const d of descriptors) {
      if (d.enabled === undefined) continue;
      expect(typeof d.enabled, `enabled of ${String(d.id)}`).toBe("boolean");
    }
  });

  it("connectTimeoutMs, when present, is a positive number", () => {
    for (const d of descriptors) {
      if (d.connectTimeoutMs === undefined) continue;
      expect(Number.isFinite(d.connectTimeoutMs), `connectTimeoutMs of ${String(d.id)}`).toBe(true);
      expect(d.connectTimeoutMs as number).toBeGreaterThan(0);
    }
  });
});

describe("ahmia parser", () => {
  const engine = engineById("ahmia")!;

  it("extracts title, url, and snippet from Ahmia HTML", () => {
    const html = `<ol class="searchResults">
      <li class="result">
        <h4><a href="/redirect?search_term=test&redirect_url=${ONION}/market">Dark Market</a></h4>
        <p>Anonymous marketplace with escrow and vendor reviews.</p>
        <cite>abcdefghijklmnopabcdefghijklmnop.onion</cite>
      </li>
    </ol>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Dark Market");
    expect(results[0]!.url).toBe(`${ONION}/market`);
    expect(results[0]!.snippet).toContain("Anonymous marketplace");
  });

  it("handles 'No description provided' placeholder as snippet text", () => {
    const html = `<ol class="searchResults">
      <li class="result">
        <h4><a href="/redirect?search_term=test&redirect_url=${ONION}/site">Some Site</a></h4>
        <p>No description provided</p>
      </li>
    </ol>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toBe("No description provided");
  });

  it("falls back to regex when no result blocks match", () => {
    const html = `<div>nothing here</div><a href="${ONION}/found">link</a>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe(`${ONION}/found`);
  });
});

describe("torch parser", () => {
  const engine = engineById("torch")!;

  it("extracts results from div.result blocks with p snippet", () => {
    const html = `<div class="result">
      <a href="${ONION}/torch-result">Torch Result</a>
      <p>Description of the torch result page.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Torch Result");
    expect(results[0]!.snippet).toContain("Description of the torch");
  });
});

describe("tordex parser", () => {
  const engine = engineById("tordex")!;

  it("extracts results with .description snippet", () => {
    const html = `<div class="result">
      <a href="${ONION}/tordex-page">TorDex Page</a>
      <p class="description">A page indexed by TorDex.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toBe("A page indexed by TorDex.");
  });
});

describe("tor66 parser", () => {
  const engine = engineById("tor66")!;

  it("extracts onion anchors from div.sresults", () => {
    const html = `<div class="sresults">
      <div><a href="${ONION}/tor66-1">Site One</a> - Description of site one here.</div>
      <div><a href="${ONION}/tor66-2">Site Two</a> - Another description.</div>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe("Site One");
    expect(results[0]!.url).toBe(`${ONION}/tor66-1`);
    expect(results[0]!.snippet).toContain("Description of site one");
  });

  it("skips non-onion links", () => {
    const html = `<div class="sresults">
      <div><a href="https://example.com/clearnet">Clearnet</a> not onion</div>
      <div><a href="${ONION}/real">Real Onion</a> yes</div>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe(`${ONION}/real`);
  });

  it("falls back to regex when div.sresults absent", () => {
    const html = `<div>no sresults</div><a href="${ONION}/regex-only">link</a>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe(`${ONION}/regex-only`);
  });
});

describe("onionland parser", () => {
  const engine = engineById("onionland")!;

  it("extracts results with .description snippet", () => {
    const html = `<li class="result">
      <a href="${ONION}/onionland-1">OnionLand Result</a>
      <span class="description">Indexed by OnionLand crawler.</span>
    </li>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toBe("Indexed by OnionLand crawler.");
  });
});

describe("excavator parser", () => {
  const engine = engineById("excavator")!;

  it("extracts from div.mx-auto with h6 a and p.text-truncate", () => {
    const html = `<div class="mx-auto">
      <h6><a href="${ONION}/excavator-1">Excavator Result</a></h6>
      <p class="text-truncate">Short description truncated for display.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Excavator Result");
    expect(results[0]!.snippet).toContain("Short description");
  });
});

describe("amnesia parser", () => {
  const engine = engineById("amnesia")!;

  it("extracts from div.results with h2 a and p.site_desc", () => {
    const html = `<div class="results">
      <h2><a href="${ONION}/amnesia-1">Amnesia Site</a></h2>
      <p class="site_desc">A site found via Amnesia search.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Amnesia Site");
    expect(results[0]!.snippet).toBe("A site found via Amnesia search.");
  });
});

describe("deepsearches parser", () => {
  const engine = engineById("deepsearches")!;

  it("extracts organic results from div.doc with a.title and p.desc", () => {
    const html = `<div class="doc">
      <a class="title" href="${ONION}/deep-1">Deep Result</a>
      <p class="desc">Description from deep searches.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Deep Result");
    expect(results[0]!.snippet).toBe("Description from deep searches.");
  });

  it("skips ad results (span.label-ad)", () => {
    const html = `<div class="doc">
      <span class="label-ad">AD</span>
      <a class="title" href="${ONION}/ad-page">Sponsored</a>
      <p class="desc">Buy this thing.</p>
    </div>
    <div class="doc">
      <a class="title" href="${ONION}/organic">Organic</a>
      <p class="desc">Real result.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Organic");
  });
});

describe("torland parser", () => {
  const engine = engineById("torland")!;

  it("extracts from div.rezultat with h3 a and cite", () => {
    const html = `<div class="rezultat">
      <h3><a href="${ONION}/torland-1">Torland Result</a></h3>
      <cite>abcdefghijklmnopabcdefghijklmnop.onion</cite>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Torland Result");
    expect(results[0]!.snippet).toContain("abcdefghijklmnop");
  });
});

describe("onionway parser", () => {
  const engine = engineById("onionway")!;

  it("extracts from article.s_result with h2.title and p.desc", () => {
    const html = `<article class="s_result">
      <h2 class="title">OnionWay Result</h2>
      <a href="${ONION}/onionway-1">link</a>
      <p class="desc">Description from OnionWay.</p>
    </article>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("OnionWay Result");
    expect(results[0]!.snippet).toBe("Description from OnionWay.");
  });
});

describe("oss parser", () => {
  const engine = engineById("oss")!;

  it("extracts onion anchors from td[valign] with sibling text as snippet", () => {
    const html = `<table><tr><td valign="top">
      <a href="${ONION}/oss-1">First Site</a> Description text after the link.
      <a href="${ONION}/oss-2">Second Site</a> Another description.
    </td></tr></table>`;
    const results = engine.parse(html);
    expect(results.length).toBe(2);
    expect(results[0]!.title).toBe("First Site");
    expect(results[0]!.url).toBe(`${ONION}/oss-1`);
    expect(results[0]!.snippet).toContain("Description text after");
  });
});

describe("notevil parser", () => {
  const engine = engineById("notevil")!;

  it("extracts from div.result-item with span.result-url, a.result-title, p.result-desc", () => {
    const html = `<div class="result-item">
      <span class="result-url">${ONION}/notevil-1</span>
      <a class="result-title" href="${ONION}/notevil-1">NotEvil Result</a>
      <p class="result-desc">Description from Not Evil.</p>
    </div>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("NotEvil Result");
    expect(results[0]!.url).toBe(`${ONION}/notevil-1`);
    expect(results[0]!.snippet).toBe("Description from Not Evil.");
  });

  it("falls back to regex when div.result-item absent", () => {
    const html = `<div>no result items</div><a href="${ONION}/fallback">link</a>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe(`${ONION}/fallback`);
  });
});

describe("torgle parser", () => {
  const engine = engineById("torgle")!;

  it("extracts from tr with onion anchor, td[valign], b title", () => {
    const html = `<table>
      <tr><td valign="top">
        <b>Torgle Result</b>
        <a href="${ONION}/torgle-1">link</a>
        Description text for the torgle result here.
      </td></tr>
    </table>`;
    const results = engine.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Torgle Result");
    expect(results[0]!.url).toBe(`${ONION}/torgle-1`);
    expect(results[0]!.snippet).toContain("Description text");
  });
});

describe("same-host filtering across engines", () => {
  it("ahmia rejects same-host links (engine self-references)", () => {
    const ahmia = engineById("ahmia")!;
    const selfHost = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion";
    const html = `<ol class="searchResults">
      <li class="result">
        <h4><a href="${selfHost}/about">About Ahmia</a></h4>
        <p>About page.</p>
      </li>
      <li class="result">
        <h4><a href="/redirect?redirect_url=${ONION}/real">Real Result</a></h4>
        <p>Real result description.</p>
      </li>
    </ol>`;
    const results = ahmia.parse(html);
    expect(results.length).toBe(1);
    expect(results[0]!.url).toBe(`${ONION}/real`);
  });
});
