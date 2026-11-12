# `reminder-list-v1` — Watch Work-Set Envelope (format spec v0.1, 2026-10-30)

Status: DRAFT — prerequisite for Watch concept (build order,
`GHOST_FAMILY_DOCTRINE.md`). Companion to `GHOST_VAULT_CONCEPT.md`;
shares the outer envelope with `secure-export-v1`.

## What it is

The only data Vault ever hands to Watch: a metadata-only work set.
Fixed rule (§Ecosystem map): **Watch receives `(url, addedAt)` — nothing
else.** Notes, titles, tags and `source` never leave Vault toward Watch,
because Watch is the family's only node holding both network access and
Vault-derived data.

## Envelope

Outer envelope **verbatim `secure-export-v1`** (same code path as
Vault SAF export). **Decided: shared literal, `storeFormat` inside the
payload** — the `format` field sits in the cleartext AAD header, so a
dedicated `reminder-list-v1` literal would be a plaintext family marker on
a file that rests in shared storage under Stage 1. Shared literal keeps
the file indistinguishable from a Vault store or Ghost case export (the
camouflage property §Naming pays for). Rejected alternative — own literal:
its only gain is rejecting a wrong file before the 2.7 s PBKDF2 derive;
a UX nicety on an error path, not worth a fingerprint.

- `PBKDF2-HMAC-SHA256`, per-envelope `iterations` field, **bounds-checked
  10k–1M on every decrypt path** (same rule as Vault: a hostile envelope
  advertising `iterations=999999999` must not pin the parse thread).
- `AES-256-GCM`, 96-bit random IV, 128-bit tag, envelope header as AAD.

**Producer/consumer boundary (2026-10-30):** Ghost emits
`secure-export-v1` / `case-file-v1`; Vault and Watch accept only the
new literals (strict `.equals()`, no normalization, no legacy
fallback). Legacy accept (`ghost-encrypted-export-v1`,
`ghost-case-v1`) exists ONLY in Ghost itself — Ghost is the public
identity, so a legacy literal there costs nothing; in the camouflaged
consumers the same string would be a family fingerprint. Old files on
SAF may still carry retired literals and raw-package `source` values —
treat them as dead: re-export, don't analyze.
`source` is never a raw package name — producers/coarse mapping emit
`browser` / `share` / `saf-import` / `unknown` only.
- **Passphrase: dedicated watch-export passphrase, never the Vault
  passphrase.** Min 12 chars — same floor as the Vault store: the work set
  is less sensitive, but the passphrase is set once and pays the 2.7 s
  derive once per cycle, not per item; a weaker floor would need its own
  justification. A compromised Watch must not gain a credential that also
  opens the main store. Chosen/stored per doctrine (bounded, revocable).

Payload:

```json
{
  "storeFormat": "reminder-list-v1",
  "exportedAt": 1761820000000,
  "items": [
    { "url": "http://abc…def.onion/path", "addedAt": 1761700000000 }
  ]
}
```

Parser rules (Watch side): `storeFormat` must match exactly — envelope
and payload format are indistinguishable at the ciphertext layer, so a
`notes-store-v1` store file fed to Watch fails clean, and vice versa.
Unknown optional fields are ignored (forward compat); missing `url` in an
item drops the item, not the file. **Writer rule (Vault side): the
exporter MUST NOT emit `title`, `note`, `tags` or `source` into this
payload** — the metadata-only rule is enforced at the producer, not left
to parser discipline.

## Single envelope — no chunking (decided)

`reminder-list-v1` is always one envelope. At the Vault soft cap (~10k
items) the payload is ~600 KB. Chunked envelopes exist (Vault v1.1 #5) to
make *partial salvage* possible — but a work set is re-exportable, so
partial salvage is worthless here and the write complexity buys nothing.
If the format ever grows past ~5 MB, revisit.

## Carriage

| Stage | Mechanism | Residual |
|---|---|---|
| 0 (default) | Manual SAF export file `watch-export.gwe`, user moves/imports | none beyond user's own file hygiene |
| 1 (opt-in) | SAF-granted directory, **on-demand write only** | ciphertext at rest in shared storage; manual write per sync cycle |
| 2 (deferred) | Bound service, caller-cert pinning | not specified here |

Auto-write on Vault item change is **rejected** (timestamp-pattern leak —
see `GHOST_FAMILY_DOCTRINE.md`, Stage 1).

## Result envelope (R2 — reserved, not v1)

`ghost-watch-result-v1` is reserved for the deferred write-back path:
`{checkedAt, results:[{url, status, lastSeen}]}` through Vault's existing
SAF import. `status` uses the check vocabulary defined in
`GHOST_WATCH_CONCEPT.md` §Check semantics: `up`, `down` (with sub-codes
like `down-http-403`), `seizure-signature-match` (carries signature-list
version + bundle date), `unreachable-circuit`. Not built in Watch v1
(Stage 0/1 start at R1 = ephemeral).

## Security notes

- Explicit residual: **a compromised Watch build can exfiltrate the
  exported work set `(url, addedAt)` — bounded by design, not by code.**
  Vault contents beyond that subset are structurally unreachable from
  Watch. That set is exactly what Vault exists to protect, hence
  metadata-only is non-negotiable. **Extended residual** (full text in
  `GHOST_WATCH_CONCEPT.md` §threat model 1): if the passphrase rests on
  the device (Stage-1 polling requires it), credential extraction +
  SAF write enables *envelope injection* — steering an honest Watch to
  attacker-chosen services and observing the device's Tor behavior
  through attacker endpoints. Passive leak becomes active compromise.
- Watch's Tor-only property is a **code invariant**; the envelope itself
  carries no transport guarantee. Treat every export as: this file may end
  up anywhere the user puts it — that's why it contains the minimum.
- Distinct rejection per failure class (wrong passphrase / non-envelope /
  `storeFormat` mismatch), same convention as Vault SAF import.
