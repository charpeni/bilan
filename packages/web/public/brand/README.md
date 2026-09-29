# bilan brand assets

## Concept: Intervalle

bilan is the pulse of a GitHub repository, and a pulse is always read over a
window of time: who contributed, what moved, how reviews flowed, where work
waited. The mark is that window written as a half-open interval, **[start,
now)**: an ink-blue square bracket (the accent, `--accent`) closes the start,
because the window begins at a fixed point, and an ink parenthesis leaves the
end open, because the story is still going. Developers already read ranges
this way (Python's `range`, Rust's `a..b`, SQL windows). The lockup puts the
name inside the window: **[bilan)**.

Geometry (64-unit grid, two shapes, hand-written paths):

- Bracket: one polygon, `M8 10H24V18H16V46H24V54H8Z`: stem 8u, arms 16 x 8u,
  44u tall. Every coordinate is even, so it is crisp at 32 px.
- Parenthesis: one cubic stroke, `M41 12.94C54 19.94 54 44.06 41 51.06`,
  8.5u wide (6% heavier than the stem so the curve reads at the same weight),
  butt caps. The ends are inset so the cap tips overshoot the bracket by 0.8u,
  the usual optical overshoot for a curve against a flat.
- The bracket carries more ink on purpose: it holds the accent and the meaning.
- `favicon.svg` and the ICO frames use separately drawn, pixel-snapped
  versions: a whole-pixel bracket (2 px stem and arms) and a 2.1 px
  parenthesis.

Wordmark: `bilan` in Newsreader (weight 560, optical size 48, tracking
-0.01em, the concept's display face), converted to outlines. The bracket and
parenthesis are redrawn at text scale: stem 12.5u against Newsreader's 12.2u
`l` stem, from 7u above the ascender to 16u below the baseline, 7u from the
arm tips to the `b` and 9u from the `n` to the parenthesis.

## Rules

- **Clear space:** on every side, at least the width of the bracket's stem
  (8u in the mark, 12.5u in the wordmark, about a fifth of the mark's
  height). Every SVG in this folder already includes it in its viewBox.
- **Minimum size:** mark 12 px tall (use `favicon.svg`, or `<BrandMark>`, which
  switches to the pixel-snapped drawing below 24 px); wordmark lettering 14
  px tall, which is the SVG rendered at about 24 px tall (60 px wide).
- **Colour:** ink-blue accent on the bracket, ink parenthesis and lettering, or a single
  colour. Never swap the colours (the accent always marks the start), never
  put the accent on the parenthesis or the letters, and use no gradients,
  outlines or shadows. Neutral grounds only: white or `#0d0e10`, never a warm
  or tinted paper.
- **Palette:** light: ink `#111214`, ink-blue accent `#2b4fcf` on `#ffffff`.
  Dark: ink `#ececee`, ink-blue accent `#8aa4ff` on `#0d0e10`. App icons use the dark
  version on a `#0d0e10` square.
- **Contrast (WCAG):** `#2b4fcf` is 6.73:1 on `#ffffff` but only 2.87:1 on
  `#0d0e10`, so dark grounds must use `#8aa4ff` (8.12:1; it is 2.38:1 on
  white, so never the other way round). Ink `#111214` is 18.74:1
  on white; `#ececee` is 16.37:1 on `#0d0e10`.

## Files

| File                                   | Use                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mark.svg`, `mark-dark.svg`            | Symbol alone for light / dark backgrounds (docs, README, slides). 63 x 61.7, clear space included.                                                                           |
| `wordmark.svg`, `wordmark-dark.svg`    | `[bilan)` for light / dark backgrounds (GitHub README, external pages). 310.9 x 123.4, clear space included.                                                                 |
| `../../src/components/BrandMark.astro` | In the app: the inlined mark, bracket in `var(--accent)`, parenthesis in `currentColor`. Props: `size` (bracket height in px, default 20), `accent` (default true), `title`. |
| `favicon.svg`                          | Browser tab icon, 16u pixel-snapped; follows the OS colour scheme.                                                                                                           |
| `favicon.ico`                          | Legacy fallback: 16, 32 and 48 px frames on a `#0d0e10` rounded tile.                                                                                                        |
| `favicon-32.png`                       | PNG fallback for tools that do not read ICO or SVG.                                                                                                                          |
| `apple-touch-icon.png`                 | 180 x 180, full-bleed `#0d0e10` square (iOS rounds the corners).                                                                                                             |
| `icon-192.png`, `icon-512.png`         | Web app manifest icons, full bleed; the glyph sits inside the maskable safe zone.                                                                                            |
| `logo.png`                             | 1024 x 1024 avatar (GitHub, npm, social profiles).                                                                                                                           |
| `og.png`                               | 1200 x 630 social card on white: label, `[bilan)`, "The pulse of a GitHub repository.", the double rule.                                                                     |
| `site.webmanifest`                     | Web app manifest.                                                                                                                                                            |

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
<meta property="og:image:alt" content="[bilan): the pulse of a GitHub repository" />
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

with `display: inline-flex; align-items: center; gap: 0.35em` on the link. To
set the full lockup as live text instead, write `[bilan)` with the bracket in
`var(--accent)`, or use `wordmark.svg`.

## How these were made

Paths are hand-computed; rasters were rendered from the SVGs with `sharp`
(already in the lockfile), text was outlined from
`@fontsource-variable/newsreader` and `@fontsource-variable/ibm-plex-sans`
with `fontkit` and `wawoff2`, and the ICO was packed with `png-to-ico`. That
tooling ran from a scratch directory and is not a dependency of this package.
