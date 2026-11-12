import type { QueryContract } from "./engines";
import { parseQuery } from "./query";

export type AdaptedQuery = {
  query: string;
  truncated: boolean;
  termsDropped: boolean;
  operatorsStripped: boolean;
  originalLength: number;
  originalTerms: number;
  adaptedLength: number;
  adaptedTerms: number;
};

export function adaptQuery(rawQuery: string, contract: QueryContract | undefined): AdaptedQuery {
  const original = rawQuery.trim();
  const parsed = parseQuery(original);
  const originalTerms = parsed.terms.length;

  if (!contract) {
    return {
      query: original,
      truncated: false,
      termsDropped: false,
      operatorsStripped: false,
      originalLength: original.length,
      originalTerms,
      adaptedLength: original.length,
      adaptedTerms: originalTerms,
    };
  }

  let terms = [...parsed.terms];
  let termsDropped = false;
  let operatorsStripped = false;

  if (contract.booleanOperators === false) {
    const hadBoolean = /\b(AND|OR|NOT)\b/i.test(original);
    if (hadBoolean) operatorsStripped = true;
    terms = terms
      .map((t) => ({
        ...t,
        text: t.text.replace(/\b(AND|OR|NOT)\b/gi, "").trim(),
      }))
      .filter((t) => t.text.length > 0);
  }

  if (contract.phraseQuotes === false) {
    terms = terms.flatMap((t) => {
      if (!t.exact) return [{ ...t, exact: false }];
      operatorsStripped = true;
      return t.text
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => ({
          text: w,
          exact: false,
          excluded: t.excluded,
        }));
    });
  }

  if (contract.maxTerms && terms.length > contract.maxTerms) {
    terms = terms.slice(0, contract.maxTerms);
    termsDropped = true;
  }

  const parts = terms.map((t) => (t.exact ? `"${t.text}"` : t.text));
  let query = parts.join(" ");

  let truncated = false;
  const queryCodepoints = Array.from(query);
  if (contract.maxQueryLength && queryCodepoints.length > contract.maxQueryLength) {
    const max = contract.maxQueryLength;
    const words = query.split(" ");
    const kept: string[] = [];
    let len = 0;
    for (const w of words) {
      const wLen = Array.from(w).length;
      const addition = (kept.length > 0 ? 1 : 0) + wLen;
      if (len + addition > max) break;
      kept.push(w);
      len += addition;
    }
    if (kept.length === 0 && words[0]) {
      query = Array.from(words[0]).slice(0, max).join("");
    } else {
      query = kept.join(" ");
    }
    truncated = true;
  }

  return {
    query,
    truncated,
    termsDropped,
    operatorsStripped,
    originalLength: original.length,
    originalTerms,
    adaptedLength: query.length,
    adaptedTerms: terms.length,
  };
}
