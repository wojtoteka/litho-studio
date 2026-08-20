import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { BACKUP_DIRECTORY, MAX_TEXT_FILE_BYTES, type FileWrite, type WriteReport } from '@shared/project.js';
import { extname } from '@shared/paths.js';
import { fail, ok, type IpcResult } from '@shared/result.js';
import { log } from '../logger.js';
import type { PathGuard } from './pathGuard.js';
import { formatSource } from './formatter.js';

/**
 * Durable file I/O for the project folder.
 *
 * Every write is atomic (temp file in the same directory, `fsync`, then
 * `rename`) so a crash or power loss can never leave a half-written page on
 * disk. Before the first write of a session each file is copied into a
 * per-project backup folder under the OS app-data directory, and the previous
 * content is kept as a rolling `.bak` so there is always one known-good
 * version to fall back to. Backups live outside the project folder so opening
 * a project never adds files to it — a Litho project stays a plain website
 * folder, and the user's own folder (e.g. their Desktop) never gets one dropped
 * into it.
 */
export class FileService {
  /** sha-256 of the last content this process wrote, per relative path. */
  private readonly ownWriteHashes = new Map<string, string>();
  private readonly backedUpThisSession = new Set<string>();
  /** Per-project backup root, e.g. `%APPDATA%/Litho Studio/backups/<name>-<hash>`. */
  private readonly backupRoot: string;

  constructor(private readonly guard: PathGuard) {
    this.backupRoot = path.join(
      app.getPath('userData'),
      'backups',
      FileService.backupFolderId(guard.rootPath),
    );
  }

  /** Stable, collision-resistant folder name derived from the project's absolute path. */
  private static backupFolderId(rootPath: string): string {
    const hash = crypto.createHash('sha256').update(rootPath).digest('hex').slice(0, 12);
    const base =
      path
        .basename(rootPath)
        .replace(/[^a-zA-Z0-9_-]+/gu, '-')
        .slice(0, 40) || 'project';
    return `${base}-${hash}`;
  }

  static hash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * True when `content` is byte-identical to what we last wrote to that path.
   * The watcher uses this to ignore the change events its own writes produce.
   */
  isOwnWrite(relPath: string, content: string): boolean {
    return this.ownWriteHashes.get(relPath) === FileService.hash(content);
  }

  forgetHash(relPath: string): void {
    this.ownWriteHashes.delete(relPath);
  }

  recordExternalContent(relPath: string, content: string): void {
    this.ownWriteHashes.set(relPath, FileService.hash(content));
  }

  async readText(relPath: string): Promise<IpcResult<string>> {
    const resolved = await this.guard.resolve(relPath);
    if (!resolved.ok) return resolved;

    try {
      const stats = await fs.stat(resolved.value);
      if (!stats.isFile()) return fail('NOT_FOUND', `To nie jest plik: ${relPath}`);
      if (stats.size > MAX_TEXT_FILE_BYTES) {
        return fail('TOO_LARGE', `Plik ${relPath} jest zbyt duży, aby go edytować (limit 8 MB).`);
      }
      const content = await fs.readFile(resolved.value, 'utf8');
      return ok(stripBom(content));
    } catch (error) {
      return toIoFailure(error, relPath);
    }
  }

  async exists(relPath: string): Promise<IpcResult<boolean>> {
    const resolved = await this.guard.resolve(relPath);
    if (!resolved.ok) return resolved;
    try {
      await fs.access(resolved.value);
      return ok(true);
    } catch {
      return ok(false);
    }
  }

