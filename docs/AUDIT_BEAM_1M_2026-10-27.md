# Defect Audit — Ghost / Onion Search (Android)

**Auditor:** Beam (1M context, fresh eyes)
**Date:** 2026-10-27
**Target repo:** `D:\MCP Mods\digital-spyglass-android` (HEAD `1c65777580`)
**Scope:** defect hunt (invariant violations, correctness, security-adjacent, trust boundaries, test-evidence gaps). No code changes.
**Method:** file inventory → targeted reads of security-critical modules → self-review pass.

## 1. Inventory

Top-level app source (excluding `src/mcp`, `node_modules`, `tmp`):

- `src/lib/ghost/` — core logic: `authenticity.ts`, `blacklist.ts`, `breaker.ts`, `camouflage.ts`, `case-file.ts`, `correlation.ts`, `crypto-export.ts`, `dedup.ts`, `engines.ts`, `entities.ts`, `escape.ts`, `external.ts`, `graph.ts`, `highlight.ts`, `http.ts`, `parse.ts`, `pgp.ts`, `profiles.ts`, `qarf.ts`, `quality-filter.ts`, `query.ts`, `query-adapter.ts`, `ranking.ts`, `registry-chain.ts`, `registry-import.ts`, `registry-signature.ts`, `search.ts`, `snippets.ts`, `stix.ts`, `summarize.ts`, `tracking.ts`, `types.ts`, `wallet.ts`.
- `src/lib/platform/` — `bridge.ts`, `native.ts`, `storage.ts`.
- `src/lib/store/` — `ghost-context.tsx`, `ghost-settings.ts`, `personas.ts`.
- `src/routes/` — `graph.tsx`, `security.tsx`, `index.tsx`, `engines.tsx`, `__root.tsx`.
- `android/app/src/main/java/org/darknetcrawler/mobile/` — `MainActivity.java`, `PanicResponderActivity.java`, `PianoRegistryAnchorPlugin.java`, `PianoScreenPlugin.java`, `PianoTorHttpPlugin.java`, `PianoVpnPlugin.java`.
- Tests: 25 vitest files, 440 tests passing at HEAD; `tsc --noEmit` clean.

## 2. Findings

### F1 — LOW — `extractEntities` dedupes base58 wallets case-insensitively (incomplete F9 fix)

- **File:line:** `src/lib/ghost/entities.ts:72`
- **Evidence:**
  ```ts
  const key = `${type}:${value.toLowerCase()}`;
  ```
- **Trigger path:** a single snippet contains two base58 wallet addresses that differ only by case (e.g. `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa` and `1a1zp1ep5qgefi2dmptftl5slmv7divfna` — distinct base58 values). `extractEntities` collapses them into one badge.
- **Consequence:** distinct base58 identities are merged at extraction time, so downstream correlation/wallet-reuse signals (`correlation.ts`, `wallet.ts` `buildReuseIndex`) never see the second address. This contradicts the recently hardened case-aware keys in `case-file.ts` (`caseEntityKey`) and `correlation.ts`, which deliberately keep base58 case. The fix was applied at the case-file/correlation layer but not at the extraction/dedup layer, so the invariant is only half-enforced.
- **Minimal fix sketch:** make the dedup key type-aware: keep `value` verbatim for `btc`/`xmr`, lowercase for `email`/`onion`/`cve`/`ipv4`/`pgp`. Add a regression test mirroring `case-file.test.ts` "keeps base58 wallets case-SENSITIVE".
- **Confidence:** H.

### F2 — LOW — Session purge does not reset `FilterState` (and `resultsCollapsed`)

- **File:line:** `src/lib/store/ghost-context.tsx:131-157` (`purgeNow`).
- **Evidence:** `purgeNow` resets `searchQuery`, `searchOutcome`, `bookmarks`, `sessionLog`, `caseEntities`, but `filter` (FilterState) is absent from the reset list; `index.tsx` `resultsCollapsed` is component-local state never registered with `registerPurge`.
- **Trigger path:** run a search → set filter (e.g. onion-only, 2+ engines) → purge (panic or screen lock) → run a new search. The old filter persists into the wiped session; `resultsCollapsed` stays collapsed.
- **Consequence:** RAM-only session state leaks across a purge boundary (not sensitive, but violates the "purge empties session state" contract and can confuse the operator).
- **Minimal fix sketch:** add `setFilterState({ sort: "best", onionOnly: false, minEngines: 1 })` to `purgeNow`; register a purge in `index.tsx` that calls `setResultsCollapsed(false)`.
- **Confidence:** H.

