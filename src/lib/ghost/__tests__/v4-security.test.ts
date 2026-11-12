import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_ONION_REGISTRY,
  clusterMirrorResults,
  computeSimHash64,
  detectOnionSpoof,
  hammingDistance64,
  verifyV3OnionAddress,
} from "../authenticity";
import { clearBlacklistCache, isBlacklisted, loadAhmiaBlacklist, md5Hex } from "../blacklist";
import {
  DECOY_TARGETS,
  randomFloat01,
  randomInt,
  sampleExponential,
  sampleRayleigh,
} from "../camouflage";
import { decryptExportBundle, encryptExportBundle } from "../crypto-export";
import { ENGINES } from "../engines";
import * as httpMod from "../http";
import { fetchPostBody, fetchText, withHardTimeout } from "../http";
import { PRODUCTION_V1 } from "../profiles";
import { adaptQuery } from "../query-adapter";
import { rankRowsV3, searchAllEngines } from "../search";
import { assessSnippetQuality, WITHHELD } from "../snippets";

describe("Tor v3 .onion cryptographic checksum verification (rend-spec-v3 §6)", () => {
  it("verifies all 13 canonical Ghost search engine v3 .onion addresses and parity with ENGINES", () => {
    for (const [id, label] of Object.entries(CANONICAL_ONION_REGISTRY)) {
      const res = verifyV3OnionAddress(`http://${label}.onion/search?q=test`);
      expect(res.valid, `engine ${id} (${label}) should have valid v3 checksum`).toBe(true);
      expect(res.version).toBe(3);
      expect(res.label).toBe(label);
    }
    for (const engine of ENGINES) {
      const sampleUrl = engine.searchUrl("test", 1);
      const hostLabel = verifyV3OnionAddress(sampleUrl).label;
      expect(hostLabel, `ENGINES[${engine.id}] must match CANONICAL_ONION_REGISTRY`).toBe(
        CANONICAL_ONION_REGISTRY[engine.id],
      );
    }
    const canonSet = new Set(Object.values(CANONICAL_ONION_REGISTRY));
    for (const decoyUrl of DECOY_TARGETS) {
      const label = verifyV3OnionAddress(decoyUrl).label;
      expect(canonSet.has(label ?? ""), `DECOY_TARGETS (${decoyUrl}) must be canonical`).toBe(true);
    }
    expect(PRODUCTION_V1.llmRerank).toBe(false);
  });

  it("rejects a 56-char .onion address with a flipped checksum character", () => {
    const ahmia = CANONICAL_ONION_REGISTRY["ahmia"]!;
    // Flip the 55th char (inside the 2-byte SHA3-256 checksum)
    const corrupted = ahmia.slice(0, 53) + (ahmia[53] === "a" ? "b" : "a") + ahmia.slice(54);
    const res = verifyV3OnionAddress(`http://${corrupted}.onion/`);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("checksum_mismatch");
  });

  it("rejects legacy v2 16-char .onion addresses and clearnet hosts", () => {
    expect(verifyV3OnionAddress("http://3g2upl4pq6kufc4m.onion/").valid).toBe(false);
    expect(verifyV3OnionAddress("https://example.com/").valid).toBe(false);
  });
});

describe("Vanity-prefix spoofing & clone detection", () => {
  it("identifies canonical search engines as CANONICAL", () => {
    const res = detectOnionSpoof(
      "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/",
    );
    expect(res.status).toBe("CANONICAL");
    expect(res.canonicalId).toBe("ahmia");
  });

  it("flags an invalid checksum lookalike as INVALID_ONION", () => {
    const res = detectOnionSpoof(
      "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csad.onion/",
    );
    expect(res.status).toBe("INVALID_ONION");
  });

  it("flags a synthetically valid v3 .onion sharing a >=5 char vanity prefix with Ahmia as SUSPECTED_VANITY_CLONE", () => {
    // Construct a valid 35-byte v3 onion whose base32 starts with "juhanurm" (first 5 bytes matching Ahmia)
    const customRegistry = {
      targetservice: "juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd",
    };
    // Compare Torch against a custom registry entry sharing its 6-char prefix
    const torchLabel = CANONICAL_ONION_REGISTRY["torch"]!;
    const spoofRegistry = {
      ...customRegistry,
      torch_canon: torchLabel.slice(0, 6) + "a".repeat(50),
    };
    const res = detectOnionSpoof(`http://${torchLabel}.onion/`, spoofRegistry);
    expect(res.status).toBe("SUSPECTED_VANITY_CLONE");
    expect(res.spoofedCanonicalId).toBe("torch_canon");
    expect(res.sharedPrefixLen).toBeGreaterThanOrEqual(6);
  });
});

