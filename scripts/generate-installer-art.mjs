#!/usr/bin/env node
/**
 * Generuje grafiki kreatora instalacji (NSIS) z `resources/logo.svg`.
 *
 * NSIS/MUI2 przyjmuje wyłącznie nieskompresowane BMP o z góry ustalonych
 * rozmiarach, a `sharp` nie umie zapisywać BMP - dlatego kontener 24-bitowy
 * składamy tu ręcznie, dokładnie tak jak `.icns` w `generate-icons.mjs`.
 *
 * Kolory pochodzą z ciemnego motywu aplikacji (`src/styles/app.css`); tło
 * nagłówka MUSI być identyczne z `MUI_BGCOLOR` w `resources/installer/installer.nsh`,
 * bo bitmapa i tło paska nagłówka stykają się bez żadnej ramki.
 *
 * Wynik ląduje w `resources/installer/` (git-ignorowany, bo pochodny):
 *   header.bmp             150 × 57   - pasek nagłówka na stronach kreatora
 *   sidebar.bmp            164 × 314  - panel powitania/zakończenia instalatora
 *   sidebar-uninstall.bmp  164 × 314  - to samo dla dezinstalatora (znak mono)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logoSvg = path.join(root, 'resources/logo.svg');
const logoMonoSvg = path.join(root, 'resources/logo-mono.svg');
const outputDirectory = path.join(root, 'resources/installer');

/** Paleta ciemnego motywu - patrz `:root` w src/styles/app.css. */
const COLOR = {
  surface0: '#0e0f14',
  surface1: '#15161d',
  surface2: '#1c1e27',
  border: '#262936',
  ink1: '#f0f2f8',
  ink3: '#71768c',
  violet: '#7c5cff',
  blue: '#3d9bff',
};

const SIDEBAR = { width: 164, height: 314 };
const HEADER = { width: 150, height: 57 };

function log(message) {
  process.stdout.write(`[installer-art] ${message}\n`);
}

/**
 * Zapisuje 24-bitowy BMP (BI_RGB).
 *
 * Format jest prosty, ale ma dwie pułapki, na których łatwo się przewrócić:
 * wiersze idą od dołu do góry, a każdy z nich jest dopełniany do wielokrotności
 * czterech bajtów. Kolejność kanałów to BGR, nie RGB.
 */
function encodeBmp24(rgb, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelBytes);

  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10); // offset danych obrazu
  buffer.writeUInt32LE(40, 14); // rozmiar BITMAPINFOHEADER
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26); // liczba płaszczyzn
  buffer.writeUInt16LE(24, 28); // bity na piksel
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38); // ~72 dpi
  buffer.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = (height - 1 - y) * width * 3;
    let target = 54 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const pixel = sourceRow + x * 3;
      buffer[target] = rgb[pixel + 2];
      buffer[target + 1] = rgb[pixel + 1];
      buffer[target + 2] = rgb[pixel];
      target += 3;
    }
  }

  return buffer;
}

async function writeBmp(name, image, { width, height }) {
  const rgb = await image.flatten({ background: COLOR.surface1 }).removeAlpha().raw().toBuffer();
  await fs.writeFile(path.join(outputDirectory, name), encodeBmp24(rgb, width, height));
  log(`${name} - ${width} × ${height}`);
}

/** Znak marki wyrenderowany z logo.svg do podanego boku (w pikselach). */
async function renderMark(size, { mono = false } = {}) {
  if (!mono) {
    return sharp(logoSvg, { density: 512 }).resize(size, size, { fit: 'contain' }).png().toBuffer();
  }

  // logo-mono.svg używa `currentColor`, którego renderer SVG nie ma skąd wziąć -
  // podstawiamy konkretny kolor przed rasteryzacją.
  const source = await fs.readFile(logoMonoSvg, 'utf8');
  const colored = Buffer.from(source.replaceAll('currentColor', COLOR.ink3), 'utf8');
  return sharp(colored, { density: 512 }).resize(size, size, { fit: 'contain' }).png().toBuffer();
}

/**
 * Tło panelu bocznego: ciemna płyta, poświata w barwach marki i podpis.
 *
 * `variant` przełącza tylko temperaturę poświaty i podpis - układ zostaje ten
 * sam, żeby instalator i dezinstalator czytały się jako jedna rodzina.
 */
