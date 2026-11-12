/**
 * STIX 2.1 export — converts Ghost search results to OASIS STIX 2.1 bundles.
 *
 * STIX (Structured Threat Information Expression) is an OASIS standard for
 * representing cyber threat intelligence. This module converts ResultRow[]
 * to a STIX Bundle containing Observables, Indicators, and Relationships.
 *
 * Reference: OASIS STIX 2.1 specification (2021).
 *
 * Output is a JSON string suitable for download or API response.
 * All generation happens in RAM — nothing is persisted.
 */

import type { EntityBadge, ResultRow } from "./types";

export type STIXBundle = {
  type: "bundle";
  id: string;
  objects: STIXObject[];
};

export type STIXObject = {
  type: string;
  id: string;
  created: string;
  modified: string;
  [key: string]: unknown;
};

function stixId(type: string): string {
  // Fresh UUID per export — STIX 2.1 allows this, and a 32-bit content hash
  // would let crafted inputs collide two distinct objects into one identity.
  return `${type}--${crypto.randomUUID()}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

function entityToObservable(entity: EntityBadge, sourceRef: string): STIXObject | null {
  const base = { created: nowISO(), modified: nowISO() };
  switch (entity.type) {
    case "btc":
      return {
        type: "cryptocurrency-wallet",
        id: stixId("cryptocurrency-wallet"),
        ...base,
        value: entity.value,
        currency: "bitcoin",
      };
    case "xmr":
      return {
        type: "cryptocurrency-wallet",
        id: stixId("cryptocurrency-wallet"),
        ...base,
        value: entity.value,
        currency: "monero",
      };
    case "email":
      return {
        type: "email-addr",
        id: stixId("email-addr"),
        ...base,
        value: entity.value,
      };
    case "onion":
      return {
        type: "url",
        id: stixId("url"),
        ...base,
        value: entity.value,
      };
    case "ipv4":
      return {
        type: "ipv4-addr",
        id: stixId("ipv4-addr"),
        ...base,
        value: entity.value,
      };
    case "cve":
      return {
        type: "vulnerability",
        id: stixId("vulnerability"),
        ...base,
        name: entity.value,
        external_references: [
          {
            source_name: "cve",
            external_id: entity.value,
          },
        ],
      };
    case "pgp":
      return null;
    default:
      return null;
  }
}

export function resultsToSTIX(rows: ResultRow[], query: string): string {
  const objects: STIXObject[] = [];
  // Dedup on semantic keys — ids are fresh UUIDs per export, so identity
  // lives in the (type,value) pair, not in the emitted id string.
  const canonical = new Map<string, STIXObject>();
  const emit = (key: string, make: () => STIXObject): STIXObject => {
    const existing = canonical.get(key);
    if (existing) return existing;
    const obj = make();
    canonical.set(key, obj);
    objects.push(obj);
    return obj;
  };

  for (const row of rows) {
    const urlObj = emit(`url:${row.url}`, () => ({
      type: "url",
      id: stixId("url"),
      created: nowISO(),
      modified: nowISO(),
      value: row.url,
      name: row.title,
      description: row.snippet,
      labels: ["onion-search-result"],
      external_references: [
        {
          source_name: "ghost-search",
          description: `Found via engines: ${row.engines.join(", ")}`,
        },
      ],
    }));

    if (row.entities) {
      for (const entity of row.entities) {
        const observable = entityToObservable(entity, urlObj.id);
        if (observable) {
          const canonObs = emit(`obs:${entity.type}:${entity.value}`, () => observable);
          emit(`rel:${urlObj.id}|${canonObs.id}`, () => ({
            type: "relationship",
            id: stixId("relationship"),
            created: nowISO(),
            modified: nowISO(),
            relationship_type: "related-to",
            source_ref: urlObj.id,
            target_ref: canonObs.id,
            description: `Entity found in search result for query: ${query}`,
          }));
        }
      }
    }
  }

  const bundle: STIXBundle = {
    type: "bundle",
    id: stixId("bundle"),
    objects,
  };

  return JSON.stringify(bundle, null, 2);
}

function escapeCsvCell(value: string): string {
  // Neutralize spreadsheet formula injection: cells arriving from untrusted
  // engine HTML that start with = + - @ or control chars get a leading
  // apostrophe (Excel convention renders them as literal text).
  // Leading whitespace too — spreadsheet apps still evaluate " =...".
  // Control chars explicitly: "\x07=cmd" must not slip past the guard
  // (Beam audit F5). charCode check instead of regex — no-control-regex.
  const first = value.charCodeAt(0);
  if (/^[\s=+\-@]/.test(value) || first <= 0x1f || first === 0x7f) {
    value = `'${value}`;
  }
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function resultsToCSV(rows: ResultRow[]): string {
  const header = "title,url,snippet,engines,entities,score";
  const lines = rows.map((row) => {
    const entities = (row.entities ?? []).map((e) => `${e.type}:${e.value}`).join("; ");
    return [
      escapeCsvCell(row.title),
      escapeCsvCell(row.url),
      escapeCsvCell(row.snippet),
      escapeCsvCell(row.engines.join("; ")),
      escapeCsvCell(entities),
      row.score.toFixed(4),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}
