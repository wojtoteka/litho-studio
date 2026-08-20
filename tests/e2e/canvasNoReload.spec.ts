import { expect, test } from '@playwright/test';
import { launchApp, openProject, waitForFile, writeProject, type LaunchedApp } from './helpers.js';

/**
 * "It keeps bugging out, I can't edit anything for a few seconds because the
 * page reloads every time."
 *
 * That was one canvas reload per keystroke: the properties panel's text fields
 * commit on every character, and a commit that touched markup rebuilt the
 * iframe's whole document — blank frame, every web font and image fetched
 * again, full re-layout. Small markup edits are now applied to the loaded
 * document instead (see `canvasPatch` in editorStore.ts).
 *
 * The test proves it the only way that cannot be faked: it stamps the live
 * document, types, and checks the stamp is still there. A reload would have
 * taken it with it. It then checks the canvas really did change and the file on
 * disk agrees — a patch that skipped the reload but showed stale markup would
 * be worse than the reload it replaced.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

const PROJECT = {
  'index.html': `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="utf-8"><title>Strona</title></head>
<body>
<p>Akapit</p>
<img src="foto.png" alt="stary" width="80" height="60">
</body>
</html>
`,
};

/** Leaves a mark on the live document that only a reload can remove. */
async function stampFrame(): Promise<void> {
  await harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    frame.contentDocument!.documentElement.setAttribute('data-e2e-stamp', 'alive');
  });
}

async function stampSurvived(): Promise<boolean> {
  return harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    return frame.contentDocument!.documentElement.getAttribute('data-e2e-stamp') === 'alive';
  });
}

test('pisanie w panelu nie przeładowuje obszaru edycji', async () => {
  const projectPath = await writeProject(harness.workspace, 'bezprzeladowan', PROJECT);
  await openProject(harness.page, projectPath);
  await harness.page.waitForTimeout(600);

  // Select the image by clicking it on the canvas, exactly as a user would —
  // the click listeners live inside the iframe's own document.
  await harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    const image = frame.contentDocument!.querySelector('img')!;
    image.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  const altField = harness.page.getByLabel('Tekst alternatywny (alt)');
  await expect(altField).toBeVisible();

  await stampFrame();
  expect(await stampSurvived()).toBe(true);

  // Typed the way a person types: click in, select the old value, replace it.
  // One commit per character — the exact pattern that used to reload the page
  // once per keystroke.
  await altField.click();
  await harness.page.keyboard.press('Control+a');
  await altField.pressSequentially('Zdjecie zespolu', { delay: 30 });
  await harness.page.waitForTimeout(900);

  expect(await stampSurvived()).toBe(true);

  // The canvas is showing the new value, not a stale one.
  const altInCanvas = await harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    return frame.contentDocument!.querySelector('img')!.getAttribute('alt');
  });
  expect(altInCanvas).toBe('Zdjecie zespolu');

  await waitForFile(projectPath, 'index.html', (content) => content.includes('alt="Zdjecie zespolu"'));
});

test('zmiana treści elementu też jest łatką, a nie przeładowaniem', async () => {
  const projectPath = await writeProject(harness.workspace, 'tresc', PROJECT);
  await openProject(harness.page, projectPath);
  await harness.page.waitForTimeout(600);

  await harness.page.evaluate(() => window.__lithoTestHooks!.selectByText('Akapit'));

  const textField = harness.page.getByRole('textbox', { name: 'Tekst', exact: true });
  await expect(textField).toBeVisible();

  await stampFrame();

  await textField.fill('Zupełnie nowa treść');
  // The field commits on blur; clicking the panel heading is how a user leaves it.
  await textField.blur();
  await harness.page.waitForTimeout(800);

  expect(await stampSurvived()).toBe(true);

  const textInCanvas = await harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    return frame.contentDocument!.querySelector('p')!.textContent;
  });
  expect(textInCanvas).toBe('Zupełnie nowa treść');

  await waitForFile(projectPath, 'index.html', (content) => content.includes('Zupełnie nowa treść'));
});
