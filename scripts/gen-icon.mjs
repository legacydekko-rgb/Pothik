#!/usr/bin/env node
/* ==========================================================================
   Pothik — generate every Android icon + splash image from one SVG
   --------------------------------------------------------------------------
   Source of truth:  assets/icon.svg   (512x512, brand gradient + প glyph)

   Produces everything @capacitor/assets needs:
     assets/icon-only.png          1024x1024  (legacy launcher)
     assets/icon-foreground.png    1024x1024  (adaptive, 66% safe zone)
     assets/icon-background.png    1024x1024  (solid brand colour)
     assets/splash.png             2732x2732  (logo centred on brand colour)
     assets/splash-dark.png        2732x2732  (dark theme variant)

   Run:  npm run icon
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const ASSETS = path.join(ROOT, 'assets');
const ICON_SVG = path.join(ASSETS, 'icon.svg');

const BRAND = { r: 10, g: 124, b: 90, alpha: 1 };       // #0A7C5A
const BRAND_DARK = { r: 6, g: 74, b: 54, alpha: 1 };    // #064A36

async function main() {
  if (!(await exists(ICON_SVG))) {
    console.error('assets/icon.svg is missing — cannot generate icons.');
    process.exit(1);
  }
  const svg = await fs.readFile(ICON_SVG);

  /* ---- 1. Legacy launcher icon (already has its own background) ---- */
  await sharp(svg, { density: 512 })
    .resize(1024, 1024, { fit: 'contain', background: { ...BRAND, alpha: 0 } })
    .png()
    .toFile(path.join(ASSETS, 'icon-only.png'));

  /* ---- 2. Adaptive foreground: glyph only, inside the 66% safe circle --- */
  const inner = await sharp(svg, { density: 512 })
    .resize(676, 676, { fit: 'contain', background: { ...BRAND, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{ input: inner, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'icon-foreground.png'));

  /* ---- 3. Adaptive background: solid brand ---- */
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BRAND } })
    .png()
    .toFile(path.join(ASSETS, 'icon-background.png'));

  /* ---- 4. Splash screens: brand field with a centred logo ---- */
  const splashLogo = await sharp(svg, { density: 512 })
    .resize(512, 512, { fit: 'contain', background: { ...BRAND, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BRAND } })
    .composite([{ input: splashLogo, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'splash.png'));

  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BRAND_DARK } })
    .composite([{ input: splashLogo, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'splash-dark.png'));

  console.log('  assets/icon.svg -> icon-only, icon-foreground, icon-background, splash, splash-dark');
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

main().catch((err) => { console.error(err); process.exit(1); });
