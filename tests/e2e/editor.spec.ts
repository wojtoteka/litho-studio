import { expect, test } from '@playwright/test';
import { dragBy, launchApp, openProject, waitForFile, writeProject, type LaunchedApp } from './helpers.js';

/**
 * End-to-end scenarios, run against a real Electron window and real files.
 *
 * These follow the product's definition of done: open an existing folder that
 * the editor did not create, edit it visually, and confirm the *files on disk*
 * changed the way a developer would expect.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

/** A page with everything inline - the layout the editor must not assume. */
const INLINE_PROJECT = {
  'index.html': `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Strona testowa</title>
<style>
body { margin: 0; font-family: sans-serif }
.hero { padding: 40px; background: #eee }
.hero h1 { font-size: 36px }
</style>
</head>
<body>
<div class="hero">
<h1>Witaj świecie</h1>
<p class="stopka">© wojtoteka.ovh 2024-aktualna data</p>
</div>
<script>
console.info("kod uzytkownika");
</script>
</body>
</html>
`,
};

/** The same page split across several files, to prove layout-independence. */
const MULTIFILE_PROJECT = {
  'index.html': `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="css/base.css" />
    <link rel="stylesheet" href="css/theme.css" />
    <title>Wielopliki</title>
  </head>
  <body>
    <main class="tresc">
      <h1 class="tytul">Nagłówek</h1>
    </main>
    <script src="js/app.js"></script>
  </body>
</html>
`,
  'css/base.css': 'body { margin: 0; }\n',
  'css/theme.css': '.tytul { color: #333; }\n',
  'js/app.js': '// kod uzytkownika\nwindow.APP_READY = true;\n',
};

test('startuje i pokazuje ekran powitalny', async () => {
  const { page } = harness;

  await expect(page.locator('.start__title')).toHaveText('Litho Studio');
  // Opening an existing folder is the primary action, and it is the tile that
  // carries the brand gradient - see the note at the top of StartScreen.tsx.
  await expect(page.locator('.start-action--primary')).toContainText('Otwórz folder');
  // The product promise is stated on the first screen the user sees.
  await expect(page.locator('.start__subtitle')).toContainText('bez eksportu');
});

test('otwiera stronę z CSS i JS wpisanymi inline', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'inline', INLINE_PROJECT);

  await openProject(page, projectPath);

  // The canvas renders the real page.
  const frame = page.frameLocator('.canvas__frame');
  await expect(frame.locator('h1')).toHaveText('Witaj świecie');

  // The layer tree understands the structure without any editor markers.
  await page.getByRole('tab', { name: 'Warstwy' }).click();
  await expect(page.getByRole('tree')).toContainText('.hero');
});

test('wstawienie elementu zapisuje się do pliku na dysku wraz ze stylami szablonu', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'insert', INLINE_PROJECT);

  await openProject(page, projectPath);

  await page.getByRole('tab', { name: 'Elementy' }).click();
  await page
    .getByRole('button', { name: /Nagłówek/ })
    .first()
    .click();

  const html = await waitForFile(projectPath, 'index.html', (content) => content.includes('Nagłówek sekcji'));

  // The user's own content and their inline script survive untouched.
  expect(html).toContain('Witaj świecie');
  expect(html).toContain('kod uzytkownika');
  // The template's class arrives with its rules - into the page's own
  // embedded stylesheet, because that is where this project keeps CSS.
  expect(html).toContain('class="naglowek"');
  expect(html).toContain('.naglowek');
  // No project format was introduced, and no inline style was used.
  expect(html).not.toContain('data-litho-id');
});

test('zepsute odwołanie do CSS można naprawić z paska propozycji', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'broken-ref', {
    'index.html': `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>Przeniesiona</title>
    <link rel="stylesheet" href="css/style.css" />
  </head>
  <body>
    <h1 class="tytul">Nagłówek</h1>
  </body>
</html>
`,
    'assets/style.css': '.tytul { color: rgb(200, 0, 0); }\n',
  });

  await openProject(page, projectPath);

  // The banner lists the broken reference and proposes the real file.
  const banner = page.locator('.missing-refs');
  await expect(banner).toContainText('css/style.css');
  await expect(banner.locator('select')).toHaveValue('assets/style.css');

  await banner.getByRole('button', { name: 'Napraw odnośnik' }).click();

  // The HTML on disk now points at the chosen file, relative to the page.
  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('assets/style.css'),
  );
  expect(html).not.toContain('css/style.css');

  // The repaired stylesheet takes effect: the banner disappears and the canvas
  // renders the heading with the sheet's colour.
  await expect(banner).toHaveCount(0);
  const frame = page.frameLocator('.canvas__frame');
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(200, 0, 0)');
});

