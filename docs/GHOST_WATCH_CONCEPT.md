# Ghost Watch — Companion App Concept (v0.2 DRAFT, 2026-10-30)

Status: decision-complete draft — all four design questions resolved,
operational states defined. Governing documents: `GHOST_FAMILY_DOCTRINE.md`
(ecosystem map, two-thirds doctrine, channel posture ladder),
`GHOST_WATCH_ENVELOPE_V1.md` (work-set format). This file owns only
Watch-specific design.

## What Watch is

The family's `monitor` node — and its **only bridge**: the first process
to hold network access and Vault-derived data at once. It checks whether
onion services from the user's saved work set are still alive or changed,
and reports through notifications. It never browses, never renders,
never stores a database of its own.

## Hard boundaries (invariants — outside the two-thirds ratio)

- **Metadata-only input.** Watch receives `(url, addedAt)` via the
  `reminder-list-v1` envelope — nothing else. Producer-side rule: Vault's
  exporter MUST NOT emit `title`/`note`/`tags`/`source`. This is also
  the family's first *write-time provenance policy* — who may write
  what into a persistent store, at which trust level. The same problem
  shape as memory-layer write gates; solved by producer enforcement as
  the primary control, **with parser allowlist as defense-in-depth** —
  Watch's parser reads only `url`/`addedAt` and ignores every other
  field. Recognition is not control: the second layer must sit at the
  consuming boundary, not rely on the producer behaving.
- **No persistence of its own** (R1 in v1): read work set → check →
  notify → forget. No local database, no `lastChecked` store. Repeated
  alerts are the accepted cost; R2 (result envelope back through Vault's
  SAF import) is deferred until repetition proves annoying. A live write
  path into Vault (R3) is not planned.
  - **R1 exception (explicit, bounded):** exactly three scalars
    persist in SharedPreferences — `lastAttemptAt`,
    `lastSuccessfulCheck`, and `badgePending`. The two timestamps are
    UI-honesty artifacts (the b2 "nothing to report ≠ never ran"
    display); `badgePending` is a single findings-bit — the minimal
    signal Level C needs so silence is never indistinguishable from
    "no run". The last-run *summary* (per-category counts) is
    **monitor state and is deliberately not persisted** — it lives in
    memory only; after process death the UI shows "findings —
    details not retained" rather than resurrecting run shape. A
    device-access adversary therefore reads at most: two timestamps
    and one bit. Deriving timestamps from WorkManager state was
    considered and rejected — WorkManager exposes no reliable
    last-success API, so the timestamp would be inferred or lost on
    process death, which is exactly the silent failure the display
    exists to prevent.
- **Tor-only, code invariant.** SOCKS5 to `127.0.0.1:9050` only, no
  clearnet fallback, no DNS (`InetAddress.getByName` forbidden — and so
  is `new InetSocketAddress(String, int)`, which resolves internally;
  remote targets MUST use `InetSocketAddress.createUnresolved`. Resolve
  through the proxy or not at all). Unlike Vault's OS-enforced
  zero-network, this holds only while the shipped code holds.
- **Own signing key.** Watch is signed with a key distinct from Vault's —
  a shared key would recreate the exact family fingerprint §Naming
  forbids (and would have made the killed signature-permission channel
  viable for the same price it costs).
