import { expect, test } from '@playwright/test';
import { launchApp, openProject, writeProject, type LaunchedApp } from './helpers.js';

/**
 * "Open the out-of-layout list while previewing and nothing appears."
 *
 * The live preview is a native `WebContentsView`, composited above the whole
 * document - no `z-index` can put a menu in front of it. The list *was* being
 * rendered, behind the previewed page, which is indistinguishable from a button
 * that does nothing. Only modal dialogs used to stand the view down; every
 * menu, popover and dropdown that drops out of the bars over the work area had
 * the same problem and no such handling.
 *
 * Driven through the real window because that is the only place the bug exists:
 * a DOM-only check sees the popover perfectly, since the native view is not in
 * the DOM at all. What is asserted instead is the remedy - that the preview
 * stands its view down (and says so) for exactly as long as something covers
 * it, and not a moment longer.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

/** A badge pinned to pixels, so the "poza układem" warning has something to count. */
const PINNED_PROJECT = {
  'index.html': `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Przypięty element</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="hero">
<h1>Nagłówek strony</h1>
<div class="odznaka">Nowość w ofercie</div>
</div>
</body>
</html>
`,
  'style.css': `body { margin: 0; }
.hero { padding: 40px; position: relative; }
.odznaka { position: absolute; left: 40px; top: 20px; }
`,
};

test('lista „poza układem" wypycha podgląd, zamiast chować się za nim', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'przykrywanie', PINNED_PROJECT);
  await openProject(page, projectPath);

  // "Przeglądanie" puts the native view directly under the bars, which is the
  // reported case: the list drops out of the bar straight onto it.
  await page.getByRole('button', { name: 'Przeglądanie' }).click();
  await page.waitForTimeout(1200);

  const paused = page.locator('.preview__paused');
  await expect(paused).toHaveCount(0);

  const counter = page.locator('.breakpoints__warning');
  await counter.click();

  const list = page.locator('.outofflow');
  await expect(list).toBeVisible();

  // The list genuinely reaches over the previewed page - otherwise this test
  // would pass on a layout where there was never anything to fix.
  const overlaps = await page.evaluate(() => {
    const popover = document.querySelector('.outofflow')?.getBoundingClientRect();
    const surface = document.querySelector('.preview__surface')?.getBoundingClientRect();
    if (!popover || !surface) return false;
    return (
      popover.left < surface.right &&
      popover.right > surface.left &&
      popover.top < surface.bottom &&
      popover.bottom > surface.top
    );
  });
  expect(overlaps).toBe(true);

  await expect(paused).toBeVisible();

  // Closing brings the page straight back - the stand-down lasts exactly as
  // long as the thing covering it.
  await counter.click();
  await expect(list).toHaveCount(0);
  await expect(paused).toHaveCount(0);
});

test('podgląd gaśnie tylko pod tym, co go faktycznie zasłania', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'obok-siebie', PINNED_PROJECT);
  await openProject(page, projectPath);

  // Side by side this time: the preview is a column of its own, so whether a
  // menu reaches it depends on where the menu is - which is the distinction
  // being pinned. Standing the view down for *any* open menu would blink the
  // pane every time the ☰ panel was opened on the far side of the window.
  await page.getByRole('button', { name: 'Podgląd', exact: true }).click();
  await page.waitForTimeout(1200);

  const paused = page.locator('.preview__paused');
  await expect(paused).toHaveCount(0);

  await page.locator('.app-menu__trigger').click();
  const panel = page.locator('.app-menu__panel');
  await expect(panel).toBeVisible();

  const overlaps = await page.evaluate(() => {
    const menu = document.querySelector('.app-menu__panel')?.getBoundingClientRect();
    const surface = document.querySelector('.preview__surface')?.getBoundingClientRect();
    if (!menu || !surface) return false;
    return (
      menu.left < surface.right &&
      menu.right > surface.left &&
      menu.top < surface.bottom &&
      menu.bottom > surface.top
    );
  });

  // Whichever way the window happened to be laid out, the rule is the same:
  // the page keeps playing unless something is genuinely on top of it.
  if (overlaps) await expect(paused).toBeVisible();
  else await expect(paused).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(paused).toHaveCount(0);
});