### F3 — MED — Bundled registry carries no `sequence`, so rollback protection is inert for the baseline

- **File:line:** `src/lib/ghost/engines.json` (no `sequence` field); `src/lib/ghost/registry-import.ts:273-300` (`sequenceFloorViolation`); `src/lib/ghost/registry-import.ts:262-265` (`registrySequence`).
- **Evidence:** `engines.json` has no `sequence` key (verified via `node -e`). `registrySequence` returns `null` for it, so `sequenceFloorViolation` computes `floor = Math.max(null ?? 0, null ?? 0) = 0`. An import with `sequence: 0` therefore passes (`incoming 0 >= floor 0`), and because neither floor source has `sequence === 0`, `seqSources` is empty and the equal-sequence collision check is skipped entirely. An import with any positive sequence also passes.
- **Trigger path:** operator (or a trusted-key signer) imports a registry whose `sequence` is `0` (or any value) against the current bundle. The gate accepts it; the documented "replayed older signed registry is rejected" property never engages because there is no baseline sequence to order against.
- **Consequence:** the rollback-protection invariant (SECURITY.md "Rollback protection") is code-correct but data-inert until the operator runs `scripts/sign-registry.mjs --sequence 1` (or higher). Until then, any sequenced import passes the floor.
- **Minimal fix sketch:** either (a) release artifact: sign the bundled registry with `--sequence 1` so `engines.json` carries `sequence`; or (b) code: treat a missing bundled sequence as "no imports permitted until baseline is sequenced" (reject all imports when `registrySequence(bundledRegistry()) === null`). (a) is preferred; (b) is the fail-closed code-side backstop.
- **Confidence:** H.

### F4 — LOW — Case-file parser lacks prototype-pollution guard and bounds on `detail`

- **File:line:** `src/lib/ghost/case-file.ts:113-152` (`validateEntity`); `src/lib/ghost/case-file.ts:154-177` (`validateCaseObject`).
- **Evidence:** `validateEntity` validates `detail` only as `typeof === "string"` with no length cap; neither function calls a forbidden-key check (contrast `registry-import.ts:78-88` `checkNoForbiddenKeys`, applied recursively there).
- **Trigger path:** a crafted case file containing `{"__proto__": {...}}` or an entity with a multi-megabyte `detail` string. The destructuring in `validateEntity` reads named fields and ignores extras, so `__proto__` is unlikely to pollute in practice, but the defense-in-depth parity with the registry importer is missing; the unbounded `detail` is a memory-DoS vector before the 2 MB file cap (which is checked, but a single field can still be ~2 MB).
- **Consequence:** latent prototype-pollution surface + unbounded field. Low impact given the destructure, but inconsistent hardening.
- **Minimal fix sketch:** add `checkNoForbiddenKeys` parity (or at least a top-level forbidden-key rejection) and cap `detail` length (e.g. 4096), mirroring `note`/`name` caps in `registry-import.ts`.
- **Confidence:** M.

### F5 — LOW — CSV formula-injection guard misses non-whitespace control characters

