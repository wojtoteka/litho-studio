import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import {
  AUDIO_EXTENSIONS,
  IGNORED_DIRECTORIES,
  IMAGE_EXTENSIONS,
  MAX_ASSET_BYTES,
  type AssetRef,
} from '@shared/project.js';
import { extname, sanitizeFileName, stem, toPosix } from '@shared/paths.js';
import { fail, ok, type IpcResult } from '@shared/result.js';
import { log } from '../logger.js';
import { pathExists } from './fileService.js';
import type { PathGuard } from './pathGuard.js';

/**
 * Asset management.
 *
 * Imported files are copied into the project's own `assets/` folder (created on
 * demand) so that the project folder stays self-contained and can be uploaded
 * to any host as-is. Nothing is ever referenced from outside the project root.
 */

const ASSET_DIRECTORY = 'assets';
const MAX_ASSETS = 1000;

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
};

export async function listAssets(guard: PathGuard): Promise<IpcResult<AssetRef[]>> {
  const found: AssetRef[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 6 || found.length >= MAX_ASSETS) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAX_ASSETS) return;
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name);
      if (
        !IMAGE_EXTENSIONS.has(ext) &&
        !AUDIO_EXTENSIONS.has(ext) &&
        !['.mp4', '.webm', '.woff', '.woff2', '.ttf', '.otf', '.pdf'].includes(ext)
      ) {
        continue;
      }

      const relPath = toPosix(path.relative(guard.rootPath, absolute));
      try {
        const stats = await fs.stat(absolute);
        const dimensions = IMAGE_EXTENSIONS.has(ext) ? await readImageSize(absolute, ext) : null;
        found.push({
          relPath,
          name: entry.name,
          size: stats.size,
          mimeType: MIME_TYPES[ext] ?? 'application/octet-stream',
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          modifiedAt: stats.mtimeMs,
        });
      } catch {
        // Unreadable file - skip it rather than failing the whole listing.
      }
    }
  }

  await walk(guard.rootPath, 0);
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return ok(found);
}

export async function importAssetFiles(
  guard: PathGuard,
  sourcePaths: string[],
): Promise<IpcResult<AssetRef[]>> {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    return fail('INVALID_ARGUMENT', 'Nie wskazano plików do zaimportowania.');
  }
  if (sourcePaths.length > 100) {
    return fail('INVALID_ARGUMENT', 'Można zaimportować maksymalnie 100 plików naraz.');
  }

  const imported: string[] = [];
  for (const source of sourcePaths) {
    try {
      const stats = await fs.stat(source);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_ASSET_BYTES) {
        log.warn(`[assets] skipping oversized file ${source}`);
        continue;
      }
      const target = await uniqueAssetPath(guard, path.basename(source));
      await fs.mkdir(path.dirname(target.absolute), { recursive: true });
      await fs.copyFile(source, target.absolute);
      imported.push(target.relPath);
    } catch (error) {
      log.warn(`[assets] import failed for ${source}: ${String(error)}`);
    }
  }

  if (imported.length === 0) {
    return fail('IO_ERROR', 'Nie udało się zaimportować żadnego pliku.');
  }
  return listAssets(guard);
}

export async function importAssetBuffer(
  guard: PathGuard,
  name: string,
  data: Uint8Array,
): Promise<IpcResult<AssetRef>> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    return fail('INVALID_ARGUMENT', 'Pusty plik.');
  }
  if (data.byteLength > MAX_ASSET_BYTES) {
    return fail('TOO_LARGE', 'Plik jest zbyt duży (limit 64 MB).');
  }

  const ext = extname(name);
  if (
    !IMAGE_EXTENSIONS.has(ext) &&
    !AUDIO_EXTENSIONS.has(ext) &&
    !['.mp4', '.webm', '.woff', '.woff2', '.ttf', '.otf'].includes(ext)
  ) {
    return fail('UNSUPPORTED_TYPE', `Nieobsługiwany typ pliku: ${ext || 'brak rozszerzenia'}`);
  }

  try {
    const target = await uniqueAssetPath(guard, name);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, data);
    const stats = await fs.stat(target.absolute);
    const dimensions = await readImageSize(target.absolute, ext);
    return ok({
      relPath: target.relPath,
      name: path.basename(target.absolute),
      size: stats.size,
      mimeType: MIME_TYPES[ext] ?? 'application/octet-stream',
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      modifiedAt: stats.mtimeMs,
    });
  } catch (error) {
    return fail('IO_ERROR', 'Nie udało się zapisać pliku w projekcie.', String(error));
  }
}

export async function deleteAsset(guard: PathGuard, relPath: string): Promise<IpcResult<AssetRef[]>> {
  const resolved = await guard.resolve(relPath);
  if (!resolved.ok) return resolved;
  try {
    await fs.rm(resolved.value, { force: true });
  } catch (error) {
    return fail('IO_ERROR', `Nie udało się usunąć pliku ${relPath}.`, String(error));
  }
  return listAssets(guard);
}

/** Picks a free file name in `assets/`, appending `-1`, `-2`, … on collision. */
async function uniqueAssetPath(
  guard: PathGuard,
  rawName: string,
): Promise<{ absolute: string; relPath: string }> {
  const ext = extname(rawName);
  const base = sanitizeFileName(stem(rawName), 'zasob');

  for (let index = 0; index < 1000; index += 1) {
    const candidate = index === 0 ? `${base}${ext}` : `${base}-${index}${ext}`;
    const relPath = `${ASSET_DIRECTORY}/${candidate}`;
    const absolute = path.join(guard.rootPath, ASSET_DIRECTORY, candidate);
    if (!(await pathExists(absolute))) return { absolute, relPath };
  }

  const fallback = `${base}-${Date.now()}${ext}`;
  return {
    absolute: path.join(guard.rootPath, ASSET_DIRECTORY, fallback),
    relPath: `${ASSET_DIRECTORY}/${fallback}`,
  };
}

/* ------------------------------------------------------------------ */
/* Image dimensions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reads intrinsic dimensions from the file header for the formats the editor
 * cares about. Deliberately dependency-free: only the first few KB are read,
 * and an unrecognised header simply yields `null` rather than an error.
 */
async function readImageSize(
  absolutePath: string,
  ext: string,
): Promise<{ width: number; height: number } | null> {
  try {
    if (ext === '.svg') return readSvgSize(await fs.readFile(absolutePath, 'utf8'));

    const handle = await fs.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(65_536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead);
      if (ext === '.png') return readPngSize(head);
      if (ext === '.gif') return readGifSize(head);
      if (ext === '.jpg' || ext === '.jpeg') return readJpegSize(head);
      if (ext === '.webp') return readWebpSize(head);
      return null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readGifSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 10 || buffer.subarray(0, 3).toString('ascii') !== 'GIF') return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readJpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] ?? 0;
    // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

function readWebpSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;

  const format = buffer.subarray(12, 16).toString('ascii');
  if (format === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    const width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff);
    return { width, height };
  }
  return null;
}

function readSvgSize(source: string): { width: number; height: number } | null {
  const viewBox = /viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/iu.exec(source);
  if (viewBox?.[1] && viewBox[2]) {
    return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
  }
  const width = /\bwidth\s*=\s*["']([\d.]+)/iu.exec(source);
  const height = /\bheight\s*=\s*["']([\d.]+)/iu.exec(source);
  if (width?.[1] && height?.[1]) {
    return { width: Math.round(Number(width[1])), height: Math.round(Number(height[1])) };
  }
  return null;
}
