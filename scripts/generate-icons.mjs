#!/usr/bin/env node
/**
 * Generates every packaging icon from `resources/logo.svg`.
 *
 * The SVG is the single source of truth for the brand mark; running this script
 * after changing it regenerates the whole set, so the installer icon can never
 * drift from the in-app logo. Output lands in `resources/icons/`, which is
 * git-ignored precisely because it is derived.
 *
 * Formats produced:
 *   icon-{16..1024}.png  - Linux, and the input for the icns format
 *   icon.icns            - macOS (built by hand; no macOS-only tooling needed)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceSvg = path.join(root, 'resources/logo.svg');
const outputDirectory = path.join(root, 'resources/icons');

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

/** Padding around the mark so it does not touch the icon edge. */
const PADDING_RATIO = 0.12;
/** Graphite background - the mark's gradient needs a dark field to read well. */
const BACKGROUND = { r: 0x1a, g: 0x1b, b: 0x23, alpha: 1 };

function log(message) {
  process.stdout.write(`[icons] ${message}\n`);
}

async function renderPng(size, { transparent = false } = {}) {
  const inner = Math.round(size * (1 - PADDING_RATIO * 2));
  const offset = Math.round((size - inner) / 2);

  const mark = await sharp(sourceSvg, { density: 512 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: transparent ? { r: 0, g: 0, b: 0, alpha: 0 } : BACKGROUND,
    },
  });

  return canvas
    .composite([{ input: mark, top: offset, left: offset }])
    .png()
    .toBuffer();
}

/**
 * Builds an `.icns` container directly.
 *
 * `iconutil` only exists on macOS, so writing the container by hand is what
 * makes a macOS build possible from a Windows or Linux CI runner. The format is
 * simple: an 8-byte header, then one length-prefixed chunk per icon type.
 */
async function buildIcns(pngs) {
  const ICNS_TYPES = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];

  const chunks = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = pngs.get(size);
    if (!png) continue;
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }

  const body = Buffer.concat(chunks);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write('icns', 0, 4, 'ascii');
  fileHeader.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([fileHeader, body]);
}

async function main() {
  await fs.access(sourceSvg).catch(() => {
    throw new Error(`Nie znaleziono ${sourceSvg}`);
  });
  await fs.mkdir(outputDirectory, { recursive: true });

  const pngs = new Map();
  for (const size of PNG_SIZES) {
    const buffer = await renderPng(size);
    pngs.set(size, buffer);
    await fs.writeFile(path.join(outputDirectory, `icon-${size}.png`), buffer);
  }
  log(`PNG: ${PNG_SIZES.join(', ')}`);

  // electron-builder looks for a 512px `icon.png` for Linux targets.
  await fs.writeFile(path.join(outputDirectory, 'icon.png'), pngs.get(512));

  await fs.writeFile(path.join(outputDirectory, 'icon.icns'), await buildIcns(pngs));
  log('icon.icns');

  // A transparent variant for the tray and for documentation.
  await fs.writeFile(
    path.join(outputDirectory, 'icon-transparent-512.png'),
    await renderPng(512, { transparent: true }),
  );

  log(`gotowe - ${outputDirectory}`);
}

main().catch((error) => {
  process.stderr.write(`[icons] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
