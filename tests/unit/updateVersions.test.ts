import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../electron/ipc/updateService.js';

/**
 * The update banner appears on exactly one condition: the API's version is
 * *newer* than the running one. Getting that comparison wrong in either
 * direction is user-visible and annoying - a banner that never goes away, or
 * one that never appears - so the ordering rules are pinned here.
 */
describe('compareVersions', () => {
  it('treats equal versions as equal', () => {
    expect(compareVersions('1.0.1', '1.0.1')).toBe(0);
  });

  it('compares patch, minor and major numerically', () => {
    expect(compareVersions('1.0.2', '1.0.1')).toBe(1);
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.2')).toBe(-1);
  });

  it('orders 1.0.10 above 1.0.9 - the case a string comparison gets backwards', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
  });

  it('pads missing segments with zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.2', '1.1.9')).toBe(1);
  });

  it('does not report an update for the version we are already running', () => {
    // The exact shape of the shipped check: latest vs. current.
    expect(compareVersions('1.0.1', '1.0.1') > 0).toBe(false);
    expect(compareVersions('1.0.0', '1.0.1') > 0).toBe(false);
    expect(compareVersions('1.0.2', '1.0.1') > 0).toBe(true);
  });
});
