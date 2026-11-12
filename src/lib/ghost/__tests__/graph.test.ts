import { describe, expect, it } from "vitest";
import {
  buildEntityGraph,
  computeForceLayout,
  hitTest,
  nodeRadius,
  typeCounts,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
} from "../graph";

const URL_A = "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/a";
const URL_B = "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion/b";
const URL_C = "http://cccccccccccccccccccccccccccccccccccccccccccccccccccccccc.onion/c";

const BTC = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

describe("buildEntityGraph", () => {
  it("counts freq per result (not per mention) and collects urls", () => {
    const graph = buildEntityGraph([
      {
        url: URL_A,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "op@a.onion" },
        ],
      },
      {
        url: URL_B,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "op@a.onion" },
        ],
      },
      {
        url: URL_C,
        entities: [{ type: "btc", value: BTC }],
      },
    ]);
    const btc = graph.nodes.find((n) => n.id === `btc:${BTC}`)!;
    expect(btc.freq).toBe(3);
    expect(btc.urls).toEqual([URL_A, URL_B, URL_C]);
    const email = graph.nodes.find((n) => n.id === "email:op@a.onion")!;
    expect(email.freq).toBe(2);
  });

  it("keeps case-distinct base58 wallets as separate nodes (C2)", () => {
    const graph = buildEntityGraph([
      {
        url: URL_A,
        entities: [
          { type: "btc", value: "1AbCdEfGh" },
          { type: "btc", value: "1abcdefgh" },
          { type: "btc", value: "BC1QXYRES" },
          { type: "btc", value: "bc1qxyres" },
        ],
      },
    ]);
    const btcNodes = graph.nodes.filter((node) => node.type === "btc");
    // base58 is case-sensitive → two nodes; bech32 folds (BIP-173) → one
    expect(btcNodes).toHaveLength(3);
    expect(graph.nodes.map((node) => node.id)).toContain("btc:1AbCdEfGh");
    expect(graph.nodes.map((node) => node.id)).toContain("btc:1abcdefgh");
  });

  it("creates co-occurrence edges weighted by shared results", () => {
    const graph = buildEntityGraph([
      {
        url: URL_A,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "x@y.onion" },
        ],
      },
      {
        url: URL_B,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "x@y.onion" },
        ],
      },
      { url: URL_C, entities: [{ type: "btc", value: BTC }] },
    ]);
    const edge = graph.edges.find((e) => e.a === `btc:${BTC}` && e.b === "email:x@y.onion");
    expect(edge?.weight).toBe(2);
    expect(graph.edges.every((e) => e.a < e.b)).toBe(true);
  });

  it("is deterministic — node and edge ordering is stable", () => {
    const rows = [
      {
        url: URL_A,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "x@y.onion" },
        ],
      },
      {
        url: URL_B,
        entities: [
          { type: "pgp", value: "KEY2" },
          { type: "email", value: "x@y.onion" },
        ],
      },
    ];
    expect(buildEntityGraph(rows)).toEqual(buildEntityGraph(rows));
  });

  it("caps nodes and edges at the documented limits", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      url: `${URL_A}/${i}`,
      entities: Array.from({ length: 8 }, (__, j) => ({
        type: "email",
        value: `user${i}_${j}@x.onion`,
      })),
    }));
    const graph = buildEntityGraph(rows);
    expect(graph.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(graph.edges.length).toBeLessThanOrEqual(MAX_GRAPH_EDGES);
  });

  it("dedupes a repeated entity inside one result (freq counts results)", () => {
    const graph = buildEntityGraph([
      {
        url: URL_A,
        entities: [
          { type: "btc", value: BTC },
          { type: "btc", value: BTC.toUpperCase() },
        ],
      },
    ]);
    const btc = graph.nodes.find((n) => n.id === `btc:${BTC}`)!;
    expect(btc.freq).toBe(1);
    expect(graph.nodes.filter((n) => n.type === "btc").length).toBe(1);
  });
});

