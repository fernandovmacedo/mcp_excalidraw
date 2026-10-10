import { fontFilePath, getFontEntryByFamilyName, getFontEntry, DEFAULT_FONT_FAMILY, SYMBOLS_FONT_FILE } from './fonts.js';
import { tableForFile } from './ttf.js';

// Text measurement for the headless renderer. jsdom has no canvas, so
// Excalidraw's measureText (used to size and wrap labels) would otherwise get
// a guess. Instead we read real glyph advance widths from the bundled TTFs
// (cmap + hmtx tables, see ttf.ts), so label wrapping and arrow-label masks match what a
// browser computes with the same fonts.

// Parse a CSS font shorthand as Excalidraw writes it, e.g.
// "20px Excalifont, Xiaolai, Segoe UI Emoji".
function parseFont(font: string): { size: number; family: string } {
  const match = font.match(/([\d.]+)px\s+(.+)$/);
  const size = match ? Number(match[1]) : 16;
  const first = (match?.[2] ?? '').split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { size: Number.isFinite(size) ? size : 16, family: first };
}

// Width in px of `text` (a single line) rendered in `font`.
export function measureTextWidth(text: string, font: string): number {
  const { size, family } = parseFont(font);
  const entry = getFontEntryByFamilyName(family) ?? getFontEntry(DEFAULT_FONT_FAMILY);
  const table = tableForFile(fontFilePath(entry));
  const symbols = tableForFile(SYMBOLS_FONT_FILE);
  let units = 0;
  let fallbackEm = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const advance = table?.advance(cp);
    const symbolAdvance = advance === undefined ? symbols?.advance(cp) : undefined;
    if (advance !== undefined && table) {
      units += advance / table.unitsPerEm;
    } else if (symbolAdvance !== undefined && symbols) {
      // The renderer embeds the symbol font as this text's fallback.
      units += symbolAdvance / symbols.unitsPerEm;
    } else {
      // Not in the bundled fonts (CJK, emoji, ...): the browser would fall back
      // to another face; full-width scripts are ~1em, everything else ~0.6em.
      fallbackEm += cp >= 0x1100 ? 1 : 0.6;
    }
  }
  return (units + fallbackEm) * size;
}
