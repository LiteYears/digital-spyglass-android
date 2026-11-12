/**
 * Case files — sneakernet CRDT (idea 1.4).
 *
 * Two investigators (or one investigator, two devices) exchange `.json` case
 * files over any channel (USB, SecureDrop, Briar). The file IS the consensus
 * mechanism: no server, no account, no network. Merge semantics are
 * last-write-wins per entity (updatedAt timestamp) with a transparent merge
 * report.
 *
 * RAM-ONLY (invariant): a case lives in session memory and dies with the
 * purge. Import is an explicit user action that widens the session surface —
 * the UI must say so. There is deliberately NO at-rest case store.
 *
 * Sneakernet threat model: an imported file is UNTRUSTED input — the parser
 * below validates hard (same discipline as the engine parsers): size caps,
 * type whitelists, field-by-field checks, fail-closed on the first violation.
 */

import { decryptExportBundle, EXPORT_FORMAT } from "./crypto-export";
import { checkNoForbiddenKeys } from "./registry-import";

export const CASE_FORMAT = "case-file-v1";
const LEGACY_CASE_FORMAT = "ghost-case-v1";
export const MAX_CASE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CASE_ENTITIES = 500;
export const MAX_CASE_URLS_PER_ENTITY = 50;
/** Imported timestamps may be at most this far in the future (clock skew). */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const ENTITY_TYPES = new Set(["btc", "pgp", "email", "onion", "xmr", "cve", "ipv4"]);

export type CaseEntity = {
  type: string;
  value: string;
  detail?: string | undefined;
  updatedAt: number;
  urls: string[];
};

export type CaseFileV1 = {
  format: typeof CASE_FORMAT;
  exportedAt: number;
  caseName: string;
  entities: CaseEntity[];
};

/** Types whose values are case-insensitive identifiers — safe to fold into a
 *  merge key. base58 wallets (btc/xmr) are case-SENSITIVE: folding them would
 *  collide distinct addresses into one entity (F9). bech32 (`bc1…`) is the
 *  exception inside btc — BIP-173 mandates a single case, so folding is
 *  correct. Unknown types preserve case — losing an entity is worse than
 *  keeping a duplicate. */
const CASE_INSENSITIVE_TYPES = new Set(["pgp", "email", "onion", "cve", "ipv4"]);

export function caseEntityKey(entity: { type: string; value: string }): string {
  const fold =
    CASE_INSENSITIVE_TYPES.has(entity.type) ||
    (entity.type === "btc" && entity.value.toLowerCase().startsWith("bc1"));
  return `${entity.type}:${fold ? entity.value.toLowerCase() : entity.value}`;
}

/* ── export (session RAM → case file) ──────────────────────────────────── */

/**
 * Build a case file from the current session outcome rows (plus already
 * merged case entities, if any). Entities are keyed type:value(lowercase),
 * evidence urls capped per entity, updatedAt = now (this session's knowledge).
 */
export function buildCaseFile(
  rows: Array<{
    url: string;
    entities?: Array<{ type: string; value: string; detail?: string | undefined }> | undefined;
  }>,
  existing: CaseEntity[] = [],
  caseName = "session case",
  now = Date.now(),
): CaseFileV1 {
  const byKey = new Map<string, CaseEntity>();
  for (const entity of existing) {
    byKey.set(caseEntityKey(entity), { ...entity, urls: [...entity.urls] });
  }
  for (const row of rows) {
    for (const badge of row.entities ?? []) {
      const key = caseEntityKey(badge);
      let entry = byKey.get(key);
      if (!entry) {
        entry = { type: badge.type, value: badge.value, updatedAt: now, urls: [] };
        byKey.set(key, entry);
      }
      if (badge.detail && !entry.detail) entry.detail = badge.detail;
      if (entry.urls.length < MAX_CASE_URLS_PER_ENTITY && !entry.urls.includes(row.url)) {
        entry.urls.push(row.url);
      }
    }
  }
  const entities = Array.from(byKey.values())
    .sort((a, b) => caseEntityKey(a).localeCompare(caseEntityKey(b)))
    .slice(0, MAX_CASE_ENTITIES);
  return { format: CASE_FORMAT, exportedAt: now, caseName, entities };
}

