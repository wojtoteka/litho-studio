import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  launchApp,
  openProject,
  waitForCondition,
  waitForFile,
  writeProject,
  type LaunchedApp,
} from './helpers.js';

/**
 * Uploading a stylesheet, and attaching a dynamic script to an element.
 *
 * Both features are only worth anything if they change the *files on disk* the
 * way a developer would expect, so the assertions read the project folder
 * rather than the app's own state.
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
      <p class="data-dnia">tu pojawi się data</p>
    </main>
    <script src="js/app.js"></script>
  </body>
</html>
`,
  'css/base.css': `body {\n  margin: 0;\n  font-family: sans-serif;\n}\n\n.tytul {\n  font-size: 32px;\n}\n`,
  'js/app.js': `console.info("kod użytkownika, którego nie wolno ruszać");\n`,
};

const UPLOADED_CSS = `.motyw-ciemny {
  background: #101018;
  color: #f4f4f8;
}

.przycisk-cta {
  padding: 12px 24px;
  border-radius: 999px;
}
`;

test('wgrany plik CSS trafia do projektu, do strony i do listy klas', async () => {
  const projectPath = await writeProject(harness.workspace, 'firma', PROJECT);
  // The uploaded file deliberately lives *outside* the project, like a file the
  // user downloaded — importing it must copy it in, not link to where it sits.
  const sourceCss = path.join(harness.workspace, 'pobrane', 'motyw.css');
  await fs.mkdir(path.dirname(sourceCss), { recursive: true });
  await fs.writeFile(sourceCss, UPLOADED_CSS, 'utf8');

  const { page } = harness;
  await openProject(page, projectPath);

  await page.getByRole('tab', { name: 'Zasoby' }).click();
  await page.locator('input[type="file"][accept*="css"]').setInputFiles(sourceCss);

  // The project keeps its CSS in css/, so the import must follow that layout
  // rather than inventing a second convention next to it.
  const copied = await waitForFile(projectPath, 'css/motyw.css', (content) =>
    content.includes('.motyw-ciemny'),
  );
  expect(copied).toContain('.przycisk-cta');

  const html = await waitForFile(projectPath, 'index.html', (content) => content.includes('css/motyw.css'));
  expect(html).toContain('rel="stylesheet"');
  // The original sheet must survive: an upload adds a sheet, it does not replace one.
  expect(html).toContain('css/base.css');

  await expect(page.locator('.sheet-list__name', { hasText: 'css/motyw.css' })).toBeVisible();

  // The point of the upload: the class names it defines become choosable in the
  // properties panel.
  await page.evaluate(() => window.__lithoTestHooks?.selectByText('Witaj w naszej firmie'));
  await page.getByRole('button', { name: 'Pokaż listę klas' }).click();
  await expect(page.getByRole('option', { name: 'motyw-ciemny' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'przycisk-cta' })).toBeVisible();
});

test('skrypt przypisany do elementu ląduje w pliku JS strony', async () => {
  const projectPath = await writeProject(harness.workspace, 'firma', PROJECT);
  const { page } = harness;
  await openProject(page, projectPath);

  await page.evaluate(() => window.__lithoTestHooks?.selectByText('tu pojawi się data'));

  // Before any script is attached, the "Treść" field is the normal way to edit
  // this element's text.
  const contentSection = page.locator('.props__section', { hasText: 'Treść' });
  await expect(contentSection).toBeVisible();

  const section = page.locator('.props__section', { hasText: 'Skrypt / Funkcja dynamiczna' });
  await section.locator('summary').click();

  // The page already has js/app.js, so nothing new may be invented for it.
  await expect(section).toContainText('istniejącego pliku strony: js/app.js');

  await section.getByLabel('Gotowa funkcja').selectOption({ label: 'Wyświetl aktualną datę' });
  await section.getByLabel('Tekst przed datą').fill('Dzisiaj jest ');

  // The live preview is the only feedback the editor can give (the canvas runs
  // no scripts); it must reflect the params before anything is even applied.
  await expect(section.locator('.script-preview__value')).toContainText('Dzisiaj jest ');

  await section.getByRole('button', { name: 'Zastosuj skrypt' }).click();

  const script = await waitForFile(projectPath, 'js/app.js', (content) => content.includes('litho-config'));

  // The user's own code is never touched — that is the whole contract of the
  // managed region.
  expect(script).toContain('kod użytkownika, którego nie wolno ruszać');
  expect(script).toContain('Intl.DateTimeFormat');
  expect(script).toContain('Dzisiaj jest ');
  expect(script).toContain('DOMContentLoaded');

  // The element must have gained the id the generated code looks up.
  const html = await waitForFile(projectPath, 'index.html', (content) => content.includes('id='));
  const domId = /id="([^"]+)"/u.exec(html)?.[1];
  expect(domId).toBeTruthy();
  expect(script).toContain(`document.getElementById("${domId}")`);

  // Re-selecting the element reads the binding back out of the generated file.
  await waitForCondition(
    page,
    () => document.querySelector('.script-section__status')?.textContent?.includes('Przypisano') === true,
    'panel pokazuje przypisany skrypt',
  );

  // With a script attached, manual text editing would just be overwritten on
  // the next "Zastosuj" — the field is replaced by an explanation instead.
  await expect(contentSection).not.toBeVisible();
  await expect(page.getByText('ustawia przypisany skrypt', { exact: false })).toBeVisible();

  // Applying again must replace the snippet, never append a second copy.
  await section.getByRole('button', { name: 'Zaktualizuj skrypt' }).click();
  await page.evaluate(() => window.__lithoTestHooks?.flushSave());
  const afterUpdate = await waitForFile(projectPath, 'js/app.js', (content) =>
    content.includes('litho-config'),
  );
  expect(afterUpdate.split('litho-config')).toHaveLength(2);

  await section.getByRole('button', { name: 'Usuń skrypt' }).click();
  const afterRemoval = await waitForFile(
    projectPath,
    'js/app.js',
    (content) => !content.includes('litho-config'),
  );
  expect(afterRemoval).toContain('kod użytkownika, którego nie wolno ruszać');

  // Removing the script gives the "Treść" field back.
  await expect(contentSection).toBeVisible();
});

test('strona bez pliku JS dostaje dokładnie jeden <script>, mimo dwóch skryptów', async () => {
  const projectPath = await writeProject(harness.workspace, 'bez-js', {
    'index.html': `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>Bez skryptów</title>
  </head>
  <body>
    <h1>Nagłówek strony</h1>
    <p>Miejsce na datę</p>
  </body>
</html>
`,
  });

  const { page } = harness;
  await openProject(page, projectPath);

  const section = page.locator('.props__section', { hasText: 'Skrypt / Funkcja dynamiczna' });

  await page.evaluate(() => window.__lithoTestHooks?.selectByText('Miejsce na datę'));
  await section.locator('summary').click();
  await expect(section).toContainText('zostanie utworzony script.js');

  // "Just the year": clearing the prefix on the year preset must preview a bare
  // year, which is the exact case the user reported could not be produced.
  await section.getByLabel('Gotowa funkcja').selectOption({ label: 'Aktualny rok (© 2026)' });
  await section.getByLabel('Tekst przed rokiem').fill('');
  await expect(section.locator('.script-preview__value')).toHaveText(String(new Date().getFullYear()));
  await section.getByLabel('Gotowa funkcja').selectOption({ label: 'Efekt maszyny do pisania' });

  await section.getByRole('button', { name: 'Zastosuj skrypt' }).click();
  await waitForFile(projectPath, 'script.js', (content) => content.includes('litho-config'));

  // A second element: the `<script src>` created a moment ago is in the document
  // but not yet in the re-parsed source list, so this is where a duplicate tag
  // used to appear.
  await page.evaluate(() => window.__lithoTestHooks?.selectByText('Nagłówek strony'));
  await section.getByLabel('Gotowa funkcja').selectOption({ label: 'Efekt maszyny do pisania' });
  await section.getByRole('button', { name: 'Zastosuj skrypt' }).click();
  await page.evaluate(() => window.__lithoTestHooks?.flushSave());

  const script = await waitForFile(projectPath, 'script.js', (content) => content.includes('setInterval'));
  expect(script.split('litho-config')).toHaveLength(3);

  const html = await waitForFile(projectPath, 'index.html', (content) => content.includes('script.js'));
  expect(html.split('<script').length - 1).toBe(1);
});

/**
 * Pseudo-class states.
 *
 * The point of the feature is that someone who has never written CSS can give a
 * button a hover colour, so the assertion is the one that matters to them: a
 * real `:hover` rule in their own stylesheet, and their normal-state rule left
 * exactly as it was.
 */
