# Ghost Family — Ecosystem Map & Doctrine (v1, 2026-10-30)

Authoritative plan for the Ghost app family. Graduated from
`GHOST_VAULT_CONCEPT.md` when the family sections outgrew that document —
the Vault concept is FROZEN and describes what was built; this document
describes where the family goes.

**Documents in scope:**
- `GHOST_VAULT_CONCEPT.md` — Vault concept (frozen, v1 shipped)
- `GHOST_VAULT_IMPLEMENTATION.md` — Vault build spec (as-built)
- `GHOST_WATCH_ENVELOPE_V1.md` — Watch work-set format spec (draft)
- `GHOST_WATCH_CONCEPT.md` — Watch concept (draft)

**Staleness convention:** sections carry `last-verified: <date>`,
marking when their claims were last checked against the built code.
A section without a marker reflects the doc version date, not
verified-as-of-today state.

## §Ecosystem map — the complete extension

The journey `discover → read → keep → monitor → submit`, spelled out as
components. Every element follows the §Ecosystem doctrine below: a fixed
security floor (invariant), plus a bounded convenience budget.

_Status column last-verified: 2026-10-30._

| Node | Element | Status | Capability envelope | Must NEVER |
|---|---|---|---|---|
| discover | **Ghost** | shipped (F-Droid) | Tor-routed onion search, RAM session, purge triggers | persist anything |
| read | Tor Browser | external | renders, hands off via share-intent | — (not ours) |
| keep | **Vault** | shipped v1 2026-10-30 | encrypted store, share-intent sink, SAF import/export, biometric opt-in | transmit (no INTERNET) |
| monitor | **Watch** | built + device-verified (release pending) | Tor-only outbound checks of a metadata-only work set `(url, addedAt)`; notifications as output | persist its own database; receive `title`/`note`/`tags`; touch clearnet |
| submit | *(unnamed)* | placeholder | user-initiated encrypted hand-off (`secure-export-v1` envelopes, SAF) | act without explicit user gesture |
| entry | **Console** *(optional)* | allowed, undesigned | stateless launch tray + unified panic affordance | hold family state (doctrine §4) |

**Element boundaries — the load-bearing rules:**

- **Watch has no persistence of its own.** Its work set comes from Vault;
  per run it reads the exported envelope, checks, reports via notification,
  forgets. If a later stage adds remembered monitor state, it lives as
  metadata on Vault items (e.g. `lastChecked`, `contentHash`) written back
  through the same narrow import path — never a parallel database.
  *(v1 is R1 with one named exception, decided 2026-10-30: two
  timestamps (`lastAttemptAt`, `lastSuccessfulCheck`) plus one
  findings-bit (`badgePending`) persist as UI-honesty artifacts;
  `lastSummary` is memory-only — no monitor semantics at rest.
  Anything beyond that subset stays later-stage-only.)*
