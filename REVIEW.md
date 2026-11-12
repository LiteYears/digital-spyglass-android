# Ghost Search v4.0 — Reviewer Checklist

Every item is atomic and produces a pass/fail observation, not an opinion.
File a Codeberg issue per finding; include the check ID (e.g. `P2`).

---

## A. Protocol enforcement — `PianoTorHttpPlugin.java`

Only an external reviewer can answer these — the author wrote the code.

| ID  | Check                                                                                                     | Expected                                                                                                  |
| :-- | :-------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| P1  | Is `isValidOnionUrl()` enforced **before** the socket connects, not after?                                | Reject before any bytes leave; a clearnet host must never be dialed                                       |
| P2  | Is the `Location` header validated on **every** redirect hop in `executeFetchWithRedirects()`?            | `.onion` → clearnet redirect dies immediately, incl. relative-URL resolution via `toAsciiRequestTarget()` |
| P3  | Does `Sec-Fetch-Site` transition to `cross-site` when a redirect changes host?                            | `none` → `same-origin`/`cross-site`; `same-origin` on a different host is a fingerprint contradiction     |
| P4  | Is the cookie jar silent across host changes (`buildCookieHeader` / `parseSetCookie`)?                    | Cookies from engine A never reach engine B                                                                |
| P5  | When `Content-Length` and `Transfer-Encoding` coexist, is the safe path taken?                            | No request-smuggling ambiguity; one wins deterministically                                                |
| P6  | Are `decodeChunked`, `findHeaderEnd`, `hasChunkedTerminator` robust to malformed/truncated input?         | `MAX_BODY` cap (2,000,000 B) holds; no infinite read on missing terminator                                |
| P7  | When Tor delivers a clearnet redirect (compromised exit), does the failure surface as an **error**?       | User sees a failure state, not a silent "no results"                                                      |
| P8  | RFC 1929 handshake: does the client refuse a server that picks `0x00` (no-auth) after `0x02` was offered? | Fail-closed — covered by JUnit, verify the _failure path_ also can't proceed silently                     |

## B. Threat model — `docs/GHOST_V4_SECURITY_ARCHITECTURE.md`

| ID  | Check                                                                                           | Expected                                                                                                                                                   |
| :-- | :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | List every assumption stated as "given" that is not argued                                      | Each assumption either proven, cited, or moved to Known Limitations                                                                                        |
| T2  | Does the model assume Orbot binds SOCKS5 to `127.0.0.1` only?                                   | If Orbot LAN-mode is possible, transport isolation breaks at the root — must be documented                                                                 |
| T3  | Parallel fan-out to 13 engines: is the timing/length correlation acknowledged?                  | Known Limitations entry — separate circuits don't decorrelate simultaneous identical-length queries                                                        |
| T4  | Engine _selection_ as a stable cross-session fingerprint?                                       | Documented as a coverage↔anonymity trade-off, not a bug                                                                                                    |
| T5  | HTTP fingerprint gap: no `Sec-CH-UA` hints, header order not byte-identical to Firefox 140 ESR? | Documented; graded as "harder, not impossible". UA/`Accept-Encoding`/`Connection` aligned to TB-Android baseline in v4.1.0; remaining deltas tracked in §B |

## C. Reproducibility — build it yourself

| ID  | Check                                                                                                                    | Expected                                                                                                                                                                                                                                                                                                                                 |
| :-- | :----------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Fresh environment, no Gradle cache: clone, `bun install --frozen-lockfile`, build, compare SHA-256 against release asset | v4.1.0 (vc12): `492ba8a0ab9e25f59140681feeccf4f9fdcf3ca8f3ce0ea7fa0153bf710f3271` (3,007,804 B) — locally built from the signed-registry tree; re-pin to the published asset when v4.1.0 is uploaded. v4.0.0 (historic): `3a05ef72a069fd45bfcbf0417a06652d3c6de3fbe9622e256caf90e9620d29a1` (1,852,694 B). Divergence **is** the finding |
| R2  | Are `buildToolsVersion`, `compileSdkVersion`, JDK/Gradle versions exactly pinned?                                        | Any drift breaks byte-identity                                                                                                                                                                                                                                                                                                           |
| R3  | Is `SOURCE_DATE_EPOCH` set so ZIP timestamps are stable?                                                                 | Two consecutive builds identical                                                                                                                                                                                                                                                                                                         |
| R4  | Any dynamic version derivation (`git describe`, build timestamps)?                                                       | None — `versionCode 11` static                                                                                                                                                                                                                                                                                                           |

## D. Onion registry provenance — `src/lib/ghost/authenticity.ts`

13 canonical addresses are the trust anchor of `detectOnionSpoof`. Two are
independently confirmed (Ahmia `juhanurmihxlp77…`, Tor66 `tor66sewebgixw…`);
the rest were sourced from public mirror lists, which can be stale.

| ID  | Check                                                                                                                           | Expected                                                                                                      |
| :-- | :------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------ |
| D1  | For each of the 13 entries: find the address on the engine's **official** source (project homepage/repo, Ahmia directory entry) | `provenance_url` per row; unverifiable entries move to a `best-effort` registry excluded from spoof detection |

## E. Device matrix — other phones, other Androids

| ID  | Device               | Check                               | Expected                                                                                                              |
| :-- | :------------------- | :---------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| E1  | API 24 (emulator)    | `FLAG_SECURE` + screenshot          | Empty capture, no Recents thumbnail                                                                                   |
| E2  | API 24               | Panic wipe + `run-as ls`            | `app_webview/`, `cache/`, `shared_prefs/` empty                                                                       |
| E3  | GrapheneOS / CalyxOS | VPN gate without Orbot              | `egressOk = false`, search blocked; `tun\d+` heuristic may differ — report interface names                            |
| E4  | API 30               | `setHideOverlayWindows` unavailable | `SecurityException` caught, no crash — and note: **no tapjacking protection exists below API 31, by platform design** |

---

## Reporting format

```
[ID] P2
Result: FAIL (or PASS / INCONCLUSIVE)
Artifact: <commit | file:line | device | APK sha256>
Evidence: <what you observed, literally>
```

For transport-level findings, use the compact evidence receipt — it survives
a later fix and separates what was proven from what wasn't:

```plaintext
Check: HTTP_CL_PREMATURE_EOF
Source: Ghost v4.0.0, <pinned commit sha>
Runner: Java transport + local SOCKS5/HTTP mock
Input: 200; Content-Length: 100; body "short"; then EOF
Expected: incomplete-response error
Observed: <literal result>
Replicated: <environments>
APK: download hash matched; <which paths were checked>
Android device: <tested or not>
```

`INCONCLUSIVE` is a valid result — an untestable claim is itself a finding.
