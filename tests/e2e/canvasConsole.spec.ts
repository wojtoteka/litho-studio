import { test, expect } from '@playwright/test';
import { launchApp, writeProject, openProject } from './helpers.js';

test('a broken resource on the edited page surfaces in the in-app console panel', async () => {
  const { page, workspace, close } = await launchApp();
  try {
    const projectPath = await writeProject(workspace, 'broken-image', {
      'index.html': `<!doctype html><html><body><img src="http://this-domain-does-not-exist.invalid/x.png"></body></html>`,
    });

    await openProject(page, projectPath);
    await page.getByTitle(/Panel logów/).click();

    await expect(
      page.locator('.console__entry', { hasText: 'this-domain-does-not-exist.invalid' }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await close();
  }
});
