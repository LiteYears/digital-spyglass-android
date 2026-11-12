#!/usr/bin/env node
// Signs src/lib/ghost/engines.json -> src/lib/ghost/engines.sig.json.
// Detached RSA-PSS/SHA-256 signature over the canonical projection
// (health.* excluded, keys sorted — mirrors src/lib/ghost/registry-signature.ts).
// Hash-chain aware: embeds `previous` (SHA-256 of the canonicalised predecessor
// registry) into engines.json BEFORE signing and appends a segment to
// src/lib/ghost/registry-history.json (see registry-chain.ts for semantics).
// Usage: bun scripts/sign-registry.mjs --key ~/.ghost-keys/registry-signing.pem
//        [--cert scripts/registry-release.pub.pem] [--sequence <n>]
// --sequence is REQUIRED the first time (genesis: --sequence 1); afterwards the
// value in engines.json is kept unless --sequence overrides it. The field is
// part of the signed payload — the import gate rejects registries without it.
// Never commit the private key.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, sign as cryptoSign, constants } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRegistryBytes } from "../src/lib/ghost/registry-signature.ts";
import { decideChainUpdate } from "../src/lib/ghost/registry-chain.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, envName) => {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return envName ? process.env[envName] : undefined;
};

const keyPath = opt("key", "GHOST_REGISTRY_KEY");
const certPath = opt("cert") ?? join(root, "scripts", "registry-release.pub.pem");
const registryPath = join(root, "src", "lib", "ghost", "engines.json");
const sigPath = join(root, "src", "lib", "ghost", "engines.sig.json");
const chainPath = join(root, "src", "lib", "ghost", "registry-history.json");

if (!keyPath) {
  console.error("missing --key <private.pem> (or GHOST_REGISTRY_KEY)");
  process.exit(1);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const privateKey = readFileSync(keyPath, "utf8");

/* ── sequence (F3) — monotonic version inside the signed payload ── */
const seqBefore = typeof registry.sequence === "number" ? registry.sequence : undefined;
const seqArg = opt("sequence");
const seqNum = seqArg === undefined ? undefined : Number(seqArg);
if (seqArg !== undefined && (!Number.isInteger(seqNum) || seqNum < 0)) {
  console.error(`--sequence must be a non-negative integer, got ${JSON.stringify(seqArg)}`);
  process.exit(1);
}
if (registry.sequence === undefined) {
  if (seqNum === undefined) {
    console.error("engines.json has no `sequence` — pass --sequence <n> (genesis: 1)");
    process.exit(1);
  }
  registry.sequence = seqNum;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  console.log(`sequence: ${seqNum} embedded into engines.json (genesis)`);
} else if (seqNum !== undefined && seqNum !== registry.sequence) {
  if (seqNum < registry.sequence) {
    console.error(
      `--sequence ${seqNum} is below current ${registry.sequence} — refusing to regress`,
    );
    process.exit(1);
  }
  registry.sequence = seqNum;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  console.log(`sequence: bumped to ${seqNum} in engines.json`);
}

/* ── chain bookkeeping — `previous` must land inside the signed payload ── */
const hashOf = (value) =>
  `sha256:${createHash("sha256").update(canonicalRegistryBytes(value)).digest("hex")}`;

let chainDoc = { chain: [] };
if (existsSync(chainPath)) chainDoc = JSON.parse(readFileSync(chainPath, "utf8"));
const currentContentHash = hashOf(registry);
const decision = decideChainUpdate({
  chain: chainDoc.chain,
  registryHasPrevious: typeof registry.previous === "string",
  registryPrevious: typeof registry.previous === "string" ? registry.previous : undefined,
  currentContentHash,
});

if (decision.action === "error") {
  console.error(`chain: ${decision.reason}`);
  process.exit(1);
}
if (decision.action === "genesis") {
  chainDoc.chain.push({
    ...decision.segment,
    ...(typeof registry.sequence === "number" ? { sequence: registry.sequence } : {}),
    signedAt: new Date().toISOString(),
  });
  console.log(`chain: genesis segment v1 appended (${currentContentHash.slice(0, 24)}…)`);
} else if (decision.action === "tracked-resign") {
  console.log("chain: content already tracked at the tip — plain re-sign");
} else if (decision.action === "extend") {
  // New signed content must order strictly above the last signed sequence —
  // re-signing changed bytes at the same sequence produces unordered
  // artifacts the import gate now rejects (equal-seq different-content, R1).
  const finalSeq = typeof registry.sequence === "number" ? registry.sequence : undefined;
  const tipSeq = decision.tipSequence;
  const ordered =
    finalSeq !== undefined &&
    (tipSeq !== undefined ? finalSeq > tipSeq : seqNum !== undefined && seqNum > (seqBefore ?? -1));
  if (!ordered) {
    console.error(
      `chain: content differs from the tracked tip but sequence does not order above it ` +
        `(tip sequence: ${tipSeq ?? "untracked"}, registry sequence: ${finalSeq ?? "none"}) ` +
        `— pass --sequence to bump`,
    );
    process.exit(1);
  }
  if (registry.previous !== decision.setPrevious) {
    registry.previous = decision.setPrevious;
    writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
    console.log(`chain: previous=${decision.setPrevious} embedded into engines.json`);
  }
  chainDoc.chain.push({
    version: decision.segmentTemplate.version,
    contentHash: hashOf(registry),
    previousHash: decision.segmentTemplate.previousHash,
    sequence: finalSeq,
    signedAt: new Date().toISOString(),
  });
}

/* ── sign AFTER any previous embedding ─────────────────────────────────── */
const message = canonicalRegistryBytes(registry);
const signature = cryptoSign("sha256", message, {
  key: privateKey,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: 32,
});

let keyFingerprint = "";
try {
  keyFingerprint = createHash("sha256")
    .update(
      Buffer.from(
        readFileSync(certPath, "utf8")
          .replace(/-----[^-]+-----/g, "")
          .replace(/\s+/g, ""),
        "base64",
      ),
    )
    .digest("hex");
} catch {
  console.error(`warning: could not hash cert at ${certPath} — keyFingerprint left empty`);
}

const out = {
  scheme: "registry-sig-v1",
  algo: "RSA-PSS-SHA256",
  keyFingerprint,
  signature: signature.toString("base64"),
};
writeFileSync(sigPath, JSON.stringify(out, null, 2) + "\n");
writeFileSync(chainPath, JSON.stringify(chainDoc, null, 2) + "\n");
console.log(`wrote ${sigPath}`);
console.log(`chain: ${chainDoc.chain.length} segment(s) tracked in registry-history.json`);
console.log(`signer cert sha256: ${keyFingerprint}`);
