# Reproducible Builds & Verification Guide

**Status:** DRAFT v0.1 (2026-10-25) — the missing trust-anchor guide: how an external reviewer rebuilds Ghost Search byte-exactly and verifies what they are running.
**Companion:** [`SECURITY.md`](../SECURITY.md) "Evidence" section (canonical commands + expected outputs) · [`THREAT_MODEL.md`](THREAT_MODEL.md) §A4 (supply-chain adversary) · in-repo F-Droid reference recipe: `metadata/org.darknetcrawler.mobile.yml`.

**Verified toolchain pins (checked at HEAD 7c06a377d3, 2026-10-25):** Gradle **8.14.3** (wrapper, `android/gradle/wrapper/gradle-wrapper.properties`) · Android Gradle Plugin **8.13.0** (`android/build.gradle:10`) · Capacitor core **8.5.0**, Vite **8.2.0**, React **19.2.8** (`package.json`) · dependency lockfile **`bun.lock`** (exact pins, enforced `--frozen-lockfile`) · minSdk 24 / Android 7.0+ (metadata + store listing). Node.js **22+** is required by the Capacitor CLI; the F-Droid build server installs Node 24 from Debian *forky* (documented in the recipe's `sudo:` block and MaintainerNotes:78-81).

---

## 1. The two trust paths (read this first)

Ghost distributes **upstream-signed** APKs through F-Droid using the reproducible-binaries model:

1. **F-Droid path (primary, what end users get):** the fdroiddata recipe (MR !46224) uses `Binaries:` + `AllowedAPKSigningKeys`. F-Droid's build server rebuilds the app from the tagged source, verifies the rebuild matches the upstream-provided APK, and then **distributes the upstream-signed APK** — the F-Droid key never signs Ghost. Reproduction is thus continuously re-proven by the F-Droid infrastructure on every release; the app page's reproducibility status reflects it.
2. **Local path (for reviewers, what this guide walks through):** rebuild the exact tag yourself as an *unsigned* release APK and compare content against the published release. You cannot reproduce the signature (the signing key is private and never leaves the operator) — that is by design; instead you verify the *published* APK's signature against the pinned signer fingerprint (§4) and its hash against the published values (§3).

## 2. Local rebuild, step by step

```bash
# 0) Prerequisites: git, bun, Node.js >= 22 (24.x tested), JDK 17+ (AGP 8.13),
#    Android SDK with the platform matching compileSdk, ANDROID_HOME set.
git clone https://codeberg.org/sookoothaii/digital-spyglass-android.git
cd digital-spyglass-android
git checkout v4.1.0            # always build a tag, never a branch head

# 1) JS dependencies — exact pins, no drift:
bun install --frozen-lockfile  # must report no changes (lockfile is the enforcement point)

# 2) Web assets + Capacitor sync (order matters; this is what the F-Droid
#    recipe's init: block does — keep it identical):
bun run build:mobile           # vite build via vite.mobile.config.ts
bunx cap sync android

# 3) Native build (unsigned release):
cd android
./gradlew assembleRelease      # uses the pinned wrapper → Gradle 8.14.3
# Output: app/build/outputs/apk/release/app-release-unsigned.apk
```

**Byte-exactness caveats a reviewer must know (honesty section):**

- The upstream release artifact is **signed**; your local build is unsigned. Compare against the upstream *build* the same way F-Droid does (content comparison before/at signing), or simplest: verify the published APK's signature (§4) + hash (§3) and treat your rebuild as proof that *the tag builds from clean source with pinned tooling*, while the hash attests *which bytes* were signed.
- `key.properties` / `release-keystore.jks` are gitignored (MaintainerNotes:83-85) — a from-source build is release-config-compatible and produces the unsigned APK the F-Droid recipe names as its `output:` (`metadata/org.darknetcrawler.mobile.yml:62`).
- If your environment's Android SDK/NDK components differ from the F-Droid build server's, resource compilation can legitimately differ; the F-Droid rebuild (path 1) is the authoritative byte-exactness oracle, run on identical infrastructure every release.

## 3. Verify the published release artifact

```bash
# Get the release APK (F-Droid client, or the Codeberg release):
curl -sL -o ghost.apk \
  https://codeberg.org/sookoothaii/digital-spyglass-android/releases/download/v4.1.0/ghost-v4.1.0-release.apk

# Expected SHA-256 (published in SECURITY.md:214-222 — cross-check there, do not
# trust this guide alone; SECURITY.md is the living source):
#   v4.1.0 (vc12): 492ba8a0ab9e25f59140681feeccf4f9fdcf3ca8f3ce0ea7fa0153bf710f3271
#   v4.0.0 (vc11→ see SECURITY.md for the v4.0.0 value): 3a05ef72a069fd45bfcbf0417a06652d3c6de3fbe9622e256caf90e9620d29a1
sha256sum ghost.apk
```

## 4. Verify the signature (who signed what you are about to run)

```bash
apksigner verify --verbose --print-certs ghost.apk
# Expected: v2=true, v3=true, signer certificate SHA-256:
#   0295bf53d9abe8621e41510cdc1bd8dcaf992745621a6bcff33eeb6f3f870106
```

This fingerprint is the **root of the app's internal trust chain**: the operator-signed engine registry (`engines.sig.json`) is verified at runtime against a public key anchored to this APK signer (`PianoRegistryAnchorPlugin` + `src/lib/ghost/registry-signature.ts`), fail-closed. If you got the APK from anywhere and this fingerprint does not match, nothing else in this document applies — you are looking at a different build than the one the guarantees cover.

## 5. Verify the signed engine registry (offline, no device needed)

```bash
bun scripts/verify-registry.mjs   # verifies src/lib/ghost/engines.json
                                   # against engines.sig.json + scripts/registry-release.spki.pem
```

Also review `scripts/sign-registry.mjs` to see exactly what is signed (the canonical projection drops mutable `health` fields — covered by tests `registry-signature.test.ts:59-129`). The APK-anchored runtime check additionally ties the verification key to the APK signer, so a tampered registry file next to a legit APK still fails closed at runtime.

## 6. Verify the behavioral claims while you are at it

From a clean checkout (see `SECURITY.md` "Evidence" for expected outputs):

```bash
bun run test                              # 253 tests, 11 files
bunx vitest run src/lib/ghost/__tests__/fuzz.pbt.test.ts   # 11 property checks
cd android && ./gradlew testReleaseUnitTest               # 18 native tests incl. SOCKS5/redirect/chunked
aapt dump permissions ghost.apk           # INTERNET, ACCESS_NETWORK_STATE, VIBRATE, HIDE_OVERLAY_WINDOWS only
```

## 7. What is *not* reproducible (and why that's fine)

- **The APK signing key** — private by definition; verified via fingerprint instead (§4).
- **F-Droid's distribution metadata** — lives in fdroiddata, not this repo; the in-repo `metadata/` copy is a reference (see its MaintainerNotes).
- **Engine addresses/health over time** — `engines.json` `health` fields change per release train but are excluded from the signature's canonical projection; the signed set (ids, addresses, parsers, trust) is what verifiability covers.

## 8. Reviewer quick checklist

1. Build the tag locally with `--frozen-lockfile` → unsigned APK builds clean (§2).
2. F-Droid page shows the release as reproducible (path 1) (§1).
3. Downloaded APK hash matches SECURITY.md (§3).
4. `apksigner` signer SHA-256 == `0295bf53…070106` (§4).
5. `bun scripts/verify-registry.mjs` passes on the checkout you built (§5).
6. Test suites green (§6).

All six together establish: *these bytes, from this source, signed by that key, with a fail-closed engine registry — and anyone can re-prove it.*

---

*Maintainer note: DRAFT — before external publication, (a) have one non-operator actually run §2 end-to-end and record their environment, (b) sync the §3 hash list with SECURITY.md on every release (single source of truth = SECURITY.md), (c) consider linking the fdroiddata MR diff for the current release from §1.*