- **File:line:** `src/lib/ghost/stix.ts:165-168` (`escapeCsvCell`).
- **Evidence:**
  ```ts
  if (/^[\s=+\-@]/.test(value)) { value = `'${value}`; }
  ```
- **Trigger path:** a field whose first character is a control char outside `\s` (e.g. `\x01=cmd` or `\x1f+...`) followed by a formula starter. Spreadsheet apps may still evaluate after stripping/ignoring the leading control byte.
- **Consequence:** a crafted result title/snippet could inject a formula when the CSV is opened in Excel/LibreOffice. The recently hardened whitespace coverage (`\s`) does not extend to the full control range.
- **Minimal fix sketch:** broaden the leading-char class to `/^[\s\x00-\x1f=+\-@]/` (or trim + test), matching the documented "leading whitespace/control chars" intent.
- **Confidence:** M.

### F6 — LOW (suspicion) — `extractEntities` timeout is per-pattern, not per-match

- **File:line:** `src/lib/ghost/entities.ts:82-83`.
- **Evidence:** the 50 ms guard sits outside the inner `while (re.exec(...))` loop, so it only fires between patterns. All patterns are documented ReDoS-safe with bounded quantifiers, and the test suite passes the adversarial inputs, so this is latent only.
- **Trigger path:** a future pattern added with nested quantifiers would not be interrupted mid-scan.
- **Consequence:** potential UI freeze only if a non-linear regex is introduced later.
- **Minimal fix sketch:** move the timeout check inside the inner loop (check every N matches). Label as preventive hardening, not a current defect.
- **Confidence:** L.

### F7 — LOW (test-evidence gap) — `engines.test.ts` asserts 13 engines but threat model/docs reference 14

- **File:line:** `src/lib/ghost/__tests__/engines.test.ts:8-11` (`ENGINES.length === 13`, "Torgol removed").
- **Evidence:** `HANDOVER_PHASE5.md` §8 lists 14 engines including Torgol; threat model §1 lists "13 onion search engines". The test pins 13. Not a code defect per se, but the doc/test counts disagree (13 vs 14), and `ENGINES.length` is asserted as a hard invariant in tests. If Torgol is re-added, the test breaks; if it stays removed, the handover doc is stale.
- **Trigger path:** any change to the engine set requires updating both the test and the docs in lockstep.
- **Consequence:** documentation drift; auditors cannot tell which count is authoritative.
- **Minimal fix sketch:** reconcile the handover doc to 13 (or update both if Torgol returns) and add a comment in the test citing the canonical source.
- **Confidence:** M.

### F8 — LOW (trust boundary) — `unwrapRedirect` trusts engine-supplied query params to produce non-onion result URLs

- **File:line:** `src/lib/ghost/parse.ts:58-73` (`unwrapRedirect`).
- **Evidence:** for keys `redirect_url`, `url`, `u`, `redir`, `redirect`, `target`, `q`, if the value starts with `http(s)://`, it becomes the result URL with no onion check at extraction time.
- **Trigger path:** a malicious/misconfigured engine returns HTML whose redirect wrapper points at a clearnet URL. The result row carries a clearnet URL; `isOnion()` is false so the UI shows no onion badge and prompts before opening, and no fetch occurs (fetches are onion-gated in `http.ts`), but the URL still flows into exports (CSV/STIX) and the graph.
- **Consequence:** data-integrity/trust issue, not a Tor-only networking violation, but an untrusted engine can inject off-network destinations into exported artifacts. Consider gating `unwrapRedirect` output through `isOnion` (or marking non-onion results distinctly).
- **Minimal fix sketch:** only accept unwrapped values whose host is `.onion` (or at least flag them); keep clearnet redirect targets out of the result set unless explicitly allowed.
- **Confidence:** M.

### F9 — LOW — `case-file.ts` `sameUrlSet` can collide on newline-containing URLs

- **File:line:** `src/lib/ghost/case-file.ts:107-111`.
- **Evidence:**
  ```ts
  return sorted(a).join("\n") === sorted(b).join("\n");
  ```
  URL validation in `validateEntity` checks only `^https?://` and length ≤ 2048; it does not reject control characters, so a URL may contain `\n`.
- **Trigger path:** two URL sets whose joined forms differ only by boundary placement (e.g. `["http://a\nhttp://b"]` vs `["http://a", "http://b"]`) compare equal.
- **Consequence:** merge report counts identical sets incorrectly (unchanged vs updated). Minor.
- **Minimal fix sketch:** compare length + element-wise after sorting, or join with a separator that cannot occur in a validated URL (reject control chars in URL validation).
- **Confidence:** M.

### F10 — LOW — Onion-hostname case handling differs between `parse.ts` and `http.ts`