- **Watch ↔ Vault exchange channel — decided structure (posture ladder).**
  The question decomposes into three axes: read path (Vault→Watch),
  write-back path (Watch→Vault), and the data subset that moves at all.
  The subset decides more than the transport — Watch is the family's only
  node combining network access with Vault data (Ghost: net without
  persistence; Vault: persistence without net), so every byte it receives
  is exfiltration surface if a Watch build is ever compromised.
  **Data-minimal at the source beats transport hardening.** Fixed rule:
  *"Watch receives only `(url, addedAt)`. Notes, titles and tags never
  leave Vault toward Watch — not as a design shortcut, but because Watch
  is the only node holding both network and Vault data, and every
  additional field widens the exfiltration surface."* Watch work moves in
  a dedicated `reminder-list-v1` envelope with its own passphrase (separate
  from the Vault passphrase) — format spec: `GHOST_WATCH_ENVELOPE_V1.md`.
  - **Stage 0 — default (secure-by-default):** manual SAF export of the
    watch-scoped envelope + no write-back (ephemeral runs: read → check →
    notify → forget). Zero new attack surface in Vault; user decides per
    cycle what Watch sees. UX cost: two manual steps per cycle.
  - **Stage 1 — opt-in "sync" (the convenience third, target design):**
    one-time SAF directory grant; Vault writes the watch-scoped envelope
    there **on demand only** — auto-write on item change is rejected:
    every Vault save would drop a timestamped ciphertext into shared
    storage, a write-timing pattern observable by any app holding the
    same grant. Watch polls. Results return as a separate metadata
    envelope through the existing SAF import — Vault stays structurally
    closed, no exported component. Only new surface: ciphertext resting
    in shared storage, protected by the envelope passphrase.
  - **Stage 2 — not planned.** A bound service with caller-cert pinning
    (`Binder.getCallingUid` → package → cert SHA-256 pinned to the Watch
    release key — the checker/PanicKit pattern, no shared key needed)
    exists as a design sketch only. It is revived solely by a specific,
    named failure of Stage 1 that cannot be fixed inside Stage 1 —
    **not** by general UX dissatisfaction (that is a Stage-1 problem to
    fix, not an exported-service reason). If ever revived, its open cost
    is named upfront: an exported bind surface is bind-spammable by
    arbitrary apps (no data leaks, but service resources burn) —
    mitigation: bind-rate-limit (~1 bind / 10 s, then `SecurityException`)
    or documented acceptance, since spam degrades the Watch service only,
    never the store.
  - **Killed options:** signature-level permission / exported provider —
    `protectionLevel="signature"` requires the *same* signing key on both
    APKs, i.e. the exact family fingerprint §Naming forbids (checkable
    via `apksigner --print-certs`). `sharedUserId` rejected for the same
    reason. Clipboard transport rejected (history leak). Any variant
    carrying `note`/`title`/`tags` rejected per the fixed rule above.
  - **Write-back starts at R1** (no persistence). Only if repeated
    notifications prove annoying: R2 (result envelope via existing SAF
    import). A live write path into Vault (R3) is deferred — it costs
    unlock-gate semantics, rollback design and schema growth, and touches
    the core write dance.
- **Watch is the family's only bridge node — network + Vault data in one
  process.** Envelope: Tor SOCKS5 only, no clearnet fallback, checks bound
  to the exported work set. Convenience third spends on check cadence and
  notification verbosity, never on scope.
- **"Tor-only" is a code invariant, not an OS invariant.** Vault's
  zero-network is OS-enforced and unbypassable even by a compromised
  build; Watch's Tor-only holds only as long as the shipped code holds —
  a compromised Watch build can dial anywhere. Test gate for the concept:
  static audit (no `new Socket`/`openConnection` without the SOCKS
  proxy; no `InetAddress.getByName`; no `new InetSocketAddress(String,
  int)` on remote targets — the constructor resolves implicitly,
  `createUnresolved` only) plus a live device monitor proving all
  traffic binds `127.0.0.1:9050` during a check run.
- **Every invariant carries an evidence type per observable layer.**
  The layers: code (what the source guarantees), function (what the
  device does), external observation (what a third party — the proxy,
  the OS, an auditor — testifies), full packet (what the wire shows).
  Where an external observer exists, use it — Tor's `TestSocks`
  oracle is the model: DNS silence was verified by the proxy's own
  log, not by the app's claims. Where no external observation point
  exists, code + function is the ceiling — stated as such, not
  smoothed into "verified". Residuals are classified, not just
  listed: a leak-class residual (an observer sees what they
  shouldn't) outranks a blindness-class residual (the check misses
  something; the next run bounds it).
- **Panic propagates downward only.** Vault panic destroys Vault + its
  credential material; Watch panics only if the user armed it — a Watch
  panic must never cascade into a Vault wipe (different persistence
  classes, different threat postures).
- **submit stays a placeholder by design** — the first proposal for it
  arrives when the need is concrete, not before.

