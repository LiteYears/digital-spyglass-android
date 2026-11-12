export type EngineResultSummary = {
  title: string;
  snippet: string;
};

export type QarfOptions = {
  lambda?: number;
  topK?: number;
  minMultiplier?: number;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

export function computeQarfWeights(
  query: string,
  engineResults: Map<string, EngineResultSummary[]>,
  baseTrust: Map<string, number>,
  lambdaOrOptions?: number | QarfOptions,
): Map<string, number> {
  const options: QarfOptions =
    typeof lambdaOrOptions === "number" ? { lambda: lambdaOrOptions } : (lambdaOrOptions ?? {});
  const lambda = options.lambda ?? 0.9;
  const topK = options.topK ?? 20;
  const minMultiplier = options.minMultiplier ?? 0.25;

  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return new Map(baseTrust);

  const allDocs: string[] = [];
  for (const results of engineResults.values()) {
    for (const r of results) {
      allDocs.push(`${r.title} ${r.snippet}`);
    }
  }
  const N = allDocs.length;
  if (N === 0) return new Map(baseTrust);

  const docTokenSets = allDocs.map((d) => new Set(tokenize(d)));

  const idfMap = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const tokens of docTokenSets) {
      if (tokens.has(term)) df++;
    }
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(term, idf);
  }

  const maxIdf = Math.max(...idfMap.values(), 0);
  if (maxIdf <= 0) return new Map(baseTrust);

  const qarfWeights = new Map<string, number>();

  for (const [engineId, results] of engineResults) {
    const trust = baseTrust.get(engineId) ?? 1;
    if (results.length === 0) {
      qarfWeights.set(engineId, trust);
      continue;
    }

    const topResults = results.slice(0, topK);
    let matchScore = 0;
    for (const r of topResults) {
      const docTerms = new Set(tokenize(`${r.title} ${r.snippet}`));
      for (const term of queryTerms) {
        if (docTerms.has(term)) {
          matchScore += idfMap.get(term) ?? 0;
        }
      }
    }
    const avgMatch = matchScore / topResults.length;
    const normalizedMatch = Math.min(avgMatch / maxIdf, 1);

    const multiplier = Math.max(1 - lambda + lambda * normalizedMatch, minMultiplier);
    const weight = trust * multiplier;
    qarfWeights.set(engineId, weight);
  }

  return qarfWeights;
}