/* ── import parsing (untrusted input — fail closed) ───────────────────── */

function fail(message: string): never {
  throw new Error(`invalid case file: ${message}`);
}

/** Same entity payload — value, detail and the url evidence set (order-free). */
function sameUrlSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = (urls: string[]) => [...urls].sort();
  return sorted(a).join("\n") === sorted(b).join("\n");
}

function validateEntity(raw: unknown, index: number): CaseEntity {
  if (typeof raw !== "object" || raw === null) fail(`entity #${index} is not an object`);
  const source = raw as Record<string, unknown>;
  const { type, value, detail, updatedAt, urls } = source;
  if (typeof type !== "string" || !ENTITY_TYPES.has(type)) {
    fail(`entity #${index}: unknown type ${JSON.stringify(type)}`);
  }
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    fail(`entity #${index}: value missing or out of bounds`);
  }
  if (detail !== undefined && typeof detail !== "string") {
    fail(`entity #${index}: detail must be a string`);
  }
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < 0) {
    fail(`entity #${index}: updatedAt must be a non-negative number`);
  }
  if (updatedAt > Date.now() + MAX_CLOCK_SKEW_MS) {
    fail(`entity #${index}: updatedAt too far in the future (clock skew?)`);
  }
  if (!Array.isArray(urls)) fail(`entity #${index}: urls must be an array`);
  if (urls.length > MAX_CASE_URLS_PER_ENTITY) {
    fail(`entity #${index}: more than ${MAX_CASE_URLS_PER_ENTITY} urls`);
  }
  const cleanUrls: string[] = [];
  for (const url of urls) {
    if (typeof url !== "string" || url.length > 2048) {
      fail(`entity #${index}: url missing or out of bounds`);
    }
    if (!/^https?:\/\//i.test(url))
      fail(`entity #${index}: url is not http(s): ${url.slice(0, 40)}`);
    // Control chars in URLs let sameUrlSet collide on join boundaries and
    // smuggle invisible content into evidence lists (Beam audit F9).
    for (let i = 0; i < url.length; i++) {
      const c = url.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) fail(`entity #${index}: url contains control characters`);
    }
    cleanUrls.push(url);
  }
  return {
    type,
    value,
    ...(detail !== undefined ? { detail } : {}),
    updatedAt,
    urls: cleanUrls,
  };
}

function validateCaseObject(obj: unknown): CaseFileV1 {
  if (typeof obj !== "object" || obj === null) fail("payload is not an object");
  checkNoForbiddenKeys(obj, "casefile", fail);
  const { format, exportedAt, caseName, entities } = obj as Record<string, unknown>;
  if (format !== CASE_FORMAT && format !== LEGACY_CASE_FORMAT) {
    fail(
      `unsupported format ${JSON.stringify(format)} (STIX/CSV exports are report-only, not mergeable)`,
    );
  }
  if (typeof exportedAt !== "number" || exportedAt < 0) {
    fail("exportedAt must be a non-negative number");
  }
  if (exportedAt > Date.now() + MAX_CLOCK_SKEW_MS) {
    fail("exportedAt too far in the future (clock skew?)");
  }
  if (typeof caseName !== "string" || caseName.length < 1 || caseName.length > 200) {
    fail("caseName missing or out of bounds");
  }
  if (!Array.isArray(entities)) fail("entities must be an array");
  if (entities.length > MAX_CASE_ENTITIES) {
    fail(`more than ${MAX_CASE_ENTITIES} entities`);
  }
  const validated = entities.map((entry, index) => validateEntity(entry, index));
  return { format: CASE_FORMAT, exportedAt, caseName, entities: validated };
}

