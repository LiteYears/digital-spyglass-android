/**
 * Entity correlation graph + force-directed canvas layout.
 *
 * Pure local math over RAM-only search results: builds an entity co-occurrence
 * graph from the existing extraction/correlation data and lays it out with a
 * simplified Fruchterman-Reingold force model (repulsion k²/d, attraction d²/k,
 * temperature cooling). Deterministic for a given seed — same session data +
 * seed always draws the same picture. No persistence, no network, no deps.
 */

import { caseEntityKey } from "./case-file";
import type { EntityType } from "./types";

export type GraphSourceRow = {
  url: string;
  entities: Array<{ type: string; value: string; detail?: string | undefined }>;
};

export type GraphNode = {
  /** `caseEntityKey` — stable node identity honoring the F9 fold rules. */
  id: string;
  type: string;
  value: string;
  /** Number of results containing this entity (node size signal). */
  freq: number;
  urls: string[];
  detail?: string | undefined;
};

export type GraphEdge = {
  a: string;
  b: string;
  /** Co-occurrence count: results containing both entities. */
  weight: number;
};

export type EntityGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export const MAX_GRAPH_NODES = 150;
export const MAX_GRAPH_EDGES = 400;

/**
 * Project result rows into an entity co-occurrence graph. Nodes are entities
 * (size ∝ freq), edges connect entities seen in the same result. Deterministic
 * ordering: nodes by freq desc then id, edges by weight desc then (a, b).
 * Bounded: top MAX_GRAPH_NODES nodes, top MAX_GRAPH_EDGES edges.
 */
export function buildEntityGraph(rows: GraphSourceRow[]): EntityGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  for (const row of rows) {
    const seenInRow = new Set<string>();
    for (const entity of row.entities) {
      const id = caseEntityKey(entity);
      let node = nodes.get(id);
      if (!node) {
        node = {
          id,
          type: entity.type,
          value: entity.value,
          freq: 0,
          urls: [],
          detail: entity.detail,
        };
        nodes.set(id, node);
      }
      if (!seenInRow.has(id)) {
        seenInRow.add(id);
        node.freq += 1;
        if (!node.urls.includes(row.url) && node.urls.length < 50) node.urls.push(row.url);
      }
    }
    const ids = Array.from(seenInRow).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        const key = `${a}|${b}`;
        const edge = edges.get(key) ?? { a, b, weight: 0 };
        edge.weight += 1;
        edges.set(key, edge);
      }
    }
  }

  const keptNodes = Array.from(nodes.values())
    .sort((x, y) => y.freq - x.freq || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, MAX_GRAPH_NODES);
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = Array.from(edges.values())
    .filter((e) => keptIds.has(e.a) && keptIds.has(e.b))
    .sort((x, y) => y.weight - x.weight || (x.a + x.b < y.a + y.b ? -1 : 1))
    .slice(0, MAX_GRAPH_EDGES);

  return { nodes: keptNodes, edges: keptEdges };
}

/** Deterministic PRNG (mulberry32) — seeded layouts for reproducible tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type LayoutOptions = {
  width: number;
  height: number;
  iterations?: number;
  seed?: number;
};

export type NodeLayout = GraphNode & { x: number; y: number; r: number };

export type LaidOutEdge = { a: NodeLayout; b: NodeLayout; weight: number };

export type ForceLayout = {
  nodes: NodeLayout[];
  edges: LaidOutEdge[];
  /** Total displacement of the final iteration — lower = more settled. */
  finalDisplacement: number;
};

/** Visual radius ∝ sqrt(freq) so area (not diameter) tracks occurrence count. */
export function nodeRadius(freq: number): number {
  return Math.min(18, 4 + Math.sqrt(freq) * 2.2);
}

/**
 * Force-directed layout (simplified Fruchterman-Reingold):
 * repulsion k²/d between every pair, attraction d²/k along edges (weighted,
 * capped so heavy edges do not collapse clusters), center gravity growing
 * with distance² so repulsion dominates near the core but the rim pulls
 * back (prevents nodes pinning to the canvas boundary), temperature-cooled
 * displacement, final clamp.
 */
