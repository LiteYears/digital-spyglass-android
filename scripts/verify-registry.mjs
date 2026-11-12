#!/usr/bin/env node
// Verifies src/lib/ghost/engines.json against committed engines.sig.json
// and the release public key, then checks the registry hash chain
// (src/lib/ghost/registry-history.json).
// Exit 1 on signature mismatch or a BROKEN chain (segment gap / rollback
// against the tip). An "unlinked" or empty chain only warns — the fail-closed
// gate is the signature itself.
// Usage: bun scripts/verify-registry.mjs

import { existsSync, readFileSync } from "node:fs";
import { createPublicKey, verify as cryptoVerify, constants } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRegistryBytes } from "../src/lib/ghost/registry-signature.ts";
import { verifyRegistryChain } from "../src/lib/ghost/registry-chain.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(
  readFileSync(join(root, "src", "lib", "ghost", "engines.json"), "utf8"),
);
const sig = JSON.parse(readFileSync(join(root, "src", "lib", "ghost", "engines.sig.json"), "utf8"));
const pem = readFileSync(join(root, "scripts", "registry-release.spki.pem"), "utf8");

if (sig.scheme !== "registry-sig-v1" || sig.algo !== "RSA-PSS-SHA256") {
  console.error(`unsupported sig scheme: ${sig.scheme}/${sig.algo}`);
  process.exit(1);
}

const ok = cryptoVerify(
  "sha256",
  canonicalRegistryBytes(registry),
  { key: createPublicKey(pem), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
  Buffer.from(sig.signature, "base64"),
);

if (!ok) {
  console.error("FAIL: engines.json does not match engines.sig.json");
  console.error(
    "      (registry changed since the last operator signature — re-sign out-of-band:",
    "bun scripts/sign-registry.mjs --key <release.pem>)",
  );
  process.exit(1);
}
console.log(`OK: registry signed by ${sig.keyFingerprint?.slice(0, 8) ?? "?"}… verifies`);

/* ── hash-chain check (informational for unlinked/empty, hard on broken) ── */
const chainPath = join(root, "src", "lib", "ghost", "registry-history.json");
if (!existsSync(chainPath)) {
  console.warn("chain: registry-history.json missing — chain verification skipped");
  process.exit(0);
}
const chainDoc = JSON.parse(readFileSync(chainPath, "utf8"));
const status = await verifyRegistryChain(registry, chainDoc);
if (status.status === "broken") {
  console.error(`CHAIN FAIL: ${status.detail}`);
  process.exit(1);
}
if (status.status === "unlinked") {
  console.warn(`chain WARN: ${status.detail}`);
} else {
  console.log(`chain: ${status.detail}`);
}
