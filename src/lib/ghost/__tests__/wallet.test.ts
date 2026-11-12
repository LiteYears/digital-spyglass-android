import { describe, expect, it } from "vitest";
import {
  buildReuseIndex,
  classifyBtc,
  classifyXmr,
  entityBadgeDetail,
  lookupReuse,
  walletDetail,
} from "../wallet";
import { extractEntities } from "../entities";
import { correlateEntities } from "../correlation";

// BIP-173 / BIP-350 reference vectors (lowercase forms).
const P2WPKH_VALID = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const P2TR_VALID = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const P2WPKH_BAD_CHECKSUM = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5";
const P2TR_BAD_CHECKSUM = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1";
// Real Monero donation address (primary, network 4…, 95 chars).
const XMR_PRIMARY =
  "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";

describe("classifyBtc", () => {
  it("verifies a BIP-173 P2WPKH vector (bech32)", () => {
    expect(classifyBtc(P2WPKH_VALID)).toEqual({
      shape: "bech32-segwit",
      valid: true,
    });
  });

  it("verifies a BIP-350 P2TR vector (bech32m)", () => {
    expect(classifyBtc(P2TR_VALID)).toEqual({
      shape: "bech32m-taproot",
      valid: true,
    });
  });

  it("rejects a mutated checksum character", () => {
    expect(classifyBtc(P2WPKH_BAD_CHECKSUM)?.valid).toBe(false);
    expect(classifyBtc(P2TR_BAD_CHECKSUM)?.valid).toBe(false);
  });

  it("rejects mixed-case bech32 (BIP-173 rule)", () => {
    expect(classifyBtc("BC1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")?.valid).toBe(false);
  });

  it("classifies legacy base58 shape without a validity claim", () => {
    expect(classifyBtc("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toEqual({
      shape: "base58-legacy",
      valid: null,
    });
  });

  it("returns null for non-addresses", () => {
    expect(classifyBtc("not-an-address")).toBeNull();
  });
});

describe("classifyXmr", () => {
  it("recognizes a real primary address (4…, 95 chars)", () => {
    expect(classifyXmr(XMR_PRIMARY)).toEqual({ shape: "primary", valid: null });
  });

  it("recognizes subaddress shape (8…)", () => {
    const sub = "8" + XMR_PRIMARY.slice(1);
    expect(classifyXmr(sub)?.shape).toBe("subaddress");
  });

  it("recognizes integrated shape (4…, 106 chars)", () => {
    const integrated = XMR_PRIMARY + "qqqqqqqqqqq"; // +11 → 106-char integrated form
    expect(integrated.length).toBe(106);
    expect(classifyXmr(integrated)?.shape).toBe("integrated");
  });

  it("returns null for too-short strings", () => {
    expect(classifyXmr("4abc")).toBeNull();
  });
});

describe("badge enrichment", () => {
  it("extractEntities decorates BTC/XMR badges with a detail label", () => {
    const badges = extractEntities(`send to ${P2WPKH_VALID} or xmr ${XMR_PRIMARY}`);
    const btc = badges.find((b) => b.type === "btc");
    const xmr = badges.find((b) => b.type === "xmr");
    expect(btc?.detail).toBe("BTC · segwit ✓");
    expect(xmr?.detail).toBe("XMR · primary");
  });

  it("flags a bad checksum in the badge detail", () => {
    expect(walletDetail({ type: "btc", value: P2WPKH_BAD_CHECKSUM })).toBe("BTC · bad checksum");
  });
});