test('zmiana stylu w stanie „Najechanie" zapisuje regułę :hover, nie ruszając stanu normalnego', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'stany', PROJECT);
  await openProject(page, projectPath);

  const frame = page.frameLocator('.canvas__frame');
  await frame.locator('h1').click();

  // Set a normal-state colour first, so there is something to prove untouched.
  await page.getByRole('button', { name: 'Normalny' }).click();
  await page.evaluate(() => window.__lithoTestHooks?.setStyleOnSelection({ color: 'rgb(0, 0, 255)' }));
  await waitForFile(projectPath, 'css/base.css', (css) => css.includes('rgb(0, 0, 255)'));

  await page.getByRole('button', { name: 'Najechanie' }).click();
  await page.evaluate(() => window.__lithoTestHooks?.setStyleOnSelection({ color: 'rgb(255, 0, 0)' }));

  const css = await waitForFile(projectPath, 'css/base.css', (content) => content.includes(':hover'));

  // The hover rule carries only the hover colour…
  expect(css).toMatch(/\.tytul:hover\s*\{[^}]*color:\s*rgb\(255,\s*0,\s*0\)/u);
  // …and the plain rule keeps its own, plus the font-size that was there before.
  expect(css).toMatch(/\.tytul\s*\{[^}]*color:\s*rgb\(0,\s*0,\s*255\)/u);
  expect(css).toMatch(/\.tytul\s*\{[^}]*font-size:\s*32px/u);
});

