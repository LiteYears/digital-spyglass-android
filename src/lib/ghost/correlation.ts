import { caseEntityKey } from "./case-file";

export type CorrelationCluster = {
  entityType: string;
  entityValue: string;
  resultUrls: string[];
  resultCount: number;
  /** True when the same wallet address appears in multiple results —
   *  reuse is an operator-linking signal worth surfacing. */
  walletReuse?: boolean;
};

export type CorrelationReport = {
  clusters: CorrelationCluster[];
  totalClusters: number;
  maxClusterSize: number;
};

type ResultWithEntities = {
  url: string;
  entities: Array<{ type: string; value: string }>;
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function correlateEntities(
  results: ResultWithEntities[],
  minClusterSize = 2,
): CorrelationReport {
  const entityMap = new Map<string, Set<string>>();

  for (const r of results) {
    const ownHost = hostnameOf(r.url);
    for (const e of r.entities) {
      const valLower = e.value.toLowerCase();
      if (e.type === "onion" && ownHost && valLower.includes(ownHost)) {
        continue;
      }
      // Case-aware key: base58 wallets keep case (checksum is case-dependent),
      // folding them would collide distinct addresses into false clusters.
      const key = caseEntityKey(e);
      if (!entityMap.has(key)) {
        entityMap.set(key, new Set());
      }
      entityMap.get(key)!.add(r.url);
    }
  }

  const clusters: CorrelationCluster[] = [];
  let maxClusterSize = 0;

  for (const [key, urls] of entityMap) {
    if (urls.size >= minClusterSize) {
      const [type, ...valueParts] = key.split(":");
      const value = valueParts.join(":");
      const urlArray = Array.from(urls);
      const isWallet = type === "btc" || type === "xmr";
      const cluster: CorrelationCluster = {
        entityType: type ?? "unknown",
        entityValue: value,
        resultUrls: urlArray,
        resultCount: urlArray.length,
      };
      if (isWallet) cluster.walletReuse = true;
      clusters.push(cluster);
      if (urlArray.length > maxClusterSize) {
        maxClusterSize = urlArray.length;
      }
    }
  }

  clusters.sort((a, b) => b.resultCount - a.resultCount);

  return {
    clusters,
    totalClusters: clusters.length,
    maxClusterSize,
  };
}