- **No panic cascade — and a defined panic.** Watch panic (if armed)
  affects Watch only; it must never propagate into a Vault wipe.
  Under R1, Watch has almost no persisted state, so panic must be
  defined honestly: **panic = delete the hardware-wrapped credential
  + kill the process.** That is the only content worth a panic —
  the SAF grant is a system grant, the in-memory work set dies with
  the process anyway. Named cost: a fired panic makes Stage 1
  unusable until re-enrollment (labeled, revocable, no cascade —
  consistent with Vault's downward-only asymmetry). Under modes
  without a stored credential (Stage 0 / option (c)), panic is a
  plain force-stop and is labeled as such, not dressed as more.
- **Camouflage — identity decided (2026-10-30):** package
  `org.everyday.reminder`, launcher label `Reminders`/`Erinnerungen`
  (localized, same convention as Vault's Notes/Notizen). The `org.`
  TLD is deliberate and must be documented as *breaking the family
  namespace pattern*: a forensic reviewer reads patterns, not
  strings — `com.`+adjective+noun would re-create the
  `com.plain.notes` signature shape. Category rationale: reminders
  are periodic, background-capable, notification-driven and
  network-plausible by definition — the only banal category in which
  all three of Watch's unavoidable behaviors (INTERNET, periodic
  connectivity, 03:00 background work) are the core function, not an
  anomaly. Known residual: label collides with preinstalled reminder
  apps (good camouflage, mild user confusion — distinct icon);
  availability of the package id must be checked before first build.
  `INTERNET` makes Watch the family member a device audit notices
  first — the functional plausibility carries the weight.

## Channel (from doctrine — fixed)

- **Stage 0 default:** manual `reminder-list-v1` export → import. Ephemeral
  runs only.
- **Stage 1 opt-in (target):** SAF directory grant, Vault writes
  on-demand, Watch polls. No exported components anywhere.
  **Missing or revoked SAF grant** (user deleted the directory,
  removed storage, Android revoked the grant): Watch posts a single
  run-level notification — "Stage 1 paused — SAF grant missing;
  re-grant or switch to manual." Repeats at most once per 24 h,
  never per check cycle. Same rule as `unreachable-circuit`: an
  infrastructure failure must never masquerade as "nothing to
  report".

  **Import/run failure states (typed, never generic):** every failure
  of the read→decrypt→parse→check path maps to exactly one typed
  result with its own UI string — no path may collapse into a generic
  "import failed", because the user cannot correct what he cannot
  name. `SAF_MISSING` (grant lost — re-grant), `ENVELOPE_MISSING`
  (no `watch-export.gwe` in the folder), `PASS_MISSING` (no
  credential — enroll first), `PASS_LOCKED` (b2: device locked —
  unlock and retry), `WRONG_PASSPHRASE` (GCM tag failed — wrong
  passphrase or tampered file), `NOT_WATCH_ENVELOPE` (file is not a
  `secure-export-v1` envelope at all), `CORRUPT_ENVELOPE` (envelope
  parses but inner structure is broken), `FORMAT_MISMATCH`
  (decrypts but `storeFormat` ≠ `reminder-list-v1`),
  `ITERATIONS_BOUNDS` (KDF iterations outside 10k–1M — hostile file
  rejected before work), `CHECK_ERROR` (unexpected). Same taxonomy
  applies to `readWorkSet` (list display) and `runOnce` (check run).
- **Stage 2 — not planned.** Revived only by a specific, named Stage-1
  failure unfixable inside Stage 1 — never by UX dissatisfaction alone.

## Threat model — the bridge class (new for the family)

1. **Compromised-Build residual (required, explicit):** a compromised
   Watch build can exfiltrate the exported work set `(url, addedAt)` —
   *bounded by design, not by code*. Vault contents beyond that subset
   are structurally unreachable from Watch. This is the statement that
   justifies the metadata-only rule; it is the security story of the
   whole app.

   **Extended residual — envelope injection (if passphrase at rest):**
   the passive-exfiltration bound above holds only while the envelope
   passphrase stays a user-held secret. If Watch stores the passphrase
   (required for unattended Stage-1 polling), an adversary who
   extracts that at-rest credential *and* holds SAF write access can
   forge `reminder-list-v1` envelopes — steering an *honest* Watch build
   into checking attacker-chosen onion services (still Tor-only, but
   attacker-selected destinations: active compromise, not passive
   leak). And steerable contact is broader than destinations: every
   forced check builds a Tor circuit the attacker's own `.onion`
   endpoint can observe — the attacker learns the device's Tor
   behavior (timing, availability windows, circuit fingerprint) and,
   most importantly, *that this device checks at all*. The leak is not
   only which services, but the existence and habits of the device.
   The boundary then reads: what Watch can exfiltrate *and* what Watch
   can be made to contact *and what that contact reveals about the
   device itself*. Decided under §Design decisions 4 — the reason
   Stage-1's credential model is a security decision, not a
   convenience one.
2. **Notification leak:** notification content reveals list membership.
   Decided — see §Notifications. The seizure-naming ban is a **code
   invariant**, not a policy: the seizure notification constructor
   cannot receive an item name.
3. **Tor-circuit observability:** a local observer sees *that* Watch
   opens Tor circuits and when — not where they go. Check timing can
   correlate with user activity. Mitigation space: randomized check
   jitter, batched checks, quiet hours. Residual: unavoidable while
   Watch runs; to be named, not solved.
4. **Check semantics:** decided — see §Check semantics. Result set
   `{up, down, seizure-signature-match, unreachable-circuit}`;
   `changed` deferred to R2/R3 evaluation.
5. **Bind-spam (only if Stage 2 ever revives):** an exported bind surface
   is bind-spammable. Mitigation: rate-limit or documented acceptance —
   degrades the service only.

## Check semantics — decided (2026-10-30)

Result set per item: `up`, `down`, `seizure-signature-match`,
`unreachable-circuit`. Runtime vocabulary — lives here, not in the
envelope (the envelope carries inputs only; results are not exported
under R1).

- `up`: SOCKS-CONNECT to the `.onion` succeeds **and** a valid HTTP
  response arrives within the deadline. A bare TCP connect to
  `127.0.0.1:9050` only proves Orbot runs — it says nothing about the
  service and must not be confused with it.
- `down`: circuit established, service refused or timed out — declared
  only after a retry over a *fresh* circuit, so one bad exit cannot
  mark a service down. HTTP error responses (4xx/5xx) count as `down`
  but keep a distinguishable sub-code (`down-http-403`,
  `down-timeout`) so notification language stays precise.
- `seizure-signature-match`: HTTP 200 whose body matches a bundled
  seizure/intercept signature list. The name states what the check
  does — it matches signatures, it does not detect seizures: a generic
  takedown page can come from any provider or agency. The result
  carries the list version **and its bundle date** (`matched against
  v3, bundled 2026-09`) — the age, not the bare version, is what the
  user needs to weigh staleness; bundled lists go stale between
  releases. Notification language: "matched a
  known seizure signature (list v3, bundled 2026-09) — may be stale,
  verify manually",
  never "service seized" — the stale case matters: a replaced page can
  still match an old signature.
  The signature list is itself an intelligence artifact — forensic
  APK analysis reveals which seizure pages were tracked. Documented
  leak, not a solvable one; the list is bundled only (no backend, no
  out-of-band update channel).
- `unreachable-circuit`: the SOCKS connect failed — either Tor is not
  running (infrastructure failure) or the service descriptor could not
  be fetched (service failure). Java cannot distinguish the SOCKS
  reply codes, and **item results alone cannot distinguish "Tor down"
  from "all services dead"** — a total failure where every service is
  legitimately gone would still produce `up==0` and cry wolf on Tor.
  Resolution: **two probes, cost-ordered.** A SOCKS5 greeting to
  `127.0.0.1:9050` runs before the item checks (proxy liveness —
  a dead proxy means every item would burn a timeout). A greeting
  alone only proves Orbot answers, **not** that Tor can build
  circuits; so when item results are still ambiguous — every item
  unreachable while the device is online — a **circuit probe**
  follows: a SOCKS connect through Tor to a fixed clearnet target
  (`www.torproject.org:80`). If the circuit stands, Tor is
  functionally reachable and the failures are service-level; if it
  fails, Tor cannot build circuits regardless of the live proxy.
  Cost: at most one circuit per run, only in the ambiguous case.
  Two named limitations, accepted rather than fixed:
    - **The probe target is clearnet.** `www.torproject.org:80`
      proves circuit + exit; an exit-side or timing observer sees
      that this device runs Tor, not what it monitors — acceptable
      because the probe fires only in the ambiguous case, and the
      alternative (probing a monitored onion) would burn a target-
      specific circuit and still not isolate onion routing.
    - **It proves general Tor connectivity, not onion routing.** A
      working exit circuit can coexist with broken `.onion`
      descriptor fetches (HSDir unreachable, onion-specific relay
      failures). That failure class remains indistinguishable from
      dead services — the matrix honestly cannot separate "services
      gone" from "onion routing broken", and no wording may claim
      it can.
  The wording matrix:
    - greeting failed → "Tor unavailable — N checks skipped" (items
      not even attempted)
    - greeting ok + device offline + nothing up → "Device offline —
      N checks skipped"
    - all items unreachable + circuit probe fails → "Tor
      unavailable — N checks skipped"
    - all items unreachable + circuit probe ok → "All checks
      inconclusive — services unreachable or descriptors missing;
      Tor itself is reachable" ("reachable" now means *circuits*,
      not "the proxy answered")
    - partial unreachable → "N check(s) inconclusive — service
      unreachable or descriptor missing"
    - any UP/DOWN_* result proves circuits work; no probe needed.
  **Terminal per item, no retry** (per-item retries only burn circuit
  churn). Aggregates into a single run-level notification — never
  per-item, never reported as service-down.