describe("reused wallet clusters", () => {
  it("marks multi-result wallet clusters as walletReuse", () => {
    const report = correlateEntities([
      {
        url: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/m1",
        entities: [{ type: "btc", value: P2WPKH_VALID }],
      },
      {
        url: "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion/m2",
        entities: [{ type: "btc", value: P2WPKH_VALID }],
      },
      {
        url: "http://cccccccccccccccccccccccccccccccccccccccccccccccccccccccc.onion/m3",
        entities: [{ type: "email", value: "op@x.onion" }],
      },
    ]);
    const btc = report.clusters.find((c) => c.entityType === "btc");
    const email = report.clusters.find((c) => c.entityType === "email");
    expect(btc?.walletReuse).toBe(true);
    expect(email?.walletReuse).toBeUndefined();
  });

  it("does not cluster case-variant base58 addresses as the same wallet", () => {
    const variant = XMR_PRIMARY.toLowerCase();
    const report = correlateEntities([
      {
        url: "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion/m1",
        entities: [{ type: "xmr", value: XMR_PRIMARY }],
      },
      {
        url: "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion/m2",
        entities: [{ type: "xmr", value: variant }],
      },
    ]);
    // Distinct addresses — neither variant may reach cluster size.
    expect(report.clusters.filter((c) => c.entityType === "xmr")).toHaveLength(0);
  });
});

describe("reuse index (badge lookup)", () => {
  const clusters = [
    {
      entityType: "btc",
      entityValue: P2WPKH_VALID.toLowerCase(),
      resultUrls: ["http://a.onion/1", "http://b.onion/2", "http://c.onion/3"],
      resultCount: 3,
      walletReuse: true,
    },
    {
      entityType: "email",
      entityValue: "op@x.onion",
      resultUrls: ["http://a.onion/1", "http://b.onion/2"],
      resultCount: 2,
      // walletReuse undefined — non-wallet cluster must not enter the index
    },
  ];

  it("indexes wallet-reuse clusters keyed by type:value", () => {
    const index = buildReuseIndex(clusters);
    expect(lookupReuse(index, { type: "btc", value: P2WPKH_VALID })).toBe(3);
  });

  it("does NOT match case-variants for base58 wallets — case is part of the checksum", () => {
    const index = buildReuseIndex([
      {
        entityType: "xmr",
        entityValue: XMR_PRIMARY.toLowerCase(),
        resultCount: 2,
        walletReuse: true,
      },
    ]);
    // A differently-cased badge is a DIFFERENT address — no reuse hit.
    expect(lookupReuse(index, { type: "xmr", value: XMR_PRIMARY })).toBeUndefined();
    expect(lookupReuse(index, { type: "xmr", value: XMR_PRIMARY.toLowerCase() })).toBe(2);
  });

  it("still folds bech32 — BIP-173 is single-case", () => {
    const index = buildReuseIndex([
      { entityType: "btc", entityValue: P2WPKH_VALID, resultCount: 2, walletReuse: true },
    ]);
    expect(lookupReuse(index, { type: "btc", value: P2WPKH_VALID.toUpperCase() })).toBe(2);
  });

  it("returns undefined for non-wallet clusters and unknown addresses", () => {
    const index = buildReuseIndex(clusters);
    expect(lookupReuse(index, { type: "email", value: "op@x.onion" })).toBeUndefined();
    expect(lookupReuse(index, { type: "btc", value: P2TR_VALID })).toBeUndefined();
  });
});

describe("entityBadgeDetail (collapsed badge text)", () => {
  it("strips the coin prefix from the wallet detail", () => {
    expect(entityBadgeDetail({ type: "btc", value: P2WPKH_VALID, detail: "BTC · segwit ✓" })).toBe(
      "segwit ✓",
    );
  });

  it("appends the reuse marker when the count reaches 2+", () => {
    expect(
      entityBadgeDetail({ type: "btc", value: P2WPKH_VALID, detail: "BTC · segwit ✓" }, 3),
    ).toBe("segwit ✓ · reuse 3");
  });

  it("shows the reuse marker alone when there is no shape detail", () => {
    expect(entityBadgeDetail({ type: "xmr", value: "4xyz" }, 2)).toBe("reuse 2");
  });

  it("returns undefined when there is nothing to show", () => {
    expect(entityBadgeDetail({ type: "email", value: "op@x.onion" })).toBeUndefined();
    expect(entityBadgeDetail({ type: "btc", value: P2WPKH_VALID }, 1)).toBeUndefined();
  });
});
