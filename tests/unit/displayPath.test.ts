import { describe, expect, it } from 'vitest';
import { collapseHome, displayPath, relativeDay, shortenPath } from '@/lib/displayPath.js';

/**
 * These exist because the start screen's recents list shipped for months
 * truncating paths with `direction: rtl`, which silently reordered them -
 * `/home/ala/strona` was drawn as `home/ala/strona/`. The first test below is
 * that regression: whatever else changes, the string that reaches the DOM must
 * be in reading order.
 */

describe('shortenPath', () => {
  it('never reorders the path it is given', () => {
    const full = '/home/ala/Dokumenty/projekty/portfolio-2026/podstrony/kontakt.html';
    const shown = shortenPath(full);

    expect(shown.startsWith('…/')).toBe(true);
    expect(shown.endsWith('kontakt.html')).toBe(true);
    // The separator order of what survived matches the original, not its mirror.
    expect(full).toContain(shown.replace('…/', ''));
  });

  it('leaves a path that already fits alone', () => {
    expect(shortenPath('/home/ala/strona')).toBe('/home/ala/strona');
  });

  it('drops whole segments from the front, not characters', () => {
    const shown = shortenPath('/aaaaaaaaaa/bbbbbbbbbb/cccccccccc/dddddddddd/eeeeeeeeee/index.html', 40);
    expect(shown).toBe('…/dddddddddd/eeeeeeeeee/index.html');
  });

  it('keeps the final segment whole even when it alone is over budget', () => {
    const shown = shortenPath('/var/tmp/a-really-quite-absurdly-long-file-name-here.html', 20);
    expect(shown).toBe('…/a-really-quite-absurdly-long-file-name-here.html');
  });

  it('preserves Windows separators', () => {
    const shown = shortenPath('C:\\Users\\Ala\\Dokumenty\\projekty\\portfolio\\podstrony\\kontakt.html', 40);
    expect(shown).toContain('\\');
    expect(shown).not.toContain('/');
  });
});

describe('collapseHome', () => {
  it('replaces the home prefix with a tilde', () => {
    expect(collapseHome('/home/ala/strona', '/home/ala')).toBe('~/strona');
  });

  it('collapses the home directory itself', () => {
    expect(collapseHome('/home/ala', '/home/ala')).toBe('~');
  });

  it('only matches on a segment boundary', () => {
    // The bug a plain startsWith would have: /home/ala is not a prefix of alan.
    expect(collapseHome('/home/alan/strona', '/home/ala')).toBe('/home/alan/strona');
  });

  it('tolerates a trailing separator on the home directory', () => {
    expect(collapseHome('/home/ala/strona', '/home/ala/')).toBe('~/strona');
  });

  it('passes the path through when the home directory is unknown', () => {
    expect(collapseHome('/home/ala/strona', '')).toBe('/home/ala/strona');
  });
});

describe('displayPath', () => {
  it('collapses home before measuring, so the tilde buys back budget', () => {
    const full = '/home/wojtoteka/Dokumenty/projekty/sklep-rowerowy/index.html';
    expect(displayPath(full, '/home/wojtoteka')).toBe('~/Dokumenty/projekty/sklep-rowerowy/index.html');
  });
});

describe('relativeDay', () => {
  const noon = new Date('2026-08-07T12:00:00').getTime();
  const daysBefore = (days: number): number =>
    new Date('2026-08-07T12:00:00').setDate(7 - days);

  it('counts calendar days, not elapsed hours', () => {
    // 23:00 the previous evening is "wczoraj" at 01:00, not "2 godziny temu".
    const lateYesterday = new Date('2026-08-06T23:00:00').getTime();
    expect(relativeDay(lateYesterday, new Date('2026-08-07T01:00:00').getTime())).toBe('wczoraj');
  });

  it('names today and yesterday', () => {
    expect(relativeDay(noon, noon)).toBe('dzisiaj');
    expect(relativeDay(daysBefore(1), noon)).toBe('wczoraj');
  });

  it('counts days, then weeks, then months', () => {
    expect(relativeDay(daysBefore(3), noon)).toBe('3 dni temu');
    expect(relativeDay(daysBefore(10), noon)).toBe('1 tyg. temu');
    expect(relativeDay(daysBefore(60), noon)).toBe('2 mies. temu');
    expect(relativeDay(daysBefore(500), noon)).toBe('ponad rok temu');
  });

  it('never reports a negative age for a clock that ran backwards', () => {
    expect(relativeDay(noon + 86_400_000, noon)).toBe('dzisiaj');
  });
});
