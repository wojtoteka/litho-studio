import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { RecentProject } from '@shared/project.js';
import { log } from '../logger.js';
import { writeAtomic } from './fileService.js';

/**
 * The recent-projects list, stored in the OS app-data folder.
 *
 * This is *application preference* state, not project state: it holds nothing
 * but folder paths and timestamps. Deleting it loses no user work, and a
 * project folder never gains a file because Litho opened it - which is the
 * guarantee that a Litho project stays a plain website folder.
 */

const MAX_RECENT = 12;
const FILE_NAME = 'recent-projects.json';

interface StoredEntry {
  rootPath: string;
  name: string;
  openedAt: number;
  /** Absolute path of the specific file opened, when opened via "Open file" rather than "Open folder". */
  filePath?: string;
}

let cache: StoredEntry[] | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

async function read(): Promise<StoredEntry[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed.filter(isStoredEntry).slice(0, MAX_RECENT) : [];
  } catch {
    // Missing or corrupt file is not an error - the list simply starts empty.
    cache = [];
  }
  return cache;
}

async function persist(entries: StoredEntry[]): Promise<void> {
  cache = entries;
  try {
    await fs.mkdir(path.dirname(storePath()), { recursive: true });
    await writeAtomic(storePath(), `${JSON.stringify(entries, null, 2)}\n`);
  } catch (error) {
    log.warn('[recent] could not persist recent projects', error);
  }
}

export async function rememberProject(rootPath: string, name: string, filePath?: string): Promise<void> {
  const entries = await read();
  const filtered = entries.filter((entry) => !samePath(entry.rootPath, rootPath));
  filtered.unshift({ rootPath, name, openedAt: Date.now(), ...(filePath ? { filePath } : {}) });
  await persist(filtered.slice(0, MAX_RECENT));
}

export async function forgetProject(rootPath: string): Promise<RecentProject[]> {
  const entries = await read();
  await persist(entries.filter((entry) => !samePath(entry.rootPath, rootPath)));
  return listRecentProjects();
}

/** Annotates each entry with whether the folder still exists on disk. */
export async function listRecentProjects(): Promise<RecentProject[]> {
  const entries = await read();
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      available: await isDirectory(entry.rootPath),
    })),
  );
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const normalise = (value: string) => path.resolve(value).replace(/[/\\]+$/u, '');
  return normalise(a) === normalise(b);
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.rootPath === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.openedAt === 'number' &&
    (entry.filePath === undefined || typeof entry.filePath === 'string')
  );
}
