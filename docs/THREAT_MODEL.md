# Ghost Search — Threat Model

**Status:** DRAFT v0.2 (2026-10-27) — second revision incorporating post-v4.0.1 security commits; authored for external security-audit readiness.
**Scope of this document:** formal adversary model, assets, trust boundaries, in/out-of-scope statements, and mapping of third-party audit findings (Cure53 TTP-03) and self-authored research findings to current code.
**Companion documents:** [`SECURITY.md`](../SECURITY.md) (policy, evidence, verification commands) · [`GHOST_V4_SECURITY_ARCHITECTURE.md`](GHOST_V4_SECURITY_ARCHITECTURE.md) (deep architecture, six-pillar design, residual-risk items 40–53) · [`USER_MANUAL.md`](USER_MANUAL.md) (user-facing guidance).

**Verification markers:** `[VERIFIED]` = checked in this repository at the cited location on 2026-10-27 (re-checked at HEAD `1c65777580`) · `[REPORT]` = from the internal research report (v4.0.1-era line numbers — re-read before relying on a line citation) · `[RESEARCH]` = external source cited · `[HYPOTHESIS]` = reasoned, not independently verified.

---

## 1. System Overview

Ghost Search is a Tor-only onion-meta-search client for Android (React + TypeScript in a Capacitor WebView, native Java plugins). Non-negotiable invariants: **Tor-only** (no clearnet fallback, ever), **backend-free** (no operator-run servers), **account-free**, **telemetry-free**, **RAM-only sensitive state**, F-Droid-distributable with reproducible builds.

Components and their trust roles:

| Component                                                                                                                           | Role                                               | Trust                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| WebView/JS layer (`src/`)                                                                                                           | UI, ranking, parsing, entity logic                 | trusted (our code, no remote content loaded)                                                                                        |
| Native plugins (`PianoTorHttpPlugin`, `PianoVpnPlugin`, `PianoScreenPlugin`, `PianoRegistryAnchorPlugin`, `PanicResponderActivity`) | transport, gating, anti-forensics, registry anchor | trusted (our code); last line of defense                                                                                            |
| Orbot (external app)                                                                                                                | SOCKS5→Tor transport, VPN mode                     | trusted for transport; **not** owned by Ghost                                                                                       |
| 13 onion search engines                                                                                                             | data sources                                       | **untrusted content** (adversarial HTML, redirects, result poisoning)                                                               |
| Ahmia blacklist endpoint                                                                                                            | abuse blacklist (bundled snapshot + live refresh)  | semi-trusted data source; marked, never auto-obeyed                                                                                 |
| F-Droid + fdroiddata recipe                                                                                                         | build & distribution channel                       | root of distribution trust (`Binaries:` + `AllowedAPKSigningKeys` = upstream signature preserved after verified rebuild) `[REPORT]` |
| OS (Android), IME, accessibility services, other apps                                                                               | environment                                        | **untrusted environment** (see A3)                                                                                                  |

Transport facts that bound the model `[VERIFIED via SECURITY.md:77-79; details REPORT]`: per-search RFC 1929 credential rotation with per-engine suffixes (Tor `IsolateSOCKSAuth` → per-engine circuits), remote DNS via `ATYP=DOMAINNAME`, non-dismissible VPN gate, http-only `.onion` destinations (no TLS ClientHello surface), TB-aligned header fingerprint (v4.1.0).

## 2. Assets (what an adversary wants)

