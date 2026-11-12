# Ghost Project — Handover Briefing for Next Agent

**Generated:** 2026-08-21
**Session:** ghost-phase5-20260821
**Operator:** Joerg Bollwahn

This file is local configuration. It is a comprehensive
briefing for the next agent session. Also stored in SuperMemory for `affect_context_load`.

> **STATUS UPDATE 2026-10-21:** F-Droid MR !46224 was **MERGED** on 2026-10-19
> (linsui, sha 381b6b6e, v1.0.4/vc5). The original freeze reason "pending MR"
> is obsolete. `phase5-camouflage` remains frozen **pending operator decision
> post-v4.0.0** — the 6-pillar security architecture landed directly on main
> (v4.0.0/vc10, 2026-10-20), which changes the branch's relevance. Whether the
> branch is still needed at all is an open operator question.
> Corrections to the text below: `.devin/` is **tracked** in this repo (not
> gitignored), GitHub is suspended — Codeberg is the primary remote.
> Everything below this note is historical (generated 2026-08-21).

---

## 1. Project Identity

- **Product:** Ghost / Ghost Search — Tor-only onion search app for Android
- **Repository:** `D:\MCP Mods\digital-spyglass-android`
- **GitHub:** `https://github.com/sookoothaii/digital-spyglass-android.git`
- **Package:** `org.darknetcrawler.mobile`
- **License:** GPL-3.0-or-later
- **Operator:** Joerg Bollwahn (sookoothaii on GitHub, sookoothaii1 on GitLab)

## 2. Product Philosophy (NON-NEGOTIABLE)

1. Anonymity and security are absolute. Nothing reduces user anonymity.
2. No backend. No accounts. No telemetry. No analytics. No ads.
3. All onion traffic is Tor-only via Orbot SOCKS5 proxy at `127.0.0.1:9050`.
4. No clearnet fallback for onion requests. Ever.
5. Search data (queries, results, bookmarks, session state) exists only in RAM.
6. State is purged on: panic wipe, screen-off/device lock, app process termination.
7. No persistent query or result history. Only non-sensitive preferences are persisted.
8. Adult users with consent may search for anything. No result removal. Snippet filter
   is liability-control only (replaces snippet text, never removes results).
9. No feature may introduce non-Tor network calls, TLS handshakes (JA3 fingerprint),
   locale/device fingerprinting, or disk persistence.
10. Private development plans must NEVER be published to GitHub. They are gitignored.

## 3. Tech Stack

- React 19, TypeScript, TanStack Router/Query/Virtual, Vite, Tailwind CSS v4
- Capacitor 8 (Android wrapper)
- Android native Java plugins (PianoTorHttpPlugin.java — raw Socket over SOCKS5)
- **Bun** package manager (NOT npm/yarn)
- Gradle 8.14.3 for Android builds
- Orbot VPN mode as Tor transport

## 4. Current Branch State

| Branch              | Commit    | Pushed              | Purpose                                 |
| ------------------- | --------- | ------------------- | --------------------------------------- |
| `main`              | `c62cc52` | Yes (GitHub)        | Released code, F-Droid MR based on this |
| `phase5-camouflage` | `0a4ad92` | **No (local only)** | Phase 5 Camouflage Layer                |

**CRITICAL:** Do NOT merge `phase5-camouflage` to main, do NOT push it, do NOT create
a `v2.0.0` tag until F-Droid v1.0.0 acceptance is confirmed via authoritative GitLab API check.

### Working tree (uncommitted, intentional):

- `metadata/org.darknetcrawler.mobile.yml` — F-Droid forky fix (local copy)
- `.devin/` — local Devin configuration (untracked, gitignored)
- `docs/GHOST_V2_PLAN.md` — private plan (gitignored)
- `docs/SITD_Theory_Overview_Revised.md` — private theory (gitignored)
- `src/lib/ghost/__tests__/` — NEW unit test suite (142 tests, vitest)
- `vitest.config.ts` — NEW vitest configuration
- `package.json` — MODIFIED (test scripts + vitest devDependency)
- `src/lib/ghost/camouflage.ts` — MODIFIED (4 functions exported for tests)
- `src/lib/ghost/search.ts` — MODIFIED (5 functions exported for tests)

## 5. F-Droid Submission Status

- **MR:** https://gitlab.com/fdroid/fdroiddata/-/merge_requests/46224
- **Title:** New app: Ghost
- **State:** `opened` (NOT merged, NOT closed) as of 2026-08-21
- **Labels:** `New App`, `waiting-on-response`
- **Maintainer:** linsui
- **Last maintainer feedback:** "Install node from forky." (2026-08-20 16:11)
- **Our response:** forky fix pushed 2026-08-20 17:33 (commit 837b4ec7 in GitLab fork)
- **No new maintainer response** since then — still waiting for review.