  /**
   * Writes a batch of files. Formatting, backup and the atomic swap happen per
   * file; a failure on one file does not abort the ones already written, but it
   * is reported so the UI can warn instead of pretending the save succeeded.
   */
  async writeBatch(writes: FileWrite[]): Promise<IpcResult<WriteReport>> {
    if (!Array.isArray(writes) || writes.length === 0) {
      return ok({ written: [], hashes: {} });
    }
    if (writes.length > 200) {
      return fail('INVALID_ARGUMENT', 'Zbyt wiele plików w jednym zapisie.');
    }

    const written: string[] = [];
    const hashes: Record<string, string> = {};
    const failures: string[] = [];

    for (const entry of writes) {
      if (typeof entry?.relPath !== 'string' || typeof entry?.content !== 'string') {
        return fail('INVALID_ARGUMENT', 'Nieprawidłowy element zapisu.');
      }
      if (Buffer.byteLength(entry.content, 'utf8') > MAX_TEXT_FILE_BYTES) {
        failures.push(`${entry.relPath} (przekracza limit rozmiaru)`);
        continue;
      }

      const resolved = await this.guard.resolve(entry.relPath);
      if (!resolved.ok) {
        failures.push(`${entry.relPath} (${resolved.message})`);
        continue;
      }

      const formatted = await formatSource(entry.content, entry.relPath);
      const hash = FileService.hash(formatted);
      hashes[entry.relPath] = hash;

      // Skip files whose content did not actually change — this keeps the
      // watcher quiet and avoids pointless disk churn during drag operations.
      if (this.ownWriteHashes.get(entry.relPath) === hash) {
        const stillThere = await pathExists(resolved.value);
        if (stillThere) continue;
      }

      try {
        await this.backupOnce(entry.relPath, resolved.value);
        await writeAtomic(resolved.value, formatted);
        this.ownWriteHashes.set(entry.relPath, hash);
        written.push(entry.relPath);
      } catch (error) {
        log.error(`[files] write failed for ${entry.relPath}`, error);
        failures.push(`${entry.relPath} (${errorMessage(error)})`);
      }
    }

    if (failures.length > 0) {
      return fail('IO_ERROR', `Nie udało się zapisać ${failures.length} plik(ów).`, failures.join('; '));
    }

    return ok({ written, hashes });
  }

  /** Deletes a file, keeping a backup copy first. */
  async deleteFile(relPath: string): Promise<IpcResult<void>> {
    const resolved = await this.guard.resolve(relPath);
    if (!resolved.ok) return resolved;
    try {
      await this.backupOnce(relPath, resolved.value, { force: true });
      await fs.rm(resolved.value, { force: true });
      this.ownWriteHashes.delete(relPath);
      return ok(undefined);
    } catch (error) {
      return toIoFailure(error, relPath);
    }
  }

  /**
   * Copies the on-disk version of a file into the backup root the first time
   * this session touches it, plus a rolling one-step `.bak` on every write.
   */
  private async backupOnce(
    relPath: string,
    absolutePath: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (relPath.startsWith(`${BACKUP_DIRECTORY}/`)) return;
    if (!options.force && this.backedUpThisSession.has(relPath)) {
      await this.rollingBackup(relPath, absolutePath);
      return;
    }

    if (!(await pathExists(absolutePath))) {
      this.backedUpThisSession.add(relPath);
      return;
    }

    const target = path.join(this.backupRoot, 'session', relPath);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(absolutePath, target);
      this.backedUpThisSession.add(relPath);
    } catch (error) {
      // A failed backup must never block the user's edit.
      log.warn(`[files] could not back up ${relPath}: ${errorMessage(error)}`);
    }
  }

  private async rollingBackup(relPath: string, absolutePath: string): Promise<void> {
    if (!(await pathExists(absolutePath))) return;
    const target = path.join(this.backupRoot, 'last', `${relPath}.bak`);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(absolutePath, target);
    } catch (error) {
      log.warn(`[files] rolling backup failed for ${relPath}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Atomic write: temp file next to the target (same volume, so `rename` is
 * atomic), flushed to disk, then renamed over the original.
 *
 * The rename retries on `EPERM`/`EACCES`/`EBUSY`: on Windows an antivirus
 * scanner or an editor's file watcher routinely holds a just-written file for
 * a few milliseconds, and failing the user's save over that would be wrong.
 */
export async function writeAtomic(absolutePath: string, content: string): Promise<void> {
  const directory = path.dirname(absolutePath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(directory, `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tempPath, 'w');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tempPath, absolutePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
    }
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function isTextExtension(relPath: string): boolean {
  const ext = extname(relPath);
  return ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md'].includes(ext);
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIoFailure(error: unknown, relPath: string): IpcResult<never> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return fail('NOT_FOUND', `Plik nie istnieje: ${relPath}`);
  if (code === 'EACCES' || code === 'EPERM') {
    return fail('PERMISSION_DENIED', `Brak uprawnień do pliku: ${relPath}`);
  }
  if (code === 'EISDIR') return fail('NOT_A_DIRECTORY', `To jest katalog, nie plik: ${relPath}`);
  return fail('IO_ERROR', `Błąd odczytu/zapisu pliku ${relPath}.`, errorMessage(error));
}
