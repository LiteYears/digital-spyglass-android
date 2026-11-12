import { describe, it, expect, beforeEach } from "vitest";
import { AHMIA_SNAPSHOT } from "../ahmia-blacklist.snapshot";
import {
  parseBlacklist,
  isBlacklisted,
  blacklistCount,
  clearBlacklistCache,
  loadAhmiaBlacklist,
} from "../blacklist";

beforeEach(() => {
  clearBlacklistCache();
});

describe("parseBlacklist", () => {
  it("parses .onion domains from text", () => {
    const body = "abc.onion\ndef.onion\n# comment\n\nghi.onion";
    const domains = parseBlacklist(body);
    expect(domains.size).toBe(3);
    expect(domains.has("abc.onion")).toBe(true);
    expect(domains.has("def.onion")).toBe(true);
    expect(domains.has("ghi.onion")).toBe(true);
  });

  it("ignores comments and empty lines", () => {
    const body = "# comment\n\n// another comment\nabc.onion";
    const domains = parseBlacklist(body);
    expect(domains.size).toBe(1);
    expect(domains.has("abc.onion")).toBe(true);
  });

  it("lowercases domains", () => {
    const body = "ABC.ONION\nDef.Onion";
    const domains = parseBlacklist(body);
    expect(domains.has("abc.onion")).toBe(true);
    expect(domains.has("def.onion")).toBe(true);
  });

  it("ignores non-onion entries", () => {
    const body = "example.com\nabc.onion\n123";
    const domains = parseBlacklist(body);
    expect(domains.size).toBe(1);
    expect(domains.has("abc.onion")).toBe(true);
  });
});

describe("isBlacklisted", () => {
  it("returns false for an unlisted host even before any fetch (snapshot baseline)", () => {
    expect(isBlacklisted("http://not-actually-banned-zz9.onion/")).toBe(false);
  });

  it("returns true for blacklisted domain", async () => {
    const mockFetch = async () => "abc.onion\ndef.onion";
    await loadAhmiaBlacklist(mockFetch);
    expect(isBlacklisted("http://abc.onion/page")).toBe(true);
    expect(isBlacklisted("http://def.onion/page")).toBe(true);
  });

  it("returns false for non-blacklisted domain", async () => {
    const mockFetch = async () => "abc.onion";
    await loadAhmiaBlacklist(mockFetch);
    expect(isBlacklisted("http://xyz.onion/page")).toBe(false);
  });

  it("handles subdomain matching", async () => {
    const mockFetch = async () => "bad.onion";
    await loadAhmiaBlacklist(mockFetch);
    expect(isBlacklisted("http://sub.bad.onion/page")).toBe(true);
  });

  it("handles invalid URL gracefully", () => {
    expect(isBlacklisted("not-a-url")).toBe(false);
  });
});

describe("blacklistCount", () => {
  it("returns the bundled snapshot size before any fetch", () => {
    expect(blacklistCount()).toBeGreaterThan(50_000);
  });

  it("returns count after loading", async () => {
    const mockFetch = async () => "a.onion\nb.onion\nc.onion";
    await loadAhmiaBlacklist(mockFetch);
    expect(blacklistCount()).toBe(3);
  });
});

describe("loadAhmiaBlacklist", () => {
  it("returns loaded=true on success", async () => {
    const mockFetch = async () => "abc.onion";
    const result = await loadAhmiaBlacklist(mockFetch);
    expect(result.loaded).toBe(true);
    expect(result.count).toBe(1);
  });

  it("returns loaded=false on fetch error but keeps the snapshot baseline", async () => {
    const mockFetch = async () => {
      throw new Error("network error");
    };
    const result = await loadAhmiaBlacklist(mockFetch);
    expect(result.loaded).toBe(false);
    expect(result.count).toBeGreaterThan(50_000);
  });

  it("bundled snapshot parses to a large MD5 set", () => {
    const domains = parseBlacklist(AHMIA_SNAPSHOT);
    expect(domains.size).toBeGreaterThan(50_000);
  });

  it("uses cache on subsequent calls", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return "abc.onion";
    };
    await loadAhmiaBlacklist(mockFetch);
    await loadAhmiaBlacklist(mockFetch);
    expect(callCount).toBe(1);
  });
});
