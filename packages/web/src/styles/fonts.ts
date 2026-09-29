import sansLatinExt from '@fontsource-variable/archivo/files/archivo-latin-ext-standard-normal.woff2?url';
import sansLatin from '@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2?url';
import monoLatinExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url';
/**
 * The two families of the "Spec sheet" type system, self-hosted: Archivo (one
 * grotesk for text, headings, and controls; weight and width axes) and
 * JetBrains Mono (every figure, label, and piece of code). Only the Latin and
 * Latin Extended subsets are declared; a browser downloads a face only once
 * text on the page uses it.
 *
 * Each family also gets a local fallback with the web font's vertical metrics
 * (from its hhea table) and an approximate advance-width match against Arial
 * and Courier New, so swapping in the web font barely moves the layout.
 */
import monoLatin from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface Face {
  family: string;
  url: string;
  range: string;
  weight: string;
  stretch?: string;
}

const FACES: Face[] = [
  {
    family: 'Archivo Variable',
    url: sansLatin,
    range: LATIN,
    weight: '100 900',
    stretch: '62% 125%',
  },
  {
    family: 'Archivo Variable',
    url: sansLatinExt,
    range: LATIN_EXT,
    weight: '100 900',
    stretch: '62% 125%',
  },
  { family: 'JetBrains Mono Variable', url: monoLatin, range: LATIN, weight: '100 800' },
  { family: 'JetBrains Mono Variable', url: monoLatinExt, range: LATIN_EXT, weight: '100 800' },
];

/** Local stand-ins with the web fonts' vertical metrics and roughly their advance widths. */
const FALLBACKS = `
@font-face{font-family:'Archivo Fallback';src:local('Arial'),local('Helvetica Neue'),local('Liberation Sans');size-adjust:106%;ascent-override:82.83%;descent-override:19.81%;line-gap-override:0%}
@font-face{font-family:'JetBrains Mono Fallback';src:local('Courier New'),local('Liberation Mono');size-adjust:100%;ascent-override:102%;descent-override:30%;line-gap-override:0%}`;

/** `@font-face` rules for the page head. */
export const FONT_FACES =
  FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-display:swap;font-weight:${f.weight};${f.stretch ? `font-stretch:${f.stretch};` : ''}src:url(${f.url}) format('woff2');unicode-range:${f.range}}`,
  ).join('\n') + FALLBACKS;

/** Every page sets text in both; preloading them avoids a late swap. */
export const PRELOAD_FONTS: readonly string[] = [sansLatin, monoLatin];
