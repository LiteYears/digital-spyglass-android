# F-Droid Distribution Guide

Ghost is distributed via two F-Droid channels:

1. **Self-hosted repo** (live now) — add the repo URL to F-Droid client
2. **Official F-Droid repo** (pending submission) — would appear without adding a custom repo

## Option 1: Self-Hosted Repo (Live)

The F-Droid repository is hosted on GitHub Pages and is live now.

### Repo URL

```
https://sookoothaii.github.io/digital-spyglass-android/repo
```

### How to Install

1. Open **F-Droid** on your Android device
2. Go to **Settings → Repositories**
3. Tap **+** (New Repository)
4. Enter the repo URL above
5. F-Droid downloads the repo index
6. Search for **Ghost**
7. Install

### Verify the Repo Signing Key

When F-Droid asks to confirm the repo fingerprint, it should match:

```
FF 14 6D F7 6B 06 7D 6F 71 E6 15 9E C3 BA 62 DC 24 97 BD 40 7E 6A D4 6C 29 50 B5 70 D9 5F E3 D1
```

### How the Self-Hosted Repo Works

- The `gh-pages` branch contains the F-Droid repo structure
- `repo/` directory holds the APK, signed index (`index-v1.jar`, `index-v2.json`), and icons
- `metadata/org.darknetcrawler.mobile.yml` holds the app metadata
- GitHub Pages serves the repo at `https://sookoothaii.github.io/digital-spyglass-android/repo`
- The repo index is signed with a dedicated F-Droid signing key (not the APK signing key)

### Updating the Self-Hosted Repo

When a new APK is released:

```sh
# Switch to gh-pages branch
git checkout gh-pages

# Copy the new APK into repo/
cp android/app/build/outputs/apk/release/app-release.apk repo/ghost-v1.1.0-release.apk

# Regenerate the index
fdroid update

# Commit and push
git add repo/ metadata/
git commit -m "F-Droid repo: update to v1.1.0"
git push origin gh-pages

# Switch back to main
git checkout main
```

## Option 2: Official F-Droid Repo (Submission)

Submit the app to the official F-Droid repository so users can find it
without adding a custom repo.

### Prerequisites (all met)

- [x] Open-source (GPL-3.0-or-later license)
- [x] No proprietary dependencies
- [x] No Google Play Services dependency
- [x] Reproducible build from source
- [x] No anti-features (no ads, no tracking, no non-free deps)

### Submission Steps

1. **Create a GitLab account** at https://gitlab.com (if you don't have one)

2. **Fork the fdroiddata repository:**
   - Go to https://gitlab.com/fdroid/fdroiddata
   - Click **Fork**

3. **Clone your fork:**

   ```sh
   git clone https://gitlab.com/YOUR_USERNAME/fdroiddata.git
   cd fdroiddata
   ```

4. **Copy the metadata file:**

   ```sh
   # Download from GitHub or copy from this repo's metadata/ directory
   cp /path/to/org.darknetcrawler.mobile.yml metadata/
   ```

5. **Validate the metadata:**

   ```sh
   fdroid checkmetadata org.darknetcrawler.mobile
   fdroid readmeta
   ```

6. **Test the build locally (optional but recommended):**

   ```sh
   fdroid build org.darknetcrawler.mobile:1
   ```

7. **Commit and push:**

   ```sh
   git add metadata/org.darknetcrawler.mobile.yml
   git commit -m "New app: org.darknetcrawler.mobile"
   git push origin master
   ```

8. **Create a Merge Request:**
   - Go to your fork on GitLab
   - Click **Create merge request**
   - Target: `fdroid/fdroiddata` master branch
   - Title: `New app: org.darknetcrawler.mobile (Ghost)`
   - Description: Include a link to the GitHub repo and note that it's
     already distributed via a self-hosted F-Droid repo

9. **Wait for review:**
   - F-Droid maintainers review the metadata and build the app
   - They may request changes (build reproducibility, dependency issues, etc.)
   - Typical review time: 1-4 weeks
   - Once approved, the app appears in the official F-Droid repo

### What F-Droid Reviews

| Check                   | Status                                    |
| ----------------------- | ----------------------------------------- |
| Open-source license     | GPL-3.0-or-later — pass                   |
| No proprietary deps     | All deps are open-source — pass           |
| No anti-features        | No ads, tracking, or non-free code — pass |
| Reproducible build      | Build config in metadata — pass           |
| No Google Play Services | Not used — pass                           |
| Active maintenance      | Recent commits and release — pass         |

## Option 3: Direct APK (GitHub Releases)

The simplest distribution — users download the APK directly.

- **Release URL:** https://github.com/sookoothaii/digital-spyglass-android/releases/tag/v1.0.0
- **APK:** `ghost-v1.0.0-release.apk` (1.87 MB)
- **SHA-256:** `99182012481a68e2b120d6b22da15708c5c808218fd52d4490e33c0b8a67acac`

Users must enable "Install from unknown sources" in Android settings.

## Signing Notes

| Key                    | Purpose                     | Where                       |
| ---------------------- | --------------------------- | --------------------------- |
| `release-keystore.jks` | APK signing (developer key) | Local only, gitignored      |
| `keystore.p12`         | F-Droid repo index signing  | gh-pages branch, gitignored |

The APK is signed with the developer's key. The F-Droid repo index is signed
with a separate F-Droid repo key. If the official F-Droid repo accepts the
app, they will sign the APK with their own key.
