# bilan brand assets

## Concept: Relevé

bilan turns a repository's history into figures, and a _bilan_ is the sheet
they are read from. The mark is the ledger b: a lowercase b drawn as a bar
chart. The stem is the axis every figure is measured from and takes the
ink-blue accent (`--accent`); the ink bars that come off it trace the bowl, so
the initial of the name is also a chart of the data. On the landing page the
timeline draws the same thing: the accent anchor at "ready for review" is the
stem, and the lanes' bars start from it.

Geometry (64-unit grid, two shapes, hand-written paths):

- Stem: `M15 5H23V59H15Z`, 8u wide and 54u tall.
- Bars: four 7u bars with 3u gaps, flush with the stem, 16, 26, 26 and 16u
  long: `M23 22H39V29H23ZM23 32H49V39H23ZM23 42H49V49H23ZM23 52H39V59H23Z`.
  The bowl is 37u of the 54u height (69%), close to Archivo's x-height to
  ascender ratio (526 / 723, 73%), and the last bar sits on the stem's foot,
  like a baseline.
- The glyph spans x 15 to 49 and y 5 to 59, centred on the grid. Every
  coordinate is whole, so the mark is crisp wherever a unit lands on a pixel.
- `favicon.svg`, `<BrandMark>` below 24 px and the ICO frames use separately
  drawn, pixel-snapped versions. The 16u drawing keeps the four bars: a 2 px
  stem, 2 px bars with 1 px gaps, 4 and 7 px long (`M3 1H5V15H3Z`, bars from
  y 4, 7, 10 and 13). The 16 px ICO frame drops to three bars to fit its
  tile.

Wordmark: the mark, then `bilan` in Archivo (weight 650, tracking -0.035em,
as in the site header), converted to outlines. At a font size of 100u the
mark is 88.4u tall, so its stem is 13.1u wide, the width of Archivo's `l`
stem at that weight. It stands on the baseline and rises 16.1u above the
ascenders, 30u (0.3em) from the `b`, the gap the header uses.

## Rules

- **Clear space:** on every side, at least the width of the stem (8u in the
  mark, 13.1u in the wordmark, about a seventh of the mark's height). Every
  SVG in this folder already includes it in its viewBox.
- **Minimum size:** mark 14 px tall (use `favicon.svg`, or `<BrandMark>`,
  which switches to the pixel-snapped drawing below 24 px; 14 px is that
  drawing's native size); wordmark 24 px tall, which sets the lettering about
  15 px tall.
- **Colour:** ink-blue accent on the stem, ink bars and lettering, or a single
  colour. Never swap the colours (the accent always marks the axis), never put
  the accent on the bars or the letters, and use no gradients, outlines or
  shadows. Neutral grounds only: white or `#0d0e10`, never a warm or tinted
  paper.
- **Shape:** keep the bars joined to the stem, the stem rising above them,
  and the bars' lengths short, long, long, short: that is what makes it a b.
  Equal bars, or bars set apart from the stem, read as a generic "I≡".
- **Palette:** light: ink `#111214`, ink-blue accent `#2b4fcf` on `#ffffff`.
  Dark: ink `#ececee`, ink-blue accent `#8aa4ff` on `#0d0e10`. App icons use
  the dark version on a `#0d0e10` square.
- **Contrast (WCAG):** `#2b4fcf` is 6.73:1 on `#ffffff` but only 2.87:1 on
  `#0d0e10`, so dark grounds must use `#8aa4ff` (8.12:1; it is 2.38:1 on
  white, so never the other way round). Ink `#111214` is 18.74:1
  on white; `#ececee` is 16.37:1 on `#0d0e10`.

## Files

| File                                   | Use                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mark.svg`, `mark-dark.svg`            | Symbol alone for light / dark backgrounds (docs, README, slides). 50 x 70, clear space included.                                                                |
| `wordmark.svg`, `wordmark-dark.svg`    | Mark and `bilan` for light / dark backgrounds (GitHub README, external pages). 325.83 x 114.59, clear space included.                                           |
| `../../src/components/BrandMark.astro` | In the app: the inlined mark, stem in `var(--accent)`, bars in `currentColor`. Props: `size` (stem height in px, default 20), `accent` (default true), `title`. |
| `favicon.svg`                          | Browser tab icon, 16u pixel-snapped; follows the OS colour scheme.                                                                                              |
| `favicon.ico`                          | Legacy fallback: 16, 32 and 48 px frames on a `#0d0e10` rounded tile, each drawn on its own pixel grid.                                                         |
| `favicon-32.png`                       | PNG fallback for tools that do not read ICO or SVG; the ICO's 32 px frame.                                                                                      |
| `apple-touch-icon.png`                 | 180 x 180, full-bleed `#0d0e10` square (iOS rounds the corners).                                                                                                |
| `icon-192.png`, `icon-512.png`         | Web app manifest icons, full bleed; the glyph is half the square's height and sits inside the maskable safe zone.                                               |
| `logo.png`                             | 1024 x 1024 avatar (GitHub, npm, social profiles).                                                                                                              |
| `og.png`                               | 1200 x 630 social card on white, set in Archivo: label, the wordmark, "The pulse of a GitHub repository.", the double rule.                                     |
| `site.webmanifest`                     | Web app manifest.                                                                                                                                               |

## Head tags

Put these in `src/layouts/Base.astro`. `og:image` must be absolute, so build
it from the request URL (the app sets no `site`):

```astro
---
const ogImage = new URL('/brand/og.png', Astro.url).href;
---
<link rel="icon" href="/brand/favicon.ico" sizes="32x32" />
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
<link rel="manifest" href="/brand/site.webmanifest" />
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d0e10" />
<meta property="og:site_name" content="bilan" />
<meta property="og:title" content={title} />
<meta property="og:image" content={ogImage} />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="bilan: the pulse of a GitHub repository" />
<meta name="twitter:card" content="summary_large_image" />
```

The ICO keeps `sizes="32x32"` (not `any`) so browsers that read SVG still
prefer `favicon.svg`. `theme-color` follows the OS scheme; if the page's
`data-theme` overrides it, update the matching tag from the theme script. The
colours are the page backgrounds, white and `#0d0e10`.

Header usage:

```astro
<a class="wordmark" href="/"><BrandMark size={18} />bilan</a>
```

with `display: inline-flex; align-items: baseline; gap: 0.3em` on the link,
so the mark stands on the baseline like a letter (the header adds
`flex-wrap: wrap; align-content: center` to centre that line in its height).
To set the full lockup outside the app, use `wordmark.svg`.

## How these were made

Paths are hand-computed. `bilan` was outlined from
`@fontsource-variable/archivo` with `fontkit` (after `wawoff2` decompressed
the WOFF2), the rasters were rendered from SVG with `sharp` (already in the
lockfile), the ICO's 32-bit BMP frames were packed by a short script, and
`og.png` was rendered from HTML with headless Chrome, in the site's fonts.
That tooling ran from a scratch directory and is not a dependency of this
package.
