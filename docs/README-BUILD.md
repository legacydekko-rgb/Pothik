# Pothik — Build the Android app in the cloud (English)

**You do not need Android Studio, Java, or any software on your computer.**
GitHub's servers build the APK for free and hand you a downloadable file.

> 🇧🇩 বাংলা ভাষায় বিস্তারিত গাইড: **`BUILD-APK-BANGLA.md`**

---

## Files you will get

| Artifact | What to do with it |
|---|---|
| `Pothik-<sha>-release-signed.apk` | **Install this on a phone.** (Named `-unsigned` only if you skipped the keystore secrets — use the debug APK in that case.) |
| `Pothik-<sha>-release.aab` | Upload to Google Play Console. |
| `Pothik-<sha>-debug.apk` | Only appears when there is no keystore yet. Fine for testing. |

---

## Step 1 — Put the project on GitHub

```bash
cd your-project
git init
git add .
git commit -m "Pothik"
git branch -M main
git remote add origin https://github.com/YOUR-USER/pothik.git
git push -u origin main
```

Or use the browser: **New repository → uploading an existing file** and drag the
folders in. Do **not** upload `node_modules`. Make sure `.github/` goes up — that
is the build itself.

## Step 2 — Run the build

1. Repository → **Actions** tab → enable workflows if prompted.
2. Left sidebar → **Build Android App (APK + AAB)**.
3. **Run workflow ▾ → Run workflow**.
4. Wait ~8–12 min for the first run (Gradle downloads), 3–5 min after that.

Download the APK from the **Artifacts** box at the bottom of the run, or from the
**Releases** page (a permanent link you can share).

## Step 3 — Install on a phone

Transfer the APK, tap it, and when Android says *"your phone is not allowed to
install unknown apps from this source"*, choose **Settings → Allow from this
source**, then **Install**.

> That prompt is normal for **any** APK not distributed through Google Play.
> A signing certificate does not remove it — see Step 5.

---

## Step 4 — Signing certificate (do this once)

`Actions → **Generate Signing Keystore (run once)** → Run workflow`.
It generates the key on GitHub's servers and gives you three files to download:

- `pothik-keystore-info.txt` — contains your passwords
- `pothik-release.jks` — the certificate itself
- `pothik-keystore-base64.txt` — the text to paste into secrets

**Back the `.jks` up in two places immediately. Losing it means you can never
update the app under the same identity again.**

Then add four **repository secrets**
(`Settings → Secrets and variables → Actions → New repository secret`):

| Name | Value |
|---|---|
| `KEYSTORE_BASE64` | entire contents of `pothik-keystore-base64.txt` |
| `KEYSTORE_PASSWORD` | from the info file |
| `KEY_ALIAS` | from the info file (default `pothik`) |
| `KEY_PASSWORD` | from the info file |

Re-run the build. The log will say *"release build will be SIGNED and verified"*,
and the APK name will contain `signed`.

### What signing does and does not do

| ✅ It does | ❌ It does not |
|---|---|
| Proves the app is consistently from you | Remove the "unknown sources" warning |
| Lets new builds update over the old one **without wiping data** | Add the Play Store "verified" badge |
| Stops anyone republishing a modified copy as your app | Disable Play Protect scanning |
| Required to upload to Google Play | — |

**The only way to get a warning-free, trusted install is to publish on Google
Play** — upload the `.aab` the workflow already produces (one-time $25 developer
account). Everything else is sideloading, and sideloading always warns.

## Step 5 — Passenger and driver must share one URL

Camera: matching cannot work across two phones unless both apps talk to the same
live database.

1. Publish the site (Genspark **Publish** tab, GitHub Pages, Netlify, Cloudflare).
2. `Settings → Secrets and variables → Actions → **Variables**` → New variable:
   - **`APP_URL`** = `https://your-live-site.com` (must be `https://`)
3. Re-run the build.

The APK then loads your live site, so future fixes reach installed users without
rebuilding. Leave `APP_URL` unset to keep the site bundled inside the APK instead
(works offline, but each device has its own separate data).

## Demo logins

| Role | Phone | Password |
|---|---|---|
| Passenger | `01711111111` | `passenger123` |
| Driver | `01712345678` | `driver123` |
| Admin | `1700000001` | `admin1234` |

Admin console: `/admin/index.html`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Check JavaScript` step fails | A `.js` file has a syntax error. The log prints the file and line. |
| `gradlew: Permission denied` | The workflow chmods it; if it persists, re-upload the repo (line endings were changed). |
| Build runs > 30 min | Normal on the first run (Gradle download). Later runs are cached. |
| Artifacts box empty | The build failed — open the red step's log. |
| App opens to a white screen | `APP_URL` is wrong or unreachable. Delete the variable to fall back to the bundled site. |
| Installed app won't update | The new APK was signed with a different key. Uninstall, then install. Always set up signing *before* the first real install. |
| GPS not working | Enable phone Location and grant the permission when prompted. |

---

## How the pieces fit

| File | Role |
|---|---|
| `.github/workflows/android.yml` | The build: verify → bundle → native → sign → publish |
| `.github/workflows/make-keystore.yml` | Creates the signing certificate |
| `scripts/check-syntax.mjs` | Compiles every browser script; blocks bad code |
| `scripts/copy-www.mjs` | Copies the site into `www/` for Capacitor |
| `scripts/gen-icon.mjs` | `assets/icon.svg` → all Android icons + splashes |
| `scripts/patch-android.mjs` | Version, minSdk 24, permissions, app name |
| `scripts/set-app-url.mjs` | Writes `serverUrl`/`hostname` into `strings.xml` |
| `capacitor.config.json` | `appId com.pothik.ride`, `webDir www` |
