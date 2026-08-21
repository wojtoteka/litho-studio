import { expect, test } from '@playwright/test';
import { launchApp, openProject, waitForCondition, writeProject, type LaunchedApp } from './helpers.js';

/**
 * The embedded terminal, end to end: a real shell process, real keystrokes over
 * IPC, real output rendered by xterm.
 *
 * This exists because the terminal has no single implementation any more.
 * node-pty ships prebuilt binaries for Windows and macOS only, so the Linux
 * package - which is cross-built from Windows and cannot compile it - runs on
 * one of the fallback backends in `electron/ipc/terminalService.ts` instead.
 *
 * Both cases below assert the same contract, which is the point: the shell
 * starts, what you type reaches it, and what it prints comes back. What differs
 * is only which backend the main process was steered onto. Asserting a backend
 * *name* would just re-state the platform; asserting the round trip is what
 * separates a working terminal from a broken one.
 */

const PAGE = `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>Terminal</title>
  </head>
  <body>
    <main><h1 data-litho-id="tytul">Terminal</h1></main>
  </body>
</html>
`;

let launched: LaunchedApp | null = null;

test.afterEach(async () => {
  await launched?.close();
  launched = null;
});

/**
 * Opens a project, opens the terminal and runs `echo`, asserting the output
 * comes back.
 *
 * The marker is split by an empty quoted string so that the *echoed command
 * line* cannot satisfy the assertion on its own - only the shell's own output
 * joins the halves. `litho""-ok` collapses to `litho-ok` in both PowerShell and
 * every POSIX shell, so one spelling covers all backends.
 */
async function runEchoRoundTrip(app: LaunchedApp, projectName: string): Promise<void> {
  const { page, workspace } = app;
  const projectPath = await writeProject(workspace, projectName, { 'index.html': PAGE });
  await openProject(page, projectPath);

  await page.keyboard.press('Control+`');

  const terminal = page.locator('.terminal-panel');
  await expect(terminal).toBeVisible();

  // xterm routes keystrokes through a hidden textarea; typing before it exists
  // would send them to the canvas instead.
  const input = terminal.locator('textarea.xterm-helper-textarea');
  await expect(input).toBeAttached();
  await input.focus();

  // The shell must have drawn a prompt before it will accept a command - on a
  // cold start that is the slowest part of the whole flow.
  await waitForCondition(
    page,
    () => (document.querySelector('.terminal-panel .xterm-screen')?.textContent ?? '').trim().length > 0,
    'znak zachęty powłoki',
    20_000,
  );

  await input.type('echo litho""-ok');
  await input.press('Enter');

  await waitForCondition(
    page,
    () => (document.querySelector('.terminal-panel .xterm-screen')?.textContent ?? '').includes('litho-ok'),
    'wynik polecenia echo',
    20_000,
  );
}

test('terminal uruchamia powłokę i zwraca wynik polecenia', async () => {
  launched = await launchApp();
  await runEchoRoundTrip(launched, 'terminal-projekt');
});

test('terminal działa też na zapasowym backendzie, bez node-pty', async () => {
  // The backend the Linux package falls back to when node-pty has no binary it
  // can load. Forcing it here is the only way to exercise that path from a
  // developer machine, where node-pty loads perfectly well.
  launched = await launchApp({ LITHO_TERMINAL_BACKEND: 'pipe' });
  await runEchoRoundTrip(launched, 'terminal-zapasowy');

  // The degraded backend must announce itself - a terminal that quietly behaves
  // differently is worse than one that says why.
  const screen = await launched.page.locator('.terminal-panel .xterm-screen').textContent();
  expect(screen ?? '').toContain('trybie potokowym');
});
