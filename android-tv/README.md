# Cave Trivia for Android TV

A thin full-screen WebView app that opens the live TV page, https://ajersj-cmyk.github.io/EPG/ (index.html).
When the site changes, the app picks it up without a reinstall.

- Package `com.ahlers.cavetrivia`, minSdk 24, so it runs on onn Google TV boxes.
- Keeps the screen awake, runs immersive full-screen, passes D-pad/OK to the page, and reloads on network errors.
- Build: `source ~/android-dev/env.sh` plus the signing env, then `./gradlew assembleRelease`. Art: `python3 art.py`.
- Install: in the Downloader app, enter the APK link from the `cavetrivia-tv-v*` release.
