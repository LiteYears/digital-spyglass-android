/**
 * Engine-registry integrity — detached RSA-PSS signature over a canonical
 * projection of engines.json, verified against the APK signing certificate.
 *
 * The operator signs the registry out-of-band with the release key and commits
 * engines.sig.json; the build only consumes committed bytes (F-Droid
 * reproducible-build safe). At boot the native anchor supplies the public key
 * of whoever signed this APK — the same identity F-Droid pins via
 * AllowedAPKSigningKeys — and verification proves the registry was authored by
 * that signer. The canonical projection excludes `health.*` (rewritten weekly
 * by scripts/engine-healthcheck.mjs) so health merges never invalidate the sig.
 */
export const REGISTRY_SIG_SCHEME = "registry-sig-v1";

export type RegistryIntegrity = "unchecked" | "verified" | "failed";

export type RegistryAnchor = {
  /** SPKI (SubjectPublicKeyInfo) bytes of the APK signing key, base64. */
  spkiBase64: string;
  /** SHA-256 of the signing certificate, lowercase hex. */
  certSha256: string;
};

export type RegistrySigFile = {
  scheme: string;
  algo: string;
  keyFingerprint: string;
  signature: string;
};

export function canonicalizeRegistry(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return canonicalizeNode(value);
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (key === "health") continue;
    out[key] =
      key === "engines" && Array.isArray(src[key])
        ? (src[key] as unknown[]).map(stripEngineHealth)
        : canonicalizeNode(src[key]);
  }
  return out;
}

/**
 * `health` is unsigned CI bookkeeping only as a direct key of the registry
 * root and of each `engines[]` entry — anywhere deeper it is signed content,
 * so future fields cannot silently land outside the projection (R5). The
 * strip is positional, never name-based: a nested key that happens to be
 * called `engines` cannot reopen an unsigned surface (F1).
 */
function stripEngineHealth(item: unknown): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return canonicalizeNode(item);
  }
  const src = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (key === "health") continue;
    out[key] = canonicalizeNode(src[key]);
  }
  return out;
}

function canonicalizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeNode);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalizeNode(src[key]);
    }
    return out;
  }
  return value;
}

export function canonicalRegistryBytes(registry: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalizeRegistry(registry)));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function parseRegistrySig(sigFile: string): RegistrySigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sigFile);
  } catch {
    throw new Error("registry signature file is not valid JSON");
  }
  const sig = parsed as Partial<RegistrySigFile>;
  if (sig.scheme !== REGISTRY_SIG_SCHEME) {
    throw new Error(`unsupported registry signature scheme: ${String(sig.scheme)}`);
  }
  if (sig.algo !== "RSA-PSS-SHA256" || typeof sig.signature !== "string") {
    throw new Error("registry signature file is malformed");
  }
  return sig as RegistrySigFile;
}

export async function verifyRegistrySignature(
  registry: unknown,
  sigFile: string,
  spki: Uint8Array,
): Promise<boolean> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("integrity check unavailable: no WebCrypto");
  }
  const sig = parseRegistrySig(sigFile);
  const key = await crypto.subtle.importKey(
    "spki",
    spki as BufferSource,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    base64ToBytes(sig.signature) as BufferSource,
    canonicalRegistryBytes(registry) as BufferSource,
  );
}

export type AnchorProvider = () => Promise<RegistryAnchor>;

/**
 * The cached verdict is bound to the canonical content it verified (F5):
 * a state change that forgets resetRegistryVerification can never apply a
 * stale "verified" to different registry bytes.
 */
let integrityState: RegistryIntegrity = "unchecked";
let integrityFingerprint: string | null = null;
let verifiedContentKey: string | null = null;
let pending: { key: string; p: Promise<RegistryIntegrity> } | null = null;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function registryIntegrity(): RegistryIntegrity {
  return integrityState;
}

/**
 * Reset cached verification state — required after swapping the active
 * registry (bundled → import or back) so the next gate run re-verifies
 * against the actually active content. Defense-in-depth on top of the
 * content key, not a substitute for it.
 */
export function resetRegistryVerification(): void {
  integrityState = "unchecked";
  integrityFingerprint = null;
  verifiedContentKey = null;
  pending = null;
}

export function registryAnchorFingerprint(): string | null {
  return integrityFingerprint;
}

/**
 * Idempotent boot-time verification. `registry` is the parsed bundled registry,
 * `loadSig` returns the committed sig-file contents, `loadAnchor` supplies the
 * APK signer's public key (native layer). Any failure — malformed sig, missing
 * anchor, WebCrypto absence, verification false — lands in "failed".
 */
export function ensureRegistryVerified(
  registry: unknown,
  loadSig: () => Promise<string>,
  loadAnchor: AnchorProvider,
): Promise<RegistryIntegrity> {
  return (async () => {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      integrityState = "failed";
      return integrityState;
    }
    const key = await sha256Hex(canonicalRegistryBytes(registry));
    if (integrityState !== "unchecked" && verifiedContentKey === key) return integrityState;
    if (pending && pending.key === key) return pending.p;
    const p = (async () => {
      try {
        const [sigFile, anchor] = await Promise.all([loadSig(), loadAnchor()]);
        const ok = await verifyRegistrySignature(
          registry,
          sigFile,
          base64ToBytes(anchor.spkiBase64),
        );
        integrityFingerprint = anchor.certSha256;
        integrityState = ok ? "verified" : "failed";
      } catch {
        integrityState = "failed";
      }
      verifiedContentKey = key;
      if (pending?.key === key) pending = null;
      return integrityState;
    })();
    pending = { key, p };
    return p;
  })();
}

/**
 * Verify the ACTIVE registry (bundled or import) against any trusted key:
 * the APK anchor OR one of the operator-confirmed import keys (SSH
 * known_hosts style). Updates the same global integrity state the security
 * screen reads — including WHICH key verified (F4): a trusted-key import
 * reports its own signer's SPKI fingerprint, the anchor reports its cert
 * hash. Used when an import is active — an import signed by an additional
 * trusted key must pass the fail-closed gate too.
 */
export async function ensureActiveRegistryVerified(
  registry: unknown,
  loadSig: () => Promise<string>,
  loadAnchor: AnchorProvider,
  loadTrustedSpkis: () => Promise<Uint8Array[]>,
): Promise<RegistryIntegrity> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    integrityState = "failed";
    return integrityState;
  }
  const key = await sha256Hex(canonicalRegistryBytes(registry));
  if (integrityState !== "unchecked" && verifiedContentKey === key) return integrityState;
  try {
    const [sigFile, trusted] = await Promise.all([loadSig(), loadTrustedSpkis()]);
    const anchor = await loadAnchor().catch(() => null);
    for (const spki of trusted) {
      if (!spki) continue;
      try {
        if (await verifyRegistrySignature(registry, sigFile, spki)) {
          integrityState = "verified";
          integrityFingerprint = await sha256Hex(spki);
          verifiedContentKey = key;
          return integrityState;
        }
      } catch {
        /* try the next key */
      }
    }
    if (anchor?.spkiBase64) {
      try {
        if (await verifyRegistrySignature(registry, sigFile, base64ToBytes(anchor.spkiBase64))) {
          integrityState = "verified";
          integrityFingerprint = anchor.certSha256;
          verifiedContentKey = key;
          return integrityState;
        }
      } catch {
        /* fall through to failed */
      }
    }
    integrityState = "failed";
  } catch {
    integrityState = "failed";
  }
  verifiedContentKey = key;
  return integrityState;
}