**Build order (dependency-respecting):** Vault ✓ → `reminder-list-v1`
envelope format spec (single envelope, no chunking — partial salvage of a
re-exportable metadata list is worthless) → Watch concept (bridge-node
threat model; open questions: check semantics, notification-content leak,
Tor-circuit observability, Stage-2 bind-spam mitigation; required explicit
residual: *"a compromised Watch build can exfiltrate the exported work set
`(url, addedAt)` — bounded by design, not by code; Vault contents beyond
that subset are structurally unreachable from Watch"*) → Watch v1 →
(Console, optional, any time) → submit when a real hand-off case exists.
Chunked envelopes (Vault v1.1 #5) concern the vault store only — Watch
never reads `notes-store-v1` — and are opportunistic, not gating; same
for Vault v1.1 items 1 (size padding) and 4 (zeroing audit).

## §Ecosystem doctrine — the two-thirds rule

Design ratio for every Ghost-family component: **~2/3 security posture,
~1/3 convenience** — state of the art is not "maximum security" but
security the user actually keeps switched on.

The rule's mechanics:

1. **Security is not a setting; convenience is.** Every component ships in
   its hardest safe state (secure-by-default). Convenience exists only as
   explicit, informed opt-in — precedent: Vault's biometric unlock
   (off by default, crypto-bound, honestly labeled as compellable).
2. **Core invariants sit outside the ratio.** Ghost's zero-persistence and
   Vault's zero-network are not negotiable surface — the convenience third
   may never buy a relaxation of a defining guarantee. It spends on the
   non-invariant surface only: unlock ergonomics, share flows, import/
   export paths, UI posture.
3. **Convenience must be bounded, revocable, and labeled.** A convenience
   feature has to name its cost (what it trades, who can compel it) and
   must be removable without weakening the floor — the biometric wrap can
   be disabled and leaves no residue; panic erases it entirely.
4. **Entry-point convenience is allowed; central state is not.** A thin,
   stateless entry surface (launch tray, unified panic affordance) is
   legitimate 1/3-spending — it adds UX without adding a target. A central
   app holding family state is forbidden: it becomes fingerprint #1 and
   the single point every other boundary was built to avoid.
5. **Posture over toggles.** Where a component offers security-relevant
   choice, express it as a posture axis (the Tor-Browser-slider pattern:
   few honest levels, safe default) rather than a field of switches —
   switch fields are how convenience quietly eats the security two-thirds.

### Compliance vs. sweet spot — the honest balance (2026-10-30)

**The 2/3–1/3 ratio is a maximum convenience budget, not the default
experience.** A user who declines every opt-in experiences almost none
of the convenience third. That is deliberate for the target audience —
but it is a bet on that audience, not a balance that holds for every
user. Security that gets switched off is not security; convenience that
stays opt-in-hidden is not spent. **Review trigger:** measure Stage-1
adoption and biometric enrollment at the first post-Watch review — if
both stay near zero, the convenience third is not being spent and this
balance claim needs revision.

Named non-compliances to watch (labeled, but not bounded):

- **Clipboard history — accepted.** Copy-to-clipboard is a convenience
  feature whose cost is *unbounded*: OEM/system clipboard history
  (Samsung, Gboard) persists the copied URL and no SDK API can remove
  it. Today it is labeled (warn + manual clear) — honest reading: it is
  a consciously unbounded leak, not merely a labeled one. Accepted
  because no fix exists.
- **Soft cap without hard ceiling — tracked.** "~10k items soft cap, UI
  never hard-rejects" is effectively no cap — the threat model already
  lists store-size growth as unprotected. A hard ceiling is the bounded
  variant and is tracked as a v1.1 candidate.
- **Friction without security gain — deferred.** The ~2.7 s BouncyCastle PBKDF2
  derive is pure friction: identical strength is ~4× faster in native
  code, but Android ships **no** native PBKDF2 provider — native means a
  bundled `.so`/JNI, i.e. a real new supply-chain surface. Keeping pure-
  Java BC is a *conservative supply-chain choice*, explicitly not a
  security gain; labeled accordingly and re-evaluated in v1.1. **If the
  native-dependency cost is ever paid, it buys Argon2id** (memory-hard —
  a real security gain, not just speed), not merely faster PBKDF2.
