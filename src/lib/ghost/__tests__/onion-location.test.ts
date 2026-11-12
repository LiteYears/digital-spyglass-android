import { describe, expect, it } from "vitest";
// CI-side helper (scripts/ tree) — imported here because vitest only picks
// up tests under src/. The .mjs is consumed by scripts/engine-healthcheck.mjs.
import { extractOnionLocation, isV3OnionUrl } from "../../../../scripts/lib/onion-location.mjs";

const OLD = "http://" + "a".repeat(56) + ".onion";
const NEW = "http://" + "b".repeat(56) + ".onion";

describe("isV3OnionUrl", () => {
  it("accepts a 56-char base32 http v3 host", () => {
    expect(isV3OnionUrl(NEW)).toBe(true);
  });
  it("rejects https, v2-length, and garbage", () => {
    expect(isV3OnionUrl(NEW.replace("http", "https"))).toBe(false);
    expect(isV3OnionUrl("http://" + "a".repeat(16) + ".onion")).toBe(false);
    expect(isV3OnionUrl("not a url")).toBe(false);
  });
});

describe("extractOnionLocation", () => {
  it("prefers the response header", () => {
    const r = extractOnionLocation({
      headers: { get: (n: string) => (n === "onion-location" ? NEW : null) },
      body: `<meta http-equiv="onion-location" content="${OLD}">`,
      baseUrl: OLD,
    });
    expect(r).toEqual({ url: NEW, source: "header" });
  });

  it("falls back to the meta tag (both attribute orders)", () => {
    const a = extractOnionLocation({
      body: `<meta http-equiv="onion-location" content="${NEW}">`,
      baseUrl: OLD,
    });
    const b = extractOnionLocation({
      body: `<meta content="${NEW}" http-equiv="onion-location">`,
      baseUrl: OLD,
    });
    expect(a).toEqual({ url: NEW, source: "meta" });
    expect(b).toEqual({ url: NEW, source: "meta" });
  });

  it("ignores self-announcements (same host as current base)", () => {
    const r = extractOnionLocation({
      headers: { "onion-location": OLD },
      baseUrl: OLD,
    });
    expect(r).toBeNull();
  });

  it("rejects non-v3 or non-http candidates", () => {
    const v2 = "http://" + "c".repeat(16) + ".onion";
    expect(extractOnionLocation({ headers: { "onion-location": v2 }, baseUrl: OLD })).toBeNull();
    expect(
      extractOnionLocation({
        body: `<meta http-equiv="onion-location" content="https://${"d".repeat(56)}.onion">`,
        baseUrl: OLD,
      }),
    ).toBeNull();
  });

  it("returns null when nothing announces a relocation", () => {
    expect(extractOnionLocation({ body: "<html>nothing</html>", baseUrl: OLD })).toBeNull();
    expect(extractOnionLocation({ headers: {}, body: "", baseUrl: OLD })).toBeNull();
  });

  it("handles plain-object headers case-insensitively", () => {
    const r = extractOnionLocation({
      headers: { "Onion-Location": NEW },
      baseUrl: OLD,
    });
    expect(r).toEqual({ url: NEW, source: "header" });
  });
});
