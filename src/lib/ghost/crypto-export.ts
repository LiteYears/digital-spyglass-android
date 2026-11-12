/**
 * Ghost v4.0 — Passphrase-Encrypted RAM Export (`AES-256-GCM` + `PBKDF2-HMAC-SHA256`).
 *
 * Ensures that exported CSV or STIX 2.1 intelligence bundles never touch
 * `getCacheDir()/piano/exports/` in plaintext when shared via Android's
 * FileProvider.
 *
 * Cryptographic parameters (OWASP 2024 Password Storage Cheat Sheet):
 *  - KDF: PBKDF2-HMAC-SHA256, 210,000 iterations, 128-bit random salt
 *  - Cipher: AES-256-GCM, 96-bit random IV, 128-bit authentication tag
 */

export const EXPORT_FORMAT = "secure-export-v1";
const LEGACY_EXPORT_FORMAT = "ghost-encrypted-export-v1";

export type EncryptedExportEnvelope = {
  format: typeof EXPORT_FORMAT | typeof LEGACY_EXPORT_FORMAT;
  kdf: "PBKDF2-HMAC-SHA256";
  iterations: number;
  cipher: "AES-256-GCM";
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
};

const DEFAULT_PBKDF2_ITERATIONS = 210_000;
const MIN_PBKDF2_ITERATIONS = 10_000;
const MAX_PBKDF2_ITERATIONS = 1_000_000;

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new Error("Invalid base64 encoding in export envelope");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesGcmKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("WebCrypto SubtleCrypto API is unavailable in this runtime");
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

function buildEnvelopeAad(format: string, iterations: number): Uint8Array {
  return new TextEncoder().encode(
    `${format}|PBKDF2-HMAC-SHA256|${iterations}|AES-256-GCM`,
  );
}

/**
 * Encrypts a plaintext export string (CSV or STIX 2.1 JSON) in RAM into a
 * serialized `EncryptedExportEnvelope` JSON string.
 *
 * Generates a fresh 128-bit random salt and a fresh 96-bit random IV on every
 * invocation (preventing key/IV reuse across exports) and binds the envelope
 * header fields as AES-GCM Additional Authenticated Data (AAD).
 */
export async function encryptExportBundle(
  plaintext: string,
  passphrase: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<string> {
  if (!passphrase || passphrase.trim().length < 8) {
    throw new Error("Passphrase must be at least 8 non-whitespace characters");
  }
  if (
    !Number.isInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("PBKDF2 iteration count out of bounds [10000, 1000000]");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildEnvelopeAad(EXPORT_FORMAT, iterations);
  const key = await deriveAesGcmKey(passphrase, salt, iterations, ["encrypt"]);
  const encoded = new TextEncoder().encode(plaintext);

  const encryptedBuf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: 128,
    },
    key,
    encoded,
  );

  const envelope: EncryptedExportEnvelope = {
    format: EXPORT_FORMAT,
    kdf: "PBKDF2-HMAC-SHA256",
    iterations,
    cipher: "AES-256-GCM",
    saltB64: bytesToBase64(salt),
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(new Uint8Array(encryptedBuf)),
  };

  return JSON.stringify(envelope, null, 2);
}

/**
 * Decrypts and authenticates a serialized `EncryptedExportEnvelope` JSON string
 * in RAM. Throws if the passphrase is wrong or if the ciphertext/tag was tampered with.
 */
export async function decryptExportBundle(
  envelopeJson: string,
  passphrase: string,
): Promise<string> {
  if (!passphrase || passphrase.trim().length < 8) {
    throw new Error("Passphrase must be at least 8 non-whitespace characters");
  }
  const parsed = JSON.parse(envelopeJson) as Partial<EncryptedExportEnvelope>;
  if (
    (parsed.format !== EXPORT_FORMAT && parsed.format !== LEGACY_EXPORT_FORMAT) ||
    parsed.kdf !== "PBKDF2-HMAC-SHA256" ||
    parsed.cipher !== "AES-256-GCM" ||
    typeof parsed.iterations !== "number" ||
    !Number.isInteger(parsed.iterations) ||
    parsed.iterations < MIN_PBKDF2_ITERATIONS ||
    parsed.iterations > MAX_PBKDF2_ITERATIONS ||
    typeof parsed.saltB64 !== "string" ||
    typeof parsed.ivB64 !== "string" ||
    typeof parsed.ciphertextB64 !== "string"
  ) {
    throw new Error("Invalid encrypted export envelope");
  }

  const salt = base64ToBytes(parsed.saltB64);
  const iv = base64ToBytes(parsed.ivB64);
  const ciphertext = base64ToBytes(parsed.ciphertextB64);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
    throw new Error("Invalid envelope field length");
  }
  const aad = buildEnvelopeAad(parsed.format, parsed.iterations);

  const key = await deriveAesGcmKey(passphrase, salt, parsed.iterations, ["decrypt"]);
  const decryptedBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: 128,
    },
    key,
    ciphertext as BufferSource,
  );

  return new TextDecoder().decode(decryptedBuf);
}