describe("computeForceLayout", () => {
  const graph = buildEntityGraph([
    {
      url: URL_A,
      entities: [
        { type: "btc", value: BTC },
        { type: "email", value: "x@y.onion" },
      ],
    },
    {
      url: URL_B,
      entities: [
        { type: "btc", value: BTC },
        { type: "email", value: "x@y.onion" },
      ],
    },
    { url: URL_C, entities: [{ type: "pgp", value: "KEYAB" }] },
  ]);

  it("is deterministic for a given seed", () => {
    const a = computeForceLayout(graph, { width: 400, height: 400, seed: 7 });
    const b = computeForceLayout(graph, { width: 400, height: 400, seed: 7 });
    expect(a.nodes.map((n) => [n.id, n.x, n.y])).toEqual(b.nodes.map((n) => [n.id, n.x, n.y]));
  });

  it("different seeds produce a different picture", () => {
    const a = computeForceLayout(graph, { width: 400, height: 400, seed: 7 });
    const b = computeForceLayout(graph, { width: 400, height: 400, seed: 8 });
    const pa = a.nodes.map((n) => `${n.x},${n.y}`).join(";");
    const pb = b.nodes.map((n) => `${n.x},${n.y}`).join(";");
    expect(pa).not.toBe(pb);
  });

  it("keeps every node inside the canvas bounds", () => {
    const layout = computeForceLayout(graph, { width: 400, height: 400, seed: 1 });
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(node.r);
      expect(node.x).toBeLessThanOrEqual(400 - node.r);
      expect(node.y).toBeGreaterThanOrEqual(node.r);
      expect(node.y).toBeLessThanOrEqual(400 - node.r);
    }
  });

  it("does not pin sparse graphs to the canvas boundary", () => {
    // Regression: near-weightless center gravity let repulsion drive
    // disconnected nodes onto the clamped border ring (all nodes on walls).
    const sparse = buildEntityGraph(
      Array.from({ length: 32 }, (_, i) => ({
        url: `${URL_A}/${i}`,
        entities: [{ type: "onion", value: `${"a".repeat(40)}${i}v3onionaddressxx.onion` }],
      })),
    );
    const width = 360;
    const height = 378;
    const layout = computeForceLayout(sparse, { width, height, seed: 7 });
    const pinned = layout.nodes.filter(
      (n) =>
        n.x <= n.r + 0.5 ||
        n.x >= width - n.r - 0.5 ||
        n.y <= n.r + 0.5 ||
        n.y >= height - n.r - 0.5,
    );
    expect(pinned).toEqual([]);
  });

  it("settles: final displacement far below the cooled first step", () => {
    const hot = computeForceLayout(graph, { width: 400, height: 400, seed: 3, iterations: 1 });
    const settled = computeForceLayout(graph, { width: 400, height: 400, seed: 3, iterations: 80 });
    expect(settled.finalDisplacement).toBeLessThan(hot.finalDisplacement);
  });

  it("connected nodes end up closer than unconnected ones on average", () => {
    const layout = computeForceLayout(graph, { width: 400, height: 400, seed: 5, iterations: 120 });
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    const connectedDist = Math.hypot(
      byId.get(`btc:${BTC}`)!.x - byId.get("email:x@y.onion")!.x,
      byId.get(`btc:${BTC}`)!.y - byId.get("email:x@y.onion")!.y,
    );
    const pgpDist = Math.hypot(
      byId.get(`btc:${BTC}`)!.x - byId.get("pgp:keyab")!.x,
      byId.get(`btc:${BTC}`)!.y - byId.get("pgp:keyab")!.y,
    );
    expect(connectedDist).toBeLessThan(pgpDist);
  });

  it("handles the empty graph", () => {
    expect(computeForceLayout({ nodes: [], edges: [] }, { width: 300, height: 300 })).toEqual({
      nodes: [],
      edges: [],
      finalDisplacement: 0,
    });
  });
});

describe("nodeRadius / hitTest / typeCounts", () => {
  it("radius grows monotonically with freq and is capped", () => {
    expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(10000)).toBeLessThanOrEqual(18);
  });

  it("hitTest finds the nearest node within radius + padding", () => {
    const graph = buildEntityGraph([
      {
        url: URL_A,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "x@y.onion" },
        ],
      },
      {
        url: URL_B,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "x@y.onion" },
        ],
      },
    ]);
    const layout = computeForceLayout(graph, { width: 400, height: 400, seed: 9 });
    const node = layout.nodes[0]!;
    expect(hitTest(layout, node.x, node.y)?.id).toBe(node.id);
    expect(hitTest(layout, node.x, node.y + node.r + 5)?.id).toBe(node.id);
    expect(hitTest(layout, node.x + node.r + 200, node.y + node.r + 200)).toBeUndefined();
  });

  it("typeCounts aggregates node types sorted by count", () => {
    const graph = buildEntityGraph([
      {
        url: URL_A,
        entities: [
          { type: "btc", value: BTC },
          { type: "email", value: "x@y.onion" },
        ],
      },
      {
        url: URL_B,
        entities: [
          { type: "btc", value: BTC.toUpperCase() },
          { type: "pgp", value: "K1" },
        ],
      },
    ]);
    // BTC appears twice as value (different ids: case-insensitive same id!) —
    // btc:BTC and btc:BTC-upper collapse to one lowercase id, so btc=1 node.
    const counts = typeCounts(graph);
    expect(counts.map((c) => c.type).sort()).toEqual(["btc", "email", "pgp"]);
    expect(counts.reduce((sum, c) => sum + c.count, 0)).toBe(3);
  });
});