### GitLab PAT location

`C:\Users\sooko\AppData\Roaming\devin\mcp_config.json`
Field: `mcpServers.gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN`
Use for REST API calls. **Never commit this token.**

### How to check MR status

```powershell
$pat = (Get-Content "$env:APPDATA\devin\mcp_config.json" -Raw | ConvertFrom-Json)."mcpServers".gitlab.env.GITLAB_PERSONAL_ACCESS_TOKEN
$headers = @{ "PRIVATE-TOKEN" = $pat }
$mr = Invoke-RestMethod -Uri "https://gitlab.com/api/v4/projects/fdroid%2Ffdroiddata/merge_requests/46224" -Headers $headers
Write-Output "State: $($mr.state), Labels: $($mr.labels -join ', ')"
```

## 6. Privacy Architecture

### Transport

- `.onion` requests → PianoTorHttpPlugin.java → raw `java.net.Socket` → Orbot SOCKS5
- `.onion` hostnames passed as SOCKS5 DOMAINNAME (Tor does DNS, no system DNS)
- Plain HTTP over `.onion` (no TLS) — Tor provides E2E encryption, no JA3 fingerprint
- Fixed UA: `Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0`
- Fixed `Accept-Language: en-US,en;q=0.9` (no locale leak)
- HTTP/1.1 with `Connection: close`, no Referer, no custom headers

### Circuit Isolation

- Each search generates `crypto.randomUUID()` as SOCKS5 password (user=`ghost`)
- Tor's `IsolateSOCKSAuth` gives each unique credential pair a separate circuit
- All engines in one search share the same circuit (intentional)
- Different searches get different circuits (unlinkable)
- Circuit breakers reset for open engines at start of each new search

### Cookies

- Per-host cookie jar in PianoTorHttpPlugin.java
- Purged after every search via `purgeTorCookies()` bridge call
- OSS/Torgle captcha cookies preserved within a single search, purged after

### Anti-Forensics

- `FLAG_SECURE` — blocks screenshots and recents thumbnails
- `setHideOverlayWindows()` (Android 12+) — tapjacking protection
- `onSaveInstanceState()` clears Bundle — no Android state restoration
- `allowBackup="false"` — no cloud backup
- ProGuard strips all log levels in release builds
- Panic wipe: clears React Query, bookmarks, query, results, stores, settings, exits app
- Screen-off listener: triggers `purgeNow()`
- Background (HOME key): does NOT purge — session survives multitasking

## 7. Phase 5 Camouflage Layer (current work)

### Research basis (SOTA 2023-2026)

- **FRONT** (arXiv 2510.11804): 86%→1.6% detection accuracy with Rayleigh padding
- **RegulaTor** (USENIX Security 2023): beats DNN attacks at <10% time overhead
- **Tamaraw** (NDSS 2026): constant-rate, very strong but prohibitively expensive
- **WTF-PAD**: 90%→17% accuracy, ~60% bandwidth overhead
- **Honest truth:** no padding-only defense reaches 0% detection. We reduce but do NOT eliminate.

### Implementation (`src/lib/ghost/camouflage.ts`)

- `sampleRayleigh(sigma)` — inverse CDF sampling
- `sampleExponential(lambda)` — inverse CDF sampling
- `shuffle(arr)` — Fisher-Yates
- `sleep(ms, signal)` — abortable with AbortSignal
- `standardCamouflage()` — sigma=250ms, 1-3 decoys
- `paranoidCamouflage()` — sigma=500ms, 3-6 decoys
- `standardSurge()` — surgeSize=4, pauseLambda=1/800, intraSigma=150ms
- `paranoidSurge()` — surgeSize=3, pauseLambda=1/1500, intraSigma=250ms
- `fireDecoys(config, socksAuth, signal)` — batch dummy requests during search
- `assignSurgeDelays(engineCount, config)` — precompute per-engine start times
- `startIdleDecoyScheduler(meanIntervalMs)` — background cover traffic
- `DECOY_TARGETS` — 4 .onion homepages (Ahmia, Torch, Tor66, OSS)

### Integration points

- `search.ts`: engines shuffled, Rayleigh/surge delays applied, decoys fired in parallel
- `ghost-context.tsx`: idle scheduler starts/stops with paranoidMode, screen-off, purge
- `security.tsx`: toggle in "policy" panel
- `types.ts`: `paranoidMode: boolean` in GhostSettings (default: false)

### Device verification results (2026-08-21)

- Standard: 17 requests in 478ms (single burst with Rayleigh spread)
- Paranoid: 16 requests in 2981ms (2 surges + 1.5s pause + 6 decoys)
- Idle decoys: 4 requests in 70s (exponential intervals ~4s, ~16s)
- No regression on circuit isolation, cookie purge, engine health