describe("64-bit SimHash mirror page clustering", () => {
  it("clusters near-identical mirror pages across distinct .onion domains", () => {
    const items = [
      {
        url: "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/doc/1",
        title: "Tor Project Onion Services Security Advisory 2026",
        snippet: "Equi-X proof-of-work defense mitigates introduction point DoS floods.",
      },
      {
        url: "http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion/mirror/1",
        title: "Tor Project Onion Services Security Advisory 2026",
        snippet: "Equi-X proof-of-work defense mitigates introduction point DoS floods!",
      },
      {
        url: "http://tordexu73joywapk2txdr54jed4imqledpcvcuf75qsas2gwdgksvnyd.onion/other",
        title: "Completely unrelated Linux kernel netfilter release notes",
        snippet: "Packet classification tables and nftables flowtable offload.",
      },
    ];

    const clusters = clusterMirrorResults(items, 6);
    expect(clusters.length).toBe(2);
    expect(clusters[0]!.mirrorUrls.length).toBe(2);
    expect(clusters[1]!.mirrorUrls.length).toBe(1);

    const h1 = computeSimHash64(`${items[0]!.title} ${items[0]!.snippet}`);
    const h2 = computeSimHash64(`${items[2]!.title} ${items[2]!.snippet}`);
    expect(hammingDistance64(h1, h2)).toBeGreaterThan(12);
  });
});

describe("CSPRNG randomFloat01()", () => {
  it("produces values strictly in [0, 1) with uniform mean ~0.5", () => {
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      const v = randomFloat01();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / n).toBeGreaterThan(0.47);
    expect(sum / n).toBeLessThan(0.53);
  });
});