- **File:line:** `src/lib/ghost/parse.ts:75-82` (`isOnion`, lowercases) vs `src/lib/ghost/http.ts:80-86` (`isOnionUrl`, does not lowercase).
- **Evidence:** `parse.ts` does `new URL(url).hostname.toLowerCase()`; `http.ts` does `new URL(url).hostname.endsWith(".onion")` with no lowercasing.
- **Trigger path:** an engine returns a result URL whose host is uppercase (e.g. `http://ABC…XYZ.ONION/`). `isOnion()` classifies it as an onion (badge shown), but `fetchText`/`fetchPostBody` block it as non-onion.
- **Consequence:** fail-closed on the network side (good), but the UI badge and the "open in Tor Browser" prompt disagree with the fetch gate; exports (CSV/STIX) carry the URL tagged as onion. Not a Tor-only violation, but an inconsistency an auditor would flag.
- **Minimal fix sketch:** lowercase the hostname in `isOnionUrl` (or reject uppercase hosts earlier in `parseBySelectors`).
- **Confidence:** H.

### F11 — LOW — PanicKit external trigger skips WebView in-memory clearing

- **File:line:** `android/.../PanicResponderActivity.java:24` calls `PianoScreenPlugin.executeHardPanicWipe(this, null)`.
- **Evidence:** `executeHardPanicWipe(Context, WebView)` only runs `webView.clearCache/clearFormData/clearHistory` when the WebView is non-null. The external trigger passes `null`.
- **Trigger path:** Ripple/Guardian panic button fires `info.guardianproject.panic.action.TRIGGER` while Ghost is backgrounded or the WebView reference is unavailable. The native wipe still shreds `shared_prefs`, cache, code cache, and `app_webview` on disk, and kills the process, so disk artifacts are cleared; but the in-memory WebView cache/form/history teardown is skipped.
- **Consequence:** a narrower wipe on the external path than on the in-app button path. Residual RAM-only WebView state could survive until process death (which does happen via `killProcess`). Low impact because the process is terminated, but the two paths are not equivalent.
- **Minimal fix sketch:** in `PanicResponderActivity`, resolve the WebView via `getBridge()` if available, or document that the external path relies on process death for RAM clearing (it does).
- **Confidence:** H.

### F12 — LOW — VPN detection treats any `tun\d+` interface as "Orbot active"

- **File:line:** `android/.../PianoVpnPlugin.java:94-103` (`checkTunInterface`).
- **Evidence:** `name.matches("tun\\d+") && nif.isUp()` returns true for any TUN interface, regardless of which app created it.
- **Trigger path:** a co-resident VPN (non-Orbot) brings up a `tun0` interface. Ghost reports "VPN active" even though traffic is not routed through Orbot/Tor.
- **Consequence:** the VPN gate (which blocks queries when `vpnActive === false`) can be satisfied by an unrelated tunnel, weakening the "Tor-only" assurance at the UI level. Network fetches still require Orbot's SOCKS5 on 127.0.0.1:9050, so queries fail if Orbot is absent, but the status indicator lies.
- **Minimal fix sketch:** additionally verify the SOCKS endpoint (127.0.0.1:9050) is reachable, or match the interface name against Orbot's known prefix; at minimum, label the check "a VPN tunnel is up" rather than "Orbot".
- **Confidence:** M.

## 2b. Self-falsification pass (triple-check of every finding)

Each finding was challenged against three questions: (a) does the cited line actually exist and say what I quoted? (b) is the trigger path reachable in a real build, not just in theory? (c) did I overstate severity? Outcomes:

