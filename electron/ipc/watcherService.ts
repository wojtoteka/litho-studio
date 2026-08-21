import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  BACKUP_DIRECTORY,
  IGNORED_DIRECTORIES,
  MAX_TEXT_FILE_BYTES,
  TEXT_EXTENSIONS,
  type FileChangeEvent,
} from '@shared/project.js';
import { extname } from '@shared/paths.js';
import { log } from '../logger.js';
import { FileService } from './fileService.js';
import type { PathGuard } from './pathGuard.js';

/**
 * Watches the project folder so edits made in VS Code (or by a build script)
 * flow back into the editor.
 *
 * Preventing the write → watch → reload → write loop needs two layers, because
 * either one alone is unreliable:
 *
 *  1. **Suppression window.** `beginOwnWrite()` mutes a path for a short period
 *     around our own save. This handles the common case cheaply.
 *  2. **Content hashing.** Every event's content is hashed and compared against
 *     the hash of what we last wrote. If they match, the event is our own echo
 *     and is dropped - this is the authoritative check and it stays correct even
 *     when the OS delivers events late, out of order, or twice.
 *
 * Only hash equality can *confirm* an echo, so layer 2 is what the correctness
 * argument rests on; layer 1 merely avoids the wasted read.
 */

const SUPPRESSION_MS = 1500;
const DEBOUNCE_MS = 120;

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private readonly suppressed = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly guard: PathGuard,
    private readonly files: FileService,
    private readonly emit: (event: FileChangeEvent) => void,
  ) {}

  start(): void {
    if (this.watcher || this.disposed) return;

    this.watcher = chokidar.watch(this.guard.rootPath, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: 8,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      ignored: (candidate: string) => this.shouldIgnore(candidate),
    });

    this.watcher
      .on('add', (absolute) => this.schedule('add', absolute))
      .on('change', (absolute) => this.schedule('change', absolute))
      .on('unlink', (absolute) => this.schedule('unlink', absolute))
      .on('error', (error) => log.warn('[watcher] error', error));

    log.info(`[watcher] watching ${this.guard.rootPath}`);
  }

  /**
   * Mutes a path around a save we are about to perform. Always paired with the
   * hash check in `handle()`; the timer only reduces needless disk reads.
   */
  beginOwnWrite(relPaths: string[]): void {
    const until = Date.now() + SUPPRESSION_MS;
    for (const relPath of relPaths) this.suppressed.set(relPath, until);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.suppressed.clear();
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined);
      this.watcher = null;
    }
  }

  private shouldIgnore(absolute: string): boolean {
    const relative = this.guard.toRelative(absolute);
    if (relative === null) return absolute !== this.guard.rootPath;

    const segments = relative.split('/');
    for (const segment of segments.slice(0, -1)) {
      if (IGNORED_DIRECTORIES.has(segment)) return true;
      if (segment.startsWith('.') && segment !== '.well-known') return true;
    }
    if (relative.startsWith(`${BACKUP_DIRECTORY}/`)) return true;

    const name = segments[segments.length - 1] ?? '';
    // Our own atomic-write temp files, and editor swap files.
    if (name.endsWith('.tmp') || name.endsWith('~') || name.startsWith('.#')) return true;
    return false;
  }

  private schedule(type: FileChangeEvent['type'], absolute: string): void {
    const relPath = this.guard.toRelative(absolute);
    if (relPath === null) return;
    if (!TEXT_EXTENSIONS.has(extname(relPath))) {
      // Non-text files (images) only matter as asset-list invalidation.
      this.emit({ type, relPath, content: null, hash: null });
      return;
    }

    const existing = this.pending.get(relPath);
    if (existing) clearTimeout(existing);
    this.pending.set(
      relPath,
      setTimeout(() => {
        this.pending.delete(relPath);
        void this.handle(type, relPath);
      }, DEBOUNCE_MS),
    );
  }

  private async handle(type: FileChangeEvent['type'], relPath: string): Promise<void> {
    if (this.disposed) return;

    if (type === 'unlink') {
      this.suppressed.delete(relPath);
      this.files.forgetHash(relPath);
      this.emit({ type, relPath, content: null, hash: null });
      return;
    }

    const mutedUntil = this.suppressed.get(relPath) ?? 0;
    const muted = Date.now() < mutedUntil;

    let content: string;
    try {
      const absolute = path.join(this.guard.rootPath, relPath);
      const stats = await fs.stat(absolute);
      if (stats.size > MAX_TEXT_FILE_BYTES) return;
      content = await fs.readFile(absolute, 'utf8');
    } catch (error) {
      log.warn(`[watcher] could not read ${relPath}: ${String(error)}`);
      return;
    }

    // Authoritative echo check: identical content means this event was caused by
    // our own save, regardless of how the timing worked out.
    if (this.files.isOwnWrite(relPath, content)) {
      this.suppressed.delete(relPath);
      return;
    }

    if (muted) {
      // Muted but the content differs - someone edited the file while we were
      // saving. That is a real external change and must not be swallowed.
      log.info(`[watcher] external edit during own write: ${relPath}`);
    }

    this.suppressed.delete(relPath);
    this.files.recordExternalContent(relPath, content);
    this.emit({ type, relPath, content, hash: FileService.hash(content) });
  }
}
