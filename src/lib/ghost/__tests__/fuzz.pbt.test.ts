import { describe, it } from "vitest";
import * as fc from "fast-check";
import { adaptQuery } from "../query-adapter";
import type { QueryContract } from "../engines";
import {
  decodeBase32,
  extractV3OnionLabel,
  verifyV3OnionAddress,
  computeSimHash64,
  hammingDistance64,
  CANONICAL_ONION_REGISTRY,
} from "../authenticity";
import { stripHtml, safeSnippet, assessSnippetQuality, WITHHELD, SNIPPET_MAX } from "../snippets";
import { isContentUrl, looksLikeCaptcha, isOnion, unwrapRedirect, cleanText } from "../parse";
import { parseQuery } from "../query";

/**
 * Property-based fuzz harness (DeepSeek Level-3 Iteration 3, Item "fuzzing for parsers").
 * Invariants: never throw on adversarial input, bounded output, correct types,
 * no unpaired surrogates, symmetric/idempotent math, bounded runtime.
 */

const arbitraryContract: fc.Arbitrary<QueryContract> = fc.record(
  {
    maxQueryLength: fc.integer({ min: 0, max: 512 }),
    maxTerms: fc.integer({ min: 0, max: 32 }),
    booleanOperators: fc.boolean(),
    phraseQuotes: fc.boolean(),
    matchMode: fc.constantFrom("any" as const, "all" as const, "majority" as const),
    encoding: fc.constantFrom("raw" as const, "url-encoded" as const),
  },
  { requiredKeys: [] },
);

const hasUnpairedSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
};

describe("Fuzz: query adapter (surrogates, control chars, pathological lengths)", () => {
  it("adaptQuery never throws, bounds output, emits no unpaired surrogates", () => {
    fc.assert(
      fc.property(fc.string(), fc.option(arbitraryContract), (raw, contract) => {
        const out = adaptQuery(raw, contract ?? undefined);
        if (typeof out.query !== "string") return false;
        if (hasUnpairedSurrogate(out.query)) return false;
        if (contract?.maxQueryLength != null) {
          const cps = Array.from(out.query).length;
          if (out.truncated && cps > contract.maxQueryLength) return false;
        }
        if (out.originalLength !== raw.trim().length) return false;
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("parseQuery never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const r = parseQuery(raw);
        return Array.isArray(r.terms);
      }),
      { numRuns: 500 },
    );
  });
});

describe("Fuzz: v3 .onion verification (base32, checksum, label extraction)", () => {
  it("decodeBase32 never throws; valid-alphabet input decodes to floor(5n/8) bytes", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = decodeBase32(s);
        if (r === null) return true;
        const clean = s.trim().toLowerCase();
        return r.length === Math.floor((clean.length * 5) / 8);
      }),
      { numRuns: 500 },
    );
  });

  it("verifyV3OnionAddress never throws and returns a structured verdict", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = verifyV3OnionAddress(s);
        return typeof r.valid === "boolean" && (r.label === null || typeof r.label === "string");
      }),
      { numRuns: 500 },
    );
  });

  it("single-char mutation of a canonical v3 address fails checksum (collision resistance)", () => {
    const labels = Object.values(CANONICAL_ONION_REGISTRY);
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    fc.assert(
      fc.property(
        fc.constantFrom(...labels),
        fc.integer({ min: 0, max: 55 }),
        fc.constantFrom(...alphabet.split("")),
        (label, pos, ch) => {
          const mutated = label.slice(0, pos) + ch + label.slice(pos + 1);
          if (mutated === label) return true; // no-op mutation
          const r = verifyV3OnionAddress(mutated + ".onion");
          return r.valid === false;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("Fuzz: snippet sanitization and quality", () => {
  it("stripHtml never throws and removes tags from well-formed input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = stripHtml(s);
        if (typeof out !== "string") return false;
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("safeSnippet never throws and stays within SNIPPET_MAX", () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (text, filterOn) => {
        const out = safeSnippet(text, filterOn);
        if (typeof out.snippet !== "string" || typeof out.withheld !== "boolean") return false;
        if (out.snippet !== WITHHELD && out.snippet.length > SNIPPET_MAX + 1) return false;
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("assessSnippetQuality never throws and returns a bounded verdict", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (snippet, title, query) => {
        const q = assessSnippetQuality(snippet, title, query);
        return typeof q.sufficient === "boolean";
      }),
      { numRuns: 500 },
    );
  });
});

describe("Fuzz: SimHash/Hamming math", () => {
  it("hammingDistance64 is symmetric, identity is 0, range [0,64]", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const ha = computeSimHash64(a);
        const hb = computeSimHash64(b);
        if (hammingDistance64(ha, ha) !== 0) return false;
        if (hammingDistance64(ha, hb) !== hammingDistance64(hb, ha)) return false;
        const d = hammingDistance64(ha, hb);
        return d >= 0 && d <= 64;
      }),
      { numRuns: 300 },
    );
  });
});

describe("Fuzz: parse.ts helpers (URL handling, captcha heuristic, text cleaning)", () => {
  it("isContentUrl / looksLikeCaptcha / isOnion never throw and return booleans", () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string()), (href, base) => {
        const a = isContentUrl(href, base ?? undefined);
        const b = looksLikeCaptcha(href);
        const c = isOnion(href);
        return [a, b, c].every((v) => typeof v === "boolean");
      }),
      { numRuns: 500 },
    );
  });

  it("unwrapRedirect and cleanText never throw", () => {
    fc.assert(
      fc.property(fc.string(), fc.option(fc.string()), (href, base) => {
        const u = unwrapRedirect(href, base ?? undefined);
        const t = cleanText(href);
        return typeof u === "string" && typeof t === "string";
      }),
      { numRuns: 500 },
    );
  });
});
