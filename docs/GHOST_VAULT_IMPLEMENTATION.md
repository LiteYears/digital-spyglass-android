# Ghost Vault — Implementation & Security Spec
**Version:** working tree @ 2026-10-30 (uncommitted) · **Status:** device-verified on SM-G998B (Android 14)
**Audience:** external code/security review. **Repo:** `D:\MCP Mods\ghost-vault` (private; neutral name `plain-notes` by design)
**Frozen concept:** `docs/GHOST_VAULT_CONCEPT.md` v0.6 — this document describes what was *built*, verified, and where it deviates from the concept.

---

## 1. Purpose

Encrypted-at-rest companion app for an onion-search ecosystem. The sibling search app ("Ghost") is deliberately RAM-only (zero persistence). This app provides the *controlled* persistence half: an AES-256-GCM vault for onion links, clearnet links, and notes, received via Android share intents or manual entry — with the same purge discipline.

**Identity:** package `com.plain.notes`, launcher label "Notes"/"Notizen", generic notepad icon. No ecosystem branding on-device. This is a deliberate camouflage posture, not a limitation.

## 2. Hard Boundaries (what the app provably cannot do)

| Boundary | Mechanism | Verified |
|---|---|---|
| No network | Zero `INTERNET` (and no other network permission) in manifest — transmission is impossible at OS level | `aapt dump badging` |
| Only runtime permission | `POST_NOTIFICATIONS` | `aapt` |
| No cloud/device backup | `allowBackup=false`, `fullBackupContent=false`, `dataExtractionRules` excludes `root`/`path="."` for cloud-backup, device-transfer, direct-transfer | **`bmgr backupnow` refused on-device** ("Backup is not allowed") + manifest/xml |
| No screenshots / recents preview | `FLAG_SECURE` on MainActivity **and** receive dialogs (dialog windows secured explicitly — flag does not propagate) | black screencap on-device |
| Links open only in Tor Browser | `openUrl` hardcodes `org.torproject.torbrowser{,_alpha,_nightly}` via `setPackage`; never default browser | code path |

**Claim boundary on `FLAG_SECURE`:** it blocks OS-level screenshots and the
Recents preview for casual attackers and shoulder-surfers. It does **not**
resist root-level framebuffer capture (LSPosed/Magisk modules strip the flag
globally) — consistent with the app's broader non-resistance to a rooted
device, and with the panic claim boundary in §8.

## 3. Cryptography — exact parameters

Single symmetric scheme, one code path (`NoteStore.java`):

- **KDF:** PBKDF2-HMAC-SHA256, **600,000 iterations** → 256-bit key
  (bumped from 210k 2026-10-30; old envelopes decrypt — iterations is a
  per-envelope field)
