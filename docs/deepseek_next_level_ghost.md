# Ghost v4.0.0 — Roadmap to the Highest Security Maturity Level

## 1. Where We Stand

A previous assessment placed Ghost at **Level 2 (Security-Aware)** on a 0–4 maturity scale. The architecture and documentation are strong, but verifiable evidence, independent review, and operational testing are missing. This document defines the iterative path to **Level 3 (Audit-Ready)** and **Level 4 (Production-Grade Privacy)**.

## 2. The Maturity Model

| Level | Name | Core Criterion |
| :--- | :--- | :--- |
| 0 | Prototype | Runs on a dev device |
| 1 | Solid Hobby App | Clean code, README |
| 2 | Security-Aware | Threat model, defense-in-depth, audit trail, tests for critical paths |
| **3** | **Audit-Ready** | **Reproducible builds, coverage gates, independent review, documented residual risks, field-tested** |
| 4 | Production-Grade Privacy | External pen-tests, incident response, long-term maintenance, formal verification |

Ghost currently sits at **Level 2**. The gap to Level 3 is not architectural—it is **evidentiary**.

## 3. Iterative Hardening Roadmap

### Iteration 1 — Make Security Claims Verifiable (Level 2 → 2.5)

**Goal:** Every security claim is backed by a test or a measurement, not by assertion.

**Actions:**

1. **Coverage gates.** Add `vitest --coverage` with thresholds (e.g., 70% lines, 60% branches) and fail CI if coverage drops. This exposes which modules are actually exercised and which are only inspected by eye.
2. **Java protocol tests with a SOCKS5 mock.** The 5 existing JUnit tests cover method-level fixes, not protocol behavior. Add tests for `fetchOnce` with a local `ServerSocket` that speaks minimal SOCKS5, a redirect chain that violates the v3-only policy, the `MAX_BODY` cap, and cookie-jar lifecycle. OWASP MASTG specifically calls for dynamic analysis of network and storage controls[reference:0].
3. **Dependency pinning.** Replace caret ranges (`^8.5.0`) with exact versions or a lockfile-enforced policy. Supply-chain attacks on build tools are a documented Trusting-Trust vector[reference:1].
4. **`adb logcat` proof.** Capture a full search session and prove that no `.onion` URL, query string, or cookie value appears in logcat. This is the operational counterpart to the DEX-level zero-Log proof already in place.

**Exit criterion:** A `SECURITY.md` section titled “Evidence” lists commands and expected outputs for coverage, Java tests, and logcat.

### Iteration 2 — Establish Reproducibility (Level 2.5 → 3)

**Goal:** Anyone can rebuild the APK byte-for-byte and verify the release.

**Actions:**

1. **F-Droid reproducible-build recipe.** F-Droid verifies reproducible builds by copying the signature from the upstream APK to the rebuild and checking if it verifies[reference:2][reference:3]. This requires:
   - Pinned `buildToolsVersion` and `compileSdkVersion` (the F-Droid community notes that toolchain drift breaks byte-identity)[reference:4].
   - `SOURCE_DATE_EPOCH` set consistently.
   - A `Binaries:` or `binary:` field in the F-Droid metadata if the app ships prebuilt native artifacts[reference:5].
2. **Diverse Double-Compiling (DDC) as a stretch goal.** The gold standard for Trusting-Trust resistance is compiling the same source with two entirely distinct toolchains and comparing the binaries[reference:6]. This is difficult for Android but can be approached incrementally by building in two different JDK/AGP environments and diffing non-signature bytes.
3. **OpenSSF Scorecard baseline.** Run the OpenSSF Scorecard against the repository. It will expose gaps in code review, SAST, fuzzing, branch protection, and security policy[reference:7]. Treat the score as a **diagnostic**, not a target—a 10/10 does not guarantee security[reference:8].

**Exit criterion:** A third party can follow the `REPRODUCIBLE_BUILD.md` and obtain a binary that matches the release APK after signature copying.

### Iteration 3 — Automate the Security Gates (Level 3)

**Goal:** Every PR and every release is gated by automated security checks.

**Actions:**

