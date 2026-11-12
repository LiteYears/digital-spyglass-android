# Ghost Vault — Companion App Concept (v0.6, 2026-10-29)

> **Family-level content graduated 2026-10-30** to
> `GHOST_FAMILY_DOCTRINE.md` (ecosystem map, two-thirds doctrine, build
> order, Watch channel decisions). This document stays Vault-scoped:
> frozen concept + build deltas.

Status: concept FROZEN for v1 build. **v1 BUILT 2026-10-30** — shipped as
`com.plain.notes` "Notes" 1.0.0; operator-approved deviations from this frozen
text are listed in §Build deltas (bottom) and specified in
`GHOST_VAULT_IMPLEMENTATION.md`.
Companion decision: **Vault first, Watch second**
(dependency order — Watch's entity list IS Vault's persistence layer).
Review loop: v0.1–v0.6, five external rounds; all must-fix items resolved.
Diminishing returns reached — remaining questions are implementation detail.

## Product

**Ghost Vault** (working title — see §Naming): encrypted, Tor-native link/note
store for onion research. Second app in the Ghost family. Receives share-intents
from Tor Browser, stores onion links + notes + tags encrypted at rest, opens
links back via external intent. **Zero network permissions** — no INTERNET, no
SOCKS5, no renderer. A store, not a client.

Target audience: same as Ghost — researchers/journalists/investigators who
cannot afford cleartext Tor Browser bookmarks or persistent history.

## Why a separate app (architectural purity)

Ghost's core claim is **"zero persistence — everything dies"**. Any storage
inside Ghost — even encrypted — erodes that guarantee. Two apps, two
guarantees, no compromise:

- **Ghost** = the pure transient. RAM-only, purge triggers, zero persistence.
- **Vault** = the controlled persistent. Encrypted at rest, same purge DNA.

## The user-journey gap it closes

Ghost = `discover` → hands off to Tor Browser → dead end.
Tor Browser bookmarks are cleartext + persistent — the exact forensic trace
Ghost exists to avoid. Vault is the `keep` node:

```
discover → read → keep → monitor → submit
  Ghost   Tor      VAULT   Watch(later)  (out of scope)
```

## Threat model delta (explicit, documented)

| Protected                                                       | Not protected                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Store contents: AES-256-GCM, passphrase-derived key             | App existence on device (mitigated by neutral launcher name, §Naming)                                           |
| Plaintext lives in RAM only while unlocked                      | Item count / store size growth (v1.1: size-class padding)                                                       |
| Panic removes ALL store files incl. `.tmp` (flash caveat below) | Physical block destruction on eMMC/UFS — see honesty note                                                       |
| Screen-off → instant re-lock                                    | Unlocked-device access while vault is open                                                                      |
| Store never leaves device (`allowBackup=false`, tested)         | Coerced passphrase disclosure (no deniability v1)                                                               |
| Passphrase RAM lifetime (best-effort, ART caveat below)         | Per-item origin metadata (`source`) after decryption                                                            |
| Direct shares from unknown packages (whitelist)                 | PendingIntent delegation — a whitelisted app could hand its share intent to a hostile app; documented limit, v1 |

**Flash destruction — the honest claim.** Panic wipe unlinks
`notes.gve` + `notes.gve.bak` + `notes.gve.tmp` and overwrites logical
sectors (3-7 passes fresh random data as probabilistic hardening). On
eMMC/UFS flash physical deletion is NOT guaranteed — wear-leveling may
leave old blocks intact until garbage collection. Panic screen and
`THREAT_MODEL` state: _"Panic removes the store and overwrites logical
sectors; physical block destruction on flash is not guaranteed. Operators
requiring hardware-level destruction must wipe app data via OS or destroy
the device."_ Never claim "shredded = physically destroyed".

**JVM zeroing — the honest limit.** `char[]` zeroing under ART is
best-effort: JIT may elide writes, GC may copy array references. A
determined attacker with live process-memory access may recover remnants.

Design rules carried over: no backend, no accounts, no telemetry, no ads,
no INTERNET permission (stronger than Ghost — the app cannot transmit).

## Crypto binding — reuse `secure-export-v1` verbatim

Same envelope as `src/lib/ghost/crypto-export.ts` (field-identical):

- `PBKDF2-HMAC-SHA256`, 210,000 iterations, 128-bit random salt
- `AES-256-GCM`, 96-bit random IV, 128-bit tag, envelope header as AAD
- passphrase ≥ 8 chars, fresh salt+IV per write

