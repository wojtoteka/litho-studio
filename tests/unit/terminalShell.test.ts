import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultShell } from '../../electron/ipc/terminalService.js';

/**
 * Regression guard for a terminal that was dead on Windows.
 *
 * `defaultShell()` had no Windows branch: it probed a list of `/bin/*` paths and
 * fell back to `/bin/sh`. None of those exist on Windows, so node-pty - which
 * loads and spawns there without trouble - threw `ENOENT` on the shell it was
 * handed, the service read that as node-pty being unusable, and the pipe
 * fallback then tried the same missing `/bin/sh` again. The panel opened with a
 * warning blaming node-pty, a red `spawn /bin/sh ENOENT`, and no shell.
 *
 * These assertions are written to hold on every platform, so the suite pins the
 * property on whichever host it runs on rather than only on the one that broke.
 */
describe('defaultShell', () => {
  const shell = defaultShell();

  it('resolves to a shell that exists on this machine', () => {
    expect(existsSync(shell.file)).toBe(true);
  });

  it('resolves an absolute path - PATH is user-writable and this spawns a shell', () => {
    if (process.platform === 'win32') expect(shell.file).toMatch(/^[a-z]:\\/iu);
    else expect(shell.file.startsWith('/')).toBe(true);
  });

  it('never hands a POSIX path to Windows, nor a Windows path to POSIX', () => {
    if (process.platform === 'win32') {
      // The exact shape of the bug: a `/bin/...` shell on Windows.
      expect(shell.file.startsWith('/')).toBe(false);
      expect(shell.file).toMatch(/\.exe$/iu);
    } else {
      expect(shell.file).not.toMatch(/\.exe$/iu);
    }
  });

  it('passes only flags the chosen shell understands', () => {
    if (process.platform === 'win32') {
      // `-l`/`-i` are POSIX shell flags. PowerShell resolves `-l` to an
      // unrelated parameter and cmd.exe refuses it, so neither may appear here.
      expect(shell.args).not.toContain('-l');
      expect(shell.args).not.toContain('-i');
      const isCmd = /cmd\.exe$/iu.test(shell.file);
      expect(shell.args).toEqual(isCmd ? [] : ['-NoLogo']);
    } else {
      expect(shell.args).toEqual(['-l']);
    }
  });

  it('prefers a real shell on Windows, in decreasing order of capability', () => {
    if (process.platform !== 'win32') return;
    expect(shell.file).toMatch(/(pwsh|powershell|cmd)\.exe$/iu);
  });
});
