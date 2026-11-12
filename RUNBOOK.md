# Ghost Search — Operations Runbook

Scope: what to do when something security-relevant breaks or is suspected.
Owner: upstream maintainer (Codeberg `sookoothaii`).

## 1. Release cadence

- Patch releases when a security-relevant fix lands; minor releases for feature batches.
- Every release: bump `versionCode`/`versionName`, tag `vX.Y.Z`, build with
  `bun run build:mobile && bunx cap sync android && ./gradlew assembleRelease`,
  upload `ghost-vX.Y.Z-release.apk` to the Codeberg release, then update
  `fastlane/metadata/android/en-US/changelogs/<vc>.txt`.
- F-Droid picks up tags automatically (`UpdateCheckMode: Tags`); reproducibility
  depends on `bun.lock` being frozen — never edit `package.json` deps without
  running `bun install` and committing the lockfile.
- Engine registry is signed: after ANY change to `src/lib/ghost/engines.json`
  run `bun scripts/sign-registry.mjs --key ~/.ghost-keys/registry-signing.pem`
  and commit the regenerated `engines.sig.json` before building. The weekly
  health probe only mutates `health.*`, which the signature excludes, so
  health merges need no re-signing.

## 2. Incident: onion engine compromised or hostile

Symptoms: engine returns phishing/JS-injected results, canonical onion vanishes.

1. Mark the engine unavailable: remove/quarantine its entry in
   `src/lib/ghost/engines.ts` AND `CANONICAL_ONION_REGISTRY` in `authenticity.ts`.
   Decoy targets derive from the registry — both must change together.
2. Ship a patch release bumping `versionCode`.
3. Post a release note; do not disclose per-engine detail beyond "engine removed".

## 3. Incident: dependency supply-chain compromise

1. `bun install --frozen-lockfile` fails or a new dep shows unexpected behavior.
2. Pinpoint the diff: `git diff bun.lock` + audit the changed package tarball.
3. Revert the dep, bump patch release, rotate nothing (signing key unaffected
   unless the build itself ran the malicious code — if it did, treat as §4).

## 4. Incident: signing key suspected compromised

The signer digest `0295bf53…` is pinned in F-Droid `AllowedAPKSigningKeys`.

1. Stop releases immediately.
2. Generate a new keystore; F-Droid requires an fdroiddata MR updating
   `AllowedAPKSigningKeys` — until merged, users cannot update over the old
   signature (they must reinstall).
3. Re-export `scripts/registry-release.pub.pem` + `registry-release.spki.pem`
   from the new keystore and re-sign `engines.sig.json` — the registry
   signature is anchored to the APK signer and must follow the rotation.
4. Publish a clear release note about the key rotation.

## 5. Incident: panic wipe or screenshot protection reported broken

1. Reproduce on a real device (API level of the report).
2. Check `FLAG_SECURE` in `MainActivity`, `PanicResponderActivity`,
   `PianoScreenPlugin.executeHardPanicWipe`.
3. Verify residual files via `run-as org.darknetcrawler.mobile` on a debug build:
   `cache/`, `app_webview/`, `shared_prefs/` must be empty post-wipe.
4. Add a regression test before shipping the fix.

## 6. Engine-availability monitoring (weekly, manual for now)

Probe each `CANONICAL_ONION_REGISTRY` entry through Orbot SOCKS5
(`127.0.0.1:9050`), expect HTTP 200/302 on `/`. A dead engine is removed per §2.

## 7. Verification commands (run before any release)

```
bun install --frozen-lockfile   # dependency integrity
bun scripts/verify-registry.mjs # registry signature must verify
bunx --bun tsc --noEmit         # 0 errors
bun run test                    # 245/245
bun run test:coverage           # gates: lines 69 / stmt 67 / func 65 / branch 56
cd android && ./gradlew testReleaseUnitTest   # 9/9
apksigner verify --verbose --print-certs app-release.apk  # v2+v3, 0295bf53…
```

## 8. Known limitations (accepted residual risk)

- Emulator detection is advisory (`Build.*` heuristics, spoofable).
- No anti-root/anti-Frida. Device compromise is out of scope.
- Tor transport depends on Orbot; without it the app must fail closed.