export function computeForceLayout(graph: EntityGraph, options: LayoutOptions): ForceLayout {
  const { width, height } = options;
  const iterations = options.iterations ?? 60;
  const rand = mulberry32(options.seed ?? 1);
  const n = graph.nodes.length;
  if (n === 0) return { nodes: [], edges: [], finalDisplacement: 0 };

  const k = Math.sqrt((width * height) / Math.max(1, n));
  const pad = 20;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pad + rand() * Math.max(1, width - 2 * pad);
    ys[i] = pad + rand() * Math.max(1, height - 2 * pad);
  }

  const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const adjacency: Array<Array<{ j: number; w: number }>> = Array.from({ length: n }, () => []);
  for (const edge of graph.edges) {
    const ia = index.get(edge.a);
    const ib = index.get(edge.b);
    if (ia === undefined || ib === undefined) continue;
    adjacency[ia]!.push({ j: ib, w: Math.min(3, edge.weight) });
    adjacency[ib]!.push({ j: ia, w: Math.min(3, edge.weight) });
  }

  const t0 = Math.max(8, width * 0.1);
  let finalDisplacement = 0;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  for (let iter = 0; iter < iterations; iter++) {
    fx.fill(0);
    fy.fill(0);

    // Pairwise repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i]! - xs[j]!;
        let dy = ys[i]! - ys[j]!;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          dx = 0.5 + rand();
          dy = 0.5 + rand();
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const force = (k * k) / d;
        const ux = dx / d;
        const uy = dy / d;
        fx[i]! += ux * force;
        fy[i]! += uy * force;
        fx[j]! -= ux * force;
        fy[j]! -= uy * force;
      }
    }

    // Edge attraction (weighted) + mild center gravity
    const cx = width / 2;
    const cy = height / 2;
    for (let i = 0; i < n; i++) {
      for (const { j, w } of adjacency[i]!) {
        const dx = xs[j]! - xs[i]!;
        const dy = ys[j]! - ys[i]!;
        const d = Math.max(1e-3, Math.hypot(dx, dy));
        const force = ((d * d) / k) * (0.3 + 0.25 * w);
        const ux = (dx / d) * force;
        const uy = (dy / d) * force;
        fx[i]! += ux;
        fy[i]! += uy;
        fx[j]! -= ux;
        fy[j]! -= uy;
      }
      const ddx = cx - xs[i]!;
      const ddy = cy - ys[i]!;
      const centerDist = Math.hypot(ddx, ddy);
      fx[i]! += (ddx * centerDist * 2) / k;
      fy[i]! += (ddy * centerDist * 2) / k;
    }

    // Temperature-cooled apply
    const temperature = t0 * (1 - iter / iterations);
    let totalDisp = 0;
    for (let i = 0; i < n; i++) {
      const disp = Math.min(temperature, Math.hypot(fx[i]!, fy[i]!));
      const norm = Math.max(1e-6, Math.hypot(fx[i]!, fy[i]!));
      const stepX = (fx[i]! / norm) * disp;
      const stepY = (fy[i]! / norm) * disp;
      xs[i]! += stepX;
      ys[i]! += stepY;
      totalDisp += disp;
    }
    finalDisplacement = totalDisp;

    for (let i = 0; i < n; i++) {
      const r = nodeRadius(graph.nodes[i]!.freq);
      xs[i] = Math.min(width - r, Math.max(r, xs[i]!));
      ys[i] = Math.min(height - r, Math.max(r, ys[i]!));
    }
  }

  const laidOut: NodeLayout[] = graph.nodes.map((node, i) => ({
    ...node,
    x: xs[i]!,
    y: ys[i]!,
    r: nodeRadius(node.freq),
  }));
  const byId = new Map(laidOut.map((node) => [node.id, node]));
  const laidEdges: LaidOutEdge[] = [];
  for (const edge of graph.edges) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (a && b) laidEdges.push({ a, b, weight: edge.weight });
  }

  return { nodes: laidOut, edges: laidEdges, finalDisplacement };
}

/** Nearest node within (radius + padding) of a canvas point — tap hit-test. */
export function hitTest(
  layout: ForceLayout,
  x: number,
  y: number,
  padding = 14,
): NodeLayout | undefined {
  let best: NodeLayout | undefined;
  let bestDist = Infinity;
  for (const node of layout.nodes) {
    const dist = Math.hypot(node.x - x, node.y - y);
    if (dist < node.r + padding && dist < bestDist) {
      best = node;
      bestDist = dist;
    }
  }
  return best;
}

/** Distinct entity types present, sorted by total node count desc — filter chips. */
export function typeCounts(graph: EntityGraph): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
}

export function entityTypeColor(type: string): string {
  // Token-layer-independent palette for canvas (CSS vars are unavailable in
  // 2D context) — amber family for OSINT signals, muted for infrastructure.
  switch (type as EntityType) {
    case "btc":
    case "xmr":
      return "#f0b429"; // amber — value
    case "pgp":
      return "#7fd1a8"; // green — identity
    case "email":
      return "#9db4d0"; // steel — contact
    case "onion":
      return "#c58af9"; // violet — infrastructure
    case "cve":
      return "#e57373"; // red — vulnerability
    case "ipv4":
      return "#8d99ae"; // grey — network
    default:
      return "#b0b8c4";
  }
}
