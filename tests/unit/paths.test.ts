import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  extname,
  isContained,
  isSafeFileName,
  isSafeRelativePath,
  joinRelative,
  normalizeRelative,
  relativeHref,
  resolveHref,
  sanitizeFileName,
  stem,
  toPosix,
} from '@shared/paths.js';

/**
 * Path handling is a security boundary: every one of these strings could reach
 * the filesystem if the guard let it through, so the traversal cases are
 * treated as regression tests, not trivia.
 */

describe('normalizeRelative', () => {
  it('collapses . and duplicate slashes', () => {
    expect(normalizeRelative('a/./b//c')).toBe('a/b/c');
  });

  it('resolves .. within the path', () => {
    expect(normalizeRelative('a/b/../c')).toBe('a/c');
  });

  it('keeps leading .. so callers can detect an escape', () => {
    expect(normalizeRelative('../a')).toBe('../a');
    expect(normalizeRelative('a/../../b')).toBe('../b');
  });

  it('normalises Windows separators', () => {
    expect(normalizeRelative('a\\b\\c')).toBe('a/b/c');
  });
});

describe('isContained - traversal defence', () => {
  it.each([
    '../secret.txt',
    '../../etc/passwd',
    'a/../../b',
    '/etc/passwd',
    'C:\\Windows\\System32\\config',
    'c:/windows/win.ini',
    '\\\\server\\share\\file',
    '',
    '.',
    '..',
  ])('rejects %s', (candidate) => {
    expect(isContained(candidate)).toBe(false);
  });

  it.each(['index.html', 'css/style.css', 'a/b/../c.txt', './index.html', 'assets/img/logo.png'])(
    'accepts %s',
    (candidate) => {
      expect(isContained(candidate)).toBe(true);
    },
  );
});

describe('isSafeFileName', () => {
  it('accepts ordinary names including Unicode', () => {
    expect(isSafeFileName('index.html')).toBe(true);
    expect(isSafeFileName('moja-strona.html')).toBe(true);
    expect(isSafeFileName('zdjęcie 1.png')).toBe(true);
  });

  it('rejects characters Windows cannot store', () => {
    for (const name of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(isSafeFileName(name), name).toBe(false);
    }
  });

  it('rejects control characters', () => {
    expect(isSafeFileName(`a${String.fromCharCode(0)}b`)).toBe(false);
    expect(isSafeFileName(`a${String.fromCharCode(31)}b`)).toBe(false);
  });

  it('rejects reserved Windows device names', () => {
    for (const name of ['CON', 'con', 'PRN.txt', 'aux', 'NUL', 'COM1', 'lpt9.html']) {
      expect(isSafeFileName(name), name).toBe(false);
    }
  });

  it('rejects names Windows would silently truncate', () => {
    expect(isSafeFileName('name.')).toBe(false);
    expect(isSafeFileName('name ')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeFileName('a/b')).toBe(false);
    expect(isSafeFileName('a\\b')).toBe(false);
  });
});

describe('isSafeRelativePath', () => {
  it('requires every segment to be a legal file name', () => {
    expect(isSafeRelativePath('css/style.css')).toBe(true);
    expect(isSafeRelativePath('css/CON/style.css')).toBe(false);
    expect(isSafeRelativePath('../style.css')).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it('strips illegal characters but keeps the readable part', () => {
    expect(sanitizeFileName('mój: plik?.png')).toBe('mój plik.png');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeFileName('???', 'zasob')).toBe('zasob');
    expect(sanitizeFileName('', 'zasob')).toBe('zasob');
  });

  it('never returns a reserved device name', () => {
    expect(sanitizeFileName('CON')).toBe('plik');
  });
});

describe('resolveHref', () => {
  it('resolves relative to the page directory', () => {
    expect(resolveHref('index.html', 'style.css')).toBe('style.css');
    expect(resolveHref('pages/about.html', 'style.css')).toBe('pages/style.css');
    expect(resolveHref('pages/about.html', '../style.css')).toBe('style.css');
  });

  it('treats a leading slash as project-root relative', () => {
    expect(resolveHref('pages/about.html', '/css/style.css')).toBe('css/style.css');
  });

  it('strips query strings and fragments', () => {
    expect(resolveHref('index.html', 'style.css?v=2')).toBe('style.css');
    expect(resolveHref('index.html', 'style.css#x')).toBe('style.css');
  });

  it('decodes percent-encoding', () => {
    expect(resolveHref('index.html', 'assets/moje%20zdjecie.png')).toBe('assets/moje zdjecie.png');
  });

  it.each([
    'https://cdn.example.com/x.css',
    'http://example.com/x.css',
    '//cdn.example.com/x.css',
    'data:text/css,body{}',
    'mailto:a@b.pl',
    'tel:+48123',
    '#section',
    '',
  ])('returns null for %s - not a project file', (href) => {
    expect(resolveHref('index.html', href)).toBeNull();
  });

  it('returns null for a path escaping the project', () => {
    expect(resolveHref('index.html', '../../secret.css')).toBeNull();
  });
});

describe('relativeHref', () => {
  it('writes a sibling path', () => {
    expect(relativeHref('index.html', 'style.css')).toBe('style.css');
  });

  it('walks up out of a subdirectory', () => {
    expect(relativeHref('pages/about.html', 'style.css')).toBe('../style.css');
  });

  it('descends into a subdirectory', () => {
    expect(relativeHref('index.html', 'css/theme.css')).toBe('css/theme.css');
  });

  it('percent-encodes characters that would break the attribute', () => {
    expect(relativeHref('index.html', 'assets/moje zdjecie.png')).toBe('assets/moje%20zdjecie.png');
  });

  it('round-trips with resolveHref', () => {
    for (const [page, target] of [
      ['index.html', 'css/theme.css'],
      ['pages/about.html', 'style.css'],
      ['pages/deep/x.html', 'assets/logo.png'],
    ] as const) {
      expect(resolveHref(page, relativeHref(page, target))).toBe(target);
    }
  });
});

describe('small helpers', () => {
  it('extracts extensions, base names and stems', () => {
    expect(extname('a/b/c.HTML')).toBe('.html');
    expect(extname('a/b/noext')).toBe('');
    expect(extname('.gitignore')).toBe('');
    expect(basename('a/b/c.html')).toBe('c.html');
    expect(stem('a/b/c.html')).toBe('c');
    expect(dirname('a/b/c.html')).toBe('a/b');
    expect(dirname('c.html')).toBe('');
  });

  it('joins and normalises', () => {
    expect(joinRelative('a', 'b', 'c.html')).toBe('a/b/c.html');
    expect(joinRelative('', 'style.css')).toBe('style.css');
    expect(toPosix('a\\b')).toBe('a/b');
  });
});
