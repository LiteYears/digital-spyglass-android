# F-Droid Repo Configuration for Ghost
# Self-hosted F-Droid repository
#
# Setup:
#   pip install fdroidserver
#   cd fdroid
#   fdroid init
#   cp ../android/app/build/outputs/apk/release/app-release.apk repo/
#   fdroid update
#   fdroid server update
#
# Serve the repo/ directory via any web server (nginx, Caddy, Python http.server)
# Users add your repo URL in F-Droid client: Settings -> Repositories -> New

repo_url = "https://sookoothaii.github.io/digital-spyglass-android/fdroid/repo"
repo_name = "Ghost Onion Search"
repo_description = """
Transient onion meta-search aggregator for Android.
RAM-only, stateless, no backend, no telemetry.
"""
repo_icon = "icon.png"
repo_keymac = "32:BD:2C:9F:4E:1A:A0:6D:68:71:3B:4F:7A:1C:5D:8E:9A:2B:3C:4D"

# Update interval in hours (0 = manual)
update_interval = 24

# Keep all APK versions
archive_older = 5

# Mirror info
mirrors = [
    "https://sookoothaii.github.io/digital-spyglass-android/fdroid/repo",
]