| Finding | Survived? | Adjustment |
|---|---|---|
| F1 | Yes (real, but UI-badge scope only — correlation already case-aware) | Severity MED → LOW; trigger probability low for valid checksummed addresses. |
| F2 | Yes (verified in code: `filter` absent from purgeNow) | None. |
| F3 | Yes (verified: `engines.json` has no `sequence`; floor=0) | Reframed as release-hygiene gap, not code defect. Code is correct; artifact is missing. |
| F4 | Yes (verified: no forbidden-key check, no detail cap) | Confidence M (defense-in-depth, not exploitable today). |
| F5 | Partially — control chars alone are not formula starters in Excel; only `=,+,-,@,tab` matter | Kept as LOW polish; the whitespace fix already covers the practical case. |
| F6 | Not a defect — preventive only | Kept as LOW suspicion with Confidence L; labeled "not a current defect". |
| F7 | Yes as doc drift, not a runtime defect | Severity MED → LOW. |
| F8 | Yes as trust-boundary note | None; explicitly not a Tor-only violation. |
| F9 | Yes but extremely low probability | Kept as LOW. |
| F10 | Yes (verified both functions) | None; fail-closed direction is safe, only UI/badge inconsistency. |
| F11 | Yes (verified: `null` WebView passed) | None; process is killed, so RAM is cleared anyway. |
| F12 | Yes (verified: only name pattern + isUp) | None; queries still fail without Orbot SOCKS. |

**Falsified / removed:** none of the 12 were dropped, but F1 and F7 were downgraded and F5/F6 were softened. No finding was inflated to HIGH. Two candidates I considered and rejected as non-defects: (a) `purgeNow` not resetting `ready` — `ready` is a boot flag, correctly preserved; (b) `MainActivity.onPause` alpha hack — intentional anti-recents measure, not a defect. I also rejected "storage.ts returns fallback on parse failure" as a defect — that is fail-soft by design.

## 3. Looked-but-clean (audited, found sound)

- **Tor-only networking:** `src/lib/ghost/http.ts` rejects any non-`.onion` URL in both `fetchText` and `fetchPostBody`; `PianoTorHttpPlugin.java` re-validates `isValidOnionUrl` on every hop and blocks redirects outside v3 `.onion`; redirect chain re-validates host and rejects cross-host redirects carrying a request body. No clearnet HTTP path exists.
- **RAM-only / purge:** `ghost-context.tsx` `purgeNow` clears React Query, wipes memory stores, blacklists/spoof caches, invalidates Tor verification, resets breaker (F2 companion — breaker error state cleared, addressing the known 8f2187ce2d fix). Native wipe shreds `shared_prefs`, cache, code cache, `app_webview`, calls `finishAndRemoveTask` + `killProcess`. `onSaveInstanceState` clears the bundle. `allowBackup=false` + extraction rules exclude all domains.
- **FLAG_SECURE:** `MainActivity.java` applies `FLAG_SECURE` in non-debuggable builds (commit 9663755066); recents snapshot disabled on Tiramisu+; overlay windows hidden on R+.
- **Registry signature/sequence:** `registry-signature.ts` fail-closes on missing WebCrypto/anchor/malformed sig; content-key binding prevents stale "verified" verdicts; `resetRegistryVerification` on registry swap. `registry-import.ts` validates onion-only bases, base templates, forbidden keys recursively, size caps, mathRe equality with bundled pattern, and enforces the sequence floor + equal-sequence collision check. Trusted keys use known_hosts-style fingerprint confirmation.
- **Crypto export:** `crypto-export.ts` uses fresh salt/IV per call, AES-256-GCM with 128-bit tag, AAD over header fields, PBKDF2 210k (bounded 10k–1M), and rejects tampering/wrong passphrase. Plaintext path in `graph.tsx:433` is the known, documented one.
- **CSV/STIX:** `escapeCsvCell` covers formula starters and leading whitespace; STIX uses fresh UUIDs (no weak 32-bit hash).
- **Base58 case sensitivity:** `case-file.ts` `caseEntityKey` and `correlation.ts` keep btc/xmr case; `wallet.ts` classifies without folding. (F1 notes the remaining extraction-layer gap.)
- **Panic wipe ordering:** `panicWipe` purges, clears settings + registry trust, then invokes native hard wipe; JS-side fallback covers the case where the native call never runs.

## 4. Unexplored / not audited (named, not guessed)

- Java unit tests cover only `PianoTorHttpPlugin`; `PianoScreenPlugin` wipe, `PanicResponderActivity`, `PianoRegistryAnchorPlugin`, `PianoVpnPlugin` have no automated tests (panic wipe is hard to unit-test; flagged as a coverage gap, not a defect claim).
- `PanicResponderActivity.java` validated only by action-string check (per threat model); not re-read in depth here.
- `proguard-rules.pro` log-stripping not re-verified against the release build in this pass.
- `src/mcp/` (separate MCP server) out of scope for this audit.
- No dynamic/device testing performed; all findings are static.