| #   | Asset                                                  | Where it lives                                                                                                                                                                                                                                                                                                                                                                                                                    | Loss impact                                                                                                                  |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| AS1 | Search queries (content)                               | RAM (WebView + JS heap) + transient Tor circuits + **destination engine logs** (query reaches the engine in cleartext by design of onion search)                                                                                                                                                                                                                                                                                  | high — research intent exposed to engine operator                                                                            |
| AS2 | Result set / session state                             | RAM only; purged on screen-off, panic, exit `[VERIFIED SECURITY.md:52-53]`                                                                                                                                                                                                                                                                                                                                                        | high — reveals research topics                                                                                               |
| AS3 | Query/result **metadata** (timing, volume, engine mix) | observable at Tor guard; at engines (request patterns)                                                                                                                                                                                                                                                                                                                                                                            | medium — correlation/fingerprinting                                                                                          |
| AS4 | Engine registry integrity                              | signed `engines.json` + `engines.sig.json`, RSA-PSS verified against APK-signer-anchored key `[VERIFIED files exist; scripts/sign-registry.mjs, verify-registry.mjs]`                                                                                                                                                                                                                                                             | critical — poisoned registry = search manipulation / misdirection                                                            |
| AS5 | Blacklist integrity                                    | bundled snapshot + live refresh (mark-only semantics)                                                                                                                                                                                                                                                                                                                                                                             | medium — false negatives lower scam visibility; false positives mislabel                                                     |
| AS6 | APK authenticity                                       | APK v2/v3 signature; expected signer SHA-256 published `[VERIFIED SECURITY.md:237-243]`                                                                                                                                                                                                                                                                                                                                           | critical — repackaged APK defeats everything above                                                                           |
| AS7 | Device-level user behavior                             | IME dictionaries, clipboard, accessibility event streams — **outside Ghost's control**                                                                                                                                                                                                                                                                                                                                            | medium-high (see A3, and "Out of scope")                                                                                     |
| AS8 | User-exported case files (explicit user action)        | Encrypted path: AES-256-GCM envelope (PBKDF2 210k, AAD, fresh salt/IV — `crypto-export.ts`) `[VERIFIED module]`. Plaintext path: `shareFile` writes the JSON transiently to `cacheDir/piano/exports/` (`src/routes/graph.tsx:433` → `native.ts:126-169`) — only on explicit share, deleted when the share sheet ends, scrubbed at next boot, shredded by panic wipe `[VERIFIED native.ts:141-169, PianoScreenPlugin.java:84-176]` | high if a hostile share target is chosen — the receiving app gets the full case file in plaintext (user-directed disclosure) |

**AS8 residue lifecycle (4 stages, all verified in code):** (1) pre-scrub of stale export files before every share (`native.ts:145-155`); (2) delete-on-sheet-end (`native.ts:166-169` — transient plaintext residue may persist until then); (3) boot-time ephemeral disk scrub (`PianoScreenPlugin.scrubEphemeralDiskArtifacts:84-101`); (4) panic-wipe shred (`PianoScreenPlugin.java:103-176`). Export hardening from `8f2187ce2d`: CSV formula neutralization (CSV-injection defense) and STIX UUID refreshing on export.

## 3. Trust Boundaries

```
┌─ Android OS (untrusted environment: IME, a11y, other apps, forensics) ──────────────┐
│  ┌─ Ghost process ────────────────────────────────────────────────────────┐        │
│  │  [JS/WebView]  ⇄ Capacitor bridge ⇄  [Native plugins]                  │        │
│  │      parsing, ranking, RAM state          SOCKS5 client, VPN gate,     │        │
│  │                                           wipe, registry anchor        │        │
│  └──────────────┬─────────────────────────────────────────────────────────┘        │
└─────────────────┼──────────────────────────────────────────────────────────────────┘
                  │ loopback SOCKS5 (RFC 1929 creds, per-search/per-engine)
            [Orbot / tor]  ── Tor network (guard sees volume+timing, not content)
                  │
            [13 onion engines] — untrusted HTTP responses (HTML, redirects, cookies)
```

Boundary crossings and their defenses: JS↔native (typed plugin APIs, no dynamic content); native↔Orbot (strict `0x02` auth-only SOCKS negotiation `[VERIFIED PianoTorHttpPlugin.java:249-289]`); Orbot↔engines (Tor circuits, onion-space-only URLs, redirect re-validation each hop `[VERIFIED PianoTorHttpPlugin.java:186-227 — incl. cross-host 307/308 with request body rejected, :212-217]`); device↔world (VPN gate fail-closed, no cleartext, user-CAs denied `[VERIFIED network_security_config.xml]`).

## 4. Adversary Classes

### A1 — Onion engine operator (or engine compromise)

**Capabilities:** sees queries in cleartext; serves arbitrary HTML; issues redirects (re-validated each hop); sets cookies (purged per search `[VERIFIED search.ts:650 purgeTorCookies()]`); logs request fingerprints and timing; coordinates with other engines; poisons results; plants tracking parameters in result URLs.

