import { expect, test } from '@playwright/test';
import { launchApp, openProject, writeProject, type LaunchedApp } from './helpers.js';

/**
 * "The preview renders the page bigger than the editor - they should be
 * symmetrical."
 *
 * Side by side, the two halves are meant to be the same page at the same size:
 * that is the entire value of having them side by side. Two things pulled them
 * apart. The canvas loses a slice of its work area to the page's own scrollbar
 * (`clientWidth` excludes it) while the preview pane does not, so the previewed
 * page was laid out a scrollbar wider. And the bars above the canvas - the
 * breakpoint switcher, the warnings - sat inside the editor column only, so the
 * editor's half also started lower and showed a shorter slice of the page.
 *
 * Both are measured here rather than eyeballed, because "a bit bigger" is
 * exactly the kind of regression that survives a screenshot review.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

/** Tall enough to give the canvas a vertical scrollbar - the width thief. */
const PROJECT = {
  'index.html': `<!DOCTYPE html>
<html lang="pl">
<head><meta charset="utf-8"><title>Strona</title><link rel="stylesheet" href="style.css"></head>
<body>
<h1>Nagłówek</h1>
<div class="blok"><p>Pierwszy</p></div>
<div class="blok"><p>Drugi</p></div>
<div class="blok"><p>Trzeci</p></div>
</body>
</html>
`,
  'style.css': 'body { margin: 0 } .blok { height: 700px; padding: 24px }\n',
};

test('podgląd obok edytora pokazuje stronę w tej samej ramce', async () => {
  const projectPath = await writeProject(harness.workspace, 'symetria', PROJECT);
  await openProject(harness.page, projectPath);
  await harness.page.waitForTimeout(700);

  await harness.page.getByRole('button', { name: 'Podgląd' }).click();
  // The native view is laid out from this element's box; give the observers and
  // the IPC round trip time to settle before measuring.
  await harness.page.waitForTimeout(1500);

  const boxes = await harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    const surface = document.querySelector('.preview__surface') as HTMLElement;
    return {
      canvas: frame.getBoundingClientRect(),
      preview: surface.getBoundingClientRect(),
    };
  });

  // Same width: the page sees the same viewport in both halves, so its media
  // queries resolve the same way and nothing renders larger on one side.
  expect(Math.abs(boxes.canvas.width - boxes.preview.width)).toBeLessThanOrEqual(1);

  // Same vertical extent: neither half shows more of the page than the other.
  expect(Math.abs(boxes.canvas.top - boxes.preview.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxes.canvas.height - boxes.preview.height)).toBeLessThanOrEqual(1);
});

test('powiększenie działa w trybie Przeglądanie', async () => {
  const projectPath = await writeProject(harness.workspace, 'zoom', PROJECT);
  await openProject(harness.page, projectPath);
  await harness.page.waitForTimeout(700);

  await harness.page.getByRole('button', { name: 'Przeglądanie' }).click();
  await harness.page.waitForTimeout(800);

  // The zoom readout is a menu; 50 % is one of its presets.
  await harness.page.getByRole('button', { name: /%$/u }).first().click();
  await harness.page.getByRole('menuitem', { name: '50%', exact: true }).click();
  await harness.page.waitForTimeout(600);

  // It used to do nothing at all here: the canvas draws into a CSS-scaled
  // stage, which the native preview view is not part of.
  await expect(harness.page.getByRole('button', { name: /50%/u }).first()).toBeVisible();
  await expect(harness.page.locator('.preview__label')).toContainText('50%');
});
