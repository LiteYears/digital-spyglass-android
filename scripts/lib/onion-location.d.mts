export declare function isV3OnionUrl(u: string): boolean;

export declare function extractOnionLocation(input: {
  headers?: { get(name: string): string | null } | Record<string, string> | null;
  body?: string | null;
  baseUrl?: string | null;
}): { url: string; source: "header" | "meta" } | null;