## 8. Current Engines (14)

| #   | Engine       | Trust | Special                          |
| --- | ------------ | ----- | -------------------------------- |
| 1   | Ahmia        | 3     | Anti-bot token, prepareSearchUrl |
| 2   | Torch        | 2     |                                  |
| 3   | TorDex       | 2     |                                  |
| 4   | Tor66        | 1     | prepareSearchUrl form extraction |
| 5   | OnionLand    | 1     |                                  |
| 6   | Excavator    | 1     |                                  |
| 7   | Amnesia      | 1     |                                  |
| 8   | DeepSearches | 1     |                                  |
| 9   | Torland      | 1     |                                  |
| 10  | Onionway     | 1     |                                  |
| 11  | OSS          | 1     | Math captcha POST flow           |
| 12  | Torgol       | 1     |                                  |
| 13  | Not Evil     | 2     |                                  |
| 14  | Torgle       | 1     | Math captcha POST flow           |

Removed: Haystak (prolonged offline), FindTor (persistent timeout)

## 9. Device Testing

- **Device:** Samsung, ADB serial `R5CR937FWMF`
- **ADB path:** `C:\Users\sooko\AppData\Local\Android\Sdk\platform-tools\adb.exe`
- **Orbot must be in VPN mode** before testing searches

### Build + install sequence

```powershell
bun run build:mobile
bunx cap sync android
cd android; .\gradlew.bat assembleDebug
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r "D:\MCP Mods\digital-spyglass-android\android\app\build\outputs\apk\debug\app-debug.apk"
& $adb shell am start -n org.darknetcrawler.mobile/.MainActivity
& $adb logcat -d PianoTorHttp:D *:S
```

### Verification commands

```powershell
bunx tsc --noEmit                                    # Typecheck
bunx prettier --check "src/**/*.{ts,tsx}"            # Prettier check
bunx prettier --write <files>                        # Prettier fix
bun run build:dev                                    # Dev build
bun run build:mobile                                 # Mobile build
```

## 10. Known Issues and Limitations

1. **Unit tests now exist** — 142 tests across 4 files (camouflage, entities, query, dedup). Run with `bun run test`. All passing.
2. **Not Evil / Torgle parser selectors** not fully verified against real HTML — engines return HTTP 200 with 21KB/14KB body, but CSS selectors not yet confirmed to extract results. Check Engine-Health-Dashboard in UI for hits > 0.
3. **P5-4 stream multiplexing** deferred — high effort
4. **Idle decoy screen-off/on lifecycle** implemented but NOT explicitly device-tested — scheduler fires correctly in foreground (verified in logcat), but stop/restart on screen-off/on not tested
5. **No reproducible build for v2** — v1.0.0 has signed APK, v2 does not
6. **`metadata/org.darknetcrawler.mobile.yml`** on working tree is local forky modification — do not commit to phase5-camouflage or main

## 11. Lessons Learned (from self-reflection)

1. **RESEARCH BEFORE CLAIMING:** Do not make definitive security claims based on prior knowledge. Always research current SOTA first.
2. **HONOR ITERATION GRANULARITY:** Each feature gets its own build+install cycle even if coupled.
3. **POWERSHELL PITFALLS:** `$host` is read-only. Build scripts incrementally. Use `[DateTime]` for time spreads.
4. **IMPORT AWARENESS:** Check dependency graph consciously when writing TypeScript.
5. **PHYSARUM LOGGING:** Call `affect_record` every ~15min for CLI proxy, after each LLM call, and for feedback.
6. **LIFECYCLE TESTING:** Lifecycle hooks need explicit state-transition testing.
7. **SELF-ASSESSMENT:** Be more critical of yourself than the operator is. V=5 T=5 does not mean "perfect".
8. **TEST STATISTICS CAREFULLY:** When writing statistical tests for distributions, verify the math (e.g. Jaccard similarity is shared/total not shared/(a+b-shared) — actually it IS shared/(a+b-shared), but empty string edge cases produce unexpected results like "".split(" ")=[""]). Always check edge cases first.
9. **MAKE ROW HELPER SIGNATURES EXPLICIT:** Test helper functions like makeRow() should have all parameters explicitly typed — don't hardcode "Title" as a default when tests pass different titles as the second positional argument.
10. **BASE58 ALPHABET:** Monero/Bitcoin addresses use Base58 which EXCLUDES 0, O, I, l. Test vectors must not contain these characters or the regex won't match.

## 12. Next Steps (Prioritized)

### IMMEDIATE (wait for external event)

1. Monitor F-Droid MR !46224 for maintainer response
2. Do NOT merge/push/tag until F-Droid accepts v1.0.0

