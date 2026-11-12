const STATIC_ASSET_RE =
  /\.(css|js|mjs|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map|webp|avif|bmp|webmanifest|xml|rss|atom)(\?|$)/i;
const NAV_PATH_RE =
  /\/(about|directory|webmaster|contact|advertising|advertise|add-url|last-added|login|register|signup|terms|privacy|policy|help|faq|sitemap|feedback|search)(\/?|\?|$)/i;
const AD_RE = /\/(randomad|t\?ad=|uploads\/banners)/i;
const LOGIN_RE =
  /(action=login|action=register|action=signup|action=logout|login\.php|register\.php|signin)/i;

export type FilterableResult = {
  url: string;
  title: string;
  snippet: string;
};

export function isJunkResult(url: string): boolean {
  if (STATIC_ASSET_RE.test(url)) return true;
  if (NAV_PATH_RE.test(url)) return true;
  if (AD_RE.test(url)) return true;
  if (LOGIN_RE.test(url)) return true;
  if (url.includes("query=undefined")) return true;
  return false;
}

export function filterResults<T extends FilterableResult>(
  results: T[],
): { kept: T[]; filtered: number } {
  let filtered = 0;
  const kept: T[] = [];
  for (const r of results) {
    if (isJunkResult(r.url)) {
      filtered++;
      continue;
    }
    kept.push(r);
  }
  return { kept, filtered };
}
