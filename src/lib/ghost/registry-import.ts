/**
 * Registry import (B16) — bring your own signed engine registry.
 *
 * An import is a `engines.json`-shaped registry plus its detached signature
 * (`registry-sig-v1`) plus — for a NEW signer — the signer's public key
 * (SPKI PEM). Fail-closed rule: an import applies ONLY when its signature
 * verifies under a trusted key AND its signed `sequence` orders at/above the
 * active floor (F3 — a replayed older signed registry is rejected, not
 * applied). Trusted keys are (a) the APK signer anchor
 * and (b) keys the operator explicitly confirmed by fingerprint
 * (SSH-known_hosts style, out-of-band comparison against SECURITY.md /
 * release notes). Public keys are stored in preferences, never private keys.
 *
 * The applied import lives in preferences separate from the bundled asset;
 * the runtime prefers the import while it verifies, and falls back to the
 * bundled registry on any failure or deletion.
 */

import { prefsStore } from "../platform/storage";
import { activeRegistry, bundledMathRe, bundledRegistry, customParserNames } from "./engines";
import {
  canonicalizeRegistry,
  parseRegistrySig,
  verifyRegistrySignature,
} from "./registry-signature";

const IMPORT_KEY = "ghost.registry.import.v1";
const TRUSTED_KEYS_KEY = "ghost.registry.trustedkeys.v1";

/* ── untrusted-input schema validation (fail closed on first violation) ── */

const MAX_IMPORT_ENGINES = 50;
/** Serialized-size ceiling for an imported registry — `health` and unknown
 *  extra keys are otherwise unbounded and would persist/re-verify every boot
 *  (R6). The bundled registry is ~11 KB; 512 KB is generous headroom. */
export const MAX_IMPORT_BYTES = 512 * 1024;
/** Detached sig files are ~0.5 KB — anything bigger is not a signature. */
export const MAX_IMPORT_SIG_BYTES = 64 * 1024;
const ENTITY_OF_DESCRIPTOR = new Set(["selectors", "custom"]);
const PREPARE_TYPES = new Set(["hidden_input", "form_introspect", "math_captcha"]);
/** Keys that must never survive an untrusted import (prototype-pollution surface). */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** v3 onion hostnames only — v2 is dead since 2021, anything else is clearnet. */
const V3_ONION_HOST = /^[a-z2-7]{56}\.onion$/;

function importFail(message: string): never {
  throw new Error(`invalid registry import: ${message}`);
}

/**
 * Strict URL check — parses and inspects the HOSTNAME. A bare string match
 * would accept `http://evil.example/x.onion` (path contains ".onion").
 */
function isHttpOnion(url: unknown): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    V3_ONION_HOST.test(parsed.hostname)
  );
}

/** URL templates must be relative to the engine base — a literal host would
 *  bypass the onion check. `{base}` may only be followed by path/query/fragment:
 *  `{base}@host` puts the onion in the userinfo slot and chooses the host. */