**Format placement**: envelope `format` stays the strict literal
`secure-export-v1`; the vault version lives INSIDE the payload:
`{storeFormat:"notes-store-v1", items:[...]}`. Consequence: Vault and Case
files are envelope-indistinguishable — parsers MUST check `storeFormat`
after decryption and reject mismatches cleanly.
Items: `{url, title?, note?, tags[], addedAt, source}` — `source` =
best-effort (ghost / tor-browser / saf-import / unknown). Imported items
KEEP their original `source`; only items created by the current import
get `saf-import` — the provenance chain survives round-trips (load-bearing
for Watch later).

## Storage — atomic write dance + corruption states

`notes.gve` in app-private files dir. Every write runs the full atomic
sequence (crash at any point leaves ≥1 intact file):

1. write envelope to `notes.gve.tmp` + fsync
2. rename `notes.gve` → `notes.gve.bak` (atomic)
3. rename `notes.gve.tmp` → `notes.gve` (atomic)
4. `.tmp` cleanup — and on any aborted write (bounded-hold expiry, parse
   failure) `.tmp` is cleaned on the NEXT write or on unlock; it is also
   covered by panic wipe.

**Corruption ladder at unlock:**

- `notes.gve` fails GCM/parse → fall back to `.bak`, show: _"Store damaged —
  restored last backup. Recent additions may be lost."_ (item count is
  unknowable on auth failure — never claim a number)
- BOTH files fail → terminal state: _"Store irrecoverably damaged — the
  encryption envelope failed authentication. No recovery is possible.
  Start fresh, or restore from an external export."_ AES-GCM is
  all-or-nothing per envelope: no "decryptable fragments" exist in a
  single-envelope store. Partial recovery requires chunked envelopes —
  §v1.1 item 5.
- **I/O failure on the `.tmp` write itself** (ENOSPC/EIO): the existing
  store stays intact (step-1 failure never touches `notes.gve`/`.bak`) and
  the receiver surfaces a rejection notification "Could not save —
  storage error". No silent write failure.

**Store size**: soft cap ~10k items / ~5 MB (three files per write → 3×
spike). UI path: warn inline, never hard-reject. **Headless receiver
path**: over-cap shares are rejected with a notification "Store full —
open Vault to manage" — the only write path without UI must make the
state visible rather than silently lose the share.

## Share-intent flow — two-tier path + receiver hardening

1. `ShareReceiveActivity` (native, headless, `noHistory`,
   `excludeFromRecents`) registers `ACTION_SEND` `text/plain`. Never boots
   the WebView. Extras parse order: `EXTRA_TEXT` first, else
   `EXTRA_SUBJECT`; both empty → toast "Nothing to save", store nothing.
   Then: encrypt, atomic-write, one toast, `finish()`.
2. **Unlocked case** (<1.5 s): passphrase from session `Service` `char[]`.
3. **Cold case**: inline native passphrase prompt (whitelisted packages
   only), then write. <1.5 s applies ONLY unlocked. A plaintext buffer
   slot on disk is NOT an option.
4. Full React UI boots only on explicit open (PanicResponder pattern).

**Receiver hardening:**

