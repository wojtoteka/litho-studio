import type { MaterialSymbolStyle } from './elementFactory.js';

/**
 * Google Fonts / Material Symbols, loaded from Google's CDN.
 *
 * The edited page is a static site meant to be uploaded as-is (see
 * `elementFactory.ts`'s "copy into the project" rule for local assets) — a
 * webfont is the one exception, because bundling font files would balloon
 * every project and Google's own CDN is the standard way real sites pull
 * these in. `ensureHeadLink` (in `editorStore`) writes the `<link>` tags this
 * module builds hrefs for, deduped by `href` so picking a font twice is a
 * no-op.
 */

export interface GoogleFont {
  /** Family name as Google Fonts knows it, and the name to put in `font-family`. */
  name: string;
  /** Generic fallback appended after the family name. */
  fallback: 'sans-serif' | 'serif' | 'monospace' | 'cursive';
}

/** A curated set covering the families people actually reach for. */
export const GOOGLE_FONTS: GoogleFont[] = [
  { name: 'Inter', fallback: 'sans-serif' },
  { name: 'Roboto', fallback: 'sans-serif' },
  { name: 'Open Sans', fallback: 'sans-serif' },
  { name: 'Poppins', fallback: 'sans-serif' },
  { name: 'Lato', fallback: 'sans-serif' },
  { name: 'Montserrat', fallback: 'sans-serif' },
  { name: 'Nunito', fallback: 'sans-serif' },
  { name: 'Raleway', fallback: 'sans-serif' },
  { name: 'Oswald', fallback: 'sans-serif' },
  { name: 'Rubik', fallback: 'sans-serif' },
  { name: 'Work Sans', fallback: 'sans-serif' },
  { name: 'Manrope', fallback: 'sans-serif' },
  { name: 'DM Sans', fallback: 'sans-serif' },
  { name: 'Space Grotesk', fallback: 'sans-serif' },
  { name: 'Fira Sans', fallback: 'sans-serif' },
  { name: 'Source Sans 3', fallback: 'sans-serif' },
  { name: 'Playfair Display', fallback: 'serif' },
  { name: 'Merriweather', fallback: 'serif' },
  { name: 'Lora', fallback: 'serif' },
  { name: 'PT Serif', fallback: 'serif' },
  { name: 'JetBrains Mono', fallback: 'monospace' },
  { name: 'Source Code Pro', fallback: 'monospace' },
  { name: 'Pacifico', fallback: 'cursive' },
  { name: 'Dancing Script', fallback: 'cursive' },
];

/** The `font-family` declaration value for a curated font. */
export function fontFamilyValue(font: GoogleFont): string {
  return `'${font.name}', ${font.fallback}`;
}

/** The CSS2 stylesheet href that loads a family's common weights. */
export function googleFontHref(name: string): string {
  const family = name.trim().replace(/\s+/gu, '+');
  return `https://fonts.googleapis.com/css2?family=${family}:wght@300;400;500;600;700&display=swap`;
}

/** The CSS2 stylesheet href for the variable Material Symbols icon font. */
export function materialSymbolsHref(style: 'Outlined' | 'Rounded' | 'Sharp'): string {
  return (
    `https://fonts.googleapis.com/css2?family=Material+Symbols+${style}` +
    ':opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block'
  );
}

const STYLE_PARAM: Record<MaterialSymbolStyle, 'Outlined' | 'Rounded' | 'Sharp'> = {
  outlined: 'Outlined',
  rounded: 'Rounded',
  sharp: 'Sharp',
};

export function materialSymbolStyleParam(style: MaterialSymbolStyle): 'Outlined' | 'Rounded' | 'Sharp' {
  return STYLE_PARAM[style];
}

/** Google serves fonts from a second host; the connection warms up in parallel with the CSS request. */
export const GOOGLE_FONTS_PRECONNECT: { href: string; crossorigin: '' }[] = [
  { href: 'https://fonts.googleapis.com', crossorigin: '' },
  { href: 'https://fonts.gstatic.com', crossorigin: '' },
];

/**
 * Writes the preconnect hints + stylesheet `<link>` a Material Symbols style
 * needs into the open page's `<head>` — shared by the click-insert path and
 * the canvas drop handler so both ways of placing an icon load the same font.
 */
export function ensureMaterialSymbolsHeadLinks(
  ensureHeadLink: (attrs: Record<string, string>, label?: string) => boolean,
  style: MaterialSymbolStyle,
): void {
  const param = materialSymbolStyleParam(style);
  for (const hint of GOOGLE_FONTS_PRECONNECT) {
    ensureHeadLink(
      { rel: 'preconnect', href: hint.href, crossorigin: hint.crossorigin },
      'Dodanie preconnect dla Google Fonts',
    );
  }
  ensureHeadLink({ rel: 'stylesheet', href: materialSymbolsHref(param) }, `Dodanie czcionki ikon (${param})`);
}
