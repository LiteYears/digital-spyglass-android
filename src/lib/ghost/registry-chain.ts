/**
 * Registry hash chain — integrity history for engines.json (idea 3.2).
 *
 * Every registry update the operator signs carries a `previous` field with
 * the SHA-256 of the canonicalised *predecessor* registry content, and the
 * signed append happens in `scripts/registry-history.json` (chain segments:
 * version + contentHash + previousHash). The chain makes silent rollbacks to
 * older *still-validly-signed* registry versions visible — a rollback that
 * ships an old engines.json + old engines.sig.json passes signature checks,
 * but its `previous` no longer matches the chain tip.
 *
 * Runtime policy (task rule): the chain is INFORMATIONAL — a broken link
 * warns loudly (security screen + console), it never blocks search. The
 * fail-closed gate stays the detached signature. Nothing here is persisted.
 */

import { canonicalRegistryBytes } from "./registry-signature";

import chainFile from "./registry-history.json";

export type ChainSegment = {
  version: number;
  /** SHA-256 of the canonicalised registry content of this version (incl. its own `previous`). */
  contentHash: string;
  /** contentHash of the predecessor version — absent on the genesis segment. */
  previousHash?: string;
  /** Registry `sequence` this version was signed with — recorded since the
   *  equal-sequence hardening; absent on segments signed before it. */
  sequence?: number;
  signedAt?: string;
};

export type RegistryChainFile = { chain: ChainSegment[] };

export function bundledChain(): RegistryChainFile {
  return chainFile as RegistryChainFile;
}

/** SHA-256 over the canonical registry projection, hex with sha256: prefix. */
export async function registryContentHash(registry: unknown): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("registry chain unavailable: no WebCrypto");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    canonicalRegistryBytes(registry) as BufferSource,
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

export type ChainStatus =
  | { status: "ok"; detail: string }
  | { status: "empty"; detail: string }
  | { status: "unlinked"; detail: string }
  | { status: "broken"; detail: string };

function segmentsLink(chain: ChainSegment[]): number | null {
  for (let i = 1; i < chain.length; i++) {
    if (chain[i]!.previousHash !== chain[i - 1]!.contentHash) return i;
  }
  return null;
}

/**
 * Verify the bundled registry against the bundled chain. Variants:
 *  - ok        — registry chains onto the tip (previous === tip.contentHash),
 *                or the registry IS the tracked genesis (hash match, no previous)
 *  - empty     — chain not initialised yet (pre-chain build; informational)
 *  - unlinked  — registry content changed but carries no `previous` (update
 *                signed without chaining — WARN, operator process mistake)
 *  - broken    — segment gap, or `previous` points somewhere other than the tip
 *                (rollback / tamper signal — WARN loudly, never fail-closed)
 */
export async function verifyRegistryChain(
  registry: unknown,
  chain: RegistryChainFile,
): Promise<ChainStatus> {
  const segments = chain.chain ?? [];
  if (segments.length === 0) {
    return { status: "empty", detail: "chain not initialised — genesis pending" };
  }
  const gap = segmentsLink(segments);
  if (gap !== null) {
    return {
      status: "broken",
      detail: `chain segment ${gap} does not link to segment ${gap - 1}`,
    };
  }
  const tip = segments[segments.length - 1]!;
  const previous = (registry as { previous?: unknown } | null)?.previous;
  if (typeof previous === "string") {
    // Case A — the shipped registry is a NEW version whose chain segment is
    // pending (chain file lags behind): previous must name the current tip.
    if (previous === tip.contentHash) {
      return { status: "ok", detail: `chained onto v${tip.version}` };
    }
    // Case B — the shipped registry IS the tracked tip: previous must name the
    // segment before it (the predecessor), and the registry hash must match.
    const predecessor = segments.length >= 2 ? segments[segments.length - 2]! : undefined;
    const hash = await registryContentHash(registry);
    if (predecessor && hash === tip.contentHash && previous === predecessor.contentHash) {
      return {
        status: "ok",
        detail: `tracked v${tip.version} chained onto v${predecessor.version}`,
      };
    }
    return {
      status: "broken",
      detail: `registry previous ≠ chain tip (v${tip.version}) — rollback or tamper`,
    };
  }
  const hash = await registryContentHash(registry);
  if (hash === segments[0]!.contentHash) {
    return { status: "ok", detail: `tracked genesis (v${segments[0]!.version})` };
  }
  return {
    status: "unlinked",
    detail: "registry content is not the tracked genesis and carries no previous",
  };
}

/* ── signing-time chain math (pure, used by scripts/sign-registry.mjs) ─── */

export type ChainDecision =
  | { action: "genesis"; segment: ChainSegment }
  | { action: "tracked-resign" }
  | {
      action: "extend";
      setPrevious: string;
      /** The tip's recorded `sequence`, when the chain tracks it — the
       *  signing script requires new content to order strictly above this. */
      tipSequence?: number | undefined;
      segmentTemplate: { version: number; previousHash: string };
    }
  | { action: "error"; reason: string };

/**
 * Decide what signing must do to the chain. `currentContentHash` is the hash
 * of the registry file AS IT IS on disk right now (including any `previous`
 * already present). Pure function — clock/fs access stays in the script.
 */
export function decideChainUpdate(input: {
  chain: ChainSegment[];
  registryHasPrevious: boolean;
  registryPrevious?: string | undefined;
  currentContentHash: string;
}): ChainDecision {
  const tip = input.chain[input.chain.length - 1];
  if (!tip) {
    if (input.registryHasPrevious) {
      return { action: "error", reason: "registry has a previous link but the chain is empty" };
    }
    return { action: "genesis", segment: { version: 1, contentHash: input.currentContentHash } };
  }
  if (input.currentContentHash === tip.contentHash) {
    return { action: "tracked-resign" };
  }
  if (input.registryHasPrevious && input.registryPrevious !== tip.contentHash) {
    return {
      action: "error",
      reason: "registry previous ≠ chain tip — refusing to sign a broken/rolled-back chain",
    };
  }
  return {
    action: "extend",
    setPrevious: tip.contentHash,
    tipSequence: typeof tip.sequence === "number" ? tip.sequence : undefined,
    segmentTemplate: { version: tip.version + 1, previousHash: tip.contentHash },
  };
}

/* ── runtime status (warn, never block) ────────────────────────────────── */

let chainStatus: ChainStatus | null = null;

export function registryChainStatus(): ChainStatus | null {
  return chainStatus;
}

/**
 * Compute and cache the runtime chain status for the bundled registry.
 * Called opportunistically from the boot verification path — any failure
 * (e.g. missing WebCrypto) leaves status null, which the UI reports as
 * "unknown" rather than healthy.
 */
export async function refreshRegistryChainStatus(
  registry: unknown,
  chain: RegistryChainFile = bundledChain(),
): Promise<ChainStatus> {
  try {
    chainStatus = await verifyRegistryChain(registry, chain);
  } catch (error) {
    chainStatus = {
      status: "empty",
      detail: `chain check unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (chainStatus.status === "broken") {
    console.warn(`[ghost] registry chain: ${chainStatus.detail}`);
  }
  return chainStatus;
}
