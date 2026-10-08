#!/usr/bin/env node
/* ==========================================================================
   Pothik — bundle the static site into ./www
   --------------------------------------------------------------------------
   Capacitor ships whatever is inside `webDir` (./www) into the APK. The site
   itself stays at the repo root so Cloudflare / GitHub Pages / any static
   host can serve it directly. This script copies the app into ./www. No path
   rewriting is required: Capacitor serves the bundle from the origin
   https://localhost, so `../css/tokens.css` resolves exactly as it does on
   the web.

   Run:  npm run www
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'www');

/* Everything the app needs at runtime. Adding a new top-level page or asset
   folder? Add it here — the list is explicit so stray files (docs, tools,
   .env, keystores) can never leak into the shipped APK. */
const INCLUDE = [
  'index.html',
  'login.html',
  'terms.html',
  'privacy.html',
  'manifest.webmanifest',
  'sw.js',
  'css',
  'js',
  'images',
  'app',
  'driver',
  'admin'
];

const SKIP_DIRS = new Set(['node_modules', 'www', 'docs', '.git', '.github', 'scripts', 'assets', 'android']);

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const copied = [];
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!(await exists(src))) {
      console.warn(`  ! skipped (missing): ${item}`);
      continue;
    }
    const dest = path.join(OUT, item);
    const stat = await fs.stat(src);
    if (stat.isDirectory()) await copyDir(src, dest);
    else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
    copied.push(item);
  }

  /* Note: no HTML rewriting is needed. The WebView origin is
     https://localhost, so relative paths such as ../css/tokens.css resolve
     exactly as they do on the web. The service worker registers against
     https://localhost/sw.js, fails silently, and is caught in shell.js —
     which is exactly what we want inside an installed APK (no stale cache
     fighting your next release).

     The only thing we drop is the web manifest <link>: the native shell
     already provides the icon, name and splash. */
  const pages = ['index.html', 'login.html', 'terms.html', 'privacy.html',
    'app/index.html', 'driver/index.html', 'admin/index.html'];
  let stripped = 0;
  for (const p of pages) {
    const file = path.join(OUT, p);
    if (!(await exists(file))) continue;
    const html = await fs.readFile(file, 'utf8');
    const next = html.replace(/[ \t]*<link[^>]*rel="manifest"[^>]*>\r?\n?/gi, '');
    if (next !== html) { await fs.writeFile(file, next, 'utf8'); stripped++; }
  }
  if (stripped) console.log(`  manifest link removed from ${stripped} page(s)`);
  /* (End of HTML normalisation — nothing else is rewritten.) */

  const bytes = await du(OUT);
  console.log(`\n  Pothik bundle -> www/  (${copied.length} entries, ${(bytes / 1024 / 1024).toFixed(2)} MB)\n`);
  copied.forEach((c) => console.log('    + ' + c));
  console.log('');
}

async function du(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await du(p);
    else total += (await fs.stat(p)).size;
  }
  return total;
}

main().catch((err) => { console.error(err); process.exit(1); });
