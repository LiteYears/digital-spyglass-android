import { describe, it, expect } from "vitest";
import { extractEntities, entityLabel, type EntityType } from "../entities";

/* ------------------------------------------------------------------ *
 * Entity extraction — correctness
 * ------------------------------------------------------------------ */

describe("extractEntities — BTC", () => {
  it("detects Bitcoin legacy P2PKH address (1...)", () => {
    const text = "Send to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa for payment";
    const badges = extractEntities(text);
    const btc = badges.filter((b) => b.type === "btc");
    expect(btc.length).toBeGreaterThanOrEqual(1);
    expect(btc[0]!.value).toBe("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
  });

  it("detects Bitcoin P2SH address (3...)", () => {
    const text = "The address 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy is valid";
    const badges = extractEntities(text);
    const btc = badges.filter((b) => b.type === "btc");
    expect(btc.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Bitcoin Bech32 address (bc1...)", () => {
    const text = "Use bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq for payment";
    const badges = extractEntities(text);
    const btc = badges.filter((b) => b.type === "btc");
    expect(btc.length).toBeGreaterThanOrEqual(1);
    expect(btc[0]!.value.startsWith("bc1")).toBe(true);
  });

  it("does not false-positive on short strings starting with 1 or 3", () => {
    const text = "I have 3 apples and 1 orange";
    const badges = extractEntities(text);
    expect(badges.filter((b) => b.type === "btc")).toHaveLength(0);
  });
});

describe("extractEntities — XMR", () => {
  it("detects Monero address (starts with 4 or 8)", () => {
    // Monero addresses are 95 chars, Base58 (excludes 0, O, I, l)
    // Build a 95-char address starting with 4 using only Base58 chars
    const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let addr = "4";
    for (let i = 0; i < 94; i++) addr += base58[i % base58.length]!;
    const text = `Pay to ${addr} please`;
    const badges = extractEntities(text);
    const xmr = badges.filter((b) => b.type === "xmr");
    expect(xmr.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractEntities — PGP", () => {
  it("detects PGP public key block", () => {
    const text =
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\n" +
      "mQENBFzExampleKeyBlockContentHereForTestingPurposesOnlyNotReal\n" +
      "-----END PGP PUBLIC KEY BLOCK-----";
    const badges = extractEntities(text);
    const pgp = badges.filter((b) => b.type === "pgp");
    expect(pgp.length).toBeGreaterThanOrEqual(1);
  });

  it("does not detect partial PGP header without footer", () => {
    const text = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nSome content here";
    const badges = extractEntities(text);
    expect(badges.filter((b) => b.type === "pgp")).toHaveLength(0);
  });
});

describe("extractEntities — email", () => {
  it("detects standard email", () => {
    const text = "Contact me at user@example.com for details";
    const badges = extractEntities(text);
    const emails = badges.filter((b) => b.type === "email");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.value).toBe("user@example.com");
  });

  it("detects email with plus addressing", () => {
    const text = "Send to john.doe+spam@sub.domain.org";
    const badges = extractEntities(text);
    const emails = badges.filter((b) => b.type === "email");
    expect(emails.length).toBeGreaterThanOrEqual(1);
  });

  it("does not false-positive on text with @ but no domain", () => {
    const text = "meet me @ the park";
    const badges = extractEntities(text);
    expect(badges.filter((b) => b.type === "email")).toHaveLength(0);
  });
});

describe("extractEntities — onion", () => {
  it("detects .onion v3 address (56 chars)", () => {
    const addr = "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd";
    const text = `Visit http://${addr}.onion/ for search`;
    const badges = extractEntities(text);
    const onions = badges.filter((b) => b.type === "onion");
    expect(onions.length).toBeGreaterThanOrEqual(1);
    expect(onions[0]!.value).toContain(".onion");
  });

  it("detects .onion v2 address (16 chars)", () => {
    const text = "Go toabcdefghijklmnop.onion for stuff";
    const badges = extractEntities(text);
    const onions = badges.filter((b) => b.type === "onion");
    expect(onions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extractEntities — CVE", () => {
  it("detects CVE-2024-12345", () => {
    const text = "Affected by CVE-2024-12345 in OpenSSL";
    const badges = extractEntities(text);
    const cves = badges.filter((b) => b.type === "cve");
    expect(cves).toHaveLength(1);
    expect(cves[0]!.value).toBe("CVE-2024-12345");
  });

  it("detects CVE-1999-0001", () => {
    const text = "Ancient vulnerability CVE-1999-0001";
    const badges = extractEntities(text);
    const cves = badges.filter((b) => b.type === "cve");
    expect(cves).toHaveLength(1);
  });

  it("does not false-positive on CVE-like text without proper format", () => {
    const text = "CVE-99-123 or CVE-2024-123 (too short)";
    const badges = extractEntities(text);
    const cves = badges.filter((b) => b.type === "cve");
    expect(cves).toHaveLength(0);
  });
});

describe("extractEntities — IPv4", () => {
  it("detects standard IPv4 address", () => {
    const text = "Server at 192.168.1.1 is down";
    const badges = extractEntities(text);
    const ips = badges.filter((b) => b.type === "ipv4");
    expect(ips).toHaveLength(1);
    expect(ips[0]!.value).toBe("192.168.1.1");
  });

  it("detects public IPv4 address", () => {
    const text = "Exit node 203.0.113.42 detected";
    const badges = extractEntities(text);
    const ips = badges.filter((b) => b.type === "ipv4");
    expect(ips).toHaveLength(1);
    expect(ips[0]!.value).toBe("203.0.113.42");
  });

  it("does not false-positive on version numbers", () => {
    const text = "Version 1.2.3 is the latest release";
    const badges = extractEntities(text);
    const ips = badges.filter((b) => b.type === "ipv4");
    expect(ips).toHaveLength(0);
  });

  it("handles edge octets (0, 255)", () => {
    const text = "IP 0.0.0.0 and 255.255.255.255";
    const badges = extractEntities(text);
    const ips = badges.filter((b) => b.type === "ipv4");
    expect(ips.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ *
 * Edge cases
 * ------------------------------------------------------------------ */

describe("extractEntities — edge cases", () => {
  it("returns empty for empty string", () => {
    expect(extractEntities("")).toEqual([]);
  });

  it("returns empty for null/undefined input", () => {
    expect(extractEntities(null as unknown as string)).toEqual([]);
  });

  it("returns empty for very short text (<8 chars)", () => {
    expect(extractEntities("short")).toEqual([]);
  });

  it("deduplicates case-insensitively", () => {
    const text = "email: User@Example.COM and user@example.com";
    const badges = extractEntities(text);
    const emails = badges.filter((b) => b.type === "email");
    // Should dedupe to 1 (case-insensitive)
    expect(emails).toHaveLength(1);
  });

  it("detects multiple entity types in one text", () => {
    const text =
      "Contact user@example.com or visit abcdefghijklmnop.onion. " +
      "Pay to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const badges = extractEntities(text);
    const types = new Set(badges.map((b) => b.type));
    expect(types.has("email")).toBe(true);
    expect(types.has("onion")).toBe(true);
    expect(types.has("btc")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * ReDoS safety — the critical test
 * ------------------------------------------------------------------ */

describe("extractEntities — ReDoS safety", () => {
  it("completes within 200ms on adversarial email-like input", () => {
    // Classic ReDoS attack: long sequence of valid chars followed by a non-match
    // If the regex has catastrophic backtracking, this will take seconds.
    const evil = "a".repeat(50000) + "!";
    const start = Date.now();
    extractEntities(`Contact ${evil}@example.com`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("completes within 200ms on adversarial BTC-like input", () => {
    // Long Base58-like string that almost matches but fails at the end
    const evil = "Z".repeat(50000) + "!";
    const start = Date.now();
    extractEntities(`Pay to 1${evil}`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("completes within 200ms on adversarial .onion-like input", () => {
    // Long alphanumeric string that almost matches .onion but doesn't
    const evil = "a".repeat(50000) + "!";
    const start = Date.now();
    extractEntities(`Visit ${evil}.onion`);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("completes within 200ms on adversarial PGP-like input", () => {
    // 50k chars between BEGIN and END markers
    const evil = "A".repeat(50000);
    const text = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${evil}\n!-----END PGP PUBLIC KEY BLOCK-----`;
    const start = Date.now();
    extractEntities(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("completes within 200ms on mixed adversarial input", () => {
    // Combination of all patterns with adversarial suffixes
    const parts: string[] = [];
    for (let i = 0; i < 100; i++) {
      parts.push(`a`.repeat(500) + "!@example.com");
      parts.push(`1` + `Z`.repeat(100) + `!`);
      parts.push(`a`.repeat(100) + `.onion!`);
    }
    const text = parts.join(" ");
    const start = Date.now();
    extractEntities(text);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("handles 500 results in under 500ms (performance)", () => {
    // Simulate the worst case: 500 snippets, each with multiple entity types
    const snippet =
      "Contact user@example.com, visit abcdefghijklmnop.onion, " +
      "pay 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa, email admin@test.org";
    const start = Date.now();
    for (let i = 0; i < 500; i++) {
      extractEntities(snippet);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

/* ------------------------------------------------------------------ *
 * entityLabel
 * ------------------------------------------------------------------ */

describe("entityLabel", () => {
  it("returns correct labels for all types", () => {
    const cases: [EntityType, string][] = [
      ["btc", "BTC"],
      ["xmr", "XMR"],
      ["pgp", "PGP"],
      ["email", "EMAIL"],
      ["onion", "ONION"],
      ["cve", "CVE"],
      ["ipv4", "IP"],
    ];
    for (const [type, label] of cases) {
      expect(entityLabel(type)).toBe(label);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Case sensitivity (Beam audit F1): base58 wallet dedup must NOT fold
 * case — case-distinct addresses are distinct identities.
 * ------------------------------------------------------------------ */

describe("extractEntities — case sensitivity", () => {
  it("keeps case-distinct base58 wallets as separate badges", () => {
    const text = "a 1AAAAAAAAAAAAAAAAAAAAAAAAA b 1aaaaaaaaaaaaaaaaaaaaaaaaa";
    const btc = extractEntities(text).filter((b) => b.type === "btc");
    expect(btc).toHaveLength(2);
  });

  it("still dedupes byte-identical wallets", () => {
    const text = "x 1AAAAAAAAAAAAAAAAAAAAAAAAA y 1AAAAAAAAAAAAAAAAAAAAAAAAA";
    const btc = extractEntities(text).filter((b) => b.type === "btc");
    expect(btc).toHaveLength(1);
  });

  it("still folds case-insensitive types (email)", () => {
    const text = "m Alice@Example.COM n alice@example.com";
    const emails = extractEntities(text).filter((b) => b.type === "email");
    expect(emails).toHaveLength(1);
  });
});