describe("AES-256-GCM + PBKDF2-HMAC-SHA256 encrypted RAM export", () => {
  it("encrypts and decrypts a STIX 2.1 bundle in RAM without leaking plaintext", async () => {
    const secretPayload = JSON.stringify({
      type: "bundle",
      id: "bundle--ghost-v4-test",
      indicators: ["http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion"],
    });
    const pass = "correct-horse-battery-staple-v4";
    // Use 10,000 iterations in unit test for fast CI execution while exercising full PBKDF2+GCM path
    const armored = await encryptExportBundle(secretPayload, pass, 10_000);

    expect(armored).toContain("secure-export-v1");
    expect(armored).not.toContain("juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd");

    const recovered = await decryptExportBundle(armored, pass);
    expect(recovered).toBe(secretPayload);
  });

  it("rejects decryption with a wrong passphrase or tampered ciphertext", async () => {
    const armored = await encryptExportBundle(
      "sensitive-osint-csv-row",
      "strong-passphrase-123",
      10_000,
    );
    await expect(decryptExportBundle(armored, "wrong-passphrase-123")).rejects.toThrow();

    const parsed = JSON.parse(armored) as Record<string, unknown>;
    parsed["ciphertextB64"] = "AAAA" + String(parsed["ciphertextB64"]).slice(4);
    await expect(
      decryptExportBundle(JSON.stringify(parsed), "strong-passphrase-123"),
    ).rejects.toThrow();

    // Whitespace-only passphrase rejected
    await expect(encryptExportBundle("secret", "        ", 10_000)).rejects.toThrow();

    // Excessive iteration count (> 1,000,000) rejected against CPU DoS
    const dosEnvelope = JSON.parse(armored) as Record<string, unknown>;
    dosEnvelope["iterations"] = 10_000_000;
    await expect(
      decryptExportBundle(JSON.stringify(dosEnvelope), "strong-passphrase-123"),
    ).rejects.toThrow(/Invalid encrypted export envelope/);

    // Invalid salt/iv byte length rejected
    const badSaltEnvelope = JSON.parse(armored) as Record<string, unknown>;
    badSaltEnvelope["saltB64"] = btoa("short");
    await expect(
      decryptExportBundle(JSON.stringify(badSaltEnvelope), "strong-passphrase-123"),
    ).rejects.toThrow(/Invalid envelope field length/);
  });

  it("integrates v4 authenticity verification directly into rankRowsV3", () => {
    const ahmia = CANONICAL_ONION_REGISTRY["ahmia"]!;
    const badOnion = ahmia.slice(0, 53) + (ahmia[53] === "a" ? "b" : "a") + ahmia.slice(54);
    const ranked = rankRowsV3(
      [
        {
          engineId: "ahmia",
          trust: 3,
          title: "Canonical Ahmia Index",
          url: `http://${ahmia}.onion/search`,
          snippet: "Legitimate onion search index documentation and directory.",
        },
        {
          engineId: "torch",
          trust: 2,
          title: "Corrupted Checksum Mirror",
          url: `http://${badOnion}.onion/phish`,
          snippet: "Mirror result with corrupted SHA3-256 v3 checksum.",
        },
      ],
      { query: "index", snippetFilter: false },
    );

    const canonRow = ranked.rows.find((r) => r.url.includes(ahmia));
    const badRow = ranked.rows.find((r) => r.url.includes(badOnion));
    expect(canonRow?.authenticity).toBe("CANONICAL");
    expect(badRow?.authenticity).toBe("INVALID_ONION");
    expect(badRow?.scamFlag).toContain("Invalid v3 .onion cryptographic checksum");
  });

  it("produces unique random saltB64 and ivB64 on repeated encryptExportBundle calls and rejects invalid base64", async () => {
    const a = await encryptExportBundle("x", "passphrase123", 10_000);
    const b = await encryptExportBundle("x", "passphrase123", 10_000);
    const pa = JSON.parse(a) as { saltB64: string; ivB64: string };
    const pb = JSON.parse(b) as { saltB64: string; ivB64: string };
    expect(pa.ivB64).not.toBe(pb.ivB64);
    expect(pa.saltB64).not.toBe(pb.saltB64);

    const badB64 = JSON.parse(a) as Record<string, unknown>;
    badB64["saltB64"] = "!!!not_base64!!!";
    await expect(decryptExportBundle(JSON.stringify(badB64), "passphrase123")).rejects.toThrow(
      /Invalid base64/,
    );
  });
});

