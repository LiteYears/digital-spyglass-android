import { describe, expect, it } from "vitest";
import { stripTrackingParams } from "../tracking";

const ONION =
  "http://abcdefghijklmnopabcdefghijklmnopabcdefghijklmnopabcdefghijklmnop.onion";

describe("stripTrackingParams", () => {
  it("strips utm_* parameters and keeps the real ones", () => {
    const r = stripTrackingParams(
      `${ONION}/market?id=7&utm_source=ghost&utm_campaign=x`,
    );
    expect(r.url).toBe(`${ONION}/market?id=7`);
    expect(r.stripped).toEqual(["utm_source", "utm_campaign"]);
  });

  it("strips known click identifiers (fbclid, gclid, msclkid…)", () => {
    const r = stripTrackingParams(
      `${ONION}/p?fbclid=abc&gclid=x&msclkid=y&keep=1`,
    );
    expect(r.url).toBe(`${ONION}/p?keep=1`);
    expect(r.stripped).toEqual(["fbclid", "gclid", "msclkid"]);
  });

  it("strips session-identifier parameters", () => {
    const r = stripTrackingParams(`${ONION}/view?session_id=zz&doc=3`);
    expect(r.url).toBe(`${ONION}/view?doc=3`);
    expect(r.stripped).toEqual(["session_id"]);
  });

  it("does not strip lookalike search parameters (q, s, p, page)", () => {
    const url = `${ONION}/search?q=captcha&s=2&p=3&page=4`;
    expect(stripTrackingParams(url)).toEqual({ url, stripped: [] });
  });

  it("preserves the fragment", () => {
    const r = stripTrackingParams(`${ONION}/a?utm_term=k#section`);
    expect(r.url).toBe(`${ONION}/a#section`);
  });

  it("drops the trailing ? when every parameter is removed", () => {
    const r = stripTrackingParams(`${ONION}/a?utm_medium=referral`);
    expect(r.url).toBe(`${ONION}/a`);
    expect(r.url.includes("?")).toBe(false);
  });

  it("returns the input untouched for URLs without a query", () => {
    const url = `${ONION}/plain`;
    expect(stripTrackingParams(url)).toEqual({ url, stripped: [] });
  });

  it("returns non-URL input untouched", () => {
    expect(stripTrackingParams("not a url")).toEqual({
      url: "not a url",
      stripped: [],
    });
  });

  it("matches parameter names case-insensitively", () => {
    const r = stripTrackingParams(`${ONION}/?UTM_Source=a&FbCLID=b`);
    expect(r.url).toBe(`${ONION}/`);
    expect(r.stripped).toEqual(["UTM_Source", "FbCLID"]);
  });
});