const BASE_TEMPLATE = /^\{base\}(?:[/?#]|$)/;
function isBaseTemplate(value: unknown): value is string {
  return typeof value === "string" && BASE_TEMPLATE.test(value);
}

/** Recursive — nested objects (incl. `health`, which sits outside the signed
 *  projection) must not smuggle prototype-pollution keys either (F8).
 *  Shared with case-file.ts: pass that parser's `fail` so error prefixes stay
 *  format-correct. */
export function checkNoForbiddenKeys(
  obj: unknown,
  path: string,
  fail: (message: string) => never = importFail,
): void {
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => checkNoForbiddenKeys(item, `${path}[${i}]`, fail));
    return;
  }
  if (typeof obj !== "object" || obj === null) return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${path}: forbidden key "${key}"`);
    checkNoForbiddenKeys(value, `${path}.${key}`, fail);
  }
}

/** Validate an engines.json-shaped object as untrusted input. Throws on any violation. */
export function validateEngineRegistry(input: unknown): void {
  if (typeof input !== "object" || input === null) importFail("payload is not an object");
  if (new TextEncoder().encode(JSON.stringify(input)).length > MAX_IMPORT_BYTES)
    importFail(`registry exceeds ${MAX_IMPORT_BYTES} serialized bytes`);
  checkNoForbiddenKeys(input, "registry");
  const { version, engines, comment, previous, sequence } = input as Record<string, unknown>;
  if (version !== 1) importFail(`unsupported version ${JSON.stringify(version)}`);
  if (comment !== undefined && typeof comment !== "string") importFail("comment must be a string");
  if (previous !== undefined && typeof previous !== "string")
    importFail("previous must be a string");
  if (
    sequence !== undefined &&
    (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0)
  )
    importFail("sequence must be a non-negative integer");
  if (!Array.isArray(engines)) importFail("engines must be an array");
  if (engines.length === 0) importFail("engines array is empty");
  if (engines.length > MAX_IMPORT_ENGINES) importFail(`more than ${MAX_IMPORT_ENGINES} engines`);

  const seen = new Set<string>();
  engines.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) importFail(`engine #${index} is not an object`);
    checkNoForbiddenKeys(raw, `engine #${index}`);
    const {
      id,
      name,
      note,
      trust,
      clearnet,
      baseUrl,
      searchUrl,
      pagedUrl,
      fallbackUrl,
      connectTimeoutMs,
      mirrors,
      enabled,
      parser,
      prepare,
      queryContract,
      health,
    } = raw as Record<string, unknown>;

    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      importFail(`engine #${index}: id missing or out of bounds`);
    }
    if (!/^[a-z0-9_-]+$/.test(id)) importFail(`engine #${index}: id has unexpected characters`);
    if (seen.has(id)) importFail(`engine #${index}: duplicate id "${id}"`);
    seen.add(id);
    if (typeof name !== "string" || name.length === 0 || name.length > 120) {
      importFail(`engine #${index}: name missing or out of bounds`);
    }
    if (typeof note !== "string" || note.length === 0 || note.length > 1000) {
      importFail(`engine #${index}: note missing or out of bounds`);
    }
    if (typeof trust !== "number" || !Number.isInteger(trust) || trust < 1 || trust > 10) {
      importFail(`engine #${index}: trust must be an integer in [1, 10]`);
    }
    if (typeof clearnet !== "boolean") importFail(`engine #${index}: clearnet must be boolean`);
    if (!isHttpOnion(baseUrl))
      importFail(`engine #${index}: baseUrl must be an http(s) .onion URL`);
    if (typeof searchUrl !== "string" || searchUrl.length === 0 || searchUrl.length > 600) {
      importFail(`engine #${index}: searchUrl missing or out of bounds`);
    }
    if (!isBaseTemplate(searchUrl)) {
      importFail(`engine #${index}: searchUrl must be "{base}" followed by / ? # or end`);
    }
    if (pagedUrl !== undefined && !isBaseTemplate(pagedUrl)) {
      importFail(`engine #${index}: pagedUrl must be "{base}" followed by / ? # or end`);
    }
    if (fallbackUrl !== undefined && !isBaseTemplate(fallbackUrl)) {
      importFail(`engine #${index}: fallbackUrl must be "{base}" followed by / ? # or end`);
    }
    if (connectTimeoutMs !== undefined) {
      if (
        typeof connectTimeoutMs !== "number" ||
        connectTimeoutMs < 1000 ||
        connectTimeoutMs > 120_000
      ) {
        importFail(`engine #${index}: connectTimeoutMs out of bounds`);
      }
    }
    if (mirrors !== undefined) {
      if (!Array.isArray(mirrors) || mirrors.length > 5) {
        importFail(`engine #${index}: mirrors must be an array (≤ 5)`);
      }
      for (const mirror of mirrors) {
        if (!isHttpOnion(mirror))
          importFail(`engine #${index}: mirror must be an http(s) .onion URL`);
      }
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      importFail(`engine #${index}: enabled must be boolean`);
    }
    if (typeof parser !== "object" || parser === null)
      importFail(`engine #${index}: parser missing`);
    const parserType = (parser as Record<string, unknown>)["type"];
    if (typeof parserType !== "string" || !ENTITY_OF_DESCRIPTOR.has(parserType)) {
      importFail(`engine #${index}: parser.type must be selectors|custom`);
    }
    if (parserType === "custom") {
      const parserName = (parser as Record<string, unknown>)["name"];
      if (typeof parserName !== "string" || !customParserNames().includes(parserName)) {
        importFail(`engine #${index}: parser.name is not a known custom parser`);
      }
    }
    if (prepare !== undefined) {
      const prep = prepare as Record<string, unknown> | null;
      const prepType = prep?.["type"];
      if (typeof prepType !== "string" || !PREPARE_TYPES.has(prepType)) {
        importFail(
          `engine #${index}: prepare.type must be hidden_input|form_introspect|math_captcha`,
        );
      }
      for (const urlKey of ["page", "postUrl"] as const) {
        const v = prep?.[urlKey];
        if (v !== undefined && v !== "{searchUrl}" && !isBaseTemplate(v)) {
          importFail(
            `engine #${index}: prepare.${urlKey} must be "{searchUrl}" or "{base}" followed by / ? # or end`,
          );
        }
      }
      const mathRe = prep?.["mathRe"];
      if (mathRe !== undefined) {
        // Length/compile checks cannot stop exponential backtracking
        // ("(\\d+)+x" compiles fine), and the 16 KB haystack cap does not help
        // there either — an imported pattern is accepted only when it is
        // identical to the bundled pattern of the same engine id.
        if (typeof mathRe !== "string" || mathRe !== bundledMathRe(id)) {
          importFail(`engine #${index}: prepare.mathRe is not the bundled pattern of this engine`);
        }
      }
    }
    if (queryContract !== undefined && typeof queryContract !== "object") {
      importFail(`engine #${index}: queryContract must be an object`);
    }
    if (health !== undefined && typeof health !== "object") {
      importFail(`engine #${index}: health must be an object`);
    }
  });
}