function sidebarBackgroundSvg(variant) {
  const install = variant === 'install';
  const glowFrom = install ? COLOR.violet : '#5a6076';
  const glowTo = install ? COLOR.blue : '#3f4457';
  const caption = install ? 'Wizualny edytor stron WWW' : 'Dezinstalacja';

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"
  width="${SIDEBAR.width}" height="${SIDEBAR.height}" viewBox="0 0 ${SIDEBAR.width} ${SIDEBAR.height}">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0%" stop-color="${COLOR.surface2}" />
      <stop offset="52%" stop-color="${COLOR.surface1}" />
      <stop offset="100%" stop-color="${COLOR.surface0}" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${glowFrom}" stop-opacity="${install ? 0.42 : 0.2}" />
      <stop offset="55%" stop-color="${glowTo}" stop-opacity="${install ? 0.12 : 0.06}" />
      <stop offset="100%" stop-color="${glowTo}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${glowFrom}" stop-opacity="0" />
      <stop offset="50%" stop-color="${glowFrom}" stop-opacity="${install ? 0.9 : 0.45}" />
      <stop offset="100%" stop-color="${glowTo}" stop-opacity="0" />
    </linearGradient>
  </defs>

  <rect width="${SIDEBAR.width}" height="${SIDEBAR.height}" fill="url(#plate)" />
  <circle cx="82" cy="112" r="112" fill="url(#glow)" />

  <rect x="34" y="206" width="96" height="1" fill="url(#rule)" />

  <text x="82" y="232" text-anchor="middle" fill="${COLOR.ink1}"
    font-family="Segoe UI Semibold, Segoe UI, DejaVu Sans, sans-serif" font-size="15" font-weight="600">Litho Studio</text>
  <text x="82" y="250" text-anchor="middle" fill="${COLOR.ink3}"
    font-family="Segoe UI, DejaVu Sans, sans-serif" font-size="10" letter-spacing="0.4">${caption}</text>

  <rect x="${SIDEBAR.width - 1}" y="0" width="1" height="${SIDEBAR.height}" fill="${COLOR.border}" />
</svg>`);
}

/**
 * Tło paska nagłówka: płaskie `--surface-2` plus delikatna poświata pod znakiem.
 * Płaskie i dokładnie w tym kolorze, bo bitmapa styka się bez ramki z resztą
 * paska, którą rysuje MUI - kolor musi odpowiadać `MUI_BGCOLOR` z installer.nsh.
 */
function headerBackgroundSvg() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"
  width="${HEADER.width}" height="${HEADER.height}" viewBox="0 0 ${HEADER.width} ${HEADER.height}">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${COLOR.violet}" stop-opacity="0.34" />
      <stop offset="60%" stop-color="${COLOR.blue}" stop-opacity="0.08" />
      <stop offset="100%" stop-color="${COLOR.blue}" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="${HEADER.width}" height="${HEADER.height}" fill="${COLOR.surface2}" />
  <circle cx="116" cy="28" r="34" fill="url(#glow)" />
</svg>`);
}

async function buildSidebar(variant) {
  const mark = await renderMark(78, { mono: variant === 'uninstall' });
  const image = sharp(sidebarBackgroundSvg(variant)).composite([{ input: mark, top: 74, left: 43 }]);
  await writeBmp(variant === 'install' ? 'sidebar.bmp' : 'sidebar-uninstall.bmp', image, SIDEBAR);
}

async function buildHeader() {
  const mark = await renderMark(30);
  const image = sharp(headerBackgroundSvg()).composite([{ input: mark, top: 13, left: 101 }]);
  await writeBmp('header.bmp', image, HEADER);
}

async function main() {
  for (const file of [logoSvg, logoMonoSvg]) {
    await fs.access(file).catch(() => {
      throw new Error(`Nie znaleziono ${file}`);
    });
  }
  await fs.mkdir(outputDirectory, { recursive: true });

  await buildHeader();
  await buildSidebar('install');
  await buildSidebar('uninstall');

  log(`gotowe - ${outputDirectory}`);
}

main().catch((error) => {
  process.stderr.write(`[installer-art] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