## 5. Summary

Twelve findings: 1 MED (F3), 11 LOW (F1, F2, F4, F5, F6, F7, F8, F9, F10, F11, F12). No HIGH invariant violations discovered beyond the already-documented plaintext export path. The codebase is substantially hardened; the remaining items are consistency gaps (case-awareness not propagated to extraction), a release-artifact gap (bundled registry missing `sequence`), and defense-in-depth parity items. F1 and F3 are the most worth fixing before the next release; the rest are polish.

---

## MEMORY PAYLOAD

### (i) Entities / observations to add to the graph

- "ExtractEntities dedup key lowercases all types including base58 wallets — because the case-aware fix landed in case-file.ts/correlation.ts but not in entities.ts:72, so distinct base58 addresses differing by case collapse at extraction time — trigger: any snippet with two case-distinct base58 wallets."
- "PurgeNow in ghost-context.tsx omits FilterState and index.tsx resultsCollapsed from the reset list — because those states were added later and never wired into the purge — trigger: purge followed by a new search inherits stale filter/collapse."
- "Bundled engines.json has no sequence field — because the signing script requires --sequence on first run and it has not been applied — so registrySequence returns null, floor becomes 0, and rollback protection is inert for the baseline — trigger: any registry import against the current bundle."
- "Case-file parser lacks the forbidden-key guard and detail length cap that registry-import has — because the two parsers were hardened separately — trigger: crafted case file with __proto__ or oversized detail."
- "CSV escapeCsvCell formula guard covers whitespace but not the full control-char range — because the regex is /^[\s=+\-@]/ — trigger: a field beginning with a non-whitespace control char followed by a formula starter."
- "Case-file sameUrlSet joins URLs with newline, and URL validation does not reject control chars — because validateEntity only checks the http(s) prefix and length — trigger: URL sets that collide on join boundaries."
- "isOnion (parse.ts) lowercases the hostname but isOnionUrl (http.ts) does not — because the two modules were written independently — trigger: an engine returns an uppercase .ONION URL; badge shows onion but fetch blocks it."
- "PanicResponderActivity passes null WebView to executeHardPanicWipe — because the external trigger has no bridge reference — so WebView in-memory clearing is skipped on the PanicKit path; only disk shreds + process kill run."
- "PianoVpnPlugin.checkTunInterface matches any tunN interface — because it only checks the name pattern and isUp() — so a co-resident VPN can satisfy the VPN gate without Orbot/Tor."

### (ii) Traits to register (technical-error lessons)

- Trait: "When a case-sensitivity fix is applied at one layer (case-file/correlation keys), audit every other layer that dedups or keys the same values (extraction, graph, wallet) — partial propagation leaves the invariant half-enforced." Priority P1.
- Trait: "Purge handlers must enumerate all session state slots, including ones added later (filter, collapse flags) — a new state slot is not automatically covered." Priority P1.
- Trait: "A code-level invariant (rollback sequence floor) is inert if the shipped artifact lacks the field it keys on — verify the committed data file carries the field, not just the code." Priority P1.
- Trait: "Harden all untrusted-input parsers to the same standard (forbidden keys, field caps) — parity gaps across parsers are recurring findings." Priority P2.
- Trait: "Be your own falsifier before submitting an audit — challenge each finding on (a) line exists, (b) trigger reachable, (c) severity honest; downgrade or drop what does not survive. Inflated severity destroys trust." Priority P1.

### (iii) Open questions for the operator

- Should the bundled registry be signed with `--sequence 1` now (release artifact change), or should the code reject all imports until the baseline is sequenced (fail-closed backstop)? Both can be done; (a) alone restores the documented invariant.
- Is Torgol permanently removed (13 engines) or expected to return (14)? The handover doc and tests disagree.
- Should `detail` on case entities be capped, and at what length? No current cap exists.
- Is the plaintext export path (graph.tsx ~433, known) still acceptable for the next release, given the surrounding purge/export-epoch hardening is in place?