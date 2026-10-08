#!/usr/bin/env node
/* ==========================================================================
   Pothik — compile every browser script before we build anything
   --------------------------------------------------------------------------
   A single invalid statement in one .js file makes the whole page die with
   "Unexpected identifier" and *nothing else* — no build error, no obvious
   trace. node:vm compiles a file the same way a browser does (including
   'use strict' directives), so this catches those mistakes in ~50 ms.

   Run:  npm run check
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOTS = ['js', 'sw.js'];
const SKIP = new Set(['node_modules', 'www', 'dist', 'build', '.git']);

async function walk(target, out) {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    if (target.endsWith('.js')) out.push(target);
    return out;
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    await walk(path.join(target, e.name), out);
  }
  return out;
}

async function main() {
  const files = [];
  for (const r of ROOTS) {
    try { await walk(r, files); } catch { /* optional */ }
  }

  let failed = 0;
  for (const file of files.sort()) {
    const src = await fs.readFile(file, 'utf8');
    try {
      // Compile only — never execute. Browser globals are irrelevant here.
      new vm.Script(src, { filename: file });
      console.log('  ✓ ' + file);
    } catch (err) {
      failed++;
      const line = err.stack && /\bvm\.js|evalmachine/.test(err.stack)
        ? extractLine(err)
        : null;
      console.error('  ✖ ' + file + '  ->  ' + err.message + (line ? '  (line ' + line + ')' : ''));
    }
  }

  console.log('');
  if (failed) {
    console.error(`  ${failed} file(s) failed to compile — fix these before building.\n`);
    process.exit(1);
  }
  console.log(`  All ${files.length} scripts compiled cleanly.\n`);
}

function extractLine(err) {
  const m = /:(\d+)\s*$/.exec(String(err.stack).split('\n')[1] || '');
  return m ? m[1] : null;
}

main().catch((err) => { console.error(err); process.exit(1); });
