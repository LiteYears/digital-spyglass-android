import { extractEntities } from "./entities";
import { isOnion } from "./parse";
import { safeSnippet } from "./snippets";
import { type FilterState, type RawResult, type ResultRow } from "./types";

export function normaliseKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

export function aggregate(
  raw: (RawResult & { trust: number })[],
  filterOn: boolean,
): ResultRow[] {
  const byKey = new Map<string, ResultRow>();

  for (const item of raw) {
    if (!item.url) continue;
    const key = normaliseKey(item.url);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.engines.includes(item.engineId)) existing.engines.push(item.engineId);
      existing.score += item.trust + 1;
      if (existing.title.startsWith("http") && !item.title.startsWith("http")) {
        existing.title = item.title;
      }
      if (existing.snippet.length === 0 && item.snippet.length > 0) {
        const safe = safeSnippet(item.snippet, filterOn);
        existing.snippet = safe.snippet;
        existing.withheld = safe.withheld;
      }
      continue;
    }
    const safe = safeSnippet(item.snippet, filterOn);
    const entities = safe.withheld ? [] : extractEntities(safe.snippet);
    byKey.set(key, {
      key,
      url: item.url,
      title: item.title || item.url,
      snippet: safe.snippet,
      withheld: safe.withheld,
      onion: isOnion(item.url),
      engines: [item.engineId],
      score: item.trust + 1,
      entities: entities.length > 0 ? entities : undefined,
    });
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const aInfo = !a.withheld && a.snippet.length > 15;
    const bInfo = !b.withheld && b.snippet.length > 15;
    if (aInfo !== bInfo) return aInfo ? -1 : 1;
    return b.engines.length - a.engines.length || b.score - a.score;
  });
}

export function flagScams(rows: ResultRow[]): ResultRow[] {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();

  const titleMap = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const titleKey = normalize(row.title);

    const titleLower = row.title.toLowerCase();
    if (
      /\b(official\s+mirror|mirror\s+site|clone\s+of|copy\s+of|scam\s+check)\b/i.test(titleLower)
    ) {
      row.scamFlag = "scam pattern in title";
      continue;
    }

    if (titleKey.length > 10) {
      const prevIdx = titleMap.get(titleKey);
      if (prevIdx !== undefined) {
        const prev = rows[prevIdx]!;
        try {
          const hostA = new URL(row.url).hostname.toLowerCase();
          const hostB = new URL(prev.url).hostname.toLowerCase();
          if (hostA !== hostB) {
            row.scamFlag = `mirror of ${hostB}`;
          }
        } catch {
          // URL parse failure — skip mirror check
        }
      } else {
        titleMap.set(titleKey, i);
      }
    }
  }

  return rows;
}

export function filterAndSort(rows: ResultRow[], filter: FilterState): ResultRow[] {
  let filtered = rows;
  if (filter.onionOnly) {
    filtered = filtered.filter((r) => r.onion);
  }
  if (filter.minEngines > 1) {
    filtered = filtered.filter((r) => r.engines.length >= filter.minEngines);
  }
  if (filter.sort === "engines") {
    filtered = [...filtered].sort(
      (a, b) => b.engines.length - a.engines.length || b.score - a.score,
    );
  }
  return filtered;
}

export function dedupeByContent(rows: ResultRow[]): ResultRow[] {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.withheld) continue;
    const normI = normalize(rows[i]!.snippet);
    if (normI.length < 20) continue;

    for (let j = 0; j < i; j++) {
      if (rows[j]!.withheld) continue;
      const normJ = normalize(rows[j]!.snippet);
      if (normJ.length < 20) continue;

      const similarity = textSimilarity(normI, normJ);
      if (similarity > 0.8) {
        rows[i]!.score = Math.floor(rows[i]!.score / 2);
        break;
      }
    }
  }
  return rows;
}

export function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));
  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  const total = wordsA.size + wordsB.size - shared;
  return total === 0 ? 0 : shared / total;
}