/**
 * Page metadata (R3).
 *
 * With nothing selected the properties panel describes the *page*, which is the
 * only place a title, a description or a favicon can be set without opening the
 * HTML by hand. The assertion is on the file, because that is the whole point:
 * these tags are what a search engine and a chat preview read.
 */
test('panel strony zapisuje tytuł i opis do <head> prawdziwego pliku', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'meta', PROJECT);
  await openProject(page, projectPath);

  // Nothing is selected right after opening, so the page panel is on screen.
  const title = page.getByPlaceholder('np. Kowalski — stolarnia z Krakowa');
  await title.fill('Stolarnia Kowalski — meble na wymiar');
  await title.blur();

  const description = page.getByPlaceholder(/Jedno–dwa zdania/u);
  await description.fill('Robimy meble na wymiar w Krakowie od 1998 roku.');
  await description.blur();

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('name="description"'),
  );

  expect(html).toContain('<title>Stolarnia Kowalski — meble na wymiar</title>');
  expect(html).toContain('Robimy meble na wymiar w Krakowie od 1998 roku.');
  // Open Graph is mirrored, so a pasted link is not blank.
  expect(html).toContain('property="og:title"');
  expect(html).toContain('property="og:description"');
  // And the page itself is untouched.
  expect(html).toContain('Witaj w naszej firmie');
});

/**
 * Shared sections (R1).
 *
 * The feature only means anything if editing the menu on one page rewrites the
 * *other pages' files* — so that is exactly what this asserts, along with the
 * promise that the mechanism stays a plain HTML comment.
 */
test('wspólna sekcja z jednej podstrony aktualizuje pozostałe pliki', async () => {
  const { page, workspace } = harness;
  const NAV = `<header class="menu"><a href="index.html">MenuGlowne</a></header>`;
  const projectPath = await writeProject(workspace, 'wspolne', {
    'index.html': `<!doctype html>
<html lang="pl"><head><meta charset="utf-8" /><title>Start</title></head>
<body>
  <!-- litho:shared nav -->
  ${NAV}
  <!-- /litho:shared -->
  <main><h1>Strona startowa</h1></main>
</body></html>
`,
    'kontakt.html': `<!doctype html>
<html lang="pl"><head><meta charset="utf-8" /><title>Kontakt</title></head>
<body>
  <!-- litho:shared nav -->
  ${NAV}
  <!-- /litho:shared -->
  <main><h1>Napisz do nas</h1></main>
</body></html>
`,
  });

  await openProject(page, projectPath);

  // Duplicate the link inside the shared menu — a structural change to the
  // block, which is exactly what has to travel to the other page.
  await page.evaluate(() => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Brak hooków testowych');
    hooks.selectByText('MenuGlowne');
    hooks.duplicateSelection();
  });

  const other = await waitForFile(
    projectPath,
    'kontakt.html',
    (content) => (content.match(/MenuGlowne/gu) ?? []).length >= 2,
  );

  // The other page received the change…
  expect((other.match(/MenuGlowne/gu) ?? []).length).toBeGreaterThanOrEqual(2);
  // …kept its own content and title…
  expect(other).toContain('Napisz do nas');
  expect(other).toContain('<title>Kontakt</title>');
  // …and the mechanism is still a plain comment, so the file stays a plain page.
  expect(other).toContain('<!-- litho:shared nav -->');
  expect(other).toContain('<!-- /litho:shared -->');
});