### AFTER F-DROID v1.0.0 ACCEPTANCE

3. Merge `phase5-camouflage` → `main`
4. Tag `v2.0.0` on main
5. Build signed release APK with checksum
6. Push main to GitHub
7. Update F-Droid metadata if needed

### QUALITY ASSURANCE (can do now, on phase5-camouflage)

8. ~~Write unit tests for query parser, entity regex, dedup, camouflage distributions~~ **DONE (Session 2, 2026-08-21): 142 tests, all passing**
9. Explicitly device-test idle decoy screen-off/on lifecycle
10. Verify Not Evil and Torgle parser selectors against real HTML (engines return 200 with 21KB/14KB — need UI check for hits > 0)

### FUTURE ENHANCEMENTS (post-v2.0.0)

11. P5-4: Stream multiplexing
12. Tor Control Port integration (NEWNYM, direct circuit control)
13. VerifyTor improvement (check exit IP)
14. Engine-health auto-disable
15. Pluggable Transports UI (obfs4/Snowflake)
16. Haystak re-evaluation (check in 60 days)
17. Conflux/Vanguards via Orbot

## 13. Key Files

| File                                         | Purpose                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/ghost/camouflage.ts`                | NEW — traffic-analysis defense layer                              |
| `src/lib/ghost/search.ts`                    | Search orchestrator with camouflage scheduler                     |
| `src/lib/ghost/engines.ts`                   | 14 engine definitions with parsers                                |
| `src/lib/ghost/http.ts`                      | fetchText/fetchBodyOnly/fetchPostBody, verifyTor                  |
| `src/lib/ghost/types.ts`                     | GhostSettings (includes paranoidMode), ResultRow                  |
| `src/lib/ghost/breaker.ts`                   | Circuit breaker + health metrics                                  |
| `src/lib/ghost/entities.ts`                  | ReDoS-safe entity extraction                                      |
| `src/lib/ghost/query.ts`                     | Query parser (AND/OR/NOT/phrases)                                 |
| `src/lib/ghost/highlight.ts`                 | Query term highlighting                                           |
| `src/lib/ghost/escape.ts`                    | HTML/regex escaping                                               |
| `src/lib/ghost/parse.ts`                     | CSS selector parsing, isOnion, looksLikeCaptcha                   |
| `src/lib/ghost/snippets.ts`                  | Snippet filter (liability control)                                |
| `src/lib/platform/bridge.ts`                 | Capacitor bridge (torFetch, purgeTorCookies)                      |
| `src/lib/store/ghost-context.tsx`            | Session state, purge, idle decoy scheduler                        |
| `src/lib/store/ghost-settings.ts`            | Persisted preferences + paranoidMode                              |
| `src/routes/index.tsx`                       | Main search screen                                                |
| `src/routes/security.tsx`                    | Security posture, engine health, policy toggles                   |
| `android/.../PianoTorHttpPlugin.java`        | Tor SOCKS5 plugin                                                 |
| `android/.../MainActivity.java`              | FLAG_SECURE, overlay protection                                   |
| `android/app/proguard-rules.pro`             | Log stripping rules                                               |
| `metadata/org.darknetcrawler.mobile.yml`     | F-Droid build metadata (local forky mod)                          |
| `docs/GHOST_V2_PLAN.md`                      | PRIVATE plan (gitignored)                                         |
| `docs/SITD_Theory_Overview_Revised.md`       | PRIVATE theory (gitignored)                                       |
| `src/lib/ghost/__tests__/camouflage.test.ts` | NEW — 40 tests: Rayleigh/Exponential stats, shuffle, surge delays |
| `src/lib/ghost/__tests__/entities.test.ts`   | NEW — 24 tests: entity detection + ReDoS safety                   |
| `src/lib/ghost/__tests__/query.test.ts`      | NEW — 34 tests: query parser                                      |
| `src/lib/ghost/__tests__/dedup.test.ts`      | NEW — 44 tests: dedup, aggregate, flagScams, filterAndSort        |
| `vitest.config.ts`                           | NEW — vitest configuration (node env, tsconfig paths)             |

## 14. Operator Preferences

- Values precise, evidence-based, non-hyped reporting
- Prefers independent work — do not ask clarifying questions when task is clear
- Uses PowerShell (not bash). Use `-LiteralPath` for paths with spaces
- Check existing files before overwriting user-created changes
- Do not commit secrets or MCP configuration
- Do not publish private development plans
- After each iteration: build, install on device, let operator test
- Session end: update SuperMemory, Memory MCP, collect EMA, write session report, self-reflect
- "Erwachsene Menschen mit Consent dürfen alles suchen und sehen."
- "Keine Filter-Datenkrake — kein Entfernen von Suchergebnissen."
