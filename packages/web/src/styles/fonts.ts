import plexLatinExt from '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-ext-wght-normal.woff2?url';
import plexLatin from '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2?url';
import serifLatinExt from '@fontsource-variable/newsreader/files/newsreader-latin-ext-opsz-normal.woff2?url';
import serifItalicLatinExt from '@fontsource-variable/newsreader/files/newsreader-latin-ext-wght-italic.woff2?url';
import serifLatin from '@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2?url';
import serifItalicLatin from '@fontsource-variable/newsreader/files/newsreader-latin-wght-italic.woff2?url';
import monoLatin from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url';
/**
 * The three families of the "Relevé" type system, self-hosted: Newsreader
 * (display and figures), IBM Plex Sans (text and UI), IBM Plex Mono (code).
 * Only the Latin and Latin Extended subsets are declared; a browser downloads
 * a face only once text on the page uses it, so Plex Mono and the Newsreader
 * italic cost nothing on pages without code or notes.
 *
 * Each family also gets a metric-matched local fallback (`size-adjust` and
 * vertical overrides computed from the woff2 files against Georgia, Arial,
 * and Courier New), so swapping in the web font does not move the layout.
 */
import monoLatinExt from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-ext-400-normal.woff2?url';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface Face {
  family: string;
  url: string;
  range: string;
  weight: string;
  style?: 'italic';
}

const FACES: Face[] = [
  { family: 'Newsreader Variable', url: serifLatin, range: LATIN, weight: '200 800' },
  { family: 'Newsreader Variable', url: serifLatinExt, range: LATIN_EXT, weight: '200 800' },
  {
    family: 'Newsreader Variable',
    url: serifItalicLatin,
    range: LATIN,
    weight: '200 800',
    style: 'italic',
  },
  {
    family: 'Newsreader Variable',
    url: serifItalicLatinExt,
    range: LATIN_EXT,
    weight: '200 800',
    style: 'italic',
  },
  { family: 'IBM Plex Sans Variable', url: plexLatin, range: LATIN, weight: '100 700' },
  { family: 'IBM Plex Sans Variable', url: plexLatinExt, range: LATIN_EXT, weight: '100 700' },
  { family: 'IBM Plex Mono', url: monoLatin, range: LATIN, weight: '400' },
  { family: 'IBM Plex Mono', url: monoLatinExt, range: LATIN_EXT, weight: '400' },
];

/** Local stand-ins with the web fonts' advance widths and vertical metrics. */
const FALLBACKS = `
@font-face{font-family:'Newsreader Fallback';src:local('Georgia');size-adjust:89.72%;ascent-override:81.92%;descent-override:29.53%;line-gap-override:0%}
@font-face{font-family:'Plex Sans Fallback';src:local('Arial'),local('Helvetica Neue'),local('Liberation Sans');size-adjust:100.9%;ascent-override:101.58%;descent-override:27.25%;line-gap-override:0%}
@font-face{font-family:'Plex Mono Fallback';src:local('Courier New'),local('Liberation Mono');size-adjust:99.98%;ascent-override:102.52%;descent-override:27.5%;line-gap-override:0%}`;

/** `@font-face` rules for the page head. */
export const FONT_FACES =
  FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:${f.style ?? 'normal'};font-display:swap;font-weight:${f.weight};src:url(${f.url}) format('woff2');unicode-range:${f.range}}`,
  ).join('\n') + FALLBACKS;

/** Every page sets text in these two; preloading them avoids a late swap. */
export const PRELOAD_FONTS: readonly string[] = [serifLatin, plexLatin];
