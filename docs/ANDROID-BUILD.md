# Building the Android APK / AAB

**Capacitor** wraps the working PWA in a native Android shell. This is the standard,
Google-recommended way to ship a web app as a Play Store app, and it means you keep
**one** codebase: every fix I make to the web app ships to Android on the next build.

> ⚠️ **Not built in this environment** — there is no Android SDK or Gradle here.
> Run these steps on your own machine. Budget ~30 minutes the first time.

---

## 0. Prerequisites (install once)

| Tool | Version | Link |
|---|---|---|
| Node.js | 20 LTS or newer | nodejs.org |
| Android Studio | latest | developer.android.com/studio |
| JDK | 17 | bundled with Android Studio |

Verify:
```bash
node -v      # v20.x or newer
npm -v
java -version   # 17.x
```

In Android Studio: **More Actions → SDK Manager** → *SDK Platforms* → tick
**Android 14 (API 34)**; *SDK Tools* → tick **Android SDK Build-Tools**,
**Android SDK Command-line Tools**, **Platform-Tools**.

Set `ANDROID_HOME`:
```bash
# macOS / Linux
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
# Windows (PowerShell)
setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
```

---

## 1. Create the Android wrapper

From the project root (where `index.html` lives):

```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npm install @capacitor/geolocation @capacitor/push-notifications @capacitor/camera @capacitor/preferences
```

`npx cap init` — answer the prompts:
```bash
npx cap init "Pothik" com.pothik.rider --web-dir=.
```

Then add the platform:
```bash
npx cap add android
```

---

## 2. Point Capacitor at the app

Edit `capacitor.config.json`:

```json
{
  "appId": "com.pothik.rider",
  "appName": "Pothik",
  "webDir": ".",
  "bundledWebRuntime": false,
  "android": {
    "allowMixedContent": true,
    "captureInput": true,
    "webContentsDebuggingEnabled": false
  },
  "server": {
    "androidScheme": "https",
    "hostname": "app.pothik.com.bd"
  },
  "plugins": {
    "PushNotifications": { "presentationOptions": ["badge", "sound", "alert"] }
  }
}
```

For the **driver** app, use `"appId": "com.pothik.driver"` and
`"appName": "Pothik Driver"`, and keep it in a separate folder.

---

## 3. Grant the permissions the app actually needs

Edit `android/app/src/main/AndroidManifest.xml` — inside `<manifest>`, before
`<application>`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.CALL_PHONE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

Inside `<application>`:
```xml
<uses-feature android:name="android.hardware.location.gps" android:required="true" />
```

If you are using Google Maps, add your key here:
```xml
<meta-data
    android:name="com.google.android.geo.API_KEY"
    android:value="YOUR_ANDROID_MAPS_API_KEY" />
```

**Background location** is what lets a driver keep being tracked with the screen off.
Google Play requires you to justify it during review — say plainly: *"the driver app
must report location while online so passengers can track their ride."*

---

## 4. Add Firebase push (optional but recommended)

1. Copy `google-services.json` into `android/app/`.
2. In `android/build.gradle`:
   ```gradle
   dependencies {
       classpath 'com.google.gms:google-services:4.4.0'
   }
   ```
3. In `android/app/build.gradle`, last line:
   ```gradle
   apply plugin: 'com.google.gms.google-services'
   ```

---

## 5. Sync and build

```bash
npx cap sync android
npx cap copy android
npx cap open android      # opens Android Studio
```

Or build entirely from the command line:

```bash
cd android

# Debug APK — install this on a phone to test
./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk

# Release APK (sideload / direct distribution)
./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk

# Release AAB — this is what you upload to Google Play
./gradlew bundleRelease
# → android/app/build/outputs/bundle/release/app-release.aab
```

On Windows use `gradlew.bat` instead of `./gradlew`.

---

## 6. Sign the release build

An unsigned release build will not install. Create a keystore **once** and keep it safe:

```bash
keytool -genkey -v \
  -keystore pothik-release.keystore \
  -alias pothik \
  -keyalg RSA -keysize 2048 -validity 10000
```

> 🔒 **Back this file up.** If you lose it you can never update your Play Store app.
> Never commit it to git.

Create `android/keystore.properties` (also do not commit):

```properties
storeFile=../pothik-release.keystore
storePassword=YOUR_STORE_PASSWORD
keyAlias=pothik
keyPassword=YOUR_KEY_PASSWORD
```

Wire it into `android/app/build.gradle`:

```gradle
def keystorePropsFile = rootProject.file("keystore.properties")
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) {
    keystoreProps.load(new FileInputStream(keystorePropsFile))
}

android {
    signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                storeFile file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

Rebuild:
```bash
cd android && ./gradlew clean bundleRelease
```

Verify the signature:
```bash
keytool -printcert -jarfile app/build/outputs/apk/release/app-release.apk
```

---

## 7. Install on a phone

```bash
adb devices                       # confirm the phone is listed
adb install -r app/build/outputs/apk/release/app-release.apk
```

Or just copy the APK to the phone and open it (enable *Install unknown apps* first).

---

## 8. Publishing to Google Play

1. Create a **Google Play Developer** account ($25 one-time).
2. **Create app** → name *Pothik* → category *Maps & Navigation*.
3. Upload the **`.aab`** to *Internal testing* first.
4. Complete:
   - **Data safety form** — declare location, personal info, and files collected.
   - **Privacy policy URL** — must be publicly reachable (host `privacy.html`).
   - **Content rating** questionnaire.
   - **Screenshots** — phone, min 2; the app's own screens are fine.
   - **Feature graphic** 1024×500.
   - **Background location justification** — explain the driver-tracking reason.
5. Roll out to internal testers, then production.

> First review typically takes 3–7 days, longer if background location is requested.

---

## 9. Automating it

Put this in `package.json` so you never retype the steps:

```json
{
  "scripts": {
    "android:sync": "cap sync android && cap copy android",
    "android:debug": "npm run android:sync && cd android && ./gradlew assembleDebug",
    "android:release": "npm run android:sync && cd android && ./gradlew clean bundleRelease",
    "android:open": "cap open android",
    "android:install": "cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk"
  }
}
```

Then:
```bash
npm run android:install     # build + push to the connected phone
npm run android:release     # production AAB for Play Store
```

---

## 10. Checklist before you ship

- [ ] `capacitor.config.json` `webDir` points at the folder containing `index.html`
- [ ] `appId` is unique and permanent (it can never be changed after publishing)
- [ ] All location / camera / notification permissions declared
- [ ] Google Maps key restricted to the release keystore's SHA-1
- [ ] Keystore created, backed up **outside** the repo, and git-ignored
- [ ] `keystore.properties` is git-ignored
- [ ] `google-services.json` present if using FCM
- [ ] Tested on a **real device** with GPS on, screen off, and a weak connection
- [ ] Demo auto-accept switched **OFF** in production settings
- [ ] Privacy policy URL live and reachable
- [ ] `versionCode` bumped for every upload