- **Package whitelist (cold path)**: passphrase prompt shows only for
  shares from trusted packages (Tor Browser builds, SAF, Ghost). Unknown
  packages → rejection **notification** ("Share from unknown app — tap to
  allow") — a headless toast is invisible inside Tor Browser; the
  notification routes to the whitelist manager.
- **User-extensible whitelist**: Settings screen lists installed apps
  offering `ACTION_SEND text/plain`; operator consciously adds. Covers
  the maintenance case where a Tor Browser build changes package ID
  (Vault has no network to auto-update).
- **Single-writer lock** around the write dance; **rate limit** ~1 share /
  2 s, excess dropped quietly.
- **Screen-off during a write**: the in-flight write holds the passphrase
  for a bounded window (max ~2 s), then aborts with toast "Share aborted —
  vault locked". Defined behavior, not a race.

**Non-URL shared text — parse order**: (1) `.onion` URL found → URL +
surround as note; (2) other URL → store + warn once; (3) no URL → pure
note. Simple rule (valid v3 `.onion` hostname present) — `.i2p`/`.bit`/
typos are out of v1 scope and get the clearnet warning.
Toast wording: "This is a clearnet URL — Tor Browser still protects your
connection, but the site itself is not an onion service."

## Passphrase policy (decided for v1)

- Session-scoped `Service` `char[]` while unlocked; **zeroed on re-lock,
  screen-off, app exit** (ART honesty note above). In-flight share writes
  get the bounded 2 s hold (above).
- Cold-share = inline re-prompt, whitelisted only.
- ~~No biometric gate in v1.~~ — **superseded 2026-10-30**: opt-in biometric
  unlock shipped in v1 (§Build deltas 1).

## Purge integration — the three triggers, adapted

| Trigger                  | Ghost behavior    | Vault behavior                                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Panic wipe               | hard wipe + kill  | probabilistic overwrite + unlink **`notes.gve` + `.bak` + `.tmp`**, wipe passphrase, kill — flash caveat applies |
| Screen off / device lock | purge RAM session | re-lock: drop plaintext + passphrase from RAM (bounded 2 s write-hold exception), keep encrypted files           |
| App exit                 | purge             | same re-lock                                                                                                     |

Panic = total loss default. **Opt-out triple-gated**: warning dialog at
enable + persistent panic-screen indicator + re-confirm after every update.

## SAF import (separate path, not the share receiver)

`ACTION_OPEN_DOCUMENT` from inside the app UI: user picks an envelope
file, Vault decrypts + merges items, sets `source:"saf-import"` on newly
created items only (existing `source` values preserved). Wrong passphrase /
non-envelope / mismatched `storeFormat` each get a distinct rejection.
Export emits a `case-file-v1`-shaped payload inside the shared envelope —
**interop is a test-gate item**: the emitted payload must satisfy
`parseCaseFile`'s schema strictly (verified in the crypto test suite).

## Manifest hardening (all from line one, all testable)

- `android:allowBackup="false"` + `fullBackupContent="false"` +
  `dataExtractionRules` (API 31+) — store never rides a backup transport.
- `FLAG_SECURE` on every window.
- **Zero INTERNET, zero network capabilities** — aapt badging shows no
  network permissions. Precisely: the ONLY runtime permission is
  `POST_NOTIFICATIONS` (API 33+), used solely for share-rejection/storage
  notices — it grants no network or data access. "Zero caps" means
  network caps; permission honesty requires this sentence.
- Only intent-filters: `ACTION_SEND text/plain` receiver (+ standard
  `OPEN_DOCUMENT` UI path).

## Clipboard hygiene

No auto-clear (breaks flows, clobbers foreign clipboard; A13+ shows the
access toast). Warn-toast on copy + manual "Clear clipboard" button on
the detail screen.

## Screens (one + a receiver)

- **List**: newest-first, search over decrypted RAM copy, tag chips, tap →
  detail (note edit, tags, open-in-Tor-Browser intent, delete → re-encrypt
  immediately, Clear-clipboard action).
- **Unlock**: passphrase prompt; lock button always visible.
- **Settings**: user whitelist manager, panic-mode indicator, export.
- **ShareReceiveActivity**: inline passphrase prompt only when cold +
  whitelisted.
- No FileProvider-cleartext ever.

## Test strategy (v1 gate list)

- Manifest: zero INTERNET/network caps, `POST_NOTIFICATIONS` present (and
  ONLY it as runtime permission), `allowBackup=false`, `FLAG_SECURE`.
- Crypto: fresh salt/IV per write, wrong passphrase + tamper + envelope-
  format mismatch rejected cleanly; interop export round-trips through
  Ghost's `parseCaseFile` (schema-verified).
- Store: atomic dance — debug-build injectable crash points (killProcess
  at each step) + mock-FS unit test; `.bak` fallback notice; double-
  corruption reaches terminal state; ENOSPC/EIO on `.tmp` → intact store +
  rejection notification; size-cap warn in UI, cap-reject notification in
  receiver; `.tmp` cleanup on next write/unlock.
- Receiver: whitelist enforce (unknown → notification, no prompt), user
  whitelist extension honored, rate limit, writer-lock under concurrent
  shares, screen-off bounded hold then abort, `EXTRA_SUBJECT` fallback,
  empty-share "Nothing to save".
- Purge: panic removes gve+bak+tmp (absence verified — NOT "physical
  destruction"); re-lock drops plaintext + passphrase — debug reflection
  assertion on `char[]` (memory-dump = debug-only).

## §v1.1 — deferred, explicitly tracked

1. Store-size padding to classes (4/16/64 KB).
2. ~~PBKDF2 latency measured on SM-G998B~~ — done at build: ~2.7 s per
   derivation at 600k (§Build deltas 2).
3. Duress/decoy vault — gated on naming.
4. Passphrase-cache timing + JIT-zeroing audit.
5. **Chunked envelopes** (~50 items/chunk) — the only design making
   partial salvage real; deferred (multiplies write complexity).
6. **Hard store ceiling** (~20k items with a defined UI error) — turns
   the "soft cap" into a real bound (two-thirds doctrine §3).
7. **Native KDF dependency — target Argon2id, not PBKDF2.** Android
   ships no native PBKDF2 provider (verified 2026-10-30: default resolves
   to BouncyCastle pure-Java, ~2.7 s @600k). Any native KDF means a
   bundled `.so`/JNI — the app's first native dependency: real supply-
   chain surface (ABI bundling, signing, native auditability). If that
   cost is paid once, spend it on **Argon2id** — memory-hard, closes the
   GPU attack surface, buys security _and_ speed — not on merely faster
   PBKDF2 (convenience only). Library choice (BoringSSL, minimal impl,
   `argon2kt`) is part of the decision; measured numbers, not assumed.
8. **Clipboard-history residual** — OEM clipboard history persists
   copied URLs beyond app control; upgrade the label to "consciously
   unbounded leak" or remove copy for affected builds.

## Naming — DECIDED (2026-10-29)

- **Launcher label**: `Notes` (default/`values-en`) — LOCALIZED per-locale
  generic note-app label (`values-de` → `Notizen`, etc.). The camouflage
  is the localized form, not the word.
- **Package ID**: `com.plain.notes` — verified free on F-Droid
  (2026-10-29, API 404). `com.*` blends best in package lists; plain +
  notes is banal and plausible as a small-dev app.
  REJECTED: `org.darknetcrawler.vault` (direct Ghost reference — package
  list is permission-free readable); `de.samui.notes` (samui-lab-group
  publicly links samui → ghost-search — fingerprint through association);
  `com.notizblock.app` (operator preference: no German labeling).
  FINAL at first install: package-ID change later = new identity + store
  migration. Do NOT reuse any single namespace across future family apps —
  a shared marker becomes the signature.
- **Icon**: generic note-pad glyph matching the banal category — no lock,
  vault, key, or ghost imagery.
- **Leak sweep**: no "samui"/"darknet"/"ghost" strings anywhere in the new
  app's manifest comments, build.gradle author fields, or F-Droid metadata.

Honest description lives in the F-Droid listing; the on-device fingerprint
is fully neutral.

## Decisions taken (consolidated)

1. Passphrase cache: session `char[]`, zeroed on triggers; in-flight write
   bounded 2 s hold; cold-share re-prompt (whitelisted).
2. Duress/decoy: v1.1. 3. `source`: best-effort, preserved on import.
3. Naming: `com.plain.notes`, localized "Notes" — decided, built. 5. Clipboard: warn + manual.
4. Panic opt-out: triple-gated. 7. Corruption: atomic dance + `.bak` +
   honest terminal state (no salvage promise — chunked = v1.1.5).
5. Flash: probabilistic overwrite, no physical-destruction claim.
6. Receiver: whitelist + user extension + notification on reject + lock +
   rate limit + defined screen-off semantics + cap-reject notification +
   ENOSPC notification.
7. Interop: export emits case-file payload; verified as test gate.

## §Build deltas — v1 as shipped vs frozen concept (2026-10-30)

All deviations below were operator-approved during the build and are fully
specified in `GHOST_VAULT_IMPLEMENTATION.md`. The frozen text above stays
as the review baseline; this section is the reconciliation.

1. **Biometric unlock shipped in v1** (contradicts the frozen "No biometric
   gate in v1" — superseded). Opt-in, off by default: passphrase-wrapping
   KEK in StrongBox (TEE fallback), `BiometricPrompt` + `CryptoObject`
   per-use auth (no validity window),
   `setInvalidatedByBiometricEnrollment(true)`, wrapped credential at
   `files/notes.keywrap`. Documented trade: a fingerprint can be compelled —
   convenience, not a security upgrade; the user decides.
2. **KDF hardened: 210k → 600k PBKDF2 + 12-char floor** (frozen text says
   210k / ≥8). OWASP floor for PBKDF2-HMAC-SHA256 is ≥600k; ~2.7 s derive
   on SM-G998B (v1.1 item 2 resolved by measurement). Interop preserved
   both directions: `iterations` is a per-envelope field, bounds-checked
   10k–1M on every decrypt path — Ghost's 210k exports still decrypt here,
   our 600k exports decrypt there.
3. **Panic scope extended**: frozen wipe set was `notes.gve` + `.bak` +
   `.tmp`; shipped wipe adds `notes.keywrap` and drops the biometric
   keystore alias (opt-in credential must not survive panic). Panic
   triggering is the native armed-nonce gate — user-gesture-bound at OS
   level, replacing the earlier two-stage UI flag.
4. **Naming executed**: `com.plain.notes`, launcher `Notes` localized
   per-locale (§Naming already records the decision; the frozen
   "Decisions taken" line read "pick pending" — corrected inline).

Ecosystem position after v1: `keep` (Vault) is shipped; `monitor` (Watch)
is the next family element — see `GHOST_FAMILY_DOCTRINE.md` for the map,
the channel posture ladder and the two-thirds doctrine that govern it.