1. **SAST + SCA in CI.** Integrate a mobile SAST/SCA platform that runs on every PR and fails on High/Critical findings[reference:9]. For Android, MobSF provides both static and dynamic analysis and can be run in CI[reference:10].
2. **MASVS-aligned static review.** Use the OWASP MASVS checklist to systematically review exported components, deep links, WebView configuration, `network-security-config`, and backup exposure[reference:11][reference:12]. The current audit covered many of these manually; automation prevents regression.
3. **Dependency scanning.** Add SCA to detect known CVEs in `package.json`, `build.gradle`, and transitive native libraries. Supply-chain compromise is a realistic threat for a privacy app[reference:13].
4. **Fuzzing for parsers.** The 13 engine parsers and `parseByRegex` are regex/DOM hybrids. Add a fuzzing harness (e.g., Jazzer for Java, `fast-check` for TypeScript) to catch catastrophic backtracking and malformed-HTML crashes.

**Exit criterion:** CI blocks merges on High/Critical SAST/SCA findings, and a fuzzing corpus exists for the parser layer.

### Iteration 4 — Independent Verification (Level 3 → 4)

**Goal:** An external party confirms the security properties Ghost claims.

**Actions:**

1. **Penetration test following OWASP MASTG.** A tester should perform static analysis (jadx, MobSF), dynamic analysis (Frida, objection), and traffic interception (Burp/mitmproxy) against a test build[reference:14][reference:15]. The scope should explicitly include:
   - SOCKS5 handshake and redirect enforcement.
   - Cookie-jar isolation and purge.
   - Panic-wipe completeness (verify via `run-as` that `app_webview/`, `cache/`, `shared_prefs/` are empty).
   - Emulator-detection bypass (the current `Build.*` check is advisory and spoofable).
2. **Onion-service auditing.** If Ghost ever hosts an onion service (not currently the case), use OnionScan or onionscout to check for OPSEC leaks, clearnet dependencies, and metadata exposure[reference:16][reference:17].
3. **Threat-model review.** The threat model must be reviewed by someone who did not write it. The attacker owns the device and can decompile, hook, and proxy[reference:18]. A second pair of eyes will catch assumptions that the original author normalized.

**Exit criterion:** A written pen-test report with severity ratings and remediation status for every finding.

### Iteration 5 — Operational Maturity (Level 4)

**Goal:** The app remains secure after release.

**Actions:**

1. **Field testing on real hardware.** Test on API 24 (minSdk) with the oldest supported WebView, on MicroG/Custom-ROM devices, and with Orbot stopped. Document behavior.
2. **Engine-availability monitoring.** The 13 onion addresses rotate. A weekly automated probe (via Tor) should confirm each engine is reachable and report when one dies.
3. **Incident-response plan.** Define what happens if an engine is compromised, a dependency is backdoored, or a signing key is suspected. Include key-rotation and user-notification procedures.
4. **Long-term maintenance.** Establish a release cadence, a CVE-watch process, and a policy for dropping unsupported Android versions.

**Exit criterion:** A `RUNBOOK.md` exists and has been exercised at least once in a tabletop exercise.

## 4. Tooling Reference

| Tool | Purpose | Source |
| :--- | :--- | :--- |
| OWASP MASVS / MASTG | Control framework and testing guide | [reference:19][reference:20] |
| MobSF | Automated static + dynamic Android analysis | [reference:21] |
| Frida / objection | Runtime instrumentation, pinning bypass | [reference:22] |
| jadx | APK decompilation | [reference:23] |
| apksigcopier | Reproducible-build signature verification | [reference:24] |
| OpenSSF Scorecard | Repository security-health diagnostics | [reference:25] |
| OnionScan / onionscout | Onion-service OPSEC auditing | [reference:26] |
| SAST/SCA/DAST CI gates | Release-blocking automation | [reference:27] |

## 5. Metrics That Matter

Do not track vanity metrics. Track:

- **Coverage trend**, not absolute coverage.
- **Time-to-remediation** for High/Critical findings.
- **Reproducibility status** (byte-identical rebuild: yes/no).
- **Number of untested protocol paths**, not number of tests.
- **External review findings per release**, not internal test count.

## 6. Summary

The path from Level 2 to Level 3 is **evidence**, not architecture. The path from Level 3 to Level 4 is **independent verification and operational discipline**. Neither requires a rewrite. Both require the discipline to make claims falsifiable—and then to let someone else try to falsify them.