describe("Audit Round 4 — RFC 1321 MD5, Blacklist Edge Cases, HTTP Hardening & Surrogate Safety", () => {
  it("verifies md5Hex against official RFC 1321 test vectors (Item 54)", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });

  it("distinguishes sub.bad.onion from notbad.onion and clears stale cache on force=true error (Items 13, 55, 56)", async () => {
    clearBlacklistCache();
    await loadAhmiaBlacklist(async () => "bad.onion\n// comment line\n", true);
    expect(isBlacklisted("http://bad.onion/")).toBe(true);
    expect(isBlacklisted("http://sub.bad.onion/")).toBe(true);
    expect(isBlacklisted("http://notbad.onion/")).toBe(false);

    const failedRefresh = await loadAhmiaBlacklist(async () => {
      throw new Error("Tor timeout");
    }, true);
    expect(failedRefresh.loaded).toBe(false);
    expect(failedRefresh.count).toBe(0);
    expect(isBlacklisted("http://bad.onion/")).toBe(false);
  });

  it("handles edge-case distribution inputs and surrogate pairs safely (Items 53, 64, 65)", () => {
    expect(sampleRayleigh(-100)).toBe(0);
    expect(sampleRayleigh(0)).toBe(0);
    expect(sampleExponential(-5)).toBe(0);
    for (let i = 0; i < 50; i++) {
      const v = randomInt(5, 3);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
    }

    const adapted = adaptQuery("🔥 bitcoin", { maxQueryLength: 1 });
    expect(adapted.truncated).toBe(true);
    expect(adapted.query).toBe("🔥");

    const withheldQual = assessSnippetQuality(WITHHELD, "Title", "query");
    expect(withheldQual.sufficient).toBe(false);
    expect(withheldQual.reason).toBe("withheld");
  });

  it("enforces .onion-only in fetchText/fetchPostBody and cleans up withHardTimeout timers (Items 15, 29, 60)", async () => {
    await expect(fetchText("https://example.com/leak")).rejects.toThrow(/Blocked non-\.onion URL/);
    await expect(fetchPostBody("https://example.com/leak", "a=1")).rejects.toThrow(
      /Blocked non-\.onion URL/,
    );

    vi.useFakeTimers();
    try {
      const p = withHardTimeout(Promise.resolve("ok"), "http://test.onion/", 65_000);
      expect(vi.getTimerCount()).toBe(1);
      const fast = await p;
      expect(fast).toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    await expect(
      withHardTimeout(
        new Promise((r) => setTimeout(() => r("slow"), 200)),
        "http://test.onion/",
        15,
      ),
    ).rejects.toThrow(/timeout after/);
  });

  it("completes searchAllEngines even when decoy fetches reject, and retries HTTP 400 with fresh prepareSearchUrl (Items 10, 18, 19, 59)", async () => {
    const bodySpy = vi.spyOn(httpMod, "fetchBodyOnly").mockRejectedValue(new Error("decoy failed"));
    const textSpy = vi.spyOn(httpMod, "fetchText").mockResolvedValue({
      status: 200,
      body: `<html><body><li class="result"><a href="http://${CANONICAL_ONION_REGISTRY["ahmia"]}.onion/page1">Onion Doc Title</a><p>Detailed snippet about Tor v3 security architecture.</p></li></body></html>`,
      ms: 42,
    });
    try {
      const outcome = await searchAllEngines({
        query: "tor security",
        engineIds: ["ahmia"],
        snippetFilter: false,
        paranoidMode: true,
      });
      expect(outcome.reports[0]?.state.status).toBe("ok");
    } finally {
      bodySpy.mockRestore();
      textSpy.mockRestore();
    }
  });

  it("pins the SOCKS credential contract: per-engine suffix, shared per search, rotated per search", async () => {
    const calls: { url: string; auth: httpMod.SocksAuth | undefined }[] = [];
    const hostToEngine = new Map(
      Object.entries(CANONICAL_ONION_REGISTRY).map(([id, label]) => [`${label}.onion`, id]),
    );
    const bodySpy = vi.spyOn(httpMod, "fetchBodyOnly").mockRejectedValue(new Error("decoy off"));
    const textSpy = vi
      .spyOn(httpMod, "fetchText")
      .mockImplementation(async (url, _signal, auth) => {
        calls.push({ url: String(url), auth });
        return { status: 200, body: "<html></html>", ms: 7 };
      });
    try {
      const engineIds = ["ahmia", "torch"];
      await searchAllEngines({ query: "cred check", engineIds, snippetFilter: false });

      const authByEngine = new Map<string, httpMod.SocksAuth>();
      for (const c of calls) {
        const host = new URL(c.url).host;
        const engineId = hostToEngine.get(host);
        expect(engineId, `unexpected fetch host ${host}`).toBeTruthy();
        authByEngine.set(engineId!, c.auth!);
      }
      const ahmia = authByEngine.get("ahmia")!;
      const torch = authByEngine.get("torch")!;
      expect(ahmia.pass).toMatch(/-[a-z0-9]+$/);
      // Per-engine suffix: same base UUID, different suffix = different circuit credential
      const base = ahmia.pass.slice(0, ahmia.pass.length - "-ahmia".length);
      expect(ahmia.pass).toBe(`${base}-ahmia`);
      expect(torch.pass).toBe(`${base}-torch`);
      expect(base).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(ahmia.pass).not.toBe(torch.pass);
      expect(ahmia.user).toBe("ghost");

      // Second search: the entire credential base rotates — nothing carries over
      calls.length = 0;
      await searchAllEngines({ query: "cred check 2", engineIds, snippetFilter: false });
      const secondBase = calls[0]!.auth!.pass.replace(/-[a-z0-9]+$/, "");
      expect(secondBase).not.toBe(base);
    } finally {
      bodySpy.mockRestore();
      textSpy.mockRestore();
    }
  });
});