**Deferred: `changed`.** Change detection needs a persisted baseline
to distinguish "changed" from "current" — a run-local hash without
baseline is R1-conform but useless. That is R2/R3 territory, not an
R1 violation.

### Timing and concurrency (decided)

- Connect timeout 15 s; per-item deadline 45 s; at most one retry,
  over a fresh circuit.
- Concurrency bounded at **8** — circuit churn is itself an
  observability trail; 8 is the compromise between run duration and
  trail weight.
- The work set is **user-bounded, not store-bounded**: Stage 0/1
  exports are user-selected (expected tens to hundreds, not the full
  Vault). v1 guard: a work set over 1000 items makes the UI show an
  estimated run duration before starting — at 8 parallel and 45 s
  deadline, 1000 items is ~95 min worst case; tens-to-hundreds is
  minutes. The bound is honest because the user chose the set.

## Notifications — decided (2026-10-30)

Three-level posture ladder, one absolute ban.

- **Level A — aggregate (default).** Counts per result category, no
  item names: "Watch: 41 up · 3 down · 5 unreachable". A
  `seizure-signature-match` appears **without a number** — "signature
  match detected", not "1 signature match": the count itself is a
  structural leak (N matches hints at a jointly-seized cluster, i.e.
  the shape of the investigation). The user opens the app immediately
  anyway — the number saves no tap but leaks structure.
  **Post rule: A notifies only when `down > 0 || signature > 0 ||
  unreachable > 0`.** A pure all-up run is an in-app result, never a
  notification — noise notifications train the user to ignore the one
  signal that matters, the same failure `unreachable-circuit` exists
  to prevent.
