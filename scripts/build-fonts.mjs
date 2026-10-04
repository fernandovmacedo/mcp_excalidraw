#!/usr/bin/env node
// Build the TTF fonts used by the headless renderer (assets/fonts/*.ttf).
//
// Why TTF: resvg (our SVG -> PNG rasterizer) loads TTF/OTF through
// `font.fontFiles` and silently ignores WOFF2, and it does not read
// `@font-face` from the SVG either. Excalidraw ships its fonts as WOFF2 only,
// so we decompress them once here and commit the result — this script is a
// dev-time tool, not part of `npm run build`.
//
// Sources:
//   Virgil, Cascadia Code, Liberation Sans — single-file WOFF2s shipped inside
//     @excalidraw/excalidraw (dist/prod/fonts).
//   Excalifont — the package only ships unicode-range subsets, so the full
//     file comes from Excalidraw's own CDN (or --excalifont <path>).
//   Nunito — also only subsets in the package; the full static Regular TTF
//     comes from Google Fonts.
// All five are SIL OFL 1.1; see assets/fonts/LICENSES.md.
//
// Usage: node scripts/build-fonts.mjs [--excalifont /path/to/Excalifont-Regular.woff2]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wawoff2 = require('wawoff2');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgFonts = path.join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const outDir = path.join(root, 'assets/fonts');
const EXCALIFONT_CDN = 'https://excalidraw.nyc3.cdn.digitaloceanspaces.com/fonts/Excalifont-Regular.woff2';
const NUNITO_CSS = 'https://fonts.googleapis.com/css2?family=Nunito:wght@400';

const args = process.argv.slice(2);
const flagIdx = args.indexOf('--excalifont');
const excalifontOverride = flagIdx !== -1 ? args[flagIdx + 1] : undefined;

async function excalifontSource() {
  if (excalifontOverride) return fs.readFileSync(path.resolve(excalifontOverride));
  const cached = path.join(os.tmpdir(), 'Excalifont-Regular.woff2');
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  process.stderr.write(`Downloading ${EXCALIFONT_CDN}\n`);
  const res = await fetch(EXCALIFONT_CDN);
  if (!res.ok) throw new Error(`Excalifont download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cached, buf);
  return buf;
}

// Google Fonts' CSS API serves a static TTF to clients without a browser UA.
async function nunitoSource() {
  const css = await (await fetch(NUNITO_CSS)).text();
  const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
  if (!url) throw new Error('Nunito: no TTF URL in Google Fonts CSS');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nunito download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

const sources = [
  { out: 'Excalifont-Regular.ttf', read: excalifontSource },
  { out: 'Virgil-Regular.ttf', read: () => fs.readFileSync(path.join(pkgFonts, 'Virgil/Virgil-Regular.woff2')) },
  { out: 'CascadiaCode-Regular.ttf', read: () => fs.readFileSync(path.join(pkgFonts, 'Cascadia/CascadiaCode-Regular.woff2')) },
  { out: 'LiberationSans-Regular.ttf', read: () => fs.readFileSync(path.join(pkgFonts, 'Liberation/LiberationSans-Regular.woff2')) },
  { out: 'Nunito-Regular.ttf', read: nunitoSource, ttf: true }
];

fs.mkdirSync(outDir, { recursive: true });
for (const { out, read, ttf: isTtf } of sources) {
  const data = await read();
  if (isTtf) {
    fs.writeFileSync(path.join(outDir, out), data);
    process.stderr.write(`${out}: ${data.length} bytes\n`);
    continue;
  }
  if (data.subarray(0, 4).toString('latin1') !== 'wOF2') {
    throw new Error(`${out}: source is not a WOFF2 file`);
  }
  const ttf = Buffer.from(await wawoff2.decompress(data));
  fs.writeFileSync(path.join(outDir, out), ttf);
  process.stderr.write(`${out}: ${data.length} -> ${ttf.length} bytes\n`);
}
process.stderr.write(`Fonts written to ${outDir}\n`);
