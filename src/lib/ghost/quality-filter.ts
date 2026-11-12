/**
 * SOTA-based Opt-in Result Quality Filter for Ghost Search.
 *
 * DEFAULT: OFF when called standalone; enabled in PRODUCTION_V1 as a
 * non-destructive RRF score modifier. Never removes results — demotes or flags.
 */

function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function simHash(text: string): [number, number] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [0, 0];

  const weights = new Map<string, number>();
  for (const token of tokens) {
    weights.set(token, (weights.get(token) ?? 0) + 1);
  }

  const v = new Int32Array(64);

  for (const [token, weight] of weights) {
    const h1 = fnv1aHash(token);
    const h2 = fnv1aHash(token + "#salt");

    for (let i = 0; i < 32; i++) {
      if (h1 & (1 << i)) v[i]! += weight;
      else v[i]! -= weight;
    }
    for (let i = 0; i < 32; i++) {
      if (h2 & (1 << i)) v[32 + i]! += weight;
      else v[32 + i]! -= weight;
    }
  }

  let high = 0;
  let low = 0;
  for (let i = 0; i < 32; i++) {
    if (v[i]! > 0) high |= 1 << i;
    if (v[32 + i]! > 0) low |= 1 << i;
  }

  return [high >>> 0, low >>> 0];
}

function popcount32(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return Math.imul(n, 0x01010101) >>> 24;
}

export function hammingDistance(a: [number, number], b: [number, number]): number {
  return popcount32(a[0] ^ b[0]) + popcount32(a[1] ^ b[1]);
}

export type QualityFilterParams = {
  enabled: boolean;
  maxPerDomain: number;
  simHashThreshold: number;
  semanticDedupThreshold?: number;
};

export const DEFAULT_QUALITY_PARAMS: QualityFilterParams = {
  enabled: false,
  maxPerDomain: 3,
  simHashThreshold: 3,
  semanticDedupThreshold: 0.85,
};

export type FilterableResult = {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  entities?: Array<{ type: string; value: string }> | undefined;
  withheld?: boolean | undefined;
  score?: number | undefined;
};

export type ScoredResult = FilterableResult & {
  qualityScore: number;
  qualityFlags: string[];
};

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function semanticDedupDemote(
  results: ScoredResult[],
  embeddings: Array<number[] | null>,
  threshold: number,
): ScoredResult[] {
  for (let i = 1; i < results.length; i++) {
    const embI = embeddings[i];
    if (!embI) continue;

    for (let j = 0; j < i; j++) {
      const embJ = embeddings[j];
      if (!embJ) continue;

      const sim = cosineSimilarity(embI, embJ);
      if (sim > threshold) {
        results[i]!.qualityScore *= 0.3;
        results[i]!.qualityFlags.push(`semantic_duplicate (sim=${sim.toFixed(2)}, of #${j + 1})`);
        break;
      }
    }
  }
  return results;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.split("/")[2]?.toLowerCase() ?? url;
  }
}

function getUrlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function getUrlPathPattern(url: string): string {
  try {
    const u = new URL(url);
    let path = u.pathname.toLowerCase().replace(/\/+$/, "");
    path = path.replace(/\d+/g, "N");
    path = path.replace(/\/[a-f0-9]{16,56}\.onion\//, "/HOST/");
    return path;
  } catch {
    return "";
  }
}

function domainDemote(results: ScoredResult[], maxPerDomain: number): ScoredResult[] {
  const domainCount = new Map<string, number>();
  for (const r of results) {
    const domain = getDomain(r.url);
    const count = domainCount.get(domain) ?? 0;
    if (count >= maxPerDomain) {
      const penalty = 1 / (1 + count - maxPerDomain);
      r.qualityScore *= penalty;
      r.qualityFlags.push(`domain_${count + 1}_of_${maxPerDomain}`);
    }
    domainCount.set(domain, count + 1);
  }
  return results;
}

function nearDuplicateDemote(results: ScoredResult[], threshold: number): ScoredResult[] {
  const fingerprints: Array<[number, number] | null> = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;

    const text = `${r.title} ${r.snippet}`;
    if (text.trim().length < 10) {
      if (r.title.startsWith("http")) {
        const urlFp = simHash(getUrlPath(r.url));
        let isDup = false;
        for (let j = 0; j < fingerprints.length; j++) {
          const prev = fingerprints[j];
          if (!prev) continue;
          if (hammingDistance(urlFp, prev) <= threshold) {
            isDup = true;
            break;
          }
        }
        if (isDup) {
          r.qualityScore *= 0.3;
          r.qualityFlags.push(`url_near_duplicate (dist≤${threshold})`);
        }
        fingerprints.push(isDup ? null : urlFp);
      } else {
        fingerprints.push(null);
      }
      continue;
    }

    const fp = simHash(text);
    let isDuplicate = false;
    let duplicateOf = -1;

    for (let j = 0; j < fingerprints.length; j++) {
      const prev = fingerprints[j];
      if (!prev) continue;
      const dist = hammingDistance(fp, prev);
      if (dist <= threshold) {
        isDuplicate = true;
        duplicateOf = j;
        break;
      }
    }

    if (isDuplicate) {
      r.qualityScore *= 0.3;
      r.qualityFlags.push(`near_duplicate (dist≤${threshold}, of #${duplicateOf + 1})`);
      fingerprints.push(fp);
    } else {
      fingerprints.push(fp);
    }
  }

  return results;
}