- **Level B — per-item (opt-in, gated).** `down` notifications may name
  the service. Enabling requires a confirmation dialog with the
  verbatim text: "Per-item notifications name the service on your lock
  screen and are stored in your device's notification history
  (Samsung/Gboard). An observer with access to this device can learn
  which services you monitor. Continue?" — plus an unchecked checkbox.
  A settings label alone is not a label; label without friction is no
  label. Honest framing: per-item `down` leaks **list membership**,
  not merely a down-state — anyone who controls the named service and
  observes the notification channel learns this device monitors it.
  Bounded by down-state frequency and opt-in — not by content.
- **Level C — silent + badge (opt-in, high-risk).** No notifications at
  all; results carry a persistent in-app badge visible on next open.
  Without the badge this would be blind mode, not silent mode — the
  user chose against lock-screen leaks, not against the result.

**The absolute ban (code invariant, not policy):** a
`seizure-signature-match` notification can never name the service —
under any level, under any opt-in. Enforcement is structural:
`buildSeizureNotification(String signatureListVersion)`
takes **no item parameter** and no count parameter — the count was
removed, not merely unrendered, so no future "convenience" diff can
surface it. Not "is not passed" — "cannot be passed".
A reviewer can verify the leak boundary by code audit. Rationale: the
match alone already achieves the goal (the user opens the app
immediately); the name in a notification is one saved tap against
lock-screen/notification-log evidence that this device monitors a
*specific* seized service — convenience buying an unbounded surface
for no measurable benefit. Not sellable even labeled.

**Visibility:** all Watch notifications post with
`VISIBILITY_PRIVATE` — lock screen shows app icon + generic text only;
counts appear after unlock. Exception by design:
`unreachable-circuit` (probe-attributed wording per §Types) is itself
insensitive (leaks Tor usage, not monitored content) and posts
immediately — otherwise the user waits for results that never come.

