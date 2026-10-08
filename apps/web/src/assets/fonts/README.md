# Fonts

Two files, both preloaded by Base.astro and declared in `src/styles/fonts.css`, 34,408 B together against the
75 KB font budget (plan 4.6):

| File | Source | Axis | Characters |
| --- | --- | --- | --- |
| `inter-latin-wght-400-600.woff2` (19,856 B) | `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2` | `wght` 400 to 600 | U+0020-007E, U+00A0, U+00A9, U+00B7, U+2018-2019, U+201C-201D |
| `marcellus-latin-400.woff2` (14,552 B) | `@fontsource/marcellus/files/marcellus-latin-400-normal.woff2` 5.3.0 | static 400 | the fontsource latin subset, as published |

Inter is the site's own subset of the fontsource variable font: the weight axis is pinned to the range the
stylesheets use and the glyphs are cut to basic Latin plus the marks the pages contain (the middle dot, the
copyright sign and the curly quotes). Marcellus (OFL-1.1) is copied as it is; a fontTools subset to the same
range would save an estimated 4 to 5 KB and is optional. There is no mono web font: code uses the system
`ui-monospace` stack.

`fonts.css` also declares `Marcellus Fallback`, Georgia with `size-adjust: 92.4%`, `ascent-override: 105.4%` and
`descent-override: 30.3%`, computed from the Marcellus hhea metrics (0.9741 / -0.2798) and the widths of
"WE MAKE SYNTHETIC BEINGS." in both faces (14.9985em against 13.8623em), so the swap moves nothing.

To rebuild the Inter subset, use fontTools 4.60 with brotli in a throwaway Python environment (nothing here is a
project dependency), from the repository root:

```
python -m venv fontenv
fontenv/Scripts/pip install "fonttools[woff]==4.60.1"
fontenv/Scripts/python subset.py
```

where `subset.py` is:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

UNICODES = "U+0020-007E,U+00A0,U+00A9,U+00B7,U+2018,U+2019,U+201C,U+201D"
JOBS = [
    ("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", (400, 600),
     "apps/web/src/assets/fonts/inter-latin-wght-400-600.woff2"),
]
for src, (lo, hi), dst in JOBS:
    font = instancer.instantiateVariableFont(TTFont(src), {"wght": (lo, hi)}, inplace=False, updateFontNames=False)
    # fontsource's subset files carry gvar entries only for glyphs with deltas; the subsetter expects one per glyph.
    gvar = font["gvar"]
    gvar.variations = {g: (gvar.variations[g] if g in gvar.variations else []) for g in font.getGlyphOrder()}
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.recalc_average_width = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(dst)
```

If a page ever needs a character outside the Inter range, add it to `UNICODES` here and to the `unicode-range` in
fonts.css, then rebuild. A missing character falls back to the system font for that glyph only.
