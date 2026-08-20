import path from 'node:path';
import fs from 'node:fs/promises';
import { isSafeRelativePath, normalizeRelative, toPosix } from '@shared/paths.js';
import { fail, ok, type IpcResult } from '@shared/result.js';

/**
 * The only place a renderer-supplied string becomes a filesystem path.
 *
 * Two independent checks must both pass:
 *  1. the *string* must be a well-formed contained relative path, and
 *  2. the *resolved* absolute path must still sit under the project root after
 *     `realpath`, which defeats symlinks pointing outside the project.
 *
 * Failing either one is reported as `PATH_OUTSIDE_PROJECT` — never as a silent
 * clamp to the root, because silently writing to the wrong file is worse than
 * refusing.
 */
export class PathGuard {
  private constructor(
    readonly rootPath: string,
    private readonly realRoot: string,
  ) {}

  static async create(rootPath: string): Promise<PathGuard> {
    const absolute = path.resolve(rootPath);
    const realRoot = await realpathOrSelf(absolute);
    return new PathGuard(absolute, realRoot);
  }

  /** Converts a project-relative path into a validated absolute path. */
  async resolve(relPath: string): Promise<IpcResult<string>> {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      return fail('INVALID_ARGUMENT', 'Ścieżka pliku jest pusta.');
    }
    if (relPath.length > 1024) {
      return fail('INVALID_ARGUMENT', 'Ścieżka pliku jest zbyt długa.');
    }
    if (!isSafeRelativePath(relPath)) {
      return fail('PATH_OUTSIDE_PROJECT', `Nieprawidłowa ścieżka w projekcie: ${relPath}`);
    }

    const absolute = path.resolve(this.rootPath, normalizeRelative(relPath));
    if (!isInside(this.rootPath, absolute)) {
      return fail('PATH_OUTSIDE_PROJECT', `Ścieżka wychodzi poza folder projektu: ${relPath}`);
    }

    // Resolve symlinks on the deepest existing ancestor. A file that does not
    // exist yet is fine — what matters is that its parent chain stays inside.
    const realTarget = await realpathOfNearestExisting(absolute);
    if (!isInside(this.realRoot, realTarget)) {
      return fail('PATH_OUTSIDE_PROJECT', `Ścieżka prowadzi przez dowiązanie poza projekt: ${relPath}`);
    }

    return ok(absolute);
  }

  /** Converts an absolute path back into a project-relative POSIX path. */
  toRelative(absolutePath: string): string | null {
    const relative = path.relative(this.rootPath, absolutePath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return toPosix(relative);
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * Walks up until it finds a path component that exists, resolves symlinks
 * there, then re-appends the missing tail.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  return target;
}