**Doctrine note (honest):** Level B is the only convenience spend in
Q2 — and it is dialog-gated, i.e. expensive. Level C spends negative
convenience; Level A is default with no convenience gain. Q2 therefore
cements the ~85–90% security-default experience rather than moving
the effective ratio toward 2/3–1/3. Consistent with the stated bet on
the target audience — recorded explicitly, not implied.

## Convenience third — where it may spend

Check cadence (manual / daily / custom), quiet hours, notification
verbosity within the chosen leak level, per-item check toggles. Never:
scope widening, clearnet fallback, always-on persistence.

## Test gates (draft)

- Static audit: no `new Socket`/`openConnection` without the SOCKS
  proxy; no `InetAddress.getByName`; no `new InetSocketAddress(String,
  int)` on remote targets (implicitly resolves — `createUnresolved`
  only); no `java.net.*` raw use.
- Live monitor: during a check run, all traffic binds `127.0.0.1:9050`
  (the Watch equivalent of Vault's aapt zero-caps proof — but as a
  *code* proof, honestly labeled weaker).
- Forward guard: **no native code in Watch.** The static audit covers
  only managed code paths; native code could bypass the SOCKS proxy
  below the JVM. If native code is ever added, the Tor-only invariant
  must be re-audited at the native boundary.
- Jitter (observed, not configured): over 7 days of real runs, check
  timestamps show no fixed time-of-day pattern — the histogram of run
  hours is flat within the target window. Configured jitter alone
  proves nothing: Doze/App-Standby add their own drift; only the
  observed pattern tests the observability claim.
- `ACCESS_NETWORK_STATE` abuse guard: the permission is read-only and
  used solely to label `unreachable-circuit` sub-states (device
  offline vs. Tor unreachable vs. services dead). **Connectivity state
  may only label results, never gate a network operation** — no check
  may be skipped or redirected based on it. Static audit, because
  `ConnectivityManager` is not a `Socket` and would otherwise slip
  the Tor-only check. (Note: a prior draft gated `TorChecker.check`
  on connectivity — removed; per-item SOCKS failures surface
  naturally as `unreachable-circuit`, and the run-level probe does
  the honest attribution.)
- Manifest: `INTERNET` + `ACCESS_NETWORK_STATE` present (decided —
  required to distinguish "device offline" from "Tor unavailable":
  a successful SOCKS connect with failing circuit setup would
  otherwise misreport offline as `unreachable-circuit`). Nothing
  else network-adjacent.
- Envelope: `reminder-list-v1` parse rules — `storeFormat` mismatch fails
  clean, unknown fields ignored, missing `url` drops item not file,
  `iterations` bounds 10k–1M.
- Notifications — one assertion per level plus the seizure ban:
  - **A (default):** notification text contains only counts — no item
    names, no URLs, no `.onion` strings (regex over notification
    extras); seizure notification contains no number.
  - **B:** `down` notifications contain item names; seizure
    notifications still contain no item name (asserted under B too).
  - **C:** `NotificationManager.getActiveNotifications()` is empty
    after a run with hits; the in-app badge is set.
  - **VISIBILITY_PRIVATE:** every posted notification returns
    `getVisibility() == VISIBILITY_PRIVATE`.
  - **`unreachable-circuit`:** posts immediately (not delayed by the
    private-visibility path), no item references. Wording is
    probe-attributed (see §Types): greeting failed or circuit probe
    failed → "Tor unavailable — N checks skipped"; offline → "Device
    offline"; all dead + circuit ok → "All checks inconclusive — …Tor
    itself is reachable"; partial → "N check(s) inconclusive — …".
    "Tor unavailable" only when Tor demonstrably cannot build a
    circuit — never while it can.
  - **Seizure ban (structural):** code audit — the seizure
    notification constructor accepts no item parameter.
    Compile-time invariant, not a runtime test.
  - **POST_NOTIFICATIONS gate:** if the permission is denied, a
    findings-bearing run must not complete silently — the findings
    bit stays set, the UI shows a persistent "Notifications
    disabled" banner plus the badge line on next open, and the
    denial is logged. Asserted: `areNotificationsEnabled() ==
    false` → helper reports false, banner condition held.

## Design decisions — all resolved (2026-10-30)

