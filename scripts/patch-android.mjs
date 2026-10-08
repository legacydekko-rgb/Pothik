#!/usr/bin/env node
/* ==========================================================================
   Pothik — patch the freshly generated Android project
   --------------------------------------------------------------------------
   `npx cap add android` regenerates android/ from scratch on every clean CI
   run, so hand-editing files there is pointless. This script applies the
   handful of changes we always want, right after generation:

     1. android/variables.gradle    minSdk 24 (Android 7.0+, ~97% of devices)
     2. android/app/build.gradle    versionName 1.0.<CI run>, versionCode N
     3. AndroidManifest.xml         location / camera / notification perms
     4. res/values/strings.xml      the app is called "Pothik"

   NOTE ON SIGNING: we deliberately do NOT touch Gradle's signingConfigs.
   Regex-patching a generated Gradle file is brittle and fails silently.
   Instead the workflow builds an unsigned release APK and signs it
   afterwards with `apksigner` — the Android SDK's own tool — which is both
   simpler and verifiable (`apksigner verify`).

   Every edit is idempotent: running it twice changes nothing.
   Run:  node scripts/patch-android.mjs
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ANDROID = path.join(process.cwd(), 'android');
const BUILD_NUMBER = process.env.BUILD_NUMBER || '1';

const log = (...a) => console.log('  ' + a.join(' '));

async function read(p) { return fs.readFile(p, 'utf8'); }
async function write(p, s) { await fs.writeFile(p, s, 'utf8'); }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function findFile(dir, name) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === '.gradle') continue;
      const hit = await findFile(full, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

/* --------------------------------------------------------------- 1. minSdk */
async function patchVariables(varGradle) {
  let s = await read(varGradle);
  const before = s;
  if (/minSdkVersion\s*=\s*\d+/.test(s)) {
    s = s.replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 24');
  } else if (/minSdkVersion\s+\d+/.test(s)) {
    s = s.replace(/minSdkVersion\s+\d+/, 'minSdkVersion 24');
  } else {
    s += '\next.minSdkVersion = 24\n';
  }
  if (s !== before) { await write(varGradle, s); log('minSdkVersion -> 24 (Android 7.0+)'); }
  else log('minSdkVersion already 24');
}

/* ------------------------------------------------------------ 2. version */
async function patchVersion(appGradle) {
  let s = await read(appGradle);
  const before = s;

  if (/versionCode\s+\d+/.test(s)) s = s.replace(/versionCode\s+\d+/, `versionCode ${BUILD_NUMBER}`);
  if (/versionName\s+"[^"]*"/.test(s)) s = s.replace(/versionName\s+"[^"]*"/, `versionName "1.0.${BUILD_NUMBER}"`);

  if (s !== before) { await write(appGradle, s); log(`versionName -> "1.0.${BUILD_NUMBER}", versionCode -> ${BUILD_NUMBER}`); }
  else log('version block already correct');
}

/* -------------------------------------------------------- 3. permissions */
const PERMISSIONS = [
  ['ACCESS_FINE_LOCATION', 'Precise GPS: live pickup, trip tracking and driver matching'],
  ['ACCESS_COARSE_LOCATION', 'Approximate location fallback when GPS is unavailable'],
  ['ACCESS_BACKGROUND_LOCATION', 'Keep reporting trip position while the driver app is backgrounded'],
  ['CAMERA', 'Photograph NID, driving licence and vehicle papers during onboarding'],
  ['READ_MEDIA_IMAGES', 'Attach an existing document photo (Android 13+)'],
  ['READ_EXTERNAL_STORAGE', 'Attach an existing document photo (Android 12 and older)'],
  ['POST_NOTIFICATIONS', 'Ride, arrival and payment alerts (Android 13+)'],
  ['INTERNET', 'Talk to the Pothik API'],
  ['ACCESS_NETWORK_STATE', 'Show the offline banner and queue writes when there is no signal'],
  ['VIBRATE', 'Haptic alert when a new ride request arrives'],
  ['CALL_PHONE', 'Call the passenger or driver from the trip screen'],
  ['WAKE_LOCK', 'Keep the screen awake while the driver is online']
];

async function patchManifest(manifestPath) {
  let s = await read(manifestPath);
  let added = 0;
  for (const [name, comment] of PERMISSIONS) {
    if (new RegExp(`android\\.permission\\.${name}`).test(s)) continue;
    s = s.replace('</manifest>',
      `    <!-- ${comment} -->\n    <uses-permission android:name="android.permission.${name}" />\n</manifest>`);
    added++;
  }
  if (added) { await write(manifestPath, s); log(added + ' permission(s) added to AndroidManifest.xml'); }
  else log('permissions already complete');

  /* usesCleartextTraffic: the app talks to an https:// API only. Leave it off
     (the default) so a misconfigured http:// APP_URL fails loudly instead of
     silently sending phone numbers and GPS in the clear. */
}

/* ------------------------------------------------------------- 4. app name */
async function patchLabel(stringsPath) {
  let s = await read(stringsPath);
  const next = s
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1Pothik$2')
    .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, '$1Pothik$2');
  if (next !== s) { await write(stringsPath, next); log('app label -> Pothik'); }
  else log('app label already Pothik');
}

async function main() {
  if (!(await exists(ANDROID))) {
    console.error('  ✖ android/ not found — run `npx cap add android` first.');
    process.exit(1);
  }

  const variables = await findFile(ANDROID, 'variables.gradle');
  const appGradle = path.join(ANDROID, 'app', 'build.gradle');
  const manifest = path.join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml');
  const strings = path.join(ANDROID, 'app', 'src', 'main', 'res', 'values', 'strings.xml');

  if (variables) await patchVariables(variables); else log('! variables.gradle not found (skipped minSdk)');
  if (await exists(appGradle)) await patchVersion(appGradle); else log('! app/build.gradle not found');
  if (await exists(manifest)) await patchManifest(manifest); else log('! AndroidManifest.xml not found');
  if (await exists(strings)) await patchLabel(strings); else log('! strings.xml not found');
}

main().catch((err) => { console.error(err); process.exit(1); });
