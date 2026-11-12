export type RankingProfile = {
  id: string;
  version: string;
  rrfK: number;
  qualityFilterEnabled: boolean;
  maxPerDomain: number;
  simHashThreshold: number;
  semanticDedupThreshold: number;
  llmRerank: boolean;
  queryPlanner: boolean;
  queryExpansion: boolean;
  snippetFilter: boolean;
  maxResults: number;
};

export const PRODUCTION_V1: RankingProfile = {
  id: "production-v1",
  version: "1.1.0",
  rrfK: 10,
  qualityFilterEnabled: true,
  maxPerDomain: 3,
  simHashThreshold: 3,
  semanticDedupThreshold: 0.85,
  llmRerank: false,
  queryPlanner: false,
  queryExpansion: false,
  snippetFilter: false,
  maxResults: 20,
};

export function getProfile(id: string): RankingProfile | undefined {
  if (id === "production-v1") return PRODUCTION_V1;
  return undefined;
}

export function profileToSearchParams(profile: RankingProfile) {
  return {
    query: "",
    paranoid: false,
    snippetFilter: profile.snippetFilter,
    maxResults: profile.maxResults,
    qualityFilter: profile.qualityFilterEnabled,
    maxPerDomain: profile.maxPerDomain,
    llmRerank: profile.llmRerank,
    queryPlanner: profile.queryPlanner,
    queryExpansion: profile.queryExpansion,
    summarize: false,
    fastMode: false,
    qarf: false,
    correlate: true,
  };
}
