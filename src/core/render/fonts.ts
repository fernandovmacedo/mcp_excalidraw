import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeFontFamily } from '../../types.js';
import { tableForFile } from './ttf.js';

// Font registry for the headless renderer.
//
// Excalidraw identifies fonts by numeric family id and positions text using
// per-family metrics (unitsPerEm/ascender/descender/lineHeight). The values
// below are Excalidraw 0.18's own registry so headless text lands where the
// canvas puts it. Glyphs come from the TTFs in assets/fonts (built by
// scripts/build-fonts.mjs); families we do not bundle map onto the closest
// bundled face and report a warning.

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineHeight: number;
}

export interface FontEntry {
  id: number;
  // The name Excalidraw writes into `font-family` (and getFontFamilyString).
  family: string;
  // The family name inside the TTF we render with. resvg matches on this, so
  // Excalidraw's "Cascadia" must become "Cascadia Code", "Helvetica" becomes
  // "Liberation Sans" (Excalidraw makes the same substitution server-side).
  renderFamily: string;
  file: string;
  metrics: FontMetrics;
  // Set when the glyphs are a stand-in for a family we do not bundle.
  substituted?: boolean;
}

// dist/core/render/fonts.js -> <package root>/assets/fonts
const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));

const EXCALIFONT = 'Excalifont-Regular.ttf';
const VIRGIL = 'Virgil-Regular.ttf';
const NUNITO = 'Nunito-Regular.ttf';
const CASCADIA = 'CascadiaCode-Regular.ttf';
const LIBERATION = 'LiberationSans-Regular.ttf';

// Symbol fallback: a DejaVu Sans subset (arrows, ⚠, fractions, shapes...)
// built by scripts/build-symbols-font.py. Nunito and the other faces lack
// these glyphs, so without it each machine draws them in its own fonts.
export const SYMBOLS_FAMILY = 'Render Symbols';
export const SYMBOLS_FONT_FILE = path.join(FONTS_DIR, 'RenderSymbols-Regular.ttf');

const HAND_DRAWN_METRICS: FontMetrics = { unitsPerEm: 1000, ascender: 886, descender: -374, lineHeight: 1.25 };

export const DEFAULT_FONT_FAMILY = 5; // Excalifont, Excalidraw's default

const REGISTRY: Record<number, FontEntry> = {
  1: { id: 1, family: 'Virgil', renderFamily: 'Virgil', file: VIRGIL, metrics: HAND_DRAWN_METRICS },
  2: { id: 2, family: 'Helvetica', renderFamily: 'Liberation Sans', file: LIBERATION,
       metrics: { unitsPerEm: 2048, ascender: 1577, descender: -471, lineHeight: 1.15 } },
  3: { id: 3, family: 'Cascadia', renderFamily: 'Cascadia Code', file: CASCADIA,
       metrics: { unitsPerEm: 2048, ascender: 1900, descender: -480, lineHeight: 1.2 } },
  5: { id: 5, family: 'Excalifont', renderFamily: 'Excalifont', file: EXCALIFONT, metrics: HAND_DRAWN_METRICS },
  6: { id: 6, family: 'Nunito', renderFamily: 'Nunito', file: NUNITO,
       metrics: { unitsPerEm: 1000, ascender: 1011, descender: -353, lineHeight: 1.35 } },
  7: { id: 7, family: 'Lilita One', renderFamily: 'Liberation Sans', file: LIBERATION, substituted: true,
       metrics: { unitsPerEm: 1000, ascender: 923, descender: -220, lineHeight: 1.15 } },
  8: { id: 8, family: 'Comic Shanns', renderFamily: 'Cascadia Code', file: CASCADIA, substituted: true,
       metrics: { unitsPerEm: 1000, ascender: 750, descender: -250, lineHeight: 1.25 } },
  9: { id: 9, family: 'Liberation Sans', renderFamily: 'Liberation Sans', file: LIBERATION,
       metrics: { unitsPerEm: 2048, ascender: 1854, descender: -434, lineHeight: 1.15 } }
};

export function getFontEntry(fontFamily: number | string | undefined): FontEntry {
  const id = normalizeFontFamily(fontFamily) ?? DEFAULT_FONT_FAMILY;
  return REGISTRY[id] ?? REGISTRY[DEFAULT_FONT_FAMILY]!;
}

// Families as they appear in `font-family` attributes of exporter output
// (which also includes labels the exporter synthesizes, like frame names).
export function getFontEntryByFamilyName(family: string): FontEntry | undefined {
  return Object.values(REGISTRY).find(entry => entry.family === family);
}

export function collectFontEntriesFromSvg(svg: string): FontEntry[] {
  const seen = new Map<number, FontEntry>();
  for (const match of svg.matchAll(/font-family="([^",]+)/g)) {
    const entry = getFontEntryByFamilyName((match[1] ?? '').trim());
    if (entry) seen.set(entry.id, entry);
  }
  if (seen.size === 0) seen.set(DEFAULT_FONT_FAMILY, REGISTRY[DEFAULT_FONT_FAMILY]!);
  return [...seen.values()];
}

export function fontFilePath(entry: FontEntry): string {
  return path.join(FONTS_DIR, entry.file);
}

// Excalidraw: lineHeight is a unitless multiplier of fontSize.
export function getLineHeightInPx(fontSize: number, lineHeight: number): number {
  return fontSize * lineHeight;
}

// Distance from the top of a line box to its alphabetic baseline — the `y`
// Excalidraw gives each <text> line. Ported from Excalidraw's Fonts.ts.
export function getVerticalOffset(fontFamily: number | string | undefined, fontSize: number, lineHeightPx: number): number {
  const { unitsPerEm, ascender, descender } = getFontEntry(fontFamily).metrics;
  const fontSizeEm = fontSize / unitsPerEm;
  const lineGap = (lineHeightPx - fontSizeEm * ascender + fontSizeEm * descender) / 2;
  return fontSizeEm * ascender + lineGap;
}