test('zamiana fragmentu tekstu na link zapisuje poprawny HTML', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'richtext', INLINE_PROJECT);

  await openProject(page, projectPath);

  // Drive the same store action the context menu invokes; the DOM selection
  // inside the canvas iframe is not addressable through Playwright's API.
  await page.evaluate(() => {
    const store = window.__lithoTestHooks;
    if (!store) throw new Error('Brak hooków testowych');
    store.applyTextActionByText('wojtoteka.ovh', 'convert-to-link', {
      href: 'https://wojtoteka.ovh',
      target: '',
      rel: '',
    });
  });

  const html = await waitForFile(projectPath, 'index.html', (content) => content.includes('<a href'));

  expect(html).toContain('href="https://wojtoteka.ovh"');
  expect(html).toContain('>wojtoteka.ovh</a>');
  // Only the selected fragment changed.
  expect(html).toContain('©');
  expect(html).toContain('2024-aktualna data');
});

test('zamiana na dynamiczny rok dopisuje JS w wydzielonej sekcji', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'dynamic-year', MULTIFILE_PROJECT);

  await openProject(page, projectPath);

  await page.evaluate(() => {
    const store = window.__lithoTestHooks;
    if (!store) throw new Error('Brak hooków testowych');
    store.applyTextActionByText('Nagłówek', 'dynamic-year', {
      startYear: 2024,
      separator: '-',
      elementId: 'copyright-year',
    });
  });

  const js = await waitForFile(projectPath, 'js/app.js', (content) => content.includes('getFullYear'));

  // The user's code is untouched and comes first.
  expect(js).toContain('window.APP_READY = true;');
  expect(js.indexOf('window.APP_READY')).toBeLessThan(js.indexOf('Litho Studio'));
  expect(js).toContain('copyright-year');

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('id="copyright-year"'),
  );
  expect(html).toContain('<span id="copyright-year"');
});

test('zmiana stylu trafia do ostatniego zapisywalnego arkusza', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'styles', MULTIFILE_PROJECT);

  await openProject(page, projectPath);

  await page.evaluate(() => {
    const store = window.__lithoTestHooks;
    if (!store) throw new Error('Brak hooków testowych');
    store.selectByText('Nagłówek');
    store.setStyleOnSelection({ 'font-size': '64px' });
  });

  const theme = await waitForFile(projectPath, 'css/theme.css', (content) => content.includes('64px'));
  expect(theme).toContain('.tytul');
  expect(theme).toContain('color: #333');

  // base.css must not have been rewritten.
  const base = await waitForFile(projectPath, 'css/base.css', () => true);
  expect(base.trim()).toBe('body { margin: 0; }');
});

test('projekt otwiera się ponownie bez utraty zmian', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'reopen', INLINE_PROJECT);

  await openProject(page, projectPath);

  await page.getByRole('tab', { name: 'Elementy' }).click();
  await page
    .getByRole('button', { name: /Przycisk/ })
    .first()
    .click();
  await waitForFile(projectPath, 'index.html', (content) => content.includes('Kliknij mnie'));

  // Close and reopen through the real IPC path.
  await page.evaluate(async () => {
    await window.litho.project.close();
  });
  await openProject(page, projectPath);

  const frame = page.frameLocator('.canvas__frame');
  await expect(frame.locator('button')).toHaveText('Kliknij mnie');
});

