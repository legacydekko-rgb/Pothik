#!/usr/bin/env node
/* ==========================================================================
   Pothik — point the Android shell at your LIVE web deployment
   --------------------------------------------------------------------------
   Two ways to ship the app:

   A) BUNDLED  (default, nothing to configure)
      The whole site is packed into the APK (./www) and runs offline-ish.
      Use this if you have not deployed the website anywhere yet.

   B) SERVER   (recommended once the site is live)
      The APK loads the live URL, so bug fixes reach installed users without
      a new APK. Passenger and driver *must* share one URL for matching to
      work across two phones.

      Just set one GitHub secret:  APP_URL = https://your-site.example.com
      The workflow calls this script, which rewrites
      android/app/src/main/res/values/strings.xml (serverUrl / hostName).

   Run:  node scripts/set-app-url.mjs https://your-site.example.com
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const url = (process.argv[2] || '').trim();

function fail(msg) {
  console.error('\n  ✖ ' + msg + '\n');
  process.exit(1);
}

async function main() {
  if (!url || !/^https:\/\//.test(url)) {
    console.log('\n  No APP_URL set (or not https) — building the BUNDLED app from ./www.\n');
    return;
  }

  let host;
  let clean;
  try {
    const u = new URL(url);
    host = u.host;
    clean = u.origin + u.pathname.replace(/\/+$/, '') + '/';
  } catch {
    fail('APP_URL is not a valid URL: ' + url);
  }

  const stringsPath = path.join(
    process.cwd(), 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'
  );

  let xml;
  try {
    xml = await fs.readFile(stringsPath, 'utf8');
  } catch {
    fail('Could not find ' + path.relative(process.cwd(), stringsPath) +
      '\n  Run `npx cap add android` first (the workflow does this automatically).');
  }

  const setString = (src, key, value) => {
    const re = new RegExp(`(<string name="${key}">)([\\s\\S]*?)(</string>)`);
    if (re.test(src)) return src.replace(re, `$1${value}$3`);
    return src.replace('</resources>', `    <string name="${key}">${value}</string>\n</resources>`);
  };

  /* Capacitor's Android template reads these three strings. serverUrl makes
     the WebView load the remote site instead of the bundled assets; hostName
     keeps the origin stable so localStorage / sessions persist across
     restarts and app updates. */
  xml = setString(xml, 'server_url', clean);
  xml = setString(xml, 'serverUrl', clean);
  xml = setString(xml, 'hostname', host);

  await fs.writeFile(stringsPath, xml, 'utf8');
  console.log(`\n  Android shell now points at: ${clean}`);
  console.log(`  (origin ${host} — keeps logins alive across updates)\n`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
