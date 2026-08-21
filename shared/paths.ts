/**
 * Path helpers shared by the main process and the renderer.
 *
 * The renderer only ever speaks in *project-relative POSIX paths*. Turning one
 * of those into an absolute path - and proving it stays inside the project root
 * - happens exclusively in the main process (`electron/ipc/pathGuard.ts`). These
 * helpers hold the pure string logic so both sides agree on normalisation and
 * so the rules can be unit-tested without Electron.
 */

/** Normalises a path to POSIX separators without resolving `..`. */
export function toPosix(input: string): string {
  return input.replace(/\\/gu, '/');
}

/**
 * Collapses `.`/`..` segments and duplicate slashes. Leading `..` segments are
 * *kept* so callers can detect escape attempts rather than having them silently
 * clamped to the root.
 */
export function normalizeRelative(input: string): string {
  const segments = toPosix(input).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = out[out.length - 1];
      if (last !== undefined && last !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** True when a relative path stays inside its root once normalised. */
export function isContained(relPath: string): boolean {
  if (relPath === '') return false;
  // Absolute paths, Windows drive letters and UNC paths are never relative.
  if (toPosix(relPath).startsWith('/')) return false;
  if (/^[a-zA-Z]:/u.test(relPath)) return false;
  if (relPath.startsWith('\\\\')) return false;

  const normalized = normalizeRelative(relPath);
  if (normalized === '') return false;
  if (normalized === '..' || normalized.startsWith('../')) return false;
  return true;
}

/**
 * Characters that are illegal in Windows file names. Enforced on every platform
 * so that projects stay portable between machines.
 */
const ILLEGAL_NAME_CHARS = /[<>:"|?*]/u;
const ILLEGAL_NAME_CHARS_GLOBAL = /[<>:"|?*]/gu;
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu;

/** ASCII control characters are rejected without embedding them in a literal. */
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function stripControlChars(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) out += value[index];
  }
  return out;
}

export function isSafeFileName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.length > 255) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (hasControlChar(name)) return false;
  if (ILLEGAL_NAME_CHARS.test(name)) return false;
  if (RESERVED_WINDOWS_NAMES.test(name)) return false;
  // Windows silently strips these, which would desynchronise us from disk.
  if (name.endsWith(' ') || name.endsWith('.')) return false;
  return true;
}

/** True when every segment of a relative path is a legal file name. */
export function isSafeRelativePath(relPath: string): boolean {
  if (!isContained(relPath)) return false;
  return normalizeRelative(relPath).split('/').every(isSafeFileName);
}

/** Strips characters that cannot appear in a file name, for generated names. */
export function sanitizeFileName(name: string, fallback = 'plik'): string {
  const cleaned = stripControlChars(name)
    .replace(ILLEGAL_NAME_CHARS_GLOBAL, '')
    .replace(/[/\\]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .slice(0, 200);
  if (cleaned === '' || !isSafeFileName(cleaned)) return fallback;
  return cleaned;
}

export function extname(relPath: string): string {
  const base = toPosix(relPath).split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

export function basename(relPath: string): string {
  return toPosix(relPath).split('/').pop() ?? '';
}

export function stem(relPath: string): string {
  const base = basename(relPath);
  const ext = extname(base);
  return ext === '' ? base : base.slice(0, -ext.length);
}

export function dirname(relPath: string): string {
  const posix = toPosix(relPath);
  const slash = posix.lastIndexOf('/');
  return slash === -1 ? '' : posix.slice(0, slash);
}

export function joinRelative(...parts: string[]): string {
  return normalizeRelative(parts.filter(Boolean).join('/'));
}

/**
 * Resolves an `href`/`src` written in an HTML file against the page's own
 * location, mirroring how a browser would.
 *
 * Returns `null` for anything that is not a project-local file reference:
 * absolute URLs, protocol-relative URLs, `data:`/`mailto:`/`tel:` and bare
 * fragments. Callers treat `null` as "not ours - leave it alone".
 */
export function resolveHref(pageRelPath: string, href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('//')) return null; // protocol-relative
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) return null; // http:, data:, mailto:

  // Strip fragment and query before treating the value as a file path.
  const withoutHash = trimmed.split('#')[0] ?? '';
  const pathOnly = withoutHash.split('?')[0] ?? '';
  if (pathOnly === '') return null;

  const decoded = safeDecode(pathOnly);
  const joined = decoded.startsWith('/') ? decoded.slice(1) : joinRelative(dirname(pageRelPath), decoded);
  const normalized = normalizeRelative(joined);
  if (normalized === '' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Builds the `href` to write into a page for a project-relative target,
 * expressed relative to the page's own directory.
 */
export function relativeHref(pageRelPath: string, targetRelPath: string): string {
  const from = dirname(pageRelPath).split('/').filter(Boolean);
  const to = normalizeRelative(targetRelPath).split('/').filter(Boolean);

  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;

  const up: string[] = new Array(from.length - shared).fill('..');
  const parts = [...up, ...to.slice(shared)];
  const joined = parts.map(encodeSegment).join('/');
  return joined === '' ? basename(targetRelPath) : joined;
}

/** Percent-encodes the characters that would break an attribute value. */
function encodeSegment(segment: string): string {
  if (segment === '..') return segment;
  return segment.replace(
    /[ "'<>#?%]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}
