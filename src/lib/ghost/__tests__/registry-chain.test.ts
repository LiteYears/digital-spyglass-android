import { describe, expect, it, vi } from "vitest";
import {
  bundledChain,
  decideChainUpdate,
  registryContentHash,
  refreshRegistryChainStatus,
  verifyRegistryChain,
  type ChainSegment,
  type RegistryChainFile,
} from "../registry-chain";
import { bundledRegistry } from "../engines";

const GENESIS_REGISTRY = { version: 1, engines: [{ id: "a", baseUrl: "http://x.onion" }] };

function chainOf(...segments: ChainSegment[]): RegistryChainFile {
  return { chain: segments };
}

describe("registryContentHash", () => {
  it("is deterministic over the canonical projection (health excluded)", async () => {
    const a = { version: 1, engines: [{ id: "a", health: { status: "unknown" } }] };
    const b = { engines: [{ id: "a" }], version: 1 };
    expect(await registryContentHash(a)).toBe(await registryContentHash(b));
  });

  it("changes when signed content changes", async () => {
    const a = await registryContentHash({ version: 1, engines: [] });
    const b = await registryContentHash({ version: 2, engines: [] });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("verifyRegistryChain", () => {
  it("reports empty when the chain has no segments", async () => {
    const status = await verifyRegistryChain(GENESIS_REGISTRY, chainOf());
    expect(status.status).toBe("empty");
  });

  it("accepts the tracked genesis registry (no previous field)", async () => {
    const hash = await registryContentHash(GENESIS_REGISTRY);
    const status = await verifyRegistryChain(
      GENESIS_REGISTRY,
      chainOf({ version: 1, contentHash: hash }),
    );
    expect(status.status).toBe("ok");
  });

  it("accepts a registry chained onto the tip via previous", async () => {
    const genesisHash = await registryContentHash(GENESIS_REGISTRY);
    const v2 = { previous: genesisHash, version: 2, engines: [] };
    const v2Hash = await registryContentHash(v2);
    const status = await verifyRegistryChain(
      v2,
      chainOf(
        { version: 1, contentHash: genesisHash },
        { version: 2, contentHash: v2Hash, previousHash: genesisHash },
      ),
    );
    expect(status.status).toBe("ok");
  });

  it("flags a previous link that misses the tip (rollback signal)", async () => {
    const h1 = "sha256:" + "1".repeat(64);
    const h2 = "sha256:" + "2".repeat(64);
    const status = await verifyRegistryChain(
      { previous: h1, version: 2, engines: [] },
      chainOf({ version: 1, contentHash: h1 }, { version: 2, contentHash: h2, previousHash: h1 }),
    );
    expect(status.status).toBe("broken");
  });

  it("flags a gap inside the segment list", async () => {
    const h1 = "sha256:" + "1".repeat(64);
    const h2 = "sha256:" + "2".repeat(64);
    const h3 = "sha256:" + "3".repeat(64);
    const status = await verifyRegistryChain(
      { previous: h3, version: 3, engines: [] },
      chainOf(
        { version: 1, contentHash: h1 },
        { version: 2, contentHash: h2, previousHash: h1 },
        // v3 claims v1 as predecessor — gap
        { version: 3, contentHash: h3, previousHash: h1 },
      ),
    );
    expect(status.status).toBe("broken");
  });

  it("flags changed content without a previous link as unlinked (warn-tier)", async () => {
    const hash = await registryContentHash(GENESIS_REGISTRY);
    const changed = { version: 1, engines: [{ id: "a" }, { id: "b" }] };
    const status = await verifyRegistryChain(changed, chainOf({ version: 1, contentHash: hash }));
    expect(status.status).toBe("unlinked");
  });
});

describe("decideChainUpdate (signing-time, pure)", () => {
  const H1 = "sha256:" + "a".repeat(64);
  const H2 = "sha256:" + "b".repeat(64);

  it("starts a genesis segment on an empty chain without previous", () => {
    const decision = decideChainUpdate({
      chain: [],
      registryHasPrevious: false,
      currentContentHash: H1,
    });
    expect(decision).toEqual({
      action: "genesis",
      segment: { version: 1, contentHash: H1 },
    });
  });

  it("refuses previous on an empty chain (nothing to chain onto)", () => {
    const decision = decideChainUpdate({
      chain: [],
      registryHasPrevious: true,
      registryPrevious: H1,
      currentContentHash: H2,
    });
    expect(decision.action).toBe("error");
  });

  it("plain re-sign when the content already is the tracked tip", () => {
    const decision = decideChainUpdate({
      chain: [{ version: 1, contentHash: H1 }],
      registryHasPrevious: true,
      registryPrevious: H1,
      currentContentHash: H1,
    });
    expect(decision).toEqual({ action: "tracked-resign" });
  });

  it("extends: new content without previous must embed the tip hash", () => {
    const decision = decideChainUpdate({
      chain: [{ version: 1, contentHash: H1 }],
      registryHasPrevious: false,
      currentContentHash: H2,
    });
    expect(decision).toEqual({
      action: "extend",
      setPrevious: H1,
      segmentTemplate: { version: 2, previousHash: H1 },
    });
  });

  it("extends: new content whose previous already equals the tip", () => {
    const decision = decideChainUpdate({
      chain: [{ version: 1, contentHash: H1 }],
      registryHasPrevious: true,
      registryPrevious: H1,
      currentContentHash: H2,
    });
    expect(decision.action).toBe("extend");
  });

  it("refuses to sign a registry whose previous misses the tip (rollback)", () => {
    const decision = decideChainUpdate({
      chain: [
        { version: 1, contentHash: H1 },
        { version: 2, contentHash: H2, previousHash: H1 },
      ],
      registryHasPrevious: true,
      registryPrevious: H1,
      currentContentHash: "sha256:" + "c".repeat(64),
    });
    expect(decision.action).toBe("error");
  });
});

describe("bundled chain vs bundled registry (integration)", () => {
  it("the shipped engines.json matches the tracked chain tip", async () => {
    const chain = bundledChain();
    const status = await verifyRegistryChain(bundledRegistry(), chain);
    expect(status.status).toBe("ok");
    expect(await registryContentHash(bundledRegistry())).toBe(chain.chain.at(-1)?.contentHash);
  });

  it("refreshRegistryChainStatus caches and warns only on broken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const status = await refreshRegistryChainStatus(bundledRegistry(), bundledChain());
      expect(status.status).toBe("ok");
      expect(warn).not.toHaveBeenCalled();
      const broken = await refreshRegistryChainStatus(
        { previous: "sha256:" + "0".repeat(64) },
        bundledChain(),
      );
      expect(broken.status).toBe("broken");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