/**
 * Parse untrusted case-file input. Accepts the plaintext `ghost-case-v1` JSON
 * or the existing encrypted export envelope (`ghost-encrypted-export-v1`)
 * wrapping a case payload — supply the passphrase for the latter.
 * Throws a descriptive Error on ANY violation; never returns partial data.
 */
export async function parseCaseFile(
  text: string,
  passphrase?: string,
  depth = 0,
): Promise<CaseFileV1> {
  if (typeof text !== "string" || text.length === 0) fail("empty input");
  if (text.length > MAX_CASE_FILE_BYTES) fail(`larger than ${MAX_CASE_FILE_BYTES} bytes`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("input is not valid JSON");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    ((parsed as Record<string, unknown>)["format"] === EXPORT_FORMAT ||
      (parsed as Record<string, unknown>)["format"] === "ghost-encrypted-export-v1")
  ) {
    if (depth > 0) fail("nested encrypted envelopes are not supported");
    if (!passphrase || passphrase.trim().length < 8) {
      fail("encrypted case file — passphrase required (min 8 chars)");
    }
    let inner: string;
    try {
      inner = await decryptExportBundle(text, passphrase);
    } catch {
      fail("decryption failed — wrong passphrase or tampered envelope");
    }
    return parseCaseFile(inner, undefined, depth + 1);
  }
  return validateCaseObject(parsed);
}

/* ── merge (last-write-wins per entity) ────────────────────────────────── */

export type MergeReport = {
  /** Entities only the import had. */
  added: number;
  /** Entities both sides had, import won on updatedAt, payload changed. */
  updated: number;
  /** Entities both sides had, local won on updatedAt, payload changed. */
  keptLocal: number;
  /** Entities identical on both sides. */
  unchanged: number;
  /** All payload-differing collisions (updated + keptLocal) with both stamps. */
  conflicts: Array<{
    key: string;
    localUpdatedAt: number;
    importedUpdatedAt: number;
    winner: "local" | "import";
  }>;
  totalIn: number;
  totalOut: number;
};

export type MergeResult = {
  entities: CaseEntity[];
  report: MergeReport;
};

/**
 * Merge an imported case into the local (session) case entities.
 * Last-write-wins per entity key on updatedAt; identical payloads count as
 * unchanged. Deterministic: output sorted by entity key.
 */
export function mergeCaseFiles(local: CaseEntity[], imported: CaseEntity[]): MergeResult {
  const byKey = new Map<string, CaseEntity>();
  for (const entity of local) byKey.set(caseEntityKey(entity), entity);

  const report: MergeReport = {
    added: 0,
    updated: 0,
    keptLocal: 0,
    unchanged: 0,
    conflicts: [],
    totalIn: imported.length,
    totalOut: 0,
  };

  for (const incoming of imported) {
    const key = caseEntityKey(incoming);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, incoming);
      report.added += 1;
      continue;
    }
    const samePayload =
      current.value === incoming.value &&
      (current.detail ?? "") === (incoming.detail ?? "") &&
      current.updatedAt === incoming.updatedAt &&
      sameUrlSet(current.urls, incoming.urls);
    if (samePayload) {
      report.unchanged += 1;
      continue;
    }
    const importWins = incoming.updatedAt > current.updatedAt;
    if (importWins) {
      byKey.set(key, incoming);
      report.updated += 1;
    } else {
      report.keptLocal += 1;
    }
    report.conflicts.push({
      key,
      localUpdatedAt: current.updatedAt,
      importedUpdatedAt: incoming.updatedAt,
      winner: importWins ? "import" : "local",
    });
  }

  const entities = Array.from(byKey.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entity]) => entity)
    .slice(0, MAX_CASE_ENTITIES);
  report.totalOut = entities.length;
  return { entities, report };
}