/* ── public-key helpers (SPKI PEM ↔ bytes, fingerprint) ───────────────── */

export function pemToSpkiBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (body.length === 0) throw new Error("public key PEM contains no key material");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** SHA-256 over the SPKI DER — same fingerprint sign-registry.mjs prints. */
export async function spkiFingerprint(spki: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", spki as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ── signature verification against trusted keys ──────────────────────── */

export type ImportVerifyResult =
  | { ok: true; verifiedBy: "apk-anchor" | "trusted-key" | "candidate"; fingerprint: string | null }
  | { ok: false; reason: string };

/**
 * The registry's signed monotonic sequence, or null when absent/malformed.
 * `sequence` lives inside the signed payload — a forged value fails the
 * signature before this is ever consulted.
 */
export function registrySequence(registry: unknown): number | null {
  const seq = (registry as Record<string, unknown> | null)?.["sequence"];
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
}

/**
 * F3 rollback gate — strict. An import must carry a signed `sequence` and it
 * must be ≥ max(bundled.sequence, active.sequence). Absent counts as nothing:
 * pre-sequence registries cannot be ordered, so they are rejected outright.
 * Returns a reject reason, or null when the ordering is acceptable.
 */
export function sequenceFloorViolation(registry: unknown): string | null {
  const incoming = registrySequence(registry);
  if (incoming === null) {
    return "registry has no signed `sequence` — unsigned-era registries cannot be ordered and are rejected";
  }
  const floor = Math.max(
    registrySequence(bundledRegistry()) ?? 0,
    registrySequence(activeRegistry()) ?? 0,
  );
  if (incoming < floor) {
    return `registry sequence ${incoming} is below the active floor ${floor} — rollback rejected`;
  }
  if (incoming === floor) {
    // Equal sequence is unordered: only an idempotent re-import of the same
    // signed content is acceptable. Two different payloads on one sequence
    // can only come from re-signing without a bump — the artifact class this
    // gate exists to reject (a stale seq-N payload could displace a newer
    // seq-N registry). Compare against every seq-bearing floor source.
    const canon = (v: unknown) => JSON.stringify(canonicalizeRegistry(v));
    const seqSources = [bundledRegistry(), activeRegistry()].filter(
      (r) => registrySequence(r) === incoming,
    );
    if (seqSources.length > 0 && !seqSources.some((r) => canon(r) === canon(registry))) {
      return `registry sequence ${incoming} collides with different signed content — same-sequence rewrites are unordered and rejected`;
    }
  }
  return null;
}

/**
 * Verify an import's signature under any trusted SPKI. Also accepts a NEW
 * candidate key (PEM) — the caller decides whether its fingerprint was
 * operator-confirmed; verification under a candidate only succeeds when
 * `confirmCandidateKey` is true, mirroring the known_hosts first-use flow.
 */
export async function verifyRegistryImport(params: {
  registry: unknown;
  sigText: string;
  trustedSpkis: Array<Uint8Array | null>;
  anchorSpki: Uint8Array | null;
  /** SHA-256 of the APK signing certificate — reported as the fingerprint
   *  when the anchor verifies, so the engines panel and the security tab
   *  name the same signer by the same id (cert hash, not SPKI hash). */
  anchorCertSha256?: string | undefined;
  candidatePem?: string | undefined;
  confirmCandidateKey?: boolean | undefined;
}): Promise<ImportVerifyResult> {
  let sig;
  try {
    sig = parseRegistrySig(params.sigText);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const tryKeys: Array<{ spki: Uint8Array; by: "apk-anchor" | "trusted-key" | "candidate" }> = [];
  if (params.anchorSpki) tryKeys.push({ spki: params.anchorSpki, by: "apk-anchor" });
  for (const spki of params.trustedSpkis) {
    if (spki) tryKeys.push({ spki, by: "trusted-key" });
  }
  let candidateSpki: Uint8Array | null = null;
  let candidateFingerprint: string | null = null;
  if (params.candidatePem) {
    try {
      candidateSpki = pemToSpkiBytes(params.candidatePem);
      candidateFingerprint = await spkiFingerprint(candidateSpki);
    } catch (error) {
      return {
        ok: false,
        reason: `candidate public key unusable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!params.confirmCandidateKey) {
      return {
        ok: false,
        reason: `untrusted signer — confirm fingerprint ${candidateFingerprint} out-of-band to trust this key`,
      };
    }
    if (candidateSpki) tryKeys.push({ spki: candidateSpki, by: "candidate" });
  }

  for (const { spki, by } of tryKeys) {
    try {
      const ok = await verifyRegistrySignature(params.registry, params.sigText, spki);
      if (ok) {
        const violation = sequenceFloorViolation(params.registry);
        if (violation) return { ok: false, reason: violation };
        const fp =
          by === "candidate"
            ? candidateFingerprint
            : by === "apk-anchor" && params.anchorCertSha256
              ? params.anchorCertSha256
              : await sigFingerprintOrDerive(spki);
        return { ok: true, verifiedBy: by, fingerprint: fp };
      }
    } catch {
      /* try next key */
    }
  }
  return {
    ok: false,
    // The sig file's self-reported keyFingerprint is attacker-controlled
    // text — echoing it would let a forged sig wear the legitimate release
    // fingerprint in an operator-facing message (R4 phishing assist).
    reason: "signature does not verify under any trusted key",
  };
}

async function sigFingerprintOrDerive(spki: Uint8Array): Promise<string | null> {
  try {
    return await spkiFingerprint(spki);
  } catch {
    return null;
  }
}

/* ── diff (health excluded — it is CI bookkeeping, not operator intent) ── */

export type RegistryDiff = {
  added: Array<{ id: string; name: string }>;
  removed: Array<{ id: string; name: string }>;
  changed: Array<{ id: string; name: string; fields: string[] }>;
};

function stripHealth(value: unknown): unknown {
  return canonicalizeRegistry(value);
}

/** Compare two registries by engine id; field names listed for changed engines. */
export function diffRegistries(current: unknown, incoming: unknown): RegistryDiff {
  const toMap = (registry: unknown) => {
    const engines = ((registry as { engines?: unknown }).engines ?? []) as Array<
      Record<string, unknown>
    >;
    const map = new Map<string, Record<string, unknown>>();
    for (const engine of engines) {
      if (typeof engine["id"] === "string") map.set(engine["id"], engine);
    }
    return map;
  };
  const currentMap = toMap(stripHealth(current));
  const incomingMap = toMap(stripHealth(incoming));
  const nameOf = (engine: Record<string, unknown>) =>
    typeof engine["name"] === "string" ? engine["name"] : String(engine["id"]);

  const diff: RegistryDiff = { added: [], removed: [], changed: [] };
  for (const [id, engine] of incomingMap) {
    const existing = currentMap.get(id);
    if (!existing) {
      diff.added.push({ id, name: nameOf(engine) });
      continue;
    }
    const fields: string[] = [];
    const keys = new Set([...Object.keys(existing), ...Object.keys(engine)]);
    for (const key of keys) {
      if (key === "health") continue;
      if (JSON.stringify(existing[key]) !== JSON.stringify(engine[key])) fields.push(key);
    }
    if (fields.length > 0) {
      fields.sort();
      diff.changed.push({ id, name: nameOf(engine), fields });
    }
  }
  for (const [id, engine] of currentMap) {
    if (!incomingMap.has(id)) diff.removed.push({ id, name: nameOf(engine) });
  }
  diff.added.sort((a, b) => a.id.localeCompare(b.id));
  diff.removed.sort((a, b) => a.id.localeCompare(b.id));
  diff.changed.sort((a, b) => a.id.localeCompare(b.id));
  return diff;
}

/* ── persistence (preferences, clearly separate from the bundled asset) ── */

export type StoredRegistryImport = {
  registry: unknown;
  sigText: string;
  verifiedByFingerprint: string | null;
  importedAt: number;
};

export type TrustedKeyEntry = {
  fingerprint: string;
  spkiBase64: string;
  confirmedAt: number;
};

export async function loadImportedRegistry(): Promise<StoredRegistryImport | null> {
  const stored = await prefsStore.getJson<StoredRegistryImport | null>(IMPORT_KEY, null);
  if (!stored || typeof stored !== "object") return null;
  return stored;
}

export async function saveImportedRegistry(entry: StoredRegistryImport): Promise<void> {
  await prefsStore.setJson(IMPORT_KEY, entry);
}

export async function clearImportedRegistry(): Promise<void> {
  await prefsStore.remove(IMPORT_KEY);
}

export async function loadTrustedKeys(): Promise<TrustedKeyEntry[]> {
  const stored = await prefsStore.getJson<{ keys?: TrustedKeyEntry[] }>(TRUSTED_KEYS_KEY, {});
  return Array.isArray(stored?.keys) ? stored!.keys! : [];
}

export async function saveTrustedKey(entry: TrustedKeyEntry): Promise<void> {
  const keys = await loadTrustedKeys();
  if (keys.some((k) => k.fingerprint === entry.fingerprint)) return;
  keys.push(entry);
  await prefsStore.setJson(TRUSTED_KEYS_KEY, { keys });
}

export async function removeTrustedKey(fingerprint: string): Promise<void> {
  const keys = (await loadTrustedKeys()).filter((k) => k.fingerprint !== fingerprint);
  await prefsStore.setJson(TRUSTED_KEYS_KEY, { keys });
}

/**
 * Panic-wipe hook — drops the stored import AND the whole trusted-key set.
 * The native hard wipe already shreds shared_prefs wholesale; this covers
 * the JS-only fallback path where the native call never runs (plugin
 * failure → exitApp) or is unreachable.
 */
export async function clearRegistryTrust(): Promise<void> {
  await clearImportedRegistry();
  await prefsStore.remove(TRUSTED_KEYS_KEY);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function spkiToBase64(spki: Uint8Array): string {
  return bytesToBase64(spki);
}

export function base64ToSpkiBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
