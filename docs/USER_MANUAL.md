# Ghost (Onion Search) — Complete User Manual

**Version:** 4.0.1  
**Date:** 2026-10-24  
**App name:** Onion Search (Ghost)  
**Package:** `org.darknetcrawler.mobile`  
**Repository:** https://codeberg.org/sookoothaii/digital-spyglass-android  
**License:** GPL-3.0-or-later

---

## Table of Contents

1. [What Ghost Is](2. [What Ghost Is Not](#2-what-ghost-is-not)
2. [System Requirements](#3-system-requirements)
3. [Installation](#4-installation)
4. [First-Time Setup: Orbot and Tor Browser](#5-first-time-setup-orbot-and-tor-browser)
5. [Starting the App: Consent Gate](#6-starting-the-app-consent-gate)
6. [The Search Tab](#7-the-search-tab)
7. [The Engines Tab](#8-the-engines-tab)
8. [Search Results](#9-search-results)
9. [Opening Links Externally](#10-opening-links-externally)
10. [Session Persistence and Tab Switching](#11-session-persistence-and-tab-switching)
11. [Panic Wipe](#12-panic-wipe)
12. [Session Purge](#13-session-purge)
13. [Privacy and Security Guarantees](#14-privacy-and-security-guarantees)
14. [What Ghost Does NOT Protect Against](#15-what-ghost-does-not-protect-against)
15. [The 13 Onion Search Engines](#16-the-13-onion-search-engines)
16. [Circuit Breaker](#17-circuit-breaker)
17. [VPN Gate](#18-vpn-gate)
18. [FLAG_SECURE (Screenshot Block)](#19-flag_secure-screenshot-block)
19. [Pi-hole and Custom DNS Compatibility](#20-pi-hole-and-custom-dns-compatibility)
20. [Building from Source (Windows)](#21-building-from-source-windows)
21. [Building a Signed Release APK](#22-building-a-signed-release-apk)
22. [Installing on a Device](#23-installing-on-a-device)
23. [Testing and Debugging](#24-testing-and-debugging)
24. [Publishing to Google Play](#25-publishing-to-google-play)
25. [Alternative Distribution: F-Droid and GitHub Releases](#26-alternative-distribution-f-droid-and-github-releases)
26. [Troubleshooting](#27-troubleshooting)
27. [Project Structure](#28-project-structure)
28. [Architecture and Data Flow](#29-architecture-and-data-flow)
29. [Important Files Reference](#30-important-files-reference)
30. [Git History and Known-Good Commits](#31-git-history-and-known-good-commits)
31. [Legal Context and Researcher Access](#32-legal-context-and-researcher-access)
32. [Glossary](#33-glossary)

---

## 1. What Ghost Is

Ghost (store name **Onion Search**; a Google Play listing is planned but the app is not currently distributed there — see [docs/PRIVACY_POLICY.md](PRIVACY_POLICY.md)) is a **stateless Android meta-search client** for the Tor onion network. It queries 13 public onion search engines in parallel, aggregates the results, removes duplicates, ranks them by cross-engine agreement, and displays them in a virtualized list that exists only in RAM.

**Key characteristics:**

- **Meta-search:** Ghost does not crawl the web itself. It sends your query to existing onion search engines and combines their results.
- **Tor-only:** All network traffic goes through the Tor network via Orbot. No clearnet connections are made.
- **RAM-only:** Search queries and results exist only in memory during the active session. Nothing is written to disk.
- **No rendering:** Ghost never renders remote HTML inside the app. It parses search engine result pages in a detached DOMParser to extract titles, URLs, and snippets — but never displays the actual page content.
- **External links:** When you tap a result, the URL is handed to Tor Browser (an external app). Ghost never opens or displays the linked page.
- **No backend:** There is no server, no cloud service, no API, no database. The app is entirely client-side.
- **No accounts:** No login, no registration, no identity.
- **No telemetry:** No analytics, no crash reporting, no usage tracking, no advertising.
- **Consent-based:** The app shows a consent gate at every launch, requiring the user to confirm they are an adult (18+) using the tool for legitimate research purposes.

---

## 2. What Ghost Is Not

| Not claimed                         | Why                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Built-in Tor daemon                 | Ghost has no Tor node. It relies on Orbot (VPN mode) for Tor transport.                                   |
| Anti-root / anti-Frida / anti-debug | A JS-layer root check is theatre. The app shows a passive emulator hint only.                             |
| Encrypted local data                | Nothing sensitive is persisted, so there is nothing to encrypt.                                           |
| Stable engine uptime                | Onion search engines rotate addresses and go offline. A dead engine is reported, never silently replaced. |
| Content filter / blocklist          | Ghost does not filter results. The user sees everything the engines return.                               |
| Web browser                         | Ghost is a search interface. Page content is never rendered in-app.                                       |
| Content host                        | Ghost does not host, produce, or endorse any content. It is a search aggregator.                          |
| VPN service                         | Ghost does not provide VPN. It requires Orbot for VPN/Tor transport.                                      |

---

## 3. System Requirements

| Requirement     | Minimum             | Recommended     |
| --------------- | ------------------- | --------------- |
| Android version | 7.0 (API 24)        | 10.0+           |
| Target SDK      | 36 (compiled)       | 36              |
| Storage         | ~2 MB for APK       | ~5 MB free      |
| RAM             | 2 GB                | 4 GB+           |
| Network         | Tor via Orbot       | Orbot VPN mode  |
| Companion apps  | Orbot + Tor Browser | Latest versions |

**Required companion apps:**

1. **Orbot** — Tor proxy/VPN for Android (free, open-source)
2. **Tor Browser for Android** — for opening result links externally

---

## 4. Installation

### Option A: Install from Google Play (when published)

1. Open Google Play Store on your Android device
2. Search for "Onion Search"
3. Install the app
4. Proceed to [First-Time Setup](#5-first-time-setup-orbot-and-tor-browser)

### Option B: Sideload the APK

1. Obtain the APK file (`app-release.apk` or `app-debug.apk`)
   - From Codeberg Releases: https://codeberg.org/sookoothaii/digital-spyglass-android/releases
   - Or build from source (see [Building from Source](#21-building-from-source-windows))
2. Transfer the APK to your Android device (USB, cloud, messenger)
3. On the device: tap the APK file
4. Allow "Installation from unknown sources" if prompted
5. Install
6. Proceed to [First-Time Setup](#5-first-time-setup-orbot-and-tor-browser)

### Option C: Install via ADB (developer method)

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r "path\to\app-release.apk"
```

**Note:** If you have a debug APK installed and want to install a release APK (or vice versa), you must first uninstall the existing version because the signatures differ:

```powershell
& $adb uninstall org.darknetcrawler.mobile
& $adb install "path\to\app-release.apk"
```

---

## 5. First-Time Setup: Orbot and Tor Browser

Ghost requires Tor transport. Without it, the app is locked behind a non-dismissible VPN gate.

### Step 1: Install Orbot

- **Google Play:** Search for "Orbot" by The Tor Project
- **F-Droid:** Available on F-Droid
- **Direct:** https://orbot.app/

### Step 2: Install Tor Browser for Android

- **Google Play:** Search for "Tor Browser"
- **Direct:** https://www.torproject.org/download/#android

Tor Browser is needed because Ghost opens result links externally in Tor Browser, never rendering them in-app.

### Step 3: Configure Orbot in VPN Mode

1. Open Orbot
2. Choose **VPN Mode** (not SOCKS proxy mode)
   - VPN mode routes the entire app (including DNS) through Tor
   - Proxy mode can leak DNS and is blocked by Ghost's egress gate
3. In Orbot's app list, ensure **Ghost** (or **Onion Search**) is included
   - Or enable "All Apps" mode in Orbot
4. Tap **Start** in Orbot
5. Wait for the Tor circuit to be established (Orbot shows "Connected")

### Step 4: Launch Ghost

1. Open Ghost (Onion Search)
2. The VPN gate will automatically detect the active VPN transport
3. The consent gate appears (see [Starting the App](#6-starting-the-app-consent-gate))
4. After consent, the search interface is unlocked

**If the VPN gate does not disappear:**

- Ensure Orbot is running in VPN mode (not just proxy mode)
- Ensure Ghost is in Orbot's app list
- Restart Orbot
- Check that `TRANSPORT_VPN` is active in Android's network capabilities

---

## 6. Starting the App: Consent Gate

Every time you launch Ghost, a **consent gate** appears before the search interface.

### What the consent gate says

- **Title:** "Onion Search — Research Tool"
- **Header:** "research tool · adult consent"
- **Purpose:** The app is an open research tool for Tor. It aggregates results from public onion search engines.
- **No filtering:** "Nothing is filtered — you see everything the engines return."
- **Adult confirmation:** You confirm you are an adult (18+)
- **Research purposes:** journalism, security research, OSINT, academic study, personal privacy
- **User responsibility:** You accept full responsibility for how you use the results and for complying with the laws of your jurisdiction
- **Tool positioning:** The app does not host, produce, or endorse any content. It is a search aggregator.
- **No storage:** No disk storage, history, cache, database, telemetry, or accounts. Session results remain in RAM and are purged on exit or via panic button.

### Button

```
I am 18+ — I consent — continue
```

### Important notes

- The consent is **self-declared** — no identity verification, no age upload, no data collection
- The consent is **not logged** — it exists only in RAM for the current session
- The consent gate appears **at every app start** — it does not remember your answer
- There is **no bypass** — you must tap the button to proceed

---

## 7. The Search Tab

The Search tab is the main interface. It contains:

### Search bar

- A text input field at the top
- Placeholder text: "query · nothing is stored"
- Type your search query and press Enter (or the search button on your keyboard)
- The query is sent to all enabled, healthy engines in parallel

### Engine chips

- Below the search bar, small chips show all 13 engine names
- Active engines are highlighted
- Tapping a chip toggles that engine on/off
- Engine selections persist across sessions (non-sensitive preference; no query content is stored)

### Results counter

- After a search completes, a counter shows: `X RESULTS · Y MS`
- Example: `1352 RESULTS · 9177 MS`
- This tells you how many results were found and how long the search took

### Stop button

- During an active search, a Stop button is available
- Tapping it cancels all in-flight requests and stops the search
- Partial results already received are retained

### Expand/collapse report button

- A `+` / `−` button toggles the **Engine Report**
- The Engine Report shows per-engine statistics (see [Search Results](#9-search-results))

---

## 8. The Engines Tab

The Engines tab shows detailed information about each of the 13 search engines.

### What you see for each engine

| Field          | Description                                                                             |
| -------------- | --------------------------------------------------------------------------------------- |
| Name           | Engine name (e.g., Ahmia, Torch, Tor66)                                                 |
| Trust level    | Trust score (1-3), affects result ranking                                               |
| ON/OFF         | Toggle to enable/disable the engine for the current session                             |
| .onion address | The full v3 onion URL the engine is queried at                                          |
| Description    | Brief note about the engine's characteristics                                           |
| Status         | Live status (e.g., "TOR FETCH FAILED: SOCKS5 CONNECT FAILED: HOST UNREACHABLE" if down) |
| OPEN IN TOR    | Button to open the engine's homepage in Tor Browser                                     |

### Engine states

- **ON:** Engine is enabled and will be queried
- **OFF:** Engine is disabled and will not be queried
- **UNREACHABLE:** Engine was queried but the Tor connection failed (circuit breaker may have triggered)
- **CIRCUIT BREAKER:** Engine has failed 3 consecutive times and is in a 5-minute cooldown

### Manual circuit breaker reset

If an engine is in cooldown but you want to try it again immediately, you can toggle it OFF and back ON to reset the circuit breaker.

---

## 9. Search Results

### Result list

Results are displayed in a **virtualized list** (TanStack Virtual) that can handle thousands of rows efficiently. Each result shows:

| Field       | Description                                                                        |
| ----------- | ---------------------------------------------------------------------------------- |
| Title       | The page title as returned by the search engine                                    |
| URL         | The .onion URL of the result                                                       |
| Snippet     | A short text excerpt from the search engine (length-limited, not content-filtered) |
| Engine tags | Which engines returned this result (e.g., "TORCH TORDEX TOR66 AHMIA")              |

### Ranking

Results are ranked by **BM25 (Okapi BM25)** — a formal information-retrieval algorithm:

- BM25 scores each result based on query term frequency, document length, and inverse document frequency
- Cross-engine agreement boost: results returned by multiple engines rank higher
- Engine trust level is factored in (Trust 3 engines contribute more than Trust 1)
- Deduplication is by normalized URL
- Reference: Robertson & Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond" (2009)

### Entity Extraction

Results may display colored entity badges for:

- **BTC** — Bitcoin addresses (P2PKH, P2SH, Bech32)
- **XMR** — Monero addresses
- **PGP** — PGP public key blocks
- **EMAIL** — Email addresses
- **ONION** — .onion v2/v3 addresses
- **CVE** — Vulnerability references (CVE-YYYY-NNNNN)
- **IP** — IPv4 addresses

Entity extraction is purely presentational — no network enrichment, no person-level scoring. All patterns are ReDoS-safe (linear-time).

### Engine Report

When you tap the `+` / `−` button, an **Engine Report** expands showing per-engine statistics:

```
Ahmia       1054 HITS · 4462 MS
Amnesia      190 HITS · 1687 MS
Tor66         47 HITS · 2339 MS
Onionway      24 HITS · 2050 MS
TheDeepSearches 16 HITS · 2095 MS
OSS           13 HITS · 2555 MS
Torch         11 HITS · 1394 MS
Excavator      4 HITS · 1913 MS
OnionLand      3 HITS · 2516 MS
Not Evil      UNREACHABLE
TorDex        ...
Torland       ...
Torgle        ...
```

This lets you see which engines contributed, how many hits each returned, and how long each took. Engines that failed show `UNREACHABLE` instead of hit counts.

### Collapsible per-engine result groups

After a search completes, per-engine results remain visible. You can expand and collapse individual engine groups to inspect what each engine returned separately.

---

## 10. Opening Links Externally

When you tap a result in the search list:

1. Ghost constructs an external intent with the result URL
2. The intent is sent to Tor Browser for Android
3. Tor Browser opens and navigates to the URL
4. Ghost stays in the background

**What does NOT happen:**

- Ghost never opens the URL in its own WebView
- Ghost never renders the page content
- Ghost never loads any resources from the linked page
- Ghost never injects any scripts into the page

**If Tor Browser is not installed:**

- The link will not open
- Install Tor Browser for Android from Google Play or torproject.org

**In the Engines tab:**

- Each engine has an "OPEN IN TOR" button
- Tapping it opens the engine's .onion homepage in Tor Browser

---

## 11. Session Persistence and Tab Switching

Ghost preserves search state across tab switches within the same session.

### What is preserved

- Current search query
- All search results (titles, URLs, snippets, engine tags)
- Per-engine timing and hit counts
- Engine enable/disable selections
- Circuit breaker states and cooldowns

### How it works

Search state lives in a React Context called **GhostContext** (`src/lib/store/ghost-context.tsx`). This context wraps the entire app, so switching between the Search tab and the Engines tab does not destroy the state.

### Tested behavior

- **Search → Engines → Search:** Results are preserved (verified: 2139 results retained after round-trip)
- **Background → Foreground:** Results are preserved — backgrounding never purges
- The session is wiped only by screen-off, panic wipe, or process death (see [Session Purge](#13-session-purge))

---

## 12. Panic Wipe

The panic wipe instantly destroys the session and terminates the process.

### What it does

JS layer (`src/lib/store/ghost-context.tsx` → `panicWipe`):

1. Aborts all in-flight HTTP requests
2. Clears the TanStack Query cache and all RAM stores (results, query, engine states, cooldowns)
3. Resets circuit breakers and clears non-sensitive preferences

Native layer (`PianoScreenPlugin.executeHardPanicWipe`, `PianoScreenPlugin.java`):

4. Clears the in-memory Tor SOCKS5 cookie jar
5. Clears WebView cache, form data, history, WebStorage, and cookies
6. Zero-overwrites and unlinks files in `cacheDir`, `codeCacheDir`, `app_webview`, and `shared_prefs`
7. Calls `finishAndRemoveTask()` (drops the Recents card) and kills the process (`Process.killProcess` + `Runtime.halt(0)`)

A Guardian Project PanicKit responder (`PanicResponderActivity`) triggers the same hard wipe on `info.guardianproject.panic.action.TRIGGER`.

### When to use it

- If you need to instantly destroy all search activity
- If you are about to hand the device to someone
- If you see something you do not want in RAM

### What it does NOT do

- It does not clear Tor Browser's history (that is a separate app)
- It does not clear Orbot's circuits (that is a separate app)
- It does not return to the consent gate — the process is killed; the next launch starts fresh

---

## 13. Session Purge

Ghost does **not** purge when it goes to the background (HOME key, app switcher) — the session persists for multitasking. The session is wiped under exactly three conditions:

1. **Screen-off** — `PianoScreenPlugin` receives `ACTION_SCREEN_OFF`, fires a `screenOff` JS event, and all RAM session state is purged (`ghost-context.tsx`)
2. **Panic wipe** — full anti-forensic wipe (see [Panic Wipe](#12-panic-wipe))
3. **App exit** — Android process death removes all RAM

On background transitions the `appStateChange` listener only refreshes the transport state; no RAM data is cleared.

**This is the core privacy promise:** when the screen locks or the process dies, all evidence of your search activity is gone from RAM.

---

## 14. Privacy and Security Guarantees

### What Ghost guarantees

| Guarantee             | Implementation                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Zero persistence      | `QueryClient` with `gcTime: 0`, `staleTime: 0`; no `localStorage` for search data                                |
| Session purge         | Screen-off / panic wipe / process death wipe RAM state; backgrounding does not purge                             |
| VPN gate              | Non-dismissible overlay; queries blocked unless VPN transport is up                                              |
| No in-app rendering   | Links open via `AppLauncher.openUrl` / `window.open` fallback; never rendered in-app                             |
| Screenshot block      | `FLAG_SECURE` in `MainActivity` — screenshots and recents preview are black                                      |
| No cloud backup       | `android:allowBackup="false"` + `data_extraction_rules.xml` + `full_backup_content.xml`                          |
| Panic wipe            | Native hard wipe: cookie jar, WebView data, zero-overwrite shred of cache/app_webview/shared_prefs, process kill |
| Release hardening     | R8 minify + shrink resources, ProGuard rules, Android log stripping                                              |
| No telemetry          | No analytics SDK, no crash reporting, no advertising SDK                                                         |
| No backend            | No server, no API, no cloud service — entirely client-side                                                       |
| No accounts           | No login, no registration, no identity                                                                           |
| Tor-only transport    | All .onion requests go through Orbot SOCKS5 at 127.0.0.1:9050                                                    |
| Remote DNS            | .onion hostnames resolved by Tor (SOCKS5 ATYP=DOMAINNAME), not system DNS                                        |
| No cookie persistence | Per-host cookie jar exists only in RAM for captcha flows, purged on exit                                         |

---

## 15. What Ghost Does NOT Protect Against

| Not protected                        | Why                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Compromised OS                       | If Android itself is compromised, no app can protect you                               |
| Malicious keyboard                   | A keyboard app can log everything you type, including search queries                   |
| Physical access while app is running | If someone has your phone while Ghost is open, they can see your results               |
| Orbot misconfiguration               | If Orbot is not in VPN mode or is misconfigured, anonymity is not guaranteed           |
| Tor network compromise               | Tor's 3-hop design provides strong anonymity but is not infallible                     |
| Engine logging                       | Search engines may log your queries on their servers. This is outside Ghost's control. |
| ISP/network observer                 | Mitigated by Tor, but not eliminated if Orbot is misconfigured                         |

**For maximum safety:**

- Use Orbot in VPN mode
- Close Ghost when done (or use panic wipe)
- Do not install untrusted keyboard apps
- Keep your Android OS updated
- Use Tor Browser for viewing results (it has its own protections)

---

## 16. The 13 Onion Search Engines

Ghost queries 13 public onion search engines. Each has a trust level (1-3) that affects result ranking.

| #   | Engine          | Trust | .onion Address                                                          | Notes                                                                    |
| --- | --------------- | ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Ahmia           | 3     | `http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion` | Filtered index, anti-bot token, most stable parser, Tor Project endorsed |
| 2   | Torch           | 2     | `http://xmh57jrknzkhv6y3ls3ubitzfqnkrwxhopf5aygthi7d6rplyvk3noyd.onion` | Large unfiltered index, address rotates frequently                       |
| 3   | TorDex          | 2     | `http://tordexu73joywapk2txdr54jed4imqledpcvcuf75qsas2gwdgksvnyd.onion` | CSS-selector scraping, moderate coverage                                 |
| 4   | Not Evil        | 1     | `http://notevilugs2d6juvkm4nkfd635tynfmh2vshxzbpr5y4emczdufcubqd.onion` | Pure HTML/PHP, no JS, no tracking. Community-polished index.             |
| 5   | Tor66           | 1     | `http://tor66sewebgixwhcqfnp5inzp5x5uohhdy3kvtnyfxc2e5mxiuh34iid.onion` | Large index, category directory, often online when others are down       |
| 6   | OnionLand       | 1     | `http://3bbad7fauom4d6sgppalyqddsqbf5u5p56b5k5uk2zxsy3d6ey2jobad.onion` | Ad-heavy result pages, links unwrapped from redirects                    |
| 7   | Excavator       | 1     | `http://2fd6cemt4gmccflhm6imvdfvli3nf7zn6rfrwpsy7uhxrgbypvwf5fad.onion` | General dark web index, verified live 2026-Q1                            |
| 8   | Amnesia         | 1     | `http://amnesia7u5odx5xbwtpnqk3edybgud5bmiagu75bnqx2crntw5kry7ad.onion` | Verified live 2026-Q1, clean interface                                   |
| 9   | TheDeepSearches | 1     | `http://searchgf7gdtauh7bhnbyed4ivxqmuoat3nm6zfrg3ymkq6mtnpye3ad.onion` | Verified live 2026-Q1                                                    |
| 10  | Torland         | 1     | `http://torlbmqwtudkorme6prgfpmsnile7ug2zm4u3ejpcncxuhpu4k2j4kyd.onion` | Verified live 2026-Q1 (SICRY)                                            |
| 11  | Onionway        | 1     | (see `src/lib/ghost/engines.json`)                                      | Verified live 2026-Q1                                                    |
| 12  | OSS             | 1     | (see `src/lib/ghost/engines.json`)                                      | OnionSearchServer, uses arithmetic CAPTCHA, requires POST + cookie flow  |
| 13  | Torgle          | 2     | (see `src/lib/ghost/engines.json`)                                      | Ad-free gateway, math captcha (DDoS protection)                          |

**Note:** Onion addresses rotate and go offline. If an engine is consistently unreachable, its address may need updating in `src/lib/ghost/engines.json`.

### OSS CAPTCHA handling

OSS (OnionSearchServer) uses a real arithmetic CAPTCHA. Ghost handles this automatically:

1. First request to OSS may return a CAPTCHA page
2. Ghost detects the CAPTCHA, extracts the arithmetic problem
3. Ghost solves the problem and submits the answer via POST with cookies
4. The cookie jar is maintained in RAM for subsequent requests to the same engine
5. This flow was fixed in commit `2728b93` and verified working in the 2026-08-19 device test

### Tor66 URL handling

Tor66 required URL/endpoint handling fixes (commit `2728b93`). The search form is now discovered live via form introspection (`form_introspect` in `engines.json`); no per-engine connect-timeout override is configured.

---

## 17. Circuit Breaker

The circuit breaker prevents Ghost from repeatedly querying an engine that is down.

### How it works

1. Ghost queries an engine
2. If the query fails (timeout, connection error, parse error), the failure counter increments
3. After **3 consecutive failures**, the circuit breaker "trips"
4. The engine is placed in a **5-minute cooldown**
5. During cooldown, the engine is skipped (not queried)
6. After 5 minutes, the circuit breaker "resets" and the engine is tried again
7. If the engine succeeds, the failure counter resets to 0

### Where cooldowns live

- Cooldowns are stored in **RAM only**
- They reset when the app restarts
- They reset when you use panic wipe
- They persist through normal background transitions (backgrounding does not purge)

### Manual reset

In the Engines tab, you can toggle an engine OFF and back ON to manually reset its circuit breaker.

---

## 18. VPN Gate

The VPN gate is a **non-dismissible overlay** that blocks the entire UI when no VPN transport is active.

### What it checks

- `PianoVpnPlugin.isVpnActive()` checks for `NetworkCapabilities.TRANSPORT_VPN`
- This detects any active VPN, including Orbot in VPN mode

### What it blocks

- All UI interaction
- All network requests
- There is **no bypass**, no "continue anyway" button, no skip option

### When it unlocks

- Automatically, as soon as a VPN transport is detected
- No user action needed beyond starting Orbot in VPN mode

### Why it exists

- Without VPN, .onion requests would fail (system DNS cannot resolve .onion)
- Without VPN, queries could leak to clearnet DNS servers
- Without VPN, the ISP/network observer could see the query
- The VPN gate is a hard requirement, not a recommendation

---

## 19. FLAG_SECURE (Screenshot Block)

Ghost sets `FLAG_SECURE` on the Activity window, which:

- **Blocks screenshots:** Android's screenshot function produces a black image
- **Blocks recents preview:** The app switcher shows a black card instead of the actual app content
- **Blocks screen recording:** Most screen recording apps capture a black frame

### How it is set

`FLAG_SECURE` is hardcoded in `MainActivity.onCreate` (`MainActivity.java`); it is not injected by any build step.

### Verification

- Take a screenshot while Ghost is open → the result is a black image (~20KB PNG)
- Check the app switcher → Ghost shows a black card

---

## 20. Pi-hole and Custom DNS Compatibility

Ghost works with **any DNS configuration**, including:

- Pi-hole (e.g., `192.168.1.121`)
- Google DNS (`8.8.8.8`)
- Cloudflare DNS (`1.1.1.1`)
- Custom DNS servers
- Default ISP DNS

### How it works

Ghost does **not** use system DNS for .onion hostnames. Instead:

1. The `PianoTorHttpPlugin` connects to Orbot's SOCKS5 proxy at `127.0.0.1:9050`
2. The .onion hostname is sent as `SOCKS5 ATYP=DOMAINNAME` (not as an IP address)
3. **Tor resolves the hostname**, not the system DNS
4. This bypasses Pi-hole, Google DNS, Cloudflare, or any other DNS configuration

### Why this matters

- Pi-hole blocks ads and tracking domains at the DNS level
- But Pi-hole (and any standard DNS) cannot resolve `.onion` addresses
- Without Tor resolving the hostname, you get `UnknownHostException`
- Ghost's native plugin sends the hostname directly to Tor, avoiding this problem entirely

### Tested compatibility

- **With Pi-hole at 192.168.1.121:** Works (Tor resolves .onion, Pi-hole is bypassed for .onion)
- **Without Pi-hole (default DNS):** Works (Tor resolves .onion, system DNS is bypassed)
- **With Google DNS:** Works
- **With Cloudflare DNS:** Works

---

## 21. Building from Source (Windows)

### Prerequisites

Install these tools (one-time setup):

```powershell
winget install Oven-sh.Bun
winget install Git.Git
winget install EclipseAdoptium.Temurin.21.JDK
winget install Google.AndroidStudio
```

**Close and reopen PowerShell** after installation.

### Android SDK setup

1. Open Android Studio
2. **More Actions → SDK Manager**
3. Tab **SDK Platforms:** check **Android 15 (API 35)** or higher
4. Tab **SDK Tools:** check:
   - Android SDK Build-Tools
   - Android SDK Command-line Tools
   - Android SDK Platform-Tools (includes `adb`)
5. **Apply** → download → **OK**

Verify:

```powershell
$Sdk = "$env:LOCALAPPDATA\Android\Sdk"
Test-Path "$Sdk\platform-tools\adb.exe"  # Must be True
```

### Clone and build

```powershell
cd D:\projects   # Use a path WITHOUT spaces
git clone https://codeberg.org/sookoothaii/digital-spyglass-android.git
cd digital-spyglass-android
bun install

# Build the web SPA for Android
bun run build:mobile

# Add Android platform (first time only)
bunx cap add android

# Create android/local.properties manually (sdk.dir=<SDK path>) —
# the mobile:localprops script target is currently missing
# (scripts/write-local-properties.mjs does not exist)

# Sync web assets
bun run mobile:sync

# Build debug APK
cd android
.\gradlew.bat assembleDebug
```

**Output:**

```
android\app\build\outputs\apk\debug\app-debug.apk
```

### Build commands reference

| Command                                     | What it does                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `bun install`                               | Install npm dependencies                                                                                       |
| `bun run lint`                              | ESLint check                                                                                                   |
| `bun run build:mobile`                      | Build SPA for Android (`MOBILE=1` vite build) → `dist/client`                                                  |
| `bunx cap sync android`                     | Sync web assets and plugins into Android project                                                               |
| `bun run mobile:sync`                       | Build + sync (`bun run build:mobile && cap sync android`)                                                      |
| `bun run mobile:android`                    | Sync, then open the project in Android Studio                                                                  |
| `bun run mobile:localprops`                 | Broken: target `scripts/write-local-properties.mjs` does not exist — write `android/local.properties` manually |
| `bun run test` / `test:coverage`            | Vitest suite / coverage gate                                                                                   |
| `cd android; .\gradlew.bat assembleDebug`   | Build debug APK                                                                                                |
| `cd android; .\gradlew.bat assembleRelease` | Build signed release APK                                                                                       |

### Important notes

- **Use a path without spaces** for the project directory. Spaces in the path can cause Gradle errors.
- Always run `bun run build:mobile` before `cap sync`. If you sync the SSR build (`bun run build`), the WebView stays black.
- Hardening (FLAG_SECURE, backup opt-out, R8, network security config) is part of the source tree — no extra build step is required.
- If `ANDROID_PREFS_ROOT` conflicts with `ANDROID_USER_HOME`, reset it: `$env:ANDROID_PREFS_ROOT = $null`

---

## 22. Building a Signed Release APK

### Step 1: Generate a keystore (one-time)

```powershell
$keytool = "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe"
& $keytool -genkeypair -v `
  -keystore "D:\projects\digital-spyglass-android\android\app\release-keystore.jks" `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -alias onion-search `
  -dname "CN=Onion Search, O=sookoothaii, C=DE" `
  -storepass YOUR_STORE_PASSWORD `
  -keypass YOUR_KEY_PASSWORD
```

**Keep the keystore file safe.** If you lose it, you cannot update the app on Google Play.

### Step 2: Create key.properties

Create `android/key.properties` (not committed to git):

```properties
storeFile=release-keystore.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=onion-search
keyPassword=YOUR_KEY_PASSWORD
```

### Step 3: Build the release APK

```powershell
cd "D:\projects\digital-spyglass-android"
bun run build:mobile
bunx cap sync android
cd android
.\gradlew.bat assembleRelease
```

**Output:**

```
android\app\build\outputs\apk\release\app-release.apk
```

The APK is signed with your release keystore and ready for Google Play upload.

### Security

- The keystore (`release-keystore.jks`) and `key.properties` are in `.gitignore` and will never be committed
- Never share the keystore or passwords with anyone
- Back up the keystore to a secure location (encrypted USB, password manager)

---

## 23. Installing on a Device

### Via USB (recommended)

1. On the device: **Settings → About Phone → Build Number** — tap 7 times to enable Developer Options
2. **Settings → Developer Options → USB Debugging** — enable
3. Connect via USB, allow debugging on the device
4. Install:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices                    # Verify device is connected
& $adb install -r "android\app\build\outputs\apk\debug\app-debug.apk"
```

### Via ADB (release APK)

```powershell
& $adb uninstall org.darknetcrawler.mobile   # Remove old version if signature differs
& $adb install "android\app\build\outputs\apk\release\app-release.apk"
```

### Without USB

Transfer the APK file to the device (cloud, messenger, email), tap it, and allow installation from unknown sources.

---

## 24. Testing and Debugging

### Check if the app is running

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb shell pidof org.darknetcrawler.mobile
```

### Capture logs

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb logcat -c                    # Clear log buffer
# ... perform actions in the app ...
& $adb logcat -d | Select-String "PianoTorHttp|PianoVpn|AndroidRuntime|FATAL|Capacitor|Ghost|darknetcrawler"
```

### Check for crashes

```powershell
& $adb logcat -d | Select-String "FATAL EXCEPTION|AndroidRuntime|CRASH|ANR"
```

### Take a screenshot (verify FLAG_SECURE)

```powershell
& $adb shell screencap -p /sdcard/test.png
& $adb pull /sdcard/test.png "screenshot.png"
```

If FLAG_SECURE is active, the screenshot will be a black image (~20KB for 720x1600).

### WebView debugging (development only)

For development builds, you can enable WebView console logging by setting `webContentsDebuggingEnabled: true` in `capacitor.config.ts`. **This must be set back to `false` for production builds.**

After enabling, forward the DevTools port:

```powershell
# Get the WebView process ID
& $adb shell "cat /proc/net/unix | grep webview_devtools_remote"

# Forward the port (replace PID)
& $adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>

# Access DevTools
# Open http://127.0.0.1:9222/json in a browser
```

### Device test results (2026-08-19)

Tested on Samsung R5CR937FWMF with Orbot VPN mode active:

| Test                             | Result                                       |
| -------------------------------- | -------------------------------------------- |
| Release APK installation         | Pass (after uninstalling debug version)      |
| App start                        | Pass (no crashes)                            |
| Consent gate                     | Pass (displayed at launch)                   |
| VPN/Orbot detection              | Pass (auto-detected)                         |
| Search "test"                    | Pass — 1352 results in 9177ms, 12/13 engines |
| Search "marketplace"             | Pass — 2139 results in 17264ms               |
| Tab switch Search→Engines→Search | Pass — results preserved                     |
| Background→Foreground            | Pass — results preserved                     |
| FLAG_SECURE                      | Pass — screenshots are black                 |
| Engine report                    | Pass — expandable with per-engine stats      |
| OSS CAPTCHA                      | Pass — 13 hits, captcha flow works           |
| Tor66                            | Pass — 47 hits, URL fix confirmed            |
| Haystak                          | Unreachable (engine offline, not a code bug) |

---

## 25. Publishing to Google Play

**Future plan — not currently distributed.** Ghost is not on Google Play (see [docs/PRIVACY_POLICY.md](PRIVACY_POLICY.md)); current distribution is Codeberg Releases and F-Droid.

### Prerequisites

1. **Google Play Developer Account** — $25 one-time fee at https://play.google.com/console
2. **Signed release APK** — see [Building a Signed Release APK](#22-building-a-signed-release-apk)
3. **Privacy Policy** — hosted at a public URL (use `docs/PRIVACY_POLICY.md`)
4. **Data Safety Form** — all answers "No data collected"
5. **Content Rating** — Adults Only (18+)

### Store listing

Planned listing: app name "Onion Search", short description (80 chars),
full description (4000 chars), ASO keywords, and a content-rating
questionnaire (Adults Only 18+).

### Upload steps

1. Go to https://play.google.com/console
2. Create a new app: "Onion Search"
3. Fill in Store Listing
4. Upload Privacy Policy URL
5. Complete Data Safety Form (all "No data collected")
6. Complete Content Rating questionnaire (Adults Only 18+)
7. Upload `app-release.apk`
8. Submit for review

### Google Play App Signing

When uploading your first APK, opt in to **Google Play App Signing**:

- Google re-signs the APK with its own key
- Your upload key authenticates future uploads
- Keep your upload keystore safe

### If rejected

Escalation stages if the listing is rejected: reframe as "Private Onion
Search" → "Onion OSINT Search" → "Private Search" → fall back to
F-Droid + Codeberg Releases + Obtainium.

---

## 26. Alternative Distribution: F-Droid and GitHub Releases

If Google Play is not available or the app is rejected, alternative distribution channels are available.

### F-Droid

1. Add F-Droid metadata to the repository
2. Submit at https://gitlab.com/fdroid/fdroiddata
3. Requires reproducible build

### Codeberg Releases

1. Tag a release:
   ```powershell
   git tag v4.0.1
   git push origin v4.0.1
   ```
2. Upload the APK to the Codeberg Releases page
3. Users download directly from the repository

### Obtainium

- Users can add the app via the Codeberg Releases URL
- Obtainium provides auto-updates from Codeberg Releases

---

## 27. Troubleshooting

### Build issues

| Problem                                                     | Solution                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `bun : The term 'bun' is not recognized`                    | Close and reopen PowerShell; or `$env:Path += ";$env:USERPROFILE\.bun\bin"`                                    |
| `Bun could not find a package.json file`                    | You are in the wrong directory. `cd digital-spyglass-android`                                                  |
| `SDK location not found ... ANDROID_HOME`                   | Create `android/local.properties` with `sdk.dir=<SDK path>` (the `mobile:localprops` script target is missing) |
| `adb ... not recognized`                                    | Use full path: `$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"`                                 |
| Gradle path errors                                          | Spaces in project path. Move to a path without spaces.                                                         |
| `gradlew.bat` won't start / wrong Java                      | Install JDK 21: `winget install EclipseAdoptium.Temurin.21.JDK`                                                |
| `Several environment variables ... contain different paths` | `$env:ANDROID_PREFS_ROOT = $null` before building                                                              |
| `cap sync` can't find web directory                         | Run `bun run build:mobile` first (it creates `dist/client`)                                                    |
| `android/` folder is nearly empty                           | Run `bunx cap add android` again                                                                               |
| App starts, screen stays black                              | You synced the SSR build instead of the mobile build. Run `bun run build:mobile` + `cap sync`                  |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE`                        | Uninstall the old version first: `adb uninstall org.darknetcrawler.mobile`                                     |

### Runtime issues

| Problem                                           | Solution                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| UI stays locked ("VPN required")                  | Start Orbot in VPN mode, ensure Ghost is in Orbot's app list                        |
| All engines red / no results                      | Onion engines may be down. Check Engines tab, reset circuit breakers.               |
| Link does not open                                | Install Tor Browser for Android                                                     |
| Results disappear after screen-off or app restart | Expected behavior — screen-off/exit purge clears RAM (backgrounding alone does not) |
| Cannot take screenshot                            | Expected — FLAG_SECURE is active                                                    |
| An engine shows "UNREACHABLE"                     | Engine is offline. Not a code bug. Circuit breaker will skip it.                    |
| `PianoTorHttp already registered` warning         | Harmless — Capacitor registers plugin both native and JS. Functions normally.       |

---

## 28. Project Structure

```
digital-spyglass-android/
├── src/
│   ├── components/app/         # Mobile-first UI primitives, shell, VPN gate, disclaimer
│   │   ├── disclaimer.tsx      # Consent gate (18+ research tool)
│   │   ├── vpn-gate.tsx        # Non-dismissible VPN transport gate
│   │   └── ...
│   ├── lib/
│   │   ├── ghost/              # Search engine logic
│   │   │   ├── engines.json    # 13 engine descriptors (URLs, trust, selectors, health)
│   │   │   ├── engines.ts      # Parser strategies + registry loader
│   │   │   ├── search.ts       # Parallel orchestrator, dedupe, BM25 ranking
│   │   │   ├── ranking.ts      # Formal BM25 (Okapi BM25) algorithm
│   │   │   ├── stix.ts         # STIX 2.1 export (OASIS standard, opt-in)
│   │   │   ├── blacklist.ts    # Ahmia abuse blacklist (opt-in, RAM cache)
│   │   │   ├── http.ts         # Tor-only HTTP layer (.onion → PianoTorHttp, non-onion rejected)
│   │   │   ├── parse.ts        # DOMParser detached document HTML parsing
│   │   │   ├── types.ts        # TypeScript types
│   │   │   ├── breaker.ts      # Circuit breaker (3 failures = 5 min cooldown)
│   │   │   └── external.ts     # External-intent handover to Tor Browser
│   │   ├── platform/
│   │   │   ├── bridge.ts       # Lazy Capacitor bridge, registerPlugin, torFetch
│   │   │   ├── native.ts       # VPN detection, haptics, screen-off/panic bridge, wipe helpers
│   │   │   └── storage.ts      # RAM-only storage, no persistence
│   │   └── store/
│   │       ├── ghost-context.tsx  # GhostContext (search state survives tab switching)
│   │       └── ghost-settings.ts  # Session-only toggles
│   ├── routes/
│   │   ├── index.tsx           # Search tab (main route)
│   │   ├── __root.tsx          # Root layout with VPN gate
│   │   └── ...
│   └── styles.css              # Tailwind v4 OKLCH semantic tokens
├── android/
│   ├── app/
│   │   ├── src/main/java/org/darknetcrawler/mobile/
│   │   │   ├── MainActivity.java           # Activity entry, FLAG_SECURE
│   │   │   ├── PianoTorHttpPlugin.java     # Native Tor HTTP (SOCKS5, remote DNS, cookies)
│   │   │   ├── PianoVpnPlugin.java         # VPN transport detection
│   │   │   ├── PianoScreenPlugin.java      # Screen-off detection, hard panic wipe
│   │   │   └── PanicResponderActivity.java # Guardian Project PanicKit responder
│   │   ├── build.gradle                    # Release signing config, R8, ProGuard
│   │   └── ...
│   ├── variables.gradle                    # minSdk=24, compileSdk=36, targetSdk=36
│   ├── key.properties                      # Release keystore config (not in git)
│   └── ...
├── android-res/                            # Manifest/res hardening inputs
├── mobile/
│   ├── main.tsx                            # APK-only SPA entry (RouterProvider into #root)
│   └── index.html
├── scripts/
│   └── engine-healthcheck.mjs              # Weekly Tor engine liveness probe (engines.json health)
├── docs/
│   ├── USER_MANUAL.md                      # This file
│   ├── PRIVACY_POLICY.md                   # Privacy Policy
│   ├── GHOST_V4_SECURITY_ARCHITECTURE.md   # Threat model and security architecture
│   └── FDROID_SETUP.md                     # F-Droid submission status and self-hosted repo
├── capacitor.config.ts                     # App config (webContentsDebuggingEnabled, captureInput, etc.)
├── LICENSE                             # GPL-3.0-or-later License
├── README.md                           # Project overview
└── .gitignore                          # Includes keystore and key.properties protection
```

---

## 29. Architecture and Data Flow

```
[User types query in search bar]
  → useQuery (gcTime: 0, staleTime: 0)
    → src/lib/ghost/search.ts           Parallel orchestrator
      → src/lib/ghost/breaker.ts        Skip engines in cooldown
      → src/lib/ghost/http.ts           Tor-only: .onion → PianoTorHttp, non-onion rejected
        → PianoTorHttpPlugin.java       Native SOCKS5 to 127.0.0.1:9050 (Orbot)
          → SOCKS5 ATYP=DOMAINNAME      Tor resolves hostname (not system DNS)
          → Per-host cookie jar          For OSS CAPTCHA flow (RAM only)
      → src/lib/ghost/parse.ts          DOMParser detached document (never rendered)
    → Deduplicate by normalized URL
    → Rank by engine trust + cross-engine hit count
  → Virtualized list (RAM only, TanStack Virtual)
    → Tap result → external intent → Tor Browser
```

### Key invariants (do not break)

1. **No persistence of query data** — no localStorage, no SQLite, no filesystem writes of results
2. **Purge on background** — any RAM store must be cleared in `appStateChange` handler
3. **No in-app rendering of remote content** — no WebView, no iframe, no innerHTML of fetched pages
4. **VPN gate is non-dismissible** — no "continue anyway" escape hatch
5. **Engine failures are visible** — never silently substitute an engine
6. **No server-side code** — no server functions, no Lovable Cloud, no Supabase

---

## 30. Important Files Reference

### Frontend (TypeScript/React)

| File                                | Responsibility                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `src/lib/ghost/engines.json`        | 13 engine descriptors (URLs, trust levels, selectors, health)           |
| `src/lib/ghost/engines.ts`          | Parser strategies + registry loader (engine data in `engines.json`)     |
| `src/lib/ghost/search.ts`           | Parallel orchestrator, per-engine error isolation, dedupe, BM25 ranking |
| `src/lib/ghost/ranking.ts`          | Formal BM25 (Okapi BM25) ranking algorithm                              |
| `src/lib/ghost/stix.ts`             | STIX 2.1 export (OASIS standard, opt-in)                                |
| `src/lib/ghost/blacklist.ts`        | Ahmia abuse blacklist opt-in filter (RAM cache)                         |
| `src/lib/ghost/http.ts`             | Tor-only HTTP layer (.onion → PianoTorHttp; non-.onion rejected)        |
| `src/lib/ghost/parse.ts`            | Per-engine HTML extraction (DOMParser detached, never rendered)         |
| `src/lib/ghost/types.ts`            | TypeScript types (`RawResult`, `ResultRow`, `EngineState`)              |
| `src/lib/platform/bridge.ts`        | Lazy Capacitor bridge, `registerPlugin("PianoTorHttp")`, `torFetch()`   |
| `src/lib/store/ghost-context.tsx`   | GhostContext (search state survives tab switching, purge logic)         |
| `src/components/app/disclaimer.tsx` | Consent gate (18+ research tool, shown at every start)                  |
| `src/routes/index.tsx`              | Main search route                                                       |
| `src/routes/__root.tsx`             | Root layout with VPN gate                                               |

### Native (Java)

| File                          | Responsibility                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `MainActivity.java`           | Activity entry, FLAG_SECURE, splash screen                                       |
| `PianoTorHttpPlugin.java`     | Native Tor HTTP fetch (SOCKS5, remote DNS, per-host cookies, GET+POST)           |
| `PianoVpnPlugin.java`         | VPN transport detection (TRANSPORT_VPN check)                                    |
| `PianoScreenPlugin.java`      | Screen-off detection (ACTION_SCREEN_OFF), hard panic wipe (shred + process kill) |
| `PanicResponderActivity.java` | Guardian Project PanicKit responder (`panic.action.TRIGGER`)                     |

### Configuration

| File                       | Responsibility                                                         |
| -------------------------- | ---------------------------------------------------------------------- |
| `capacitor.config.ts`      | App config (appId, appName, webContentsDebuggingEnabled, captureInput) |
| `android/app/build.gradle` | Release signing config, R8 minify, ProGuard                            |
| `android/variables.gradle` | SDK versions (minSdk=24, compileSdk=36, targetSdk=36)                  |
| `android/key.properties`   | Release keystore config (not in git)                                   |

### Scripts

| File                             | Responsibility                                                |
| -------------------------------- | ------------------------------------------------------------- |
| `scripts/engine-healthcheck.mjs` | Weekly Tor liveness probe; maintains engines.json health data |

---

## 31. Git History and Known-Good Commits

| Commit    | Description                                                                            |
| --------- | -------------------------------------------------------------------------------------- |
| `fe79465` | More engines, session persistence, disclaimer on every start, engine grid              |
| `dedfe8b` | Search state moved into GhostContext (survives tab switching)                          |
| `2acde5e` | Tor66 timeout 45s and OSS CAPTCHA false-positive fix                                   |
| `2728b93` | **KNOWN-GOOD BASELINE** — OSS CAPTCHA POST+cookies, Tor66 URL fix, collapsible results |
| `c6bf05e` | Consent-based research disclaimer and legal documentation (later reverted)             |
| `e29182c` | Revert of c6bf05e, returning code toward 2728b93 state                                 |
| `7756ef6` | Only `disclaimer.tsx` changed for consent-based research disclaimer                    |
| `31d988a` | Docs: Maximum Openness Research (777 lines, 46 sources)                                |
| `8c4b459` | Play Store readiness + Open Source (GPLv3) + Release Build Pipeline                    |

**Do not regress below `2728b93` functionality.** This is the verified working baseline.

---

## 32. Legal Context and Researcher Access

Ghost is positioned as a **research tool / intermediary**, not a content publisher. This provides the strongest available legal shield in most jurisdictions.

### Key legal findings (see `docs/MAXIMUM_OPENNESS_RESEARCH.md` for details)

| Jurisdiction | Key protection                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USA          | Section 230 CDA protects search tools from liability for third-party content; DMCA 512(d) covers information location tools                                                                                                               |
| EU           | DSA Art. 4-6 provides intermediary liability exemptions for neutral, automatic processing; EU Charter Art. 11 protects right to receive information; European Media Freedom Act (2024) protects journalists' right to collect information |
| Germany      | DDG (formerly TMG) §7 mere conduit; BGH Paperboy affirms search engines not liable for linked content                                                                                                                                     |
| UK           | Online Safety Act 2023 §33 requires freedom of expression regard when imposing safety measures                                                                                                                                            |
| China        | "Technical neutrality" defense successfully used 2024-2025 to dismiss criminal charges against VPN tool developers                                                                                                                        |
| Russia       | New law (Sept 2025) penalizes intentional search for extremist content but ordinary VPN use is not penalized                                                                                                                              |

### The sweet spot

**Consent gate + no filtering + RAM-only + no rendering + Tor-only + no backend** = maximally open AND maximally legally protected.

- The app is a **tool** (intermediary), not a **publisher** (content creator)
- The app creates no content, selects no content, modifies no content, hosts no content
- The app has no editorial policy
- The app operates in a neutral, automatic manner
- The user accepts full responsibility for their use

### Important disclaimer

This legal research is **not legal advice**. Laws vary by jurisdiction and change over time. Consult a qualified attorney in your jurisdiction for specific legal questions.

---

## 33. Glossary

| Term                 | Definition                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| **.onion**           | A top-level domain suffix for Tor hidden services. Only accessible through the Tor network.                     |
| **CAPTCHA**          | A challenge-response test to verify the user is human. OSS uses an arithmetic CAPTCHA.                          |
| **Capacitor**        | A cross-platform native runtime that wraps web apps in a native Android/iOS shell.                              |
| **Circuit breaker**  | A pattern that prevents repeated calls to a failing service. In Ghost: 3 failures = 5 min cooldown.             |
| **Clearnet**         | The regular internet, accessed without Tor. Ghost excludes clearnet entirely.                                   |
| **Consent gate**     | A dialog requiring the user to confirm they are 18+ and accept responsibility before using the app.             |
| **DOMParser**        | A browser API that parses HTML into a DOM tree without rendering it. Ghost uses a detached document.            |
| **FLAG_SECURE**      | An Android flag that prevents screenshots and recents preview.                                                  |
| **GhostContext**     | A React Context that holds search state, surviving tab switches within a session.                               |
| **Meta-search**      | A search tool that queries multiple other search engines and aggregates results.                                |
| **Orbot**            | A free, open-source Tor proxy/VPN app for Android, maintained by The Tor Project and Guardian Project.          |
| **OSINT**            | Open Source Intelligence — the practice of collecting and analyzing publicly available information.             |
| **Panic wipe**       | A feature that instantly clears all RAM data and resets the app to its initial state.                           |
| **Pi-hole**          | A network-level ad and tracker blocker that runs as a DNS server. Ghost works with and without it.              |
| **RAM-only**         | Data exists only in memory and is never written to disk. Purged on exit or background.                          |
| **SOCKS5**           | A proxy protocol that supports hostname resolution (ATYP=DOMAINNAME), allowing Tor to resolve .onion addresses. |
| **Tor**              | An anonymity network that routes traffic through three relays to hide the user's origin.                        |
| **Tor Browser**      | A web browser based on Firefox that routes all traffic through Tor. Ghost opens links in it externally.         |
| **VPN gate**         | A non-dismissible overlay in Ghost that blocks all UI until a VPN transport is active.                          |
| **v3 onion address** | The current format of .onion addresses (56 characters), replacing the deprecated v2 format.                     |

---

_This manual covers everything related to the Ghost (Onion Search) system as of 2026-10-24. For the latest updates, check the Codeberg repository: https://codeberg.org/sookoothaii/digital-spyglass-android_
