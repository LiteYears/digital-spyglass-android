# Privacy Policy — Ghost

**Last updated:** 2026-10-24

## Overview

Ghost ("the App") is a stateless Tor/onion meta-search aggregator for
Android. It queries public onion search engines, aggregates results in RAM,
and opens links externally in Tor Browser.

**The App collects no data. None.**

## Data We Do NOT Collect

| Category | Status |
|----------|--------|
| Personal information (name, email, phone) | **Not collected** |
| Search queries | **Not stored** — exist only in RAM during the active session, purged on screen-off / panic wipe / app exit |
| Search results | **Not stored** — exist only in RAM during the active session, purged on screen-off / panic wipe / app exit |
| Browsing history | **Not collected** — links open in Tor Browser (external app) |
| Device identifiers | **Not collected** |
| IP address | **Not collected** — all traffic goes through Orbot/Tor |
| Location data | **Not collected** |
| Cookies | **Not collected** — per-host cookie jar exists only in RAM for engine captcha flows, purged on exit |
| Crash logs | **Not collected** — no crash reporting SDK |
| Usage analytics | **Not collected** — no analytics SDK |
| Advertising data | **Not collected** — no ads |

## Data We Do NOT Store

- No local database
- No SharedPreferences for search data (only non-sensitive preferences: engine selection, snippet filter, VPN requirement, Tor SOCKS host/port, paranoid/fast/QARF/blacklist toggles, and a consent flag that is reset on every start — no search content)
- No cache directory for web content
- No file system writes for queries or results
- `android:allowBackup="false"` — no cloud backup
- `FLAG_SECURE` — screenshots and recents preview are blocked

## Session Purge Triggers

Session data (queries, results, engine reports) is held in RAM and purged
under exactly three conditions:

1. **Panic wipe** — user presses the panic button; app clears state and exits
2. **Screen lock** — screen turns off; `PianoScreenPlugin` detects `ACTION_SCREEN_OFF` and purges
3. **App exit** — Android process death removes all RAM

Normal app switching (HOME key, app switcher) **does not** purge the session.
The session persists for multitasking.

## How the App Works

1. User enters a search query
2. The query is sent to public onion search engines via Orbot's Tor SOCKS5 proxy (127.0.0.1:9050)
3. Search engines return HTML results
4. The App parses results in a detached DOMParser (never rendered in the App)
5. Aggregated results are displayed as a list in RAM
6. Tapping a result opens the URL in Tor Browser (external app)
7. When the App is purged (screen-off / panic / exit), all RAM state is wiped

## Tor Transport

All network traffic goes through the Tor network via Orbot. The App:

- Does not make direct internet connections
- Does not use system DNS (onion hostnames are resolved by Tor via `ATYP=DOMAINNAME`)
- Does not log network traffic
- Is not a Tor relay, exit node, or bridge — it is a client only

## Third-Party Services

The App does **not** use any third-party services:

- No Google Firebase
- No Google Analytics
- No crash reporting (Sentry, Bugsnag, etc.)
- No advertising SDKs
- No social media SDKs
- No cloud backend

The only external connections are to public onion search engines, routed
through Tor.

## Children's Privacy

The App is rated 18+ and requires adult consent at every launch. It is not
directed at children and does not knowingly collect any data from anyone,
including children.

## Your Consent

By tapping "I am 18+ — I consent — continue" at App startup, you acknowledge:

- You are an adult (18+)
- You are using the App for legitimate research purposes
- You accept full responsibility for your use
- You understand that the App collects no data about you

## Distribution Channels

The App is distributed via:

- **Codeberg Releases:** https://codeberg.org/sookoothaii/digital-spyglass-android/releases
- **F-Droid:** Metadata prepared for official repo submission; self-hosted repo available

The App is **not** distributed via Google Play Store.

## Changes to This Policy

If this Privacy Policy changes, the updated version will be posted in the
App's Codeberg repository. Since the App collects no data, no user
notification is required beyond the repository update.

## Open Source

The App's source code is publicly available for audit. Anyone can verify
that no data is collected by reading the code:

https://codeberg.org/sookoothaii/digital-spyglass-android

## Contact

For privacy questions, open an issue in the Codeberg repository:
https://codeberg.org/sookoothaii/digital-spyglass-android/issues