Ordered by construction dependency (2026-10-30 — check semantics gates
notification design: what a notification may contain depends on what a
check yields; status-only produces different content than content-hash).

1. ~~Check semantics + timeout/retry spec~~ — **resolved 2026-10-30**,
   see §Check semantics. `changed` deferral keeps R2 optional, not
   eliminated.
2. ~~Notification granularity~~ — **resolved 2026-10-30**, see
   §Notifications. Levels A/B/C decided; seizure naming banned
   structurally; per-item `down` gated behind a friction dialog;
   `unreachable-circuit` posts immediately and aggregated.
3. ~~Check scheduler shape~~ — **decided 2026-10-30**, reframed as a
   security decision: which timing pattern we accept as the
   observability price. WorkManager with periodic checks produces a
   deterministic fingerprint ("this device builds Tor circuits at
   ~03:00 daily") — an app-identifying pattern regardless of content.
   Manual-only produces an irregular, user-driven pattern — less
   fingerprintable, less useful. **Decision: WorkManager + random
   jitter ≥ ±2 h around a target window + quiet hours** as default —
   a jitter of minutes still fingerprints "daily check ~03:00"; the
   window must be wide enough that no fixed time is recognizable.
   Manual-only remains a selectable posture for users who prefer an
   irregular trail over automation.
4. **Stage-1 passphrase model — decided 2026-10-30**, reframed: not
   "store the passphrase: yes/no" but "which Stage-1 model and which
   residual we accept". Polling structurally requires a stored
   credential — an unstored passphrase makes polling impossible and
   Stage 1 meaningless. The real options:
   - **(a) Stored passphrase, labeled** — enables Stage 1; a durable
     secret at rest on the *bridge node* (network + Vault-derived
     data in one process — worse placement than Vault's biometric
     credential). Requires the explicit risk dialog, not a settings
     checkbox.
   - **(b) Hardware-wrapped credential (StrongBox/TEE)** — enables
     Stage 1 with a hardware gate. **Fork inside (b) — the Keystore
     mode decides whether Stage 1 is truly unattended:**
     - **(b1) `setUnlockedDeviceRequired(false)` — default mode:**
       the key is usable from first unlock until reboot. WorkManager
       polling at 03:00 works even while the device is locked.
       Named residual: a stolen, locked device that was unlocked at
       least once this boot is *in scope* of the at-rest threat —
       the protection is "unusable after reboot", not "unusable
       while locked".
     - **(b2) `setUnlockedDeviceRequired(true)` — strict mode:**
       the key exists only while the device is actively unlocked.
       Real protection — but unattended polling is structurally
       impossible; Stage 1 becomes *semi-attended* (checks run only
       while the device happens to be in use). Optional posture for
       users who accept that bound — **with mandatory UI honesty:**
       the opt-in dialog says verbatim "Strict mode: checks run only
       while the device is unlocked. Expect irregular results; the
       last-check timestamp may be days old.", and the in-app view
       always shows the last successful check time prominently, so
       "nothing to report" is never confused with "never ran".
       Without this, (b2) is a silent-failure mode — the same class
       `unreachable-circuit` exists to prevent, re-introduced one
       layer up.
     **Primary choice: (b1) with its residual written above; (b2)
     as a selectable posture.** Without naming this fork,
     "hardware-wrapped" promises a protection the implementation
     may or may not deliver.
   - **(c) No at-rest credential** — passphrase re-prompted per run;
     Stage 1 collapses to a manual trigger (session-scoped secret,
     Stage-0-adjacent). If this is ever chosen, Stage 1 must be
     honestly marked *not implemented* rather than kept as a
     "target design" that cannot fulfill its own convenience claim.
   **Decision: (b1) primary, (b2) selectable posture, (a) as labeled
   fallback where hardware is unavailable** — and either way the
   extended residual applies: any at-rest credential enables the
   envelope-injection class (§threat model 1): an adversary
   extracting it plus SAF write can steer an honest Watch build to
   attacker-chosen services and observe the device's Tor behavior
   through their own endpoints. The passphrase ceases to be a
   user-held secret and becomes a device-held secret on the
   network node — the residual sentence covers *steerable contact
   plus device observability*, not only exfiltration.
