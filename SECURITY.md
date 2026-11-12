# Security Policy

**Last updated:** 2026-10-20

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 4.0.x   | Yes       |
| < 4.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in Ghost, please report it
responsibly. **Do not open a public issue describing the vulnerability.**

### How to Report

1. **Preferred:** Send a private message to `@sookoothaii` on the
   [Hugging Face forum](https://discuss.huggingface.co/u/sookoothaii) —
   include a clear description and reproduction steps.

2. **Alternative:** Open a [Codeberg issue](https://codeberg.org/sookoothaii/digital-spyglass-android/issues)
   titled only "Security contact request" with **no technical details** —
   the maintainer will respond with a private channel.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Affected component (native plugin, JS layer, Android manifest, etc.)
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment:** Within 72 hours
- **Initial assessment:** Within 7 days
- **Fix or mitigation:** Depends on severity, typically 14-30 days for
  non-critical issues

### Disclosure Policy

- We follow **coordinated disclosure**
- We will not publicly disclose the vulnerability until a fix is released
- We will credit you in the release notes unless you prefer to remain anonymous

## Security Architecture

### What We Protect

- **User queries and results:** RAM-only, never written to disk
- **Session state:** Purged on screen-off, panic wipe, and app exit
- **Screenshots:** Blocked via `FLAG_SECURE`
- **Network traffic:** Routed through Tor via Orbot VPN mode
- **DNS:** Resolved remotely by Tor (`.onion` via `ATYP=DOMAINNAME`)

### What We Do Not Claim

- Not anti-root / anti-Frida (JS-layer checks are ineffective)
- Not encrypted local storage (nothing sensitive is persisted)
- Not a Tor daemon (relies on Orbot for transport)
- Not immune to device compromise (rooted devices can extract RAM)

### Hardening Measures

| Measure                      | Implementation                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLAG_SECURE`                | Blocks screenshots, screen recording, recents thumbnails                                                                                                            |
| `allowBackup=false`          | No cloud backup of app data                                                                                                                                         |
| Data extraction rules        | `data_extraction_rules.xml` blocks all extraction                                                                                                                   |
| ProGuard log stripping       | `Log.d/v/i` stripped in release builds                                                                                                                              |
| R8 minify + shrinkResources  | Dead code elimination in release                                                                                                                                    |
| Minimal permissions          | `INTERNET`, `ACCESS_NETWORK_STATE` + Capacitor-injected `VIBRATE`, `HIDE_OVERLAY_WINDOWS` (no location, contacts, storage, camera, mic, biometric)                  |
| No crash reporting SDK       | No Sentry, Bugsnag, or Firebase Crashlytics                                                                                                                         |
| No analytics SDK             | No Google Analytics, Mixpanel, or similar                                                                                                                           |
| VPN gate                     | Non-dismissible; blocks all queries without VPN                                                                                                                     |
| `taskAffinity=""`            | MainActivity runs in its own task; blocks task-hijacking/phishing overlays (Cure53 TTP-03-010 recommendation)                                                       |
| Per-search SOCKS credentials | Each search generates a fresh RFC 1929 credential pair; each engine gets a `<uuid>-<engineId>` suffix → Tor `IsolateSOCKSAuth` assigns every engine its own circuit |

### Engine Registry Integrity

The engine list is attacker-relevant: a substituted registry steers queries at
hostile services. Defenses, fail-closed:

- **Bundled registry:** `engines.json` ships with a detached
  `registry-sig-v1` signature (RSA-PSS-SHA256) over a canonical projection
  (`health.*` excluded so healthcheck merges never invalidate it). At boot
  the signature is verified against the APK signer's own certificate —
  the same identity F-Droid pins via `AllowedAPKSigningKeys`. Any failure
  (missing sig, wrong signer, no WebCrypto) disables search.
- **User imports:** an `engines.json`-shaped registry plus its detached
  signature (plus the signer's SPKI PEM for a _new_ signer) applies only
  when the signature verifies under the APK anchor **or** a key the
  operator confirmed by fingerprint out-of-band — SSH `known_hosts`
  semantics: the fingerprint is shown and must be explicitly accepted.
  Imports persist in preferences, separate from the bundle; removing one
  restores the bundled registry, and every boot re-verifies — a stale or
  invalid stored import falls back to bundled.
- **Rollback protection:** the signed payload carries a monotonic
  `sequence`. Imports must order at/above `max(bundled.sequence,
active.sequence)` — a replayed older but still-validly-signed registry
  is rejected, and registries without `sequence` cannot be imported at
  all. Equal-sequence imports are accepted only as idempotent re-imports
  of byte-identical signed content: a different payload on the same
  sequence is unordered and rejected, and the signing script refuses to
  produce one (content change ⇒ mandatory `sequence` bump).
- **Import validation:** onion-only `baseUrl`/`mirrors`, `{base}`-relative
  URL templates, per-engine `mathRe` whitelist, a serialized-size cap,
  and recursive rejection of `__proto__`/`constructor`/`prototype`
  keys — including inside `health`. `health` is excluded from the
  signature only at the registry root and `engines[i].health`; a `health`
  key anywhere deeper is signed content and shows up in the import diff.
- **Hash chain (informational):** `registry-history.json` links signed
  versions by content hash; a broken link warns loudly but never gates —
  the detached signature plus `sequence` remains the enforcement point.

## Threat Model

### Protected Against

- **Device loss / casual forensics:** No disk artifacts to recover
- **Network observer:** All traffic via Tor (Orbot VPN mode)
- **Recents/screenshot capture:** `FLAG_SECURE` blocks thumbnails and screenshots
- **Cross-search circuit correlation:** Per-search SOCKS credential rotation
  gives each search an unlinkable circuit set; the VPN gate + Tor-only
  destinations + remote DNS make the transport fail-closed — stricter than
  "VPN on, hope" per-app VPN models

### Documented Design Decisions

- **Panic trigger is openly exported.** Any local app can send
  `info.guardianproject.panic.action.TRIGGER` and wipe the session. This is
  intentional PanicKit/Ripple semantics (shared with Guardian Project apps):
  the wipe is _toward_ safety — session state is RAM-only — so a hostile
  trigger is at worst a session-availability nuisance, never data exposure.
- **Circuit isolation depends on tor defaults.** `IsolateSOCKSAuth` is on by
  default in tor ≥0.3.5 (any current Orbot). A user-supplied torrc with
  `NoIsolateSOCKSAuth` would silently degrade per-engine isolation; the
  client cannot detect its own circuit assignment. Do not override it.

### Not Protected Against

- **Rooted devices with malware:** RAM can be dumped by privileged processes
- **Tor de-anonymization attacks:** The App cannot protect against Tor
  network-level attacks
- **Physical device seizure with forensic tools:** Advanced tools may extract
  RAM contents from a powered-on device
- **Social engineering:** The App cannot prevent users from voluntarily
  accessing harmful content

## Evidence

Every security claim above is backed by a reproducible check. Commands and
expected outputs:

### Unit tests (TypeScript, Vitest)

```
bun run test
# Expected: Test Files 11 passed, Tests 253 passed
```

### Coverage gate (regression floor, measured 2026-10-20)

```
bun run test:coverage
# Expected: PASS at thresholds lines 69% / statements 67% /
#   functions 65% / branches 56% (ratchet up, never down).
# native.ts and ghost-context.tsx are intentionally 0%
#   (require a live Android WebView).
```

### Property-based fuzz harness (fast-check)

```
bunx vitest run src/lib/ghost/__tests__/fuzz.pbt.test.ts
# Expected: 11/11 properties pass over 5,100 generated inputs
#   covering adaptQuery surrogates, base32/onion checksum
#   mutation resistance, snippet bounds, SimHash/Hamming
#   invariants, and URL/captcha parser robustness.
```

### Dependency pinning

```
bun install --frozen-lockfile
# Expected: "no changes" — all 86 deps pinned to exact versions
#   in package.json; lockfile is the enforcement point in CI.
```

### Runtime log-leak proof (real device, SM-G998B, 2026-10-20)

```
adb install -r ghost-v4.0.0-release.apk && adb logcat -c
# launch app, type search query "ghostcanary9x7q", submit, wait
adb logcat -d -v brief > logcat.txt
grep -cE "ghostcanary|\.onion|[?&]q=|Set-Cookie" logcat.txt
# Expected: 0 matches attributable to org.darknetcrawler.mobile.
#   Verified: 8,858 lines captured, 0 canary/0 onion/0 query/
#   0 cookie leaks, 0 Capacitor/Console output from the app.
```

### Unit tests (Java, JUnit 4)

```
cd android && ./gradlew testReleaseUnitTest
# Expected: 15/15 tests PASS in
#   app/build/test-results/testReleaseUnitTest/
#   TEST-org.darknetcrawler.mobile.PianoTorHttpPluginTest.xml
# Coverage includes: v3 .onion host policy, ASCII request-target encoding
# (pre-encoded queries preserved verbatim — single encoding owner),
# chunked trailer parsing, truncated-chunk rejection, Set-Cookie validation,
# local-loopback SOCKS5 protocol tests (RFC 1929 auth, ATYP=DOMAINNAME,
# clearnet-redirect block, Sec-Fetch-Site hop transitions, MAX_BODY cap),
# response-completion enforcement (Content-Length premature EOF and missing
# chunk terminator now error instead of returning partial bodies as 200),
# and redirect method policy (301/302/303 -> GET, 307/308 preserve POST
# same-origin, cross-host redirect carrying a request body is rejected).
```

### Type safety

```
bunx --bun tsc --noEmit
# Expected: 0 errors
```

### Release build

```
bun run build:mobile && bunx cap sync android
cd android && ./gradlew assembleRelease
# Expected: BUILD SUCCESSFUL; APK in app/build/outputs/apk/release/
```

### Signature + permissions + zero-Log audit

```
apksigner verify --verbose --print-certs app-release.apk
# Expected: v2=true, v3=true, signer SHA-256 =
#   0295bf53d9abe8621e41510cdc1bd8dcaf992745621a6bcff33eeb6f3f870106
aapt dump permissions app-release.apk
# Expected: INTERNET, ACCESS_NETWORK_STATE, VIBRATE,
#   HIDE_OVERLAY_WINDOWS (Capacitor-injected) —
#   no location/contacts/storage/camera/mic/biometric
dexdump -d classes.dex | grep -cE "android/util/Log|Ljava/io/PrintStream;->print"
# Expected: 0
```

### Release artifact verification (F-Droid `Binaries:` roundtrip)

```
curl -sL -o dl.apk \
  https://codeberg.org/sookoothaii/digital-spyglass-android/releases/download/v4.0.0/ghost-v4.0.0-release.apk
sha256sum dl.apk
# Expected (v4.0.0): 3a05ef72a069fd45bfcbf0417a06652d3c6de3fbe9622e256caf90e9620d29a1
# Expected (v4.1.0, vc12): 492ba8a0ab9e25f59140681feeccf4f9fdcf3ca8f3ce0ea7fa0153bf710f3271
```
