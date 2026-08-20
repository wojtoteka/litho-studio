import { expect, test } from '@playwright/test';
import { launchApp, openProject, waitForFile, writeProject, type LaunchedApp } from './helpers.js';

/**
 * Reusable styles, end to end: name a style, click its properties, assign it to
 * an element from the properties panel.
 *
 * The assertions read the project folder, because that is the only thing that
 * matters — the feature is worth nothing if the rule and the `class` attribute
 * do not land in the user's own CSS and HTML.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

const PROJECT = {
  'index.html': `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="css/base.css" />
    <title>Strona firmowa</title>
  </head>
  <body>
    <main class="tresc">
      <h1 class="tytul">Witaj w naszej firmie</h1>
      <p>Krótkie wprowadzenie do oferty.</p>
    </main>
  </body>
</html>
`,
  'css/base.css': `body {\n  margin: 0;\n  font-family: sans-serif;\n}\n`,
};

test('własna klasa CSS: utworzenie, właściwości i przypisanie do elementu', async () => {
  const projectPath = await writeProject(harness.workspace, 'firma', PROJECT);
  const { page } = harness;
  await openProject(page, projectPath);

  /* 1. Name the style. */
  await page.getByRole('tab', { name: 'Style' }).click();
  await page.getByPlaceholder('np. page-intro').fill('page-intro');
  await page.getByRole('button', { name: 'Utwórz', exact: true }).click();

  // The rule exists in the project's own stylesheet from the moment it is named.
  await waitForFile(projectPath, 'css/base.css', (content) => content.includes('.page-intro'));

  /* 2. Click its properties — creating a style opens it for editing straight away. */
  const editor = page.locator('.styles__editor');
  await expect(editor).toBeVisible();
  // "Wygląd" is open from the start — colour and background are what people
  // reach for first. "Typografia" is still a collapsed `<details>`.
  await editor.getByLabel('Kolor tekstu — wartość CSS').fill('#666666');
  await editor.getByText('Typografia', { exact: true }).click();
  await editor.getByRole('textbox', { name: 'Rozmiar tekstu' }).fill('18px');

  const css = await waitForFile(
    projectPath,
    'css/base.css',
    (content) => content.includes('font-size: 18px') && content.includes('#666666'),
  );
  expect(css).toMatch(/\.page-intro\s*\{/u);

  /* 2b. The raw-CSS box is hand-editable and writes back to the file. */
  const rawBox = editor.getByRole('textbox', { name: /Zapis w arkuszu CSS/u });
  await rawBox.fill('.page-intro {\n  color: #333333;\n  letter-spacing: 0.02em;\n}');
  await editor.getByText('Nazwa klasy', { exact: true }).click(); // blur the textarea to commit
  await waitForFile(
    projectPath,
    'css/base.css',
    (content) => content.includes('letter-spacing: 0.02em') && content.includes('#333333'),
  );

  /* 3. Pick the style on an element, from the properties panel. */
  await page.evaluate(() => window.__lithoTestHooks?.selectByText('Krótkie wprowadzenie do oferty.'));
  await page.getByRole('button', { name: 'Pokaż listę klas' }).click();
  await page.getByRole('option', { name: 'page-intro' }).click();

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('class="page-intro"'),
  );
  // Assigning a style must not disturb the markup around it.
  expect(html).toContain('class="tytul"');
});
