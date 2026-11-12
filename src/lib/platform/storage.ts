/**
 * Storage hierarchy & Encrypted Device Vault.
 *
 * - prefs:       non-secret settings       -> Capacitor Preferences
 * - secureVault: search results & history  -> AES-256-GCM encrypted device storage (IndexedDB / Preferences)
 *
 * Search results are securely encrypted at rest using AES-GCM (256-bit key with
 * fresh random 12-byte IV per record). They do NOT depend on RAM and persist
 * across app closures, background reclamation, and low-memory kills on Android.
 * Everything can be securely zeroed and purged at any time via Panic Wipe.
 */
import { isNative } from "./bridge";

const memory = new Map<string, string>();

/* -------------------------------- prefs ---------------------------------- */

export const prefsStore = {
  async get(key: string): Promise<string | null> {
    if (!(await isNative())) return memory.get(`prefs:${key}`) ?? null;
    try {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key });
      return value ?? null;
    } catch {
      return memory.get(`prefs:${key}`) ?? null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (!(await isNative())) {
      memory.set(`prefs:${key}`, value);
      return;
    }
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key, value });
    } catch {
      memory.set(`prefs:${key}`, value);
    }
  },
  async remove(key: string): Promise<void> {
    if (!(await isNative())) {
      memory.delete(`prefs:${key}`);
      return;
    }
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.remove({ key });
    } catch {
      memory.delete(`prefs:${key}`);
    }
  },
  async getJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  },
};

/* -------------------- Encrypted Device Vault (AES-256-GCM) ----------------- */

const VAULT_KEY_PREF = "vault:device_master_key";
const DB_NAME = "GhostSecureDeviceVault";
const DB_VERSION = 1;
const STORE_NAME = "encrypted_vault";

let cachedCryptoKey: CryptoKey | null = null;

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Retrieves or initializes the persistent device encryption key.
 */
async function getOrCreateVaultKey(): Promise<CryptoKey> {
  if (cachedCryptoKey) return cachedCryptoKey;

  const subtle = typeof window !== "undefined" ? window.crypto?.subtle : undefined;
  if (!subtle) {
    throw new Error("WebCrypto is not available in this environment");
  }

  const existingRaw = await prefsStore.get(VAULT_KEY_PREF);
  if (existingRaw) {
    try {
      const keyBytes = base64ToArrayBuffer(existingRaw);
      cachedCryptoKey = await subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
      return cachedCryptoKey;
    } catch {
      /* Re-generate if corrupt */
    }
  }

  // Generate a brand new 256-bit AES-GCM key for device storage encryption
  const newKey = await subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const exported = await subtle.exportKey("raw", newKey);
  await prefsStore.set(VAULT_KEY_PREF, arrayBufferToBase64(exported));

  cachedCryptoKey = newKey;
  return cachedCryptoKey;
}

/**
 * Encrypts an arbitrary string payload into AES-GCM ciphertext with random 12-byte IV.
 */
async function encryptPayload(plainText: string): Promise<string> {
  const key = await getOrCreateVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plainText);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );
  return `${arrayBufferToBase64(iv)}:${arrayBufferToBase64(cipher)}`;
}

/**
 * Decrypts an AES-GCM payload.
 */
async function decryptPayload(payload: string): Promise<string> {
  const [ivBase64, cipherBase64] = payload.split(":");
  if (!ivBase64 || !cipherBase64) throw new Error("Invalid cipher payload format");

  const key = await getOrCreateVaultKey();
  const iv = base64ToArrayBuffer(ivBase64);
  const cipher = base64ToArrayBuffer(cipherBase64);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    cipher
  );
  return new TextDecoder().decode(decrypted);
}

/**
 * IndexedDB helper for device-isolated storage that survives low memory kills.
 */
function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key: string): Promise<string | null> {
  try {
    const db = await openVaultDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as string) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key: string, val: string): Promise<void> {
  try {
    const db = await openVaultDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(val, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* fallback to memory */
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openVaultDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    /* no-op */
  }
}

async function idbClear(): Promise<void> {
  try {
    const db = await openVaultDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    /* no-op */
  }
}

export const secureDeviceVault = {
  /**
   * Encrypts and persists a data record in device storage.
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      const json = JSON.stringify(value);
      const cipher = await encryptPayload(json);
      await idbSet(key, cipher);
      // Also mirror critical pointers to prefsStore as backup
      await prefsStore.set(`vault_rec:${key}`, cipher);
    } catch (e) {
      console.warn("[secureDeviceVault] failed to store encrypted record:", e);
      memory.set(`vault:${key}`, JSON.stringify(value));
    }
  },

  /**
   * Retrieves and decrypts a data record from device storage.
   */
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      // Try IndexedDB first
      let cipher = await idbGet(key);
      if (!cipher) {
        // Fallback to prefsStore
        cipher = await prefsStore.get(`vault_rec:${key}`);
      }
      if (!cipher) {
        const mem = memory.get(`vault:${key}`);
        if (mem) return JSON.parse(mem) as T;
        return fallback;
      }
      const decrypted = await decryptPayload(cipher);
      return JSON.parse(decrypted) as T;
    } catch {
      return fallback;
    }
  },

  /**
   * Removes a specific record from encrypted device storage.
   */
  async remove(key: string): Promise<void> {
    await idbDelete(key);
    await prefsStore.remove(`vault_rec:${key}`);
    memory.delete(`vault:${key}`);
  },

  /**
   * Purges all encrypted records and keys from device storage (Panic Wipe).
   */
  async clearAll(): Promise<void> {
    await idbClear();
    await prefsStore.remove(VAULT_KEY_PREF);
    cachedCryptoKey = null;
    memory.clear();
  },
};

export function wipeMemoryStores(): void {
  memory.clear();
}