test('grupowanie zaznaczonych elementów owija je w <div>', async () => {
  const { page, workspace } = harness;
  const project = {
    'index.html': `<!doctype html>
<html lang="pl"><head><meta charset="utf-8" /><title>Grupa</title></head>
<body>
  <main class="tresc">
    <h2 class="a">Pierwszy</h2>
    <h2 class="b">Drugi</h2>
  </main>
</body></html>
`,
  };
  const projectPath = await writeProject(workspace, 'group', project);
  await openProject(page, projectPath);

  await page.evaluate(() => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Brak hooków testowych');
    hooks.selectManyByText(['Pierwszy', 'Drugi']);
    hooks.groupSelection();
  });

  const html = await waitForFile(projectPath, 'index.html', (content) => content.includes('grupa'));
  // Both siblings are now inside one wrapper div, in order, untouched.
  expect(html).toMatch(/<div class="grupa">[\s\S]*Pierwszy[\s\S]*Drugi[\s\S]*<\/div>/u);
});

test('kopiuj i wklej duplikuje element w plikach', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'clipboard', INLINE_PROJECT);
  await openProject(page, projectPath);

  await page.evaluate(() => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Brak hooków testowych');
    hooks.selectByText('Witaj świecie');
    hooks.copySelection();
    hooks.paste();
  });

  const html = await waitForFile(
    projectPath,
    'index.html',
    (content) => (content.match(/Witaj świecie/gu) ?? []).length >= 2,
  );
  // The original inline script and content are still intact.
  expect(html).toContain('kod uzytkownika');
});

test('zmiana rozmiaru zapisuje width/height do arkusza', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'resize', MULTIFILE_PROJECT);
  await openProject(page, projectPath);

  // The transform handles need a pointer; drive the same store action instead.
  await page.evaluate(() => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Brak hooków testowych');
    hooks.selectByText('Nagłówek');
    hooks.setStyleOnSelection({ width: '320px', height: '80px' });
  });

  const theme = await waitForFile(projectPath, 'css/theme.css', (content) => content.includes('320px'));
  expect(theme).toContain('width: 320px');
  expect(theme).toContain('height: 80px');
});

test('przeciągnięcie nagłówka przesuwa go, ale nie rusza akapitu pod nim', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'przesuwanie', INLINE_PROJECT);
  await openProject(page, projectPath);

  await page.evaluate(() => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Brak hooków testowych');
    hooks.selectByText('Witaj świecie');
  });

  const heading = page.frameLocator('.canvas__frame').locator('h1');
  const paragraph = page.frameLocator('.canvas__frame').locator('.stopka');
  const headingBefore = await heading.boundingBox();
  const paragraphBefore = await paragraph.boundingBox();
  if (!headingBefore || !paragraphBefore) throw new Error('Brak geometrii elementów strony');

  // A real drag of the move handle - the gesture under test is the pointer
  // path, not the store action it ends in. The delta is measured from the
  // handle's own centre (it sits above the *middle* of the selection box, not
  // its left edge), so the drag is exactly the 160×40 asserted below.
  const handle = page.locator('.transform__move');
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('Brak uchwytu przesuwania');
  const grabX = handleBox.x + handleBox.width / 2;
  const grabY = handleBox.y + handleBox.height / 2;
  await dragBy(page, { x: grabX, y: grabY }, { x: 160, y: 40 });

  // Relative, not absolute: the offset moves the heading while its box keeps
  // its place in the flow.
  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('position: relative'),
  );
  expect(html).toContain('position: relative');

  const headingAfter = await heading.boundingBox();
  const paragraphAfter = await paragraph.boundingBox();
  if (!headingAfter || !paragraphAfter) throw new Error('Brak geometrii elementów strony po przeciągnięciu');

  // The heading really moved (snap may adjust the landing point by a few px)…
  expect(headingAfter.x - headingBefore.x).toBeGreaterThan(100);
  // …and the paragraph under it did not budge, which is the whole point.
  expect(Math.abs(paragraphAfter.y - paragraphBefore.y)).toBeLessThan(2);
  expect(Math.abs(paragraphAfter.x - paragraphBefore.x)).toBeLessThan(2);
});

test('edytowalny breakpoint zmienia szerokość podglądu', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'breakpoints', INLINE_PROJECT);
  await openProject(page, projectPath);

  // Switch to Telefon, open the editor, change the canvas width.
  await page.getByRole('button', { name: /Telefon/ }).click();
  await page.getByRole('button', { name: 'Rozmiar' }).click();

  const widthInput = page.locator('.breakpoints__editor input').first();
  await widthInput.fill('414');

  // The canvas stage should resize to match.
  await expect(page.locator('.canvas__frame')).toHaveAttribute('width', '414');
});