// Collect the families a scene's text uses so we only load/embed those fonts.
export function collectFontEntries(elements: ReadonlyArray<{ type?: string; fontFamily?: number | string }>): FontEntry[] {
  const seen = new Map<number, FontEntry>();
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const entry = getFontEntry(el.fontFamily);
    seen.set(entry.id, entry);
  }
  if (seen.size === 0) seen.set(DEFAULT_FONT_FAMILY, REGISTRY[DEFAULT_FONT_FAMILY]!);
  return [...seen.values()];
}

// Unique TTF paths for resvg's `font.fontFiles`.
export function fontFilesFor(entries: FontEntry[]): string[] {
  return [...new Set(entries.map(fontFilePath))];
}

// Rewrite Excalidraw family names to the names inside our TTFs. Applied to the
// whole SVG text (attribute values only), so it works for both the Excalidraw
// exporter's output and our own.
export function rewriteFontFamilies(svg: string, entries: FontEntry[]): string {
  let out = svg;
  for (const entry of entries) {
    if (entry.family === entry.renderFamily) continue;
    const pattern = new RegExp(`(font-family=["'])${escapeRegExp(entry.family)}(?=[,"'])`, 'g');
    out = out.replace(pattern, `$1${entry.renderFamily}`);
  }
  return out;
}

const base64Cache = new Map<string, string>();
function fontBase64(file: string): string {
  let cached = base64Cache.get(file);
  if (!cached) {
    cached = fs.readFileSync(file).toString('base64');
    base64Cache.set(file, cached);
  }
  return cached;
}

// @font-face rules embedding the used TTFs so the SVG renders with the right
// glyphs anywhere (browsers, editors, GitHub), like the tab's export does.
export function fontFaceCss(entries: FontEntry[]): string {
  const byRenderFamily = new Map<string, FontEntry>();
  for (const entry of entries) byRenderFamily.set(entry.renderFamily, entry);
  return [...byRenderFamily.values()]
    .map(entry => `@font-face { font-family: "${entry.renderFamily}"; src: url(data:font/ttf;base64,${fontBase64(fontFilePath(entry))}) format("truetype"); }`)
    .join('\n');
}

function covers(file: string, codePoint: number): boolean {
  return tableForFile(file)?.advance(codePoint) !== undefined;
}

export function symbolsFontCovers(codePoint: number): boolean {
  return covers(SYMBOLS_FONT_FILE, codePoint);
}

const TEXT_ELEMENT = /(<text\b[^>]*?\sfont-family="([^",]+)[^>]*>)([^<]*)(<\/text>)/g;

function lineNeedsSymbols(family: string, content: string): boolean {
  const entry = getFontEntryByFamilyName(family.trim()) ?? REGISTRY[DEFAULT_FONT_FAMILY]!;
  const file = fontFilePath(entry);
  for (const ch of content) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!covers(file, cp) && symbolsFontCovers(cp)) return true;
  }
  return false;
}

// True when some <text> holds a character its own font lacks and the symbol
// font has. Run on the exporter's SVG before rewriteFontFamilies, while
// font-family still carries Excalidraw's family names.
export function needsSymbolsFont(svg: string): boolean {
  for (const match of svg.matchAll(TEXT_ELEMENT)) {
    if (lineNeedsSymbols(match[2] ?? '', match[3] ?? '')) return true;
  }
  return false;
}

// PNG only. resvg falls back to another font by shaping the whole line with
// it and copying glyphs over index by index, and gives up when the two
// shapings differ in glyph count. Ligatures in the primary font (Nunito's
// "fi", Excalifont's) make them differ, and the symbol then draws as a box.
// A zero-width non-joiner between characters stops ligatures, so both
// shapings yield one glyph per character (the joiner itself becomes a hidden
// space glyph, which is why the symbol font carries U+0020). Applied only to
// lines that need the symbol font; same rules as needsSymbolsFont.
export function breakLigaturesForSymbols(svg: string): string {
  return svg.replace(TEXT_ELEMENT, (whole, open: string, family: string, content: string, close: string) => {
    if (!lineNeedsSymbols(family, content)) return whole;
    const units = content.match(/&[^;\s]+;|[\s\S]/gu) ?? [];
    return `${open}${units.join('\u200C')}${close}`;
  });
}

// List the symbol font right after each primary family, so browsers and
// resvg fall back to it glyph by glyph before any machine font.
export function addSymbolsFamily(svg: string): string {
  return svg.replace(/(font-family=")([^",]+)(?=[,"])/g, (_m, attr: string, family: string) => `${attr}${family}, ${SYMBOLS_FAMILY}`);
}

export function symbolsFontFaceCss(): string {
  return `@font-face { font-family: "${SYMBOLS_FAMILY}"; src: url(data:font/ttf;base64,${fontBase64(SYMBOLS_FONT_FILE)}) format("truetype"); }`;
}

// Bundled fonts cover Latin scripts, plus the symbol font's characters. For CJK and other scripts resvg needs
// the machine's own fonts, at the cost of cross-machine determinism.
export function needsSystemFonts(elements: ReadonlyArray<{ type?: string; text?: string }>): boolean {
  for (const el of elements) {
    if (el.type !== 'text' || typeof el.text !== 'string') continue;
    for (const ch of el.text) {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0x024f && !(code >= 0x2000 && code <= 0x206f) && !symbolsFontCovers(code)) return true;
    }
  }
  return false;
}

export function substitutedFamilies(entries: FontEntry[]): string[] {
  return entries.filter(e => e.substituted).map(e => `${e.family} rendered with ${e.renderFamily}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