- **Cipher:** AES-256-GCM, 128-bit auth tag
- **Salt:** 128-bit, `SecureRandom`, **fresh per write** (embedded in that write's envelope)
- **IV:** 96-bit, fresh per encryption
- **AAD:** envelope header string `format|PBKDF2-HMAC-SHA256|{iters}|AES-256-GCM` — header tampering fails GCM auth
- **Measured cost:** **~2.7 s** per derivation at 600k on SM-G998B
  (n=20+, 2,650–3,018 ms, `Log.d` in `derive()`). **Deliberate
  compromise, not a hardware bound:** the call resolves to the
  **BouncyCastle (`provider=BC`, verified in logcat)** pure-Java PBKDF2 —
  not Conscrypt as first assumed — iterating in the JVM (~2.7 s); a
  native BoringSSL-class implementation reaches ~700 ms–1 s. A `.so`
  dependency for ~2 s saved once per unlock is the wrong supply-chain
  trade for a security-first vault — the provider is OS-maintained and
  reviewed. Revisit only if unlock latency becomes a real UX defect.
- **Cold-seizure math (offline GPU attack on extracted `notes.gve`):**
  ~7 kH/s per RTX-4090-class GPU at 600k (Hashcat ~4.5 MH/s @1k iters
  scaled); a 100-GPU rig ≈ 7×10⁵ guesses/s → 94¹² space ≈ 10¹⁰ years,
  even weak 12-char spaces (5-word Diceware ~6×10⁵ yr, all-lowercase
  ~7×10³ yr). The binding constraint is passphrase entropy; PBKDF2's
  missing memory-hardness keeps cost linear in GPU count — Argon2id
  remains the v2 answer for exactly this.

**Iteration count — bumped to 600k 2026-10-30 (concept delta, operator-approved):**
OWASP floor for PBKDF2-HMAC-SHA256 is ≥600k; the previous 210k was a
concept-bound under-shoot. The envelope design made the bump interop-safe
**in both directions**: `iterations` is a per-envelope field, our
`checkedIters` accepts inbound 10k–1M, and the sibling parser reads the
field with identical bounds — a 600k export decrypts on the sibling side
and their 210k exports still decrypt here. New writes carry 600k; the
on-device store re-encrypts at 600k on the next write.
**Passphrase floor raised to 12 chars** in the same decision (8 was the
weaker factor; both now at current recommendation). The remaining
concept-level item is an Argon2id v2 envelope variant — deferred to the
sibling-coordinated roadmap, since the web-side KDF dispatch would need a
wasm/JS Argon2 supply-chain decision first.

**Inbound `iterations` is bounds-checked (10k–1M) on every decrypt path**
before key derivation (`checkedIters`). Without it, a hostile envelope
advertising `iterations=999999999` would pin the single VAULT thread in a
multi-minute derive — an executor DoS that also delays a queued `panicWipe`.

**Envelope** `secure-export-v1`: `{format, kdf, iterations, cipher, saltB64, ivB64, ciphertextB64}`
**Store payload** inside ciphertext: `{storeFormat:"notes-store-v1", items:[...]}`
**Item:** `{url, title?, note?, tags[], addedAt, source}`

Decrypt enforces format/kdf/cipher string equality before attempting GCM (mismatch → `SecurityException`). GCM auth failure is *all-or-nothing*: no partial salvage, and the UI honestly says "wrong passphrase OR damaged" (they are indistinguishable).

**Passphrase handling:** minimum **12 chars**, held as `char[] sessionPass` in RAM while unlocked, `Arrays.fill` zeroing on lock — best-effort under ART (**verified by reflection assertion**: the live `char[]` is all-zeros after lock, `sessionPassZeroedOnLock`; a `String`→`char[]` copy inside `derive(String)` remains a known non-zeroable artifact). KDF key is re-derived from the stored salt on *every* write — the key itself is not retained.

## 3a. Concurrency model — single-thread executor (structural, not monitor-based)

All vault mutations run on **one** `ExecutorService` thread: unlock, append,
update, delete, import, panic, every `writeAll`. This replaced an earlier
`synchronized`-method + `WRITE_LOCK` split that had a real race: a screen-off
`lock()` (class monitor) could zero `sessionPass` while `writeAll`
(`WRITE_LOCK`) was mid-`derive`, producing a store encrypted under a corrupted
key — unrecoverable on next unlock.

Semantics now:
- `lock()` flips `unlocked=false` **synchronously** (new writes rejected
  instantly) and enqueues the zeroing behind in-flight work — never blocks,
  safe on the main thread (screen-off receiver). **Deviation from concept:**
  the spec's "abort after ~2 s" became *hold-to-completion* — the queued write
  finishes cleanly, then the lock runs. Bound = queue depth, not a timer.
  Hold wins over abort: no data loss, deterministic end state.
- `panicWipe` runs `submit().get()` on the caller thread (panic responder
  kills the process immediately after — must be synchronous). Its task body
  is `finally`-guarded: RAM zeroing (`lockInternal`) runs even if a
  shred/delete throws — deterministic end state over best-effort file
  destruction. Worst-case panic latency = the task queued ahead of it:
  measured **~4.1 s** for a SAF-cap-size foreign envelope import
  (3.9 MB, 17k items, full decrypt + normalize + dedup + store write on
  SM-G998B). Queue depth is a structural bound, not a timer — and this is
  the largest honest number for it.
- Measurements (SM-G998B): write ~0.9 s at small stores, **~1.6 s at the
  10,000-item boundary** (~1.7 MB payload) — dominated by KDF, not payload.
  Import dedup is O(N+M) via a prebuilt `(url|addedAt)` HashSet — the naive
  scan version would have dominated the queue hold at 10k×17k.

## 3b. Biometric unlock — opt-in, credential-at-rest trade

`BiometricUnlock.java` + four bridge methods. **Off by default; explicit
settings toggle.** Mechanism:

- AES-256-GCM KEK `ghostvault_kek_v1` in AndroidKeyStore, `setUserAuthenticationRequired(true)`
  + `AUTH_BIOMETRIC_STRONG` (per-use auth, no validity window),
  `setInvalidatedByBiometricEnrollment(true)`, `setIsStrongBoxBacked(true)`
  when `FEATURE_STRONGBOX_KEYSTORE` is present (SM-G998B: **yes**), TEE
  fallback otherwise.
- Enrollment wraps the live session passphrase (GCM, iv(12)||ct) into
  `files/notes.keywrap`; unlock reverses it through
  `BiometricPrompt` + `CryptoObject` (crypto-bound auth — a faked callback
  cannot release the key, per MASTG).
- **Trust-model change, stated:** enabling this creates a *credential at
  rest* (the wrapped passphrase). The default passphrase-only design holds
  no persistent credential. The wrap file is useless without the Keystore
  key, the key is useless without a live biometric, and a new biometric
  enrollment invalidates the key → wrap file unrecoverable (fail-closed:
  `KeyPermanentlyInvalidatedException` → `disable()` → re-enroll).
- The vault payload itself stays passphrase-encrypted — SAF export/import
  remains fully portable; biometrics only gates the on-device unlock path.
- **Verified on device 2026-10-30 (operator + artifacts):** enroll →
  `notes.keywrap` written (iv‖ct), lock → fingerprint prompt →
  unwrap → `NoteStore.unlock` ran (600k derive lines in logcat),
  disable removes key+file.
- **Enrollment mid-session (reviewer question):** a newly added
  fingerprint invalidates the KEK — but the live session does not depend
  on it. `sessionPass` is in RAM, `writeAll` never touches the Keystore,
  so an in-flight write completes unaffected and the session survives —
  correct semantics: invalidation kills the *persisted* credential, not
  the live session. Next `unlockBiometric` →
  `KeyPermanentlyInvalidatedException` → `disable()` → passphrase path
  → re-enroll. Residual, stated: an attacker with unlocked-app access
  could re-enroll under their own biometric — but that attacker already
  holds the decrypted session (SAF export is the same exposure).
- **Coercion asymmetry, stated honestly:** a passphrase is "something
  you know" — legally protected against compelled disclosure in many
  jurisdictions; a fingerprint is "something you can be made to do."
  A compelled fingerpress unlocks faster than the panic gesture can
  be reached, and a biometric cannot be revoked. Enabling this trades
  coercion resistance for convenience — a deliberate user choice for
  threat models that don't include forced unlock, not a security
  upgrade.

## 4. On-disk layout & atomic write protocol

`files/notes.gve` (primary), `notes.gve.bak` (backup), `notes.gve.tmp` (staging).

**Write dance** (`writeAll`, on the single VAULT executor thread — see §3a):
1. Fresh salt → derive → encrypt → write `tmp` → `getFD().sync()`
2. rename `gve → bak` (if gve exists)
3. rename `tmp → gve`
4. directory fsync via `Os.fsync` (best-effort)

**Crash recovery on unlock:** gve fails → try bak (`restoredBackup` flag → honest UI banner "restored last backup, recent additions may be lost") → both fail → `terminalCorrupt` with honest non-"irrecoverable" messaging. `.tmp` is cleaned on unlock and consumed by rename.

## 5. Share receiver pipeline (`ShareReceiveActivity`)

Headless `ACTION_SEND text/plain` receiver — never boots the WebView, `noHistory`, `excludeFromRecents`.

```
ACTION_SEND → EXTRA_TEXT (fallback: EXTRA_SUBJECT) → empty? toast+finish
           → rate limit 1 share/2s (static lastAccept)
           → caller = getReferrer() (android-app:// host) else getCallingPackage()
           → unlocked? → parse+save directly (no trust check needed — session already authorized)
           → locked + caller whitelisted? → native FLAG_SECURE passphrase dialog → unlock → save (retry loop on wrong pass; two-stage create dialog on first run)
           → locked + caller NOT verifiable? → notification "Share received — tap to save after unlock"
                                                → PendingIntent(MainActivity, extra=pending_share)
                                                → RAM-held static String → UI unlock → acceptPendingShare → save
```

**Parse order:** onion `[a-z2-7]{56}\.onion` first → else clearnet `https?://\S+` (saved + toast warns it's not an onion service) → else `note://<ts>` with full text as note. Remainder text after URL extraction becomes the note.

**Pending-share lifecycle (TTL-bounded):** the notification path holds the
share text in a RAM-only static (`pendingShare` + timestamp) — never on disk.
TTL = **10 min from delivery**; `acceptPendingShare` rejects stale deliveries,
`doLock` clears it, and the share-carrying **notification auto-cancels at
expiry** (main-thread `Handler.postDelayed(cancel)`) so the user cannot tap a
dead one. The trade-off remains: the text sits in a system-held PendingIntent
extra (chooser-referrer limitation) — TTL bounds the window, does not remove it.

**Store cap:** `MAX_ITEMS = 10,000` soft cap — receiver-side `saveShared`
rejects over-cap shares with notification "Store full — open Vault to manage"
(device-verified); UI shows an inline capacity warning at ≥10k and never
hard-rejects the UI path. Write latency at the boundary: ~1.6 s (measured).

**Known design limitation (documented, not a bug):** shares routed through the system chooser expose the *resolver* as referrer, not the real sender — sender verification is impossible for chooser shares → they always take the notification path. Only direct (non-chooser) shares can trigger the cold-path prompt. Verified live with a real Tor Browser share.

## 6. Whitelist model

- **Built-ins (non-removable):** `org.torproject.torbrowser{,_alpha,_nightly}`, `org.darknetcrawler.mobile`, `com.plain.notes`
- **User whitelist:** SharedPreferences `notes_whitelist/user` string-set; merged at check time by `isTrusted()`
- **Discovery UI:** `listShareCandidates` probes `PackageManager` for `ACTION_SEND text/plain` handlers — requires the manifest `<queries>` block on Android 11+ (package visibility declaration, not a permission). Settings UI lists candidates sorted trusted-first with allow/remove.
- **Caller provenance recorded:** every item stores `source` = referrer package or `"unknown"`/`"saf-import"` — visible in item detail.

## 7. Import / export (SAF, no clipboard)

**Export** (`exportToFile` → `ACTION_CREATE_DOCUMENT`): writes a fresh `secure-export-v1` envelope whose plaintext payload is a **`case-file-v1` case file** — onion items become `onion` entities (`value`=host, `urls=[http URL]`, `detail`=note/title, `updatedAt` clamped ≤ now, capped at 500 entities) plus a `noteItems` array carrying every item losslessly. Encrypted under the session passphrase, fresh salt/IV. Verified: the decrypted payload passes the sibling app's strict `parseCaseFile` schema validation; unknown keys are tolerated, forbidden keys rejected.

**Import** (`pickImportFile` → `ACTION_OPEN_DOCUMENT` → text, 4 MiB cap): `importEnvelope` requires the encrypted outer envelope (plaintext case files are rejected — imports must be encrypted). Decrypts under the *envelope's own* passphrase (may differ from session). Payload dispatch: `notes-store-v1` → `items`; `case-file-v1` → `noteItems` preferred, `entities` fallback.

**Input hardening on import:**
- `normalizeItem` copies field-by-field (url required, ≤2048 chars; addedAt clamped to ≤now; source defaults `saf-import`) — imported JSON is treated as untrusted despite GCM auth.
- `entityToItem` accepts only `type:"onion"` entities and re-validates the onion pattern against the final URL — malformed entities cannot inject arbitrary strings as URLs.
- **Dedup:** `(url, addedAt)` pair already present → skipped (idempotent re-import: "imported 0 item(s)" on repeat). Same URL at different times = legitimately distinct.

## 8. Lock, panic, and lifecycle

| Trigger | Effect |
|---|---|
| Screen off | `NoteStore.lock()` + clipboard cleared + pending share dropped + `vaultLocked` event → WebView drops session state |
| App destroy | `NoteStore.lock()` |
| Manual "lock now" | same as screen-off |
| **Panic button** (settings) | **Native-dialog-gated nonce:** the JS tap only requests the arm — `armPanic` opens a **native AlertDialog outside the WebView** (FLAG_SECURE'd; dialog windows do not inherit), and the armed 16-byte nonce (30 s TTL, single-use, cleared on lock) is issued **only by a physical tap on DESTROY** — a gesture bundled JS cannot forge.
`armPanic` is additionally rate-limited: one dialog per **30 s**
(`armCooldownMs`) and never while a dialog is pending — a hostile JS
loop cannot banner-fatigue the user into an accidental DESTROY tap. The resolved nonce feeds `panicWipe` → 3-pass `SecureRandom` overwrite of gve/bak/tmp **+ `notes.keywrap`** → delete → `BiometricUnlock.disable()` (drops the keystore alias — panic is total loss, the opt-in credential must not survive) → lock → `killProcess`. This replaces the earlier UI-flag two-stage gate: stronger (user-gesture-bound at OS level) and simpler. |
| **PanicKit TRIGGER** (`PanicResponderActivity`, exported) | same wipe — **single-stage by design** (that is the point of an external panic trigger; asymmetry vs the in-app two-stage gate is intentional and documented here). **Signature-pinned referrer gate** (PanicKit spec: trusted sender "pinned or TOFUed"; package name alone is spoofable by a same-named app signed by another key): referrer must be `info.guardianproject.ripple` **and** its installed signing-cert SHA-256 must match a pinned digest — Guardian Project's 4096-bit release key `f006a204…` (official signing-keys page, SHA-1 `4CB3F539…` cross-verified) or the F-Droid build signature `927f7e38…` (observed on f-droid.org 0.3.2) — **or** a user-configured `panic_sender` pref in `package:sha256cert` form (bare-package form accepted but documented weaker), **or** `com.android.shell` on **`BuildConfig.DEBUG`** builds only (adb test path, compile-time stripped in release). Verified on-device: real Ripple panic wave → wipe. |
| Wrong-passphrase | retry loop, no lockout, honest error |

**Honest claim boundary:** panic performs *logical* overwrite of file extents; physical flash-block destruction is not claimed (wear-leveling) — UI text says so verbatim and points to OS-level data-wipe for hardware removal.

## 9. WebView surface + JS→native bridge boundary

React UI views: unlock / list / detail / settings. Detail: edit note/title,
delete (single item by `url`+`addedAt`), copy-url (clipboard warning +
manual clear + auto-clear on lock), "open in Tor Browser". Settings: SAF
export/import (+ paste fallback), share-whitelist manager, lock, panic.
`vaultItemAdded` event auto-refreshes on share-add while open.

**Bridge model:** Capacitor's own bridge — no app-authored
`addJavascriptInterface`, no reflection surface. The exposed API is exactly
the `@PluginMethod` allowlist in `NotesPlugin` (callables run on the bridge
thread; store ops submit to the single vault thread).

**Local-origin invariant — enforced, not asserted (code audit result):**
the WebView loads **only** bundled `dist/` assets served over Capacitor's
local `https://localhost` scheme (`webDir`, `server.androidScheme=https`,
no `server.url` configured). There is **no code path** that can load remote
content: repo-wide audit found zero `loadUrl`/`loadData`/
`loadDataWithBaseURL`/`setWebViewClient`/`evaluateJavascript`/
`addJavascriptInterface` calls in app code — the WebView is instantiated
solely by stock `BridgeActivity`, and `MainActivity` only registers the
plugin and sets `FLAG_SECURE`. `webContentsDebuggingEnabled: false`,
`allowMixedContent: false`.

**Runtime pinning (CVE-2026-103922):** the app-code audit alone is *not*
sufficient — Capacitor versions < 6.2.2/7.6.9/8.3.5/8.4.3/8.5.1 serve the
internal proxy path `/_capacitor_http_interceptor_` under the app origin,
letting a clicked link smuggle remote content into the bridge's origin
without any app `loadUrl`. This app pins `@capacitor/{core,android,cli}`
to **8.5.1** (verified in `package.json` + `node_modules` + the fix present
in the compiled source: `Bridge.java` rejects the interceptor path before
plugin dispatch). As **defense-in-depth**, `NotesPlugin.shouldOverrideLoad`
independently aborts any `/_capacitor_http_interceptor_*` load — a runtime
regression cannot silently reopen the remote-content path. Upgrade path:
if Capacitor is bumped, the pin check belongs in review, not just
`bun.lock` diff.

| Method | Unlocked-gate | Notes |
|---|---|---|
| `unlock` `lock` `isUnlocked` `acceptPendingShare` | n/a | session ops |
| `armPanic` → `panicWipe` | n/a | **user-gesture-gated nonce + rate limit**: `armPanic` shows a **native** AlertDialog — the 16-byte nonce (30 s TTL, single-use, cleared on lock) exists only if the user physically taps DESTROY. Arm calls are bounded to **one dialog per 30 s** (`armCooldownMs`, `armDialogPending` guard) — a hostile JS loop cannot spam-fatigue the user into an accidental DESTROY. PanicKit responder path bypasses the bridge and stays unconditional (§8 asymmetry). |
| `getItems` `addItem` `updateItem` `deleteItem` `importEnvelope` `exportEnvelope` | yes — store layer returns empty/false when locked | |
| `exportToFile` `pickImportFile` `openUrl` `addToWhitelist` `removeFromWhitelist` | yes — explicit `isUnlocked()` check in plugin | mutation prefs gated: whitelist cannot change while locked |
| `listShareCandidates` `getWhitelist` | no (metadata only) | read-only, no vault data |
| `biometricStatus` | no (metadata only) | hardware/enabled flags, no vault data |
| `enableBiometric` `disableBiometric` | yes (enable requires live `sessionPassCopy`) | KEK wrap lifecycle, §3b |
| `unlockBiometric` | n/a — unlock path | BiometricPrompt + CryptoObject → `NoteStore.unlock` |

Residual exposure, stated plainly:

- **JS `panicWipe` now requires a physical user gesture.** `armPanic`
  issues its nonce only from a **native** AlertDialog confirm — a window
  the WebView cannot render or tap. A compromised JS bundle can still
  *spam* armed dialogs (annoyance, bounded) but cannot wipe without a
  human physically tapping DESTROY. This closes the earlier residual
  ("JS could call arm then wipe") for the UI path; supply-chain
  resilience still rests primarily on the local-origin invariant +
  CVE pin above.
- Any read method while unlocked is reachable from JS — same threat class.
  Item text renders through React escaping (no `dangerouslySetInnerHTML`).
- The minimization lever vs a custom-scheme bridge: the allowlist is
  explicit and every destructive/read method checks `unlocked` **inside
  the native method**, not just in the JS caller.

## 10. Verified on device (SM-G998B, this round)

All of §5–§9: real Tor Browser share via chooser → notification → save (`source=unknown`); shell-planted user whitelist → cold prompt → save (`source=com.android.shell`); notification→unlock→save roundtrip; ~70-app whitelist scan; SAF export→download→decrypt→`parseCaseFile` accept; SAF import E2E; auto-refresh; dedup re-import; launcher icon. Store survives `install -r` updates.

**Hardening round (same day, post-review):** panic armed gate —
operator-verified live wipe (files gone+process dead); since upgraded to
a native-dialog-gated nonce (§8 — the confirm tap lives outside the
WebView);
dup-delete removes exactly one `(url,addedAt)` item; cap verified at a
pushed 9,999-item store (write 1.6 s at boundary, 10k items render, UI
capacity warn, receiver reject "Store full — open Vault to manage");
executor-serialized lock/unlock cycle clean.

**Second hardening round (external net-research review):**
- **PanicKit signature pinning** — verified live: real Ripple panic wave
  (F-Droid-signed `info.guardianproject.ripple`) → referrer gate → cert-pin
  match → wipe (files gone, process dead). Shell-trigger path also verified
  on the DEBUG build (`am start` → wipe).
- **Iterations bounds** — `checkedIters` 10k–1M on every inbound decrypt;
  an out-of-bounds envelope is rejected before derive (executor-DoS
  defense). Unlock treats it as "damaged" (honest GCM message), import
  returns `-2`.
- **Import worst-case hold measured: ~4.1 s** on the VAULT thread for a
  SAF-cap-size envelope (3.9 MB / 17k items, foreign envelope, full
  decrypt + normalize + dedup + 17k-item store write, SM-G998B). 7,001 of
  17,000 items imported into the live 10k store (9,999 skipped as dups —
  dedup correct at scale). This is the honest upper bound on queued
  `panicWipe` latency.
- **panicWipe `finally`** — `lockInternal` guaranteed even on mid-shred
  throw.
- **Bridge invariant audited** — zero `loadUrl`/remote-content path
  exists; see §9.
- **CVE-2026-103922** — was on `@capacitor/*` **8.5.0**, one patch below
  the fix; upgraded to **8.5.1** (mature, Aug 2026 — 8.6.0 was 2 days old
  and deliberately not taken). Runtime now rejects the interceptor path
  before plugin dispatch; `NotesPlugin.shouldOverrideLoad` repeats the
  block as a regression guard. Rebuild + reinstall + unlock smoke-verified
  on device.

**Third hardening round (9.5-push, 2026-10-30):**
- **PBKDF2 600k + 12-char floor live** — `derive()` `Log.d` measured
  **2,707 ms median** on SM-G998B (n=10); all 8 instrumented tests re-ran
  against 600k envelopes.
- **Panic armed-nonce, upgraded to native-gesture gate** — `armPanic()`
  → native AlertDialog (FLAG_SECURE'd) → DESTROY tap issues a 16-byte
  SecureRandom nonce (30 s TTL, single-use, cleared on lock); JS
  `panicWipe` rejects without it. Instrumented: `panicNonceSingleUseAnd
  Gated` + `panicNonceExpires` green. PanicKit path unchanged
  (unconditional, §8 asymmetry).
- **Fault harness** — `FileOps` seam + on-device instrumented suite; found
  and fixed a real bug (in-memory phantom item on failed write, now rolled
  back). Coverage: zeroing (reflection), crash-between-renames (bak
  restore), ENOSPC (fail-closed + rollback + store intact), 12-char floor.
- **Biometric opt-in** — StrongBox-backed KEK + BiometricPrompt+CryptoObject;
  full roundtrip operator-verified on SM-G998B (enroll → wrap file →
  fingerprint unlock, derive logged; §3b).

**Fourth round (adversarial-review follow-up, 2026-10-30):**
- **Provider verified, not assumed:** `derive()` logs `provider=` —
  resolves to **`BC` (BouncyCastle pure-Java)** on this device, the
  source of the ~2.7 s artifact (§3 correction).
- **Rollback symmetry closed:** the phantom-item class also existed in
  `updateInternal` (in-place mutation before `writeAll`) and
  `deleteInternal` (`items` swapped before `writeAll`). Both now roll
  back on write failure — RAM always equals last durable state; two new
  ENOSPC instrumented tests prove it (`failedWriteRollsBackUpdate/
  DeleteInMemory`).
- **Dialog-spam bound:** `armPanic` rate-limited (30 s cooldown +
  pending-dialog guard), `armPanicIsRateLimited` instrumented.
- **Import-DoS measured:** 999,999-iteration envelope → derive ran,
  GCM-fail `-1`, **4,611 ms wall** — bounded as designed.
- **Backup daemon verified:** `bmgr backupnow com.plain.notes` →
  "Backup is not allowed" (allowBackup=false honored at daemon level).
- **`adb backup` legacy path — finding:** on the **debuggable** build the
  archive contained `f/notes.gve` + `f/notes.keywrap` markers. Expected
  platform gate, not a release vuln: since API 31 `adb backup` works
  **only on debuggable apps** — release builds are refused at the door.
  Caveat stands for anyone sideloading a debug APK.
- **12/12 instrumented tests green** (13 incl. example test).

## 11. Remaining gaps vs concept — honest status

1. ~~10k cap~~ **done + verified** (soft cap, UI warn, receiver notification).
2. ~~panic confirm~~ **done + verified** — now stronger than the
   earlier UI-flag two-stage: the arm is issued by a **native dialog**
   outside the WebView (physical tap unforgeable by JS), see §8.
   Asymmetry to single-stage PanicKit trigger documented in §8.
3. ~~screen-off write hold~~ **done** as executor *hold-to-completion*
   (deviation from concept's "abort" — deliberate, see §3a).
4. ~~crash-point injection + mock-FS + zeroing + ENOSPC~~ **done 2026-10-30:**
   `FileOps` seam wraps every durable file op in `NoteStore`
   (exists/openRead/openWrite/rename/delete/syncDir); 8 instrumented tests
   on SM-G998B, all green — `sessionPassZeroedOnLock` (reflection asserts
   the live `char[]` is zeroed, not just nulled), `crashBetweenRenames_
   restoresBackup` (gve deleted → bak previous-good restored), `enospcWrite
   FailsClosed` (injected write fault → append false + in-memory rollback —
   a real bug found by the test: `items.put` ran before `writeAll`, phantom
   entry now rolled back), `panicNonce*` (gating, single-use, TTL expiry),
   `shortPassphraseRejected`, `biometricHardware*`.
5. `Log.d` **reintroduced deliberately** — one line in `derive()` logs
   `iters=` + ms (no sensitive data) as a permanent KDF-latency probe.
   Release-strip decision for this line is a release-time item.
6. ~~PBKDF2 210k + 8-char floor~~ **bumped 2026-10-30:** 600k iterations +
   12-char minimum (operator decision; interop-safe via the `iterations`
   field, see §3). Argon2id remains a concept-level v2 item.
7. Negative pinning path (same-named package, wrong cert) is verified by
   construction — `certMatches` requires a digest equality — but not by an
   on-device fake-package test (would require building a same-named
   trojan APK). Stated honestly rather than claimed tested.
8. **Android 15 forward-compat — checked, clean:** Android 15 can block
   *mutable implicit* `PendingIntent`s (`BLOCK_MUTABLE_IMPLICIT_PENDING_INTENTS`
   opt-in). Our notification `contentIntent` is **explicit**
   (`new Intent(ctx, MainActivity.class)`) **and immutable**
   (`FLAG_IMMUTABLE`) — neither condition applies, so the notification
   path is Android-15-safe by construction. No code change; verified
   against `ShareReceiveActivity.java:236-239`, not assumed.
9. **System clipboard *history* is out of reach:** lock clears the active
   clip; Samsung/Gboard clipboard history is a separate system store no
   SDK API touches. UI now warns the user to empty it manually —
   residual stated, not claimed solvable.
10. **Debug-build exfiltration surface:** `adb backup` extracts app data
    from **debuggable** builds regardless of `allowBackup` (verified with
    marker files on SM-G998B). Release builds (targetSdk 36) are refused
    by the platform gate — but a debug APK must be treated as an open
    window if sideloaded or left installed.

## 12. Points a reviewer should scrutinize — updated after hardening round

**Resolved this round:** pendingShare TTL (10 min, cancel-on-expiry);
`com.android.shell` panic trigger gated to `BuildConfig.DEBUG` builds;
update/delete keyed by `(url,addedAt)` (single-item semantics verified);
unused FileProvider removed; `Log.*` removed entirely; bridge methods
unlocked-gated inside native (see §9 table); monitor-split race fixed by
executor serialization (§3a); PanicKit signature pinning (§8); inbound
`iterations` bounds-check (§3); panicWipe `finally` (§3a); O(N+M) import
dedup; local-origin bridge invariant audited (§9); `FLAG_SECURE` root
claim boundary (§2); JS-`panicWipe` gate semantics stated (§9);
Capacitor CVE-2026-103922 closed by 8.5.0→8.5.1 pin + `shouldOverrideLoad`
guard (§9); PBKDF2 600k + 12-char floor (§3); panic armed-nonce (§9);
FileOps fault harness + instrumented suite incl. zeroing assertion,
crash→bak restore, ENOSPC rollback (§11.4); opt-in StrongBox/TEE biometric
KEK wrap (§3b).

**Still worth scrutiny:**
- Notification `contentIntent` carries share text in a system-held
  PendingIntent extra (not displayed) — chooser-referrer limitation; TTL
  bounds it, does not remove it.
- `panic_sender` pref has no UI — settable only via prefs; `package:sha256`
  form pins the cert, bare-package form relies on Android's same-cert
  upgrade rule (weaker, documented).
- Static `lastAccept` rate limit resets on process death — a spammer
  restarting the activity manager-side bypasses it per-process; bounded
  impact (writes serialize through the executor).
- `entityToItem` builds `http://` + value — validated against the onion
  pattern *after* construction, so garbage values are dropped not stored.
- Clipboard auto-clear on lock is a deliberate spec extension
  (concept had manual-only).
- The 10-min pendingShare TTL is code-verified, not time-verified
  (not practically observable in a test session).
- Items identical in every field (dup-import artifacts pre-dedup) are
  indistinguishable in the UI — dates now render per-row for the
  same-url/different-time case.
- The 600k derive runs on the single VAULT executor: ~2.7 s per unlock/
  write on SM-G998B. A queued `panicWipe` behind an in-flight 600k write
  inherits that latency — bounded, measured, acceptable.
- `FileOps` seam is `volatile` + package-private setter — a test hook, not
  a runtime-configurable surface. `shred()` internals keep direct RAF
  access (documented: the seam covers durable state transitions, not the
  best-effort overwrite).
- Biometric wrap = credential at rest (§3b) — opt-in only; roundtrip
  operator-verified on SM-G998B. Mid-session enrollment invalidates the
  wrap, not the live session (§3b). Compelled-fingerpress asymmetry
  documented in §3b — convenience feature, not a security upgrade.
- One `Log.d` timing line in `derive()` — no sensitive data; release-build
  strip is a release-time decision (§11.5).