**Mitigations in depth:** TB-aligned request fingerprint (UA Android 10 / ESR 140, canonical Firefox header order incl. Priority, gzip/deflate — v4.1.0 `[VERIFIED commits 1e1bce4ae7, 7c06a377d3]`); per-search unlinkable circuits; vanity-clone detection + SimHash mirror clustering + scam-title patterns `[REPORT authenticity.ts, dedup.ts]`; cross-engine consensus weighting (RRF×trust, QARF) so single-engine poisoning ranks low `[REPORT search.ts:128-189, qarf.ts]`; blacklist marking; click-unlinkability by architecture (result fetch via Ghost circuits, visit hands off to Tor Browser — different client, circuit, no referer `[REPORT external.ts:10-23]`).

**Residual (accepted):** the queried engine _always_ learns the query (definitional for search — documented, not fixable); coordinated multi-engine poisoning defeats consensus weighting; engine sees a non-TB client **if** it fingerprints timing/behavior beyond headers (interleaving/randomization proposed in the research backlog); result content cannot be signature-verified (no protocol exists — `GHOST_V4_SECURITY_ARCHITECTURE.md` and prior research both record this impossibility).

### A2 — Network observer (local network, ISP, guard-level, global passive)

**Capabilities:** observe that the device uses Tor/Orbot; observe traffic volume/timing at the guard; block/throttle; run a malicious guard (sees only Tor-encrypted cells + timing).

**Mitigations:** all queries fail closed without VPN transport (non-dismissible gate `[VERIFIED SECURITY.md:77]`); Tor-only destinations + remote DNS (no cleartext DNS leak by construction); per-search credential rotation makes consecutive searches circuit-unlinkable `[VERIFIED SECURITY.md:79]`; decoy/camouflage traffic partially obscures engine-request patterns (`fireDecoys` runs in every mode, paranoid only sharpens parameters `[VERIFIED search.ts:474-486]`).

