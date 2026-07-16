# PH Payroll — Android app (tablet-ready)

This is a thin native wrapper that runs the exact same offline payroll web app
inside an Android **WebView**. All payroll logic, data storage and screens are
identical to the desktop/browser version — it just runs as a normal Android app
you can install on a **tablet** (or phone).

On first launch the app asks whether to **connect to your online server** (enter
its address, e.g. `https://payroll.yourcompany.com`) or **use the offline app**
on the device. You can switch anytime with the floating **⚙** button. The online
mode is the multi-user system (accounts, roles, employee self-service); offline
mode is the standalone single-device app.

- ✅ **Online or offline** — connect to the shared server or run standalone.
- ✅ **Tablet-optimised** — the responsive layout uses the full screen.
- ✅ **DTR / backup upload** — native file picker.
- ✅ **PDF & CSV export** — payslips/reports print via Android's print system
  (choose *Save as PDF*); CSV/JSON exports save to the device **Downloads**.
- ✅ Data is stored **on the device** (WebView local storage). Use the app's
  **Backup & Data → Export** to keep a JSON copy off-device.

---

## Easiest way to get the APK — no tools to install

The repository has a **GitHub Actions** workflow that builds the APK for you.

1. On GitHub, open the **Actions** tab.
2. Select **“Build Android APK”**. It runs automatically on each push to `main`,
   or click **Run workflow** to start it manually.
3. When the run finishes (green ✓), open it and download the
   **`ph-payroll-apk`** artifact (a `.zip`). Inside is **`app-debug.apk`**.

### Install on the tablet

1. Copy `app-debug.apk` to the tablet (USB, email, or a cloud drive link).
2. Open it with the tablet's Files app and tap **Install**. You'll be asked to
   allow **“Install unknown apps”** for that source — allow it (this is normal
   for apps installed outside the Play Store).
3. Open **PH Payroll** from the app drawer. Done.

> The CI build is a **debug** APK — perfect for internal company use and
> sideloading. Publishing to the Google Play Store additionally requires a
> signed **release** build and a Play Console account (see below).

---

## Building locally (optional — for developers)

Requirements: **Android Studio** (latest) or the Android SDK + JDK 17.

```bash
cd android
./gradlew assembleDebug
# APK is written to:
#   app/build/outputs/apk/debug/app-debug.apk
```

Or open the `android/` folder in Android Studio and press **Run** with a tablet
emulator or a connected device.

The web app is **not duplicated** here — the Gradle `copyWebApp` task copies
`index.html`, `assets/` and `samples/` from the repo root into the app's assets
on every build, so the Android app always matches the web app.

---

## Project layout

```
android/
  settings.gradle, build.gradle, gradle.properties   Gradle config
  gradlew, gradlew.bat, gradle/wrapper/…             Gradle wrapper (pinned 8.7)
  app/
    build.gradle                                     App module + copyWebApp task
    src/main/AndroidManifest.xml
    src/main/java/com/hdstrading/phpayroll/MainActivity.kt   WebView host + bridge
    src/main/res/…                                   Icon, theme, strings, xml rules
    src/main/assets/                                 (generated at build time)
```

## How native features are bridged

`MainActivity.kt` exposes `window.AndroidBridge` to the web app:

| Web action | Native handling |
|------------|-----------------|
| `<input type=file>` (DTR / JSON import) | `WebChromeClient.onShowFileChooser` → system file picker |
| CSV / JSON export | `AndroidBridge.saveBase64File` → saves to **Downloads** |
| Print / PDF (payslips, 201, reports) | `AndroidBridge.printHtml` → Android **PrintManager** |

The web side (`assets/js/platform.js`) detects the bridge and routes through it;
in a plain browser it falls back to normal web downloads/printing, so the same
codebase works everywhere.

---

## Publishing to Google Play (later, optional)

1. In `app/build.gradle`, add a `signingConfig` with your upload keystore and a
   `release` build type using it.
2. Build an **App Bundle**: `./gradlew bundleRelease` →
   `app/build/outputs/bundle/release/app-release.aab`.
3. Upload the `.aab` in the Google Play Console.

Ask and this can be wired up (including a CI signing step using GitHub secrets).