function informationQualityScore(r: FilterableResult): number {
  let score = 0;

  const snippetLen = r.snippet.trim().length;
  if (snippetLen > 100) score += 3;
  else if (snippetLen > 50) score += 2;
  else if (snippetLen > 15) score += 1;
  else if (snippetLen === 0) score -= 2;

  const titleLen = r.title.trim().length;
  if (titleLen > 10 && !r.title.startsWith("http")) score += 2;
  else if (titleLen > 5 && !r.title.startsWith("http")) score += 1;
  else if (r.title.startsWith("http")) score -= 1;

  const entityCount = r.entities?.length ?? 0;
  if (entityCount > 0) score += Math.min(entityCount, 3);

  return score;
}

const SCAM_TITLE_PATTERNS =
  /\b(official\s+mirror|mirror\s+site|clone\s+of|copy\s+of|scam\s+check|verified\s+link|real\s+link|not\s+a\s+scam)\b/i;

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function spamMirrorDetect(results: ScoredResult[]): ScoredResult[] {
  const titleMap = new Map<string, number>();

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;

    if (SCAM_TITLE_PATTERNS.test(r.title)) {
      r.qualityScore *= 0.2;
      r.qualityFlags.push("scam_pattern_in_title");
    }

    const titleKey = normalizeTitle(r.title);
    if (titleKey.length > 10) {
      const prevIdx = titleMap.get(titleKey);
      if (prevIdx !== undefined) {
        const prev = results[prevIdx]!;
        const domainA = getDomain(r.url);
        const domainB = getDomain(prev.url);
        if (domainA !== domainB) {
          r.qualityScore *= 0.3;
          r.qualityFlags.push(`mirror_of_${domainB}`);
        }
      } else {
        titleMap.set(titleKey, i);
      }
    }
  }

  return results;
}

function urlPathMirrorDemote(results: ScoredResult[], maxPerPath: number): ScoredResult[] {
  const pathCount = new Map<string, number>();
  const pathDomains = new Map<string, Set<string>>();

  for (const r of results) {
    const pathPattern = getUrlPathPattern(r.url);
    if (!pathPattern || pathPattern === "/") continue;

    const domains = pathDomains.get(pathPattern) ?? new Set<string>();
    domains.add(getDomain(r.url));
    pathDomains.set(pathPattern, domains);
  }

  for (const r of results) {
    const pathPattern = getUrlPathPattern(r.url);
    if (!pathPattern || pathPattern === "/") continue;

    const domains = pathDomains.get(pathPattern);
    if (!domains || domains.size < 2) continue;

    const count = pathCount.get(pathPattern) ?? 0;
    if (count >= maxPerPath) {
      const penalty = 1 / (1 + count - maxPerPath);
      r.qualityScore *= penalty;
      r.qualityFlags.push(`url_path_mirror_${count + 1} (${domains.size} domains)`);
    }
    pathCount.set(pathPattern, count + 1);
  }

  return results;
}