**Residual (accepted, physics-bound):** guard-level adversary profiles burst volume/timing of the whole search session — identical exposure to a Tor Browser user opening many tabs; no app-layer fix exists (documented as the honest claim line; Tor's own circuit padding is the correct layer). `[REPORT §1]` 2026 website-fingerprinting research confirms the realism of guard-perspective attacks while defense deployment remains research-only (nothing rolled out in Tor Browser): real-scale dataset GTT23 (arXiv:2404.07892); guard-perspective open-world attack at 0.956 precision / 0.922 recall at a 9% base rate (arXiv:2603.07412, Mar 2026); and "Peel the Onion" (arXiv:1901.04434) deanonymized Android apps _using_ Tor at 97% via circuit-fingerprinting of app-lock patterns — Android-Tor-client context, but device-level, not app-fixable. `[RESEARCH]`

### A3 — Local device adversary

Three distinct strengths:

1. **Casual/physical (seizure, borrowing):** RAM-only state, FLAG_SECURE, recents-snapshot scrub, onSaveInstanceState cleared, boot-time disk scrub, native panic wipe shreds caches + kills process `[VERIFIED PianoScreenPlugin.java:84-176 — scrub :84-101, wipe :103-176 incl. shared_prefs shred, finishAndRemoveTask, killProcess]`; `allowBackup=false` + full extraction-rule exclusions `[VERIFIED AndroidManifest.xml:6]`. _Residual:_ powered-on forensic RAM extraction by capable actors (documented `[VERIFIED SECURITY.md:147-148]`); cold-boot/forensics beyond app control.
2. **Hostile co-resident apps:** task-hijacking/phishing — mitigated by `launchMode="singleTask"` + `taskAffinity=""` `[VERIFIED AndroidManifest.xml:21-22]` (Cure53's exact TTP-03-010 fix); deep-link flood DoS — **no deep-link surface exists** (MAIN/LAUNCHER only `[VERIFIED :26-27]`); PanicKit trigger flood — any app can send `TRIGGER` and wipe the session: documented design decision (wipe is toward safety; availability nuisance only) `[VERIFIED SECURITY.md:130-135]`.
3. **Untrusted input surfaces (IME learning, clipboard, accessibility):** queries typed in WebView are visible to the active keyboard (personalized learning, cloud history) — **not mitigable in-app**; copied onion URLs persist in clipboard/IME history — partial (documented, delayed-scrub proposed); accessibility services can read result rows (FLAG_SECURE does not bind a11y) — accepted risk, documented `[REPORT §5]`. _These belong in user guidance (USER_MANUAL "what Ghost cannot protect") — doc-side action, not code._

### A4 — Supply chain

**Capabilities:** dependency compromise (86 pinned deps, lockfile-enforced `[VERIFIED SECURITY.md:184-190]`); malicious APK (repackaged/sideloaded); registry tampering; mirror serving stale/poisoned engine lists; F-Droid channel compromise.

**Mitigations:** reproducible F-Droid builds with upstream signature preservation (`Binaries:` + `AllowedAPKSigningKeys`) `[VERIFIED docs/REPRODUCIBLE.md:14]`; published release SHA-256s + apksigner expectations `[VERIFIED SECURITY.md:237-258]`; operator-signed engine registry, RSA-PSS, fail-closed verification anchored to the APK signer (`PianoRegistryAnchorPlugin` + `registry-signature.ts`) `[VERIFIED module list; REPORT details]`; healthcheck CI maintains engine health with operator-reviewed diffs.

**Residual:** dependency trust is inherited (pinning ≠ audit); registry Long PQ horizon — a CRQC would threaten RSA-PSS forgery; a versioned format with an optional second PQ signature line (e.g. ML-DSA) is proposed as cheap forward-prep (research backlog, `[HYPOTHESIS]`); a _user-imported_ registry applies only when its detached `registry-sig-v1` signature verifies under the APK anchor or an operator-confirmed trusted key (fingerprint shown, out-of-band confirm, known_hosts-style) **and** its signed `sequence` orders at/above the active floor — replayed older signed registries are rejected, unsigned-era (sequence-less) registries cannot be imported, and a different payload on an equal sequence is rejected as unordered (equal-seq is idempotent re-import only; the signing script refuses content changes without a bump) `[VERIFIED registry-import.ts, scripts/sign-registry.mjs]`; the informational hash chain warns on rollback links without gating `[VERIFIED registry-chain.ts]`.

### A5 — Orbot/Tor layer

**Capabilities/knowledge:** transports everything; a misconfigured torrc (`NoIsolateSOCKSAuth`) silently degrades per-engine isolation (client cannot detect) — documented `[VERIFIED SECURITY.md:139-141]`; Tor de-anonymization and network-level attacks (guard correlation, endpoint compromise) are outside app control — documented `[VERIFIED SECURITY.md:145-146]`; **HNDL** (harvest-now-decrypt-later: recording today's Tor traffic for future quantum decryption) is the same acceptance, tracked under the post-quantum out-of-scope line in §5 `[RESEARCH — no in-repo verification; SECURITY.md makes no HNDL-specific claim]`; onion-service PoW defense (Proposal 351, shipped Tor 0.4.8.x) is solved inside Orbot's tor — Ghost only experiences it as latency/CPU spikes under attack `[RESEARCH Tor blog 2023; USENIX Security '25]`.

**Stance:** Ghost treats Orbot as a trusted transport provider (same trust decision Tor Browser makes) and documents the dependency explicitly. Bridge/pluggable-transport configuration remains Orbot's domain; Ghost fail-closes without it.

### Planned — query-content layer (not shipped; see `docs/QUERY_CONTENT_PRIVACY.md`)

**Scope:** endpoint-level content attribution only (A1). An optional on-device model, supplied by the user, rewrites the outgoing query into a neutral form and the app sends pooled decoy queries to real engine endpoints; only results for the real query are shown. State is RAM-only and purged with all other search state. Without a reachable model the layer is inactive and behavior equals the transport-only mode.

**Not claimed:** no protection against timing, volume, circuit or entry/exit correlation (A2) — decoys add cover content, not anonymity against a global observer. The engine still receives the (rewritten) real query.

**Residual (accepted):**

- _Language remains observable._ The rewrite keeps the query's language; language is a coarse, population-wide attribute, whereas the removed signal (function-word frequencies, syntax, habitual phrasing, slang) is individual-specific. Hiding the language is a separate problem.
- _Lexical guard only._ The rewrite may only delete, reorder or inflect original words; identifiers, numbers and negations must survive verbatim. Dropping a plain content word is not detected, so the sent query is shown to the user. Synonym substitution is deliberately unsupported, so dialect content words remain.
- _Decoy quality is itself a fingerprint._ Formulaic or clustered decoys can re-identify the real query; pool admission rejects near-duplicates and decoys similar to the real query, and diversity is measured, not assumed.
- _Model supply and runtime._ The model and runtime are outside Ghost's trust boundary (user-supplied, loopback-only endpoint); some ternary model files need a specific runtime build. The loopback transport from the WebView is unverified on-device.
- _Cost._ Decoys are real requests: added engine load and bandwidth; the rewrite adds up to 15 s before the first request.

## 5. In Scope / Out of Scope

**In scope (defended):** query/result confidentiality against device-local recovery (RAM-only, anti-forensics); transport anonymity via Tor with per-search circuit unlinkability; content-integrity triage of untrusted engine output (checksum-validated v3 addresses, vanity-clone and mirror detection, scam heuristics, blacklist marking, consensus ranking); registry and APK authenticity; UI-surface capture resistance; fail-closed transport.

**Out of scope (explicitly not claimed, mirrored from SECURITY.md "What We Do Not Claim" + prior research):**

- The engine operator's knowledge of the query (definitional).
- Guard-level traffic-analysis resistance beyond Tor Browser equivalence.
- Rooted devices / malware with RAM access; anti-tamper/anti-Frida pretense.
- IME personalized learning, IME clipboard history, accessibility-service screen reading (environmental, documented for users).
- Tor-network-level de-anonymization attacks.
- Social engineering / harmful-content choices.
- Post-quantum confidentiality of recorded Tor traffic until Tor itself ships PQ handshakes (proposals 269/344 in progress; arti has no shipped PQ onion handshake as of Oct 2026) `[RESEARCH]`.

## 6. Mapping — Cure53 TTP-03 (Tor Browser & Tools audit, Jan 2024) `[RESEARCH]`

| Cure53 finding                                                                               | Ghost status                                                                                                                                                    | Evidence                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **TTP-03-010 (M)** task hijacking — recommends `taskAffinity=""` (+ consider singleInstance) | **Implemented** (singleTask + empty affinity; singleInstance deliberately not chosen — Capacitor bridge + PanicKit interactions)                                | `[VERIFIED AndroidManifest.xml:21-22, SECURITY.md:78]`                          |
| **TTP-03-011 (L)** deep-link flood DoS                                                       | **N/A** — no VIEW/BROWSABLE surface at all                                                                                                                      | `[VERIFIED AndroidManifest.xml:24-27]`                                          |
| **TTP-03-012 (L)** no root warning; Cure53 advises non-blocking warning (not blocking)       | **Partial** — "not anti-root" honesty exists `[VERIFIED SECURITY.md:60]`; a non-blocking rooted-device advisory dialog is a known open item (prior research §4) | gap, S-sized                                                                    |
| Conclusions: exported components lacking input validation                                    | MainActivity (launcher, no input surface) + PanicResponderActivity validates exact action string before wiping `[VERIFIED PanicResponderActivity.java:23]`      | meets intent; documented as PanicKit semantics `[VERIFIED SECURITY.md:130-135]` |
| TTP-03 tab-state/bridge-injection/hostname-spoofing UI (Firefox-specific)                    | **No analogue** — Ghost renders no remote content in-app; result visits hand off to Tor Browser                                                                 | by-architecture                                                                 |

## 7. Mapping — self-authored research findings (prior round, v4.0.1 → v4.1.0 status)

| Finding (prior report §)                                             | v4.1.0 status                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UA/headers distinguishable from Tor Browser (§2)                     | **Fixed** — Android 10/ESR 140 UA, canonical header order, Priority, gzip/deflate `[VERIFIED commits 1e1bce4ae7, 7c06a377d3]`                                                                                                                                                                                                            |
| taskAffinity missing (§4)                                            | **Fixed** `[VERIFIED AndroidManifest.xml:22]`                                                                                                                                                                                                                                                                                            |
| Blacklist snapshot bundling (§3)                                     | **Implemented** (`ahmia-blacklist.snapshot.ts` `[VERIFIED]`)                                                                                                                                                                                                                                                                             |
| Signed registry (§6/§7)                                              | **Implemented** (`engines.sig.json`, sign/verify scripts `[VERIFIED]`)                                                                                                                                                                                                                                                                   |
| Credential-derivation contract test (§1.2), stale doc comment (§1.1) | carry-overs — see test-gap analysis (pending)                                                                                                                                                                                                                                                                                            |
| Mirror arrays + Onion-Location discovery (§7)                        | **Implemented** — `mirrors` in the signed schema (http(s) .onion only, everything else dropped), runtime failover chain in `search.ts`, import validation, `mirror-fallback.test.ts`; no bundled engine declares mirrors yet. Onion-Location discovery lives in the healthcheck pipeline (`scripts/lib/onion-location.mjs`) `[VERIFIED]` |
| Root advisory dialog (§4), IME/clipboard/a11y documentation (§5)     | partially open (docs exist in SECURITY.md; user-facing guidance + advisory remain)                                                                                                                                                                                                                                                       |

## 8. Priority attack scenarios (audit-entry points)

Ordered by (likelihood × impact) as seen from an external auditor's first week:

1. **S1 — Repackaged/sideloaded APK** (A4): defeats all in-app guarantees. Defense = distribution-channel trust (F-Droid RB + published hashes). Audit question: "how does a user verify?" → SECURITY.md Evidence section `[VERIFIED :229-258]`.
2. **S2 — Registry substitution** (A4): forged or stale `engines.json`. Defense = RSA-PSS fail-closed verification anchored to APK signer; unsigned/invalid registry must refuse to load (test the failure path — see open test-coverage gaps above).
3. **S3 — Malicious result → user click** (A1): vanity clone or poisoned link. Defense = v3 checksum validation, clone detection, blacklist, TB hand-off. Residual: novel/unknown clones rank high until corroborated.
4. **S4 — Orbot misconfiguration** (A5): `NoIsolateSOCKSAuth` in user torrc silently degrades isolation. Defense = documentation only (client-side detection impossible).
5. **S5 — Session recovery after seizure** (A3.1): powered-on device, forensic RAM. Defense = panic wipe + boot scrub; residual accepted.
6. **S6 — Behavioral fingerprinting** (A1/A3): timing-based client identification beyond headers; IME/a11y exfiltration. Defense = partial (decoys); mostly documented out-of-scope.

## 9. Open items feeding other workstreams

- Test-coverage gaps for security-relevant failure paths (redirect chain, panic wipe, signature-fail, SOCKS-auth-fail, blacklist bypass) → separate test-gap analysis (pending).
- Parser robustness against hostile HTML → separate parser-robustness analysis (pending).
- Rebuild/verify instructions for external reviewers → `docs/REPRODUCIBLE.md`.
- Root-advisory dialog, mirror arrays, timing randomization, registry PQ second signature — product/research backlog.

---

_Maintainer note: this is a draft for review. Claims tagged `[VERIFIED]` were originally checked against baseline `7c06a377d3` on 2026-10-25 and re-checked against HEAD `1c65777580` on 2026-10-27. Claims tagged `[REPORT]` derive from the v4.0.1-era research report and should be re-verified at cited lines._

_Post-baseline security commits incorporated into this draft (between baseline `7c06a377d3` and HEAD `1c65777580`):_

- _`8eaba3dc8a` — apply-time trust recheck, positional canonicalization, export residue cleanup (AS8 lifecycle)_
- _`9663755066` — FLAG_SECURE restricted to non-debuggable builds (release/F-Droid builds unaffected)_
- _`8f2187ce2d` — case-aware entity keys, **breaker purge coverage**, export hardening (CSV formula neutralization, STIX UUID refresh). Resolved exception now covered by AS2: the circuit-breaker failure history embedded search URLs with query text and survived the screen-off purge; `purgeNow` resets the breaker since this commit (`src/lib/store/ghost-context.tsx:156,319`). Audits against pre-`8f2187ce2d` builds (e.g. the F-Droid v4.0.0 artifact) will observe the old behavior — this is expected, not a contradiction._
