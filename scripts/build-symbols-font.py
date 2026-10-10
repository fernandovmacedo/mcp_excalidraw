#!/usr/bin/env python3
"""Build assets/fonts/RenderSymbols-Regular.ttf, the headless renderer's
symbol fallback font.

Nunito and the other bundled faces lack common diagram symbols (arrows, ⚠,
fractions, geometric shapes...). Without a bundled fallback, browsers and
resvg draw them in whatever font the machine has, so the same SVG looks
different on every computer. This script subsets DejaVu Sans to a curated
list of symbols; the renderer embeds the result only when a text needs it
(see src/core/render/fonts.ts).

The Bitstream Vera licence lets modified versions be distributed only under a
name without "Bitstream" or "Vera" (and the Arev licence, without "Arev" or
"Tavmjong Bah"), so the family is renamed to "Render Symbols". Licence text
and provenance: assets/fonts/LICENSES.md.

Usage: python3 scripts/build-symbols-font.py [/path/to/DejaVuSans.ttf]
Needs fontTools (pip install fonttools). The source defaults to the Debian /
Ubuntu fonts-dejavu-core path; output was built from DejaVu Sans 2.37.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

SOURCE = Path(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
OUT = Path(__file__).resolve().parent.parent / "assets" / "fonts" / "RenderSymbols-Regular.ttf"
FAMILY = "Render Symbols"
POSTSCRIPT = "RenderSymbols-Regular"

SYMBOLS = (
    # arrows
    "←↑→↓↔↕↖↗↘↙↩↪↺↻⇐⇑⇒⇓⇔⟵⟶⟷"
    # warnings and marks
    "⚠⚡✓✔✗✘✕✖☐☑☒"
    # comparison and maths
    "≠≈≡≤≥±×÷−√∞∑∏∆∂∫∝∴∵⊂⊃⊆⊇∈∉∋∩∪∧∨¬∅"
    # fractions, super/subscripts, per mille
    "⅓⅔¼½¾⅛⅜⅝⅞⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉‰"
    # shapes
    "■□▪▫▬▭▮▯●○◉◎◦◆◇◊▲△▶▷▼▽◀◁►◄★☆♦♥♠♣"
    # gender, people, misc
    "♀♂☺☹☀☁☂☎✉✂✎♪♫"
    # punctuation that some bundled faces lack
    "·•…–—‘’“”′″§¶†‡"
    # space: resvg hides zero-width joiners as the space glyph
    " "
)


def main():
    # Keep the source's head.modified so rebuilding gives identical bytes.
    font = TTFont(SOURCE, recalcTimestamp=False)
    cmap = font.getBestCmap()
    codepoints = sorted({ord(ch) for ch in SYMBOLS if ord(ch) in cmap})
    missing = "".join(ch for ch in SYMBOLS if ord(ch) not in cmap)
    if missing:
        print(f"not in {SOURCE.name}, skipped: {missing}", file=sys.stderr)

    options = subset.Options()
    options.layout_features = []      # plain glyphs: no kerning or ligatures needed
    options.hinting = False
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    options.notdef_outline = True
    options.drop_tables += ["FFTM", "GDEF", "GPOS", "GSUB", "MATH"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)

    name = font["name"]
    version = name.getDebugName(5) or ""
    for record in list(name.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17):
            name.removeNames(nameID=record.nameID)
    name.setName(FAMILY, 1, 3, 1, 0x409)
    name.setName("Regular", 2, 3, 1, 0x409)
    name.setName(f"{POSTSCRIPT};{version}", 3, 3, 1, 0x409)
    name.setName(FAMILY, 4, 3, 1, 0x409)
    name.setName(POSTSCRIPT, 6, 3, 1, 0x409)
    name.setName(FAMILY, 16, 3, 1, 0x409)
    name.setName("Regular", 17, 3, 1, 0x409)
    # Drop Mac-platform name records so no old name survives anywhere.
    name.names = [r for r in name.names if r.platformID == 3]
    font["post"].formatType = 3.0     # no glyph names: smaller, nothing renamed to leak

    font.save(OUT)
    print(f"{OUT} ({OUT.stat().st_size} bytes, {len(codepoints)} symbols)")


if __name__ == "__main__":
    main()