const COMMERCIAL_PATTERNS =
  /\b(buy|buying|purchase|order\s+now|for\s+sale|price|cheap|discount|best\s+price|free\s+shipping|delivery|store|shop\s+now|get\s+now|download\s+now)\b/i;

const COMMERCIAL_TITLE_PATTERNS =
  /\b(buy\s+\w+|\w+\s+for\s+sale|order\s+\w+|cheap\s+\w+|premium\s+\w+)\b/i;

function commercialIntentPenalty(results: ScoredResult[]): ScoredResult[] {
  for (const r of results) {
    const titleLower = r.title.toLowerCase();
    const isCommercialTitle = COMMERCIAL_TITLE_PATTERNS.test(r.title);
    const isCommercialSnippet = COMMERCIAL_PATTERNS.test(r.snippet);
    const isCommercialTitleKW = /\b(buy|shop|store|market|vendor|seller|price)\b/i.test(titleLower);

    if (isCommercialTitle && isCommercialSnippet) {
      r.qualityScore *= 0.2;
      r.qualityFlags.push("commercial_intent_strong");
    } else if (isCommercialTitle || isCommercialTitleKW) {
      r.qualityScore *= 0.4;
      r.qualityFlags.push("commercial_intent_title");
    } else if (isCommercialSnippet) {
      r.qualityScore *= 0.6;
      r.qualityFlags.push("commercial_intent_snippet");
    }
  }
  return results;
}

const DIRECTORY_HOST_PATTERNS =
  /\b(safe\s*onion\s*links|onionlinks|onionfind|onion\w*dir|dark\s*dir|tor\s*dir|hidden\s*wiki|deep\s*web\s*links|onion\s*list)\b/i;

const DIRECTORY_TITLE_PATTERNS =
  /\b(directory|listing|index\s+of|links\s+page|resource\s+list|collection\s+of)\b/i;

function directoryDemotion(results: ScoredResult[]): ScoredResult[] {
  for (const r of results) {
    const titleLower = r.title.toLowerCase();
    const urlLower = r.url.toLowerCase();
    const isDirectoryHost =
      DIRECTORY_HOST_PATTERNS.test(r.title) || DIRECTORY_HOST_PATTERNS.test(urlLower);
    const isDirectoryTitle = DIRECTORY_TITLE_PATTERNS.test(titleLower);

    if (isDirectoryHost) {
      r.qualityScore *= 0.4;
      r.qualityFlags.push("directory_host");
    } else if (isDirectoryTitle) {
      r.qualityScore *= 0.6;
      r.qualityFlags.push("directory_title");
    }
  }
  return results;
}

function queryRelevanceScore(query: string, r: FilterableResult): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 0;

  const titleLower = r.title.toLowerCase();
  const snippetLower = r.snippet.toLowerCase();
  const urlLower = r.url.toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    if (titleLower.includes(term)) score += 2;
    if (snippetLower.includes(term)) score += 1;
    if (urlLower.includes(term)) score += 1;
  }

  return score;
}

export function applyQualityFilter(
  results: FilterableResult[],
  query: string,
  params: QualityFilterParams,
  embeddings?: Array<number[] | null>,
): ScoredResult[] {
  if (!params.enabled) {
    return results.map((r) => ({
      ...r,
      qualityScore: 0,
      qualityFlags: [],
    }));
  }

  let scored: ScoredResult[] = results.map((r) => {
    const iqScore = informationQualityScore(r);
    const relScore = queryRelevanceScore(query, r);
    return {
      ...r,
      qualityScore: iqScore + relScore,
      qualityFlags: [],
    };
  });

  scored.sort((a, b) => b.qualityScore - a.qualityScore);
  scored = domainDemote(scored, params.maxPerDomain);
  scored = nearDuplicateDemote(scored, params.simHashThreshold);

  if (embeddings && embeddings.length === scored.length) {
    scored = semanticDedupDemote(scored, embeddings, params.semanticDedupThreshold ?? 0.85);
  }

  scored = spamMirrorDetect(scored);
  scored = commercialIntentPenalty(scored);
  scored = directoryDemotion(scored);
  scored = urlPathMirrorDemote(scored, 1);

  scored.sort((a, b) => b.qualityScore - a.qualityScore);

  return scored;
}
