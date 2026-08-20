import { expect, test } from '@playwright/test';
import { launchApp, openProject, writeProject, type LaunchedApp } from './helpers.js';

/**
 * The two escape hatches around the "poza układem" warning, driven through the
 * real window: dismissing the warning for an element that is positioned on
 * purpose, and clearing the selection from the properties panel.
 *
 * Both were reported as "not there" after they had been written and built, so
 * they are pinned here — a passing unit suite said nothing about whether the
 * buttons actually render in the running application.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

/** A badge pinned to pixels — exactly the shape the warning is about. */
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

test('licznik „poza układem" pozwala zignorować pojedynczy element', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'przypiete', PINNED_PROJECT);
  await openProject(page, projectPath);

  const counter = page.locator('.breakpoints__warning');
  await expect(counter).toHaveText(/1 element poza układem/u);

  await counter.click();
  const list = page.locator('.outofflow');
  await expect(list).toBeVisible();
  await expect(list.locator('.outofflow__name')).toContainText('Nowość w ofercie');

  const ignore = list.getByRole('button', { name: 'Ignoruj ten błąd' });
  await expect(ignore).toBeVisible();
  await ignore.click();

  // The last offender is gone, so both the count and its popover disappear.
  await expect(counter).toHaveCount(0);
  await expect(list).toHaveCount(0);
});

test('panel właściwości oferuje „Ignoruj" i cofnięcie tego', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'przypiete', PINNED_PROJECT);
  await openProject(page, projectPath);

  await page.evaluate(() => window.__lithoTestHooks?.selectByText('Nowość w ofercie'));

  const warning = page.locator('.layout-warning');
  await expect(warning).toBeVisible();

  await warning.getByRole('button', { name: 'Ignoruj' }).click();

  const ignored = page.locator('.layout-warning--ignored');
  await expect(ignored).toContainText('zignorowane');
  await expect(page.locator('.breakpoints__warning')).toHaveCount(0);

  await ignored.getByRole('button', { name: 'Przestań ignorować' }).click();
  await expect(page.locator('.layout-warning--ignored')).toHaveCount(0);
  await expect(page.locator('.breakpoints__warning')).toHaveText(/1 element poza układem/u);
});

test('panel właściwości pozwala odznaczyć element', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'przypiete', PINNED_PROJECT);
  await openProject(page, projectPath);

  await page.evaluate(() => window.__lithoTestHooks?.selectByText('Nagłówek strony'));
  await expect(page.locator('.props__breadcrumb')).toBeVisible();

  await page.getByRole('button', { name: 'Odznacz element' }).click();

  await expect(page.locator('.props__breadcrumb')).toHaveCount(0);
  await expect(page.evaluate(() => window.__lithoTestHooks !== undefined)).resolves.toBe(true);
});
