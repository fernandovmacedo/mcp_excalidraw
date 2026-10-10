import fs from 'fs';

// Minimal TrueType reader for the headless renderer: which code points a
// bundled TTF covers and their advance widths (cmap + hmtx tables). Shared by
// text measurement (text-metrics.ts) and the symbol-font fallback (fonts.ts).

export interface FontMetricsTable {
  unitsPerEm: number;
  advance: (codePoint: number) => number | undefined;
}

const tables = new Map<string, FontMetricsTable | null>();

function parseTtf(buffer: Buffer): FontMetricsTable {
  const numTables = buffer.readUInt16BE(4);
  const dir = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    dir.set(buffer.toString('latin1', rec, rec + 4), buffer.readUInt32BE(rec + 8));
  }
  const head = dir.get('head');
  const hhea = dir.get('hhea');
  const hmtx = dir.get('hmtx');
  const cmap = dir.get('cmap');
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) {
    throw new Error('TTF is missing head/hhea/hmtx/cmap');
  }
  const unitsPerEm = buffer.readUInt16BE(head + 18);
  const numHMetrics = buffer.readUInt16BE(hhea + 34);
  const advanceOfGlyph = (glyph: number): number => {
    const index = Math.min(glyph, numHMetrics - 1);
    return buffer.readUInt16BE(hmtx + index * 4);
  };

  // Prefer a full-Unicode subtable (format 12), else the BMP one (format 4).
  const subtables = buffer.readUInt16BE(cmap + 2);
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; i < subtables; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buffer.readUInt16BE(rec);
    const encoding = buffer.readUInt16BE(rec + 2);
    const offset = cmap + buffer.readUInt32BE(rec + 4);
    const format = buffer.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 = offset;
    if (format === 4 && format4 === -1) format4 = offset;
  }

  const glyphCache = new Map<number, number>();
  const glyphFor = (cp: number): number => {
    const cached = glyphCache.get(cp);
    if (cached !== undefined) return cached;
    let glyph = 0;
    if (format12 !== -1) {
      const groups = buffer.readUInt32BE(format12 + 12);
      for (let g = 0; g < groups; g++) {
        const rec = format12 + 16 + g * 12;
        const start = buffer.readUInt32BE(rec);
        const end = buffer.readUInt32BE(rec + 4);
        if (cp >= start && cp <= end) { glyph = buffer.readUInt32BE(rec + 8) + (cp - start); break; }
      }
    } else if (format4 !== -1 && cp <= 0xffff) {
      const segX2 = buffer.readUInt16BE(format4 + 6);
      const ends = format4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        if (cp > buffer.readUInt16BE(ends + s)) continue;
        const start = buffer.readUInt16BE(starts + s);
        if (cp < start) break;
        const delta = buffer.readInt16BE(deltas + s);
        const rangeOffset = buffer.readUInt16BE(rangeOffsets + s);
        if (rangeOffset === 0) {
          glyph = (cp + delta) & 0xffff;
        } else {
          const at = rangeOffsets + s + rangeOffset + (cp - start) * 2;
          const raw = buffer.readUInt16BE(at);
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        break;
      }
    }
    glyphCache.set(cp, glyph);
    return glyph;
  };

  return {
    unitsPerEm,
    advance: (cp: number) => {
      const glyph = glyphFor(cp);
      return glyph === 0 ? undefined : advanceOfGlyph(glyph);
    }
  };
}

export function tableForFile(file: string): FontMetricsTable | null {
  if (!tables.has(file)) {
    try {
      tables.set(file, parseTtf(fs.readFileSync(file)));
    } catch {
      tables.set(file, null);
    }
  }
  return tables.get(file) ?? null;
}
