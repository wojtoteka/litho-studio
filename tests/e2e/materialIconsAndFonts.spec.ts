import { expect, test } from '@playwright/test';
import {
  dragBy,
  launchApp,
  openProject,
  readProjectFile,
  waitForFile,
  writeProject,
  type LaunchedApp,
} from './helpers.js';

/**
 * Icon library (Material Symbols) and Google Fonts font picker.
 *
 * Both features reference Google's CDN rather than bundling font files (see
 * `src/lib/googleFonts.ts`), so the thing worth proving end-to-end is that
 * picking an icon or a font writes both the `<link>` the page needs to load
 * it *and* the element/declaration that uses it - into the real file.
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
    <title>Strona testowa</title>
  </head>
  <body>
    <h1 class="tytul">Nagłówek</h1>
  </body>
</html>
`,
};

test('wstawienie ikony Material Symbols dodaje span i link do czcionki', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'icons', PROJECT);

  await openProject(page, projectPath);

  await page.getByRole('tab', { name: 'Ikony' }).click();
  await page.getByPlaceholder('Szukaj ikony… (np. accessible_forward)').fill('accessible_forward');
  await page.getByRole('button', { name: 'accessible_forward', exact: true }).click();

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('accessible_forward'),
  );

  expect(html).toContain('class="material-symbols-outlined"');
  expect(html).toContain('>accessible_forward<');
  expect(html).toContain('fonts.googleapis.com/css2?family=Material+Symbols+Outlined');
});

test('wybranie czcionki Google Fonts w panelu Style dodaje link i font-family', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'fonts', PROJECT);

  await openProject(page, projectPath);

  const frame = page.frameLocator('.canvas__frame');
  await frame.locator('h1').click();

  await page.getByText('Typografia').click();
  await page
    .getByRole('combobox')
    .filter({ hasText: 'wybierz z Google Fonts' })
    .selectOption({ label: 'Poppins' });

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('fonts.googleapis.com'),
  );
  expect(html).toContain('fonts.googleapis.com/css2?family=Poppins');

  const css = await readProjectFile(projectPath, 'style.css');
  expect(css).toMatch(/font-family:\s*["']Poppins["'],\s*sans-serif/);
});

test('przeciągnięcie ikony na stronę umieszcza ją dokładnie pod kursorem', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'icons-dnd', PROJECT);

  await openProject(page, projectPath);

  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  expect(frame).toBeTruthy();

  await frame!.evaluate(() => {
    const h1 = document.querySelector('h1')!;
    const box = h1.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.setData(
      'application/x-litho-drag',
      JSON.stringify({ kind: 'icon', iconName: 'home', style: 'outlined' }),
    );
    h1.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: box.right + 40,
        clientY: box.bottom + 40,
      }),
    );
  });

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('material-symbols-outlined'),
  );
  expect(html).toContain('>home<');

  // Free-drop placement writes position/left/top to the sheet, keyed by the
  // id `placeFreeElement` allocates - unlike click-insert, which appends to the flow.
  const css = await readProjectFile(projectPath, 'style.css');
  expect(css).toMatch(/position:\s*absolute/);
});

/*
 * The only test in the suite that depends on a real, sustained pointer gesture
 * rather than on a click or an evaluate - and the only one that has ever been
 * flaky. Measured before any of this: 8/10 with the old stylesheet, 9/10 with
 * the new one, i.e. the gesture, not the styling.
 *
 * Two mitigations, in order of importance: `dragBy` yields between moves so the
 * renderer can drain the guide/style work each one queues (see helpers.ts), and
 * `test.slow()` triples the budget because software rendering - the suite runs
 * with `--disable-gpu` - makes the whole gesture genuinely slow rather than
 * merely occasionally slow. The retry below is the backstop the two of them do
 * not quite make unnecessary: 24 consecutive isolated runs passed afterwards,
 * but one full-suite run (~25 Electron launches deep) still lost it.
 *
 * Scoped to this file's slowest case on purpose. A blanket retry would hide a
 * real regression somewhere else.
 */
test.describe.configure({ retries: 1 });

test('uchwyt zmiany rozmiaru skaluje ikonę przez font-size, a nie ramkę', async () => {
  test.slow();
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'icons-resize', PROJECT);

  await openProject(page, projectPath);

  await page.getByRole('tab', { name: 'Ikony' }).click();
  await page.getByPlaceholder('Szukaj ikony… (np. accessible_forward)').fill('accessible_forward');
  await page.getByRole('button', { name: 'accessible_forward', exact: true }).click();
  await waitForFile(projectPath, 'index.html', (content) => content.includes('accessible_forward'));

  await page.evaluate(() => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Brak hooków testowych');
    hooks.selectByText('accessible_forward');
  });

  const icon = page.frameLocator('.canvas__frame').locator('.material-symbols-outlined');
  const sizeBefore = await icon.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

  // A real drag of the south-east handle - the gesture is the thing under test:
  // an icon is a glyph, so pulling its corner has to scale the glyph itself.
  const handle = page.locator('.transform__handle--se');
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('Brak uchwytu zmiany rozmiaru');
  await dragBy(
    page,
    { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 },
    { x: 60, y: 60 },
  );

  await expect
    .poll(() => icon.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)))
    .toBeGreaterThan(sizeBefore);

  const css = await waitForFile(projectPath, 'style.css', (content) =>
    /#[\w-]+\s*\{[^}]*font-size:/u.test(content),
  );
  // The icon's own size lands on its own hook - never in the library's shared
  // `.material-symbols-*` rule, which every icon on the page uses - and the
  // resize writes no width/height, which would only pad the box around a glyph
  // that never grew.
  expect(css).not.toMatch(/\.material-symbols-outlined\s*\{[^}]*font-size:\s*(?!24px)\d+px/u);
  expect(css).not.toMatch(/#[\w-]+\s*\{[^}]*\bwidth:/u);
});

test('wgranie własnej czcionki .ttf pozwala wstawić niestandardową ikonę', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'custom-font', PROJECT);

  await openProject(page, projectPath);

  await page.getByRole('tab', { name: 'Ikony' }).click();

  // A minimal but structurally valid empty TTF (sfnt header only) - the
  // pipeline under test is file plumbing (asset import → @font-face → insert),
  // not font parsing, so the browser never has to actually shape a glyph.
  const ttfBytes = Buffer.from('00010000000A0080000300' + '0'.repeat(200), 'hex');

  const fileInput = page.locator('input[type="file"][accept=".ttf,.otf"]');
  await fileInput.setInputFiles({ name: 'moje-ikony.ttf', mimeType: 'font/ttf', buffer: ttfBytes });

  await expect(page.getByText('moje ikony', { exact: false })).toBeVisible({ timeout: 10_000 });

  const glyphInput = page.getByPlaceholder('Znak ikony');
  await glyphInput.fill('X');
  await page.getByTitle('Wstaw ikonę: moje ikony').click();

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('ikona-moje-ikony'),
  );
  expect(html).toContain('>X<');

  const css = await readProjectFile(projectPath, 'style.css');
  expect(css).toContain('@font-face');
  expect(css).toMatch(/font-family:\s*"moje ikony"/);
  expect(css).toContain('assets/moje-ikony.ttf');

  const assetExists = await readProjectFile(projectPath, 'assets/moje-ikony.ttf').then(
    () => true,
    () => false,
  );
  expect(assetExists).toBe(true);
});
