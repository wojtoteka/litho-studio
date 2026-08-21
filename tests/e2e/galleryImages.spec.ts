import { expect, test } from '@playwright/test';
import { launchApp, openProject, waitForFile, writeProject, type LaunchedApp } from './helpers.js';

/**
 * Filling a gallery with your own photos.
 *
 * The complaint this covers was "you can't put an image into the gallery": the
 * properties panel offered only a text field for `src`, so the job meant typing
 * six project-relative paths by hand and knowing the convention for them. The
 * behaviour under test is the whole path a user actually takes - click a tile
 * on the canvas, click a thumbnail - ending where it has to end, in the file on
 * disk.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

/** A 1x1 red PNG - a real decodable image, so the thumbnail is not a broken icon. */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('binary');

const GALLERY_PROJECT = {
  'index.html': `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Galeria</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<section class="ls-gallery">
<img class="ls-gallery__item" src="assets/placeholder.svg" alt="" width="10" height="10">
<img class="ls-gallery__item" src="assets/placeholder.svg" alt="">
</section>
</body>
</html>
`,
  'style.css': `.ls-gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 24px; }
.ls-gallery__item { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; }
`,
  'assets/placeholder.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ccc"/></svg>`,
  'assets/kot.png': RED_PNG,
};

test('podmienia zdjęcie w galerii przez wybór miniatury w panelu', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'galeria', GALLERY_PROJECT);

  await openProject(page, projectPath);

  const frame = page.frameLocator('.canvas__frame');
  await expect(frame.locator('img').first()).toBeVisible();

  // Select the first tile the way a user does: by clicking it on the canvas.
  await frame.locator('img').first().click();

  // The picker offers what is already in assets/ - no path to type, no detour
  // through the Zasoby panel.
  const pick = page.getByRole('button', { name: 'Ustaw obraz: kot.png' });
  await expect(pick).toBeVisible();
  await pick.click();

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('src="assets/kot.png"'),
  );

  // The tile now points at the chosen file, and the *other* tile is untouched.
  expect(html).toContain('src="assets/kot.png"');
  expect(html).toContain('src="assets/placeholder.svg"');
  // The previous picture's intrinsic size must not survive onto a different
  // image - 10x10 belonged to the placeholder.
  expect(html).not.toContain('width="10"');
  // Nothing about the editor leaks into the markup.
  expect(html).not.toContain('data-litho');
});

test('upuszczenie zdjęcia na kafelek galerii podmienia je zamiast kłaść nowe na wierzchu', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'przeciaganie', GALLERY_PROJECT);

  await openProject(page, projectPath);

  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  expect(frame).toBeTruthy();

  // Released over the *second* tile. The drop carries the payload the assets
  // panel puts on every drag; the canvas decides what to do with it purely from
  // that plus where the pointer is, which is what makes this reproducible.
  await frame!.evaluate(() => {
    const image = document.querySelectorAll('img')[1]!;
    const box = image.getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.setData(
      'application/x-litho-drag',
      JSON.stringify({ kind: 'asset', relPath: 'assets/kot.png', width: 1, height: 1 }),
    );
    image.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
  });

  const html = await waitForFile(projectPath, 'index.html', (content) =>
    content.includes('src="assets/kot.png"'),
  );

  // The *second* tile changed, the first did not, and no extra <img> was added.
  expect(html.match(/<img/gu)).toHaveLength(2);
  expect(html).toContain('src="assets/placeholder.svg"');
  // A replaced tile keeps its place in the grid - nothing gets torn out of flow.
  expect(html).not.toContain('position: absolute');
});

test('zmienia tło zaznaczonej sekcji i zapisuje regułę do arkusza', async () => {
  const { page, workspace } = harness;
  const projectPath = await writeProject(workspace, 'tlo', GALLERY_PROJECT);

  await openProject(page, projectPath);

  const frame = page.frameLocator('.canvas__frame');
  await expect(frame.locator('.ls-gallery')).toBeVisible();
  await frame.locator('.ls-gallery').click();

  // "Kolor tła" is a colour picker paired with a text input, because CSS
  // colours a native picker cannot express have to stay typeable.
  await page.getByRole('textbox', { name: 'Kolor tła - wartość CSS' }).fill('#101828');

  const css = await waitForFile(projectPath, 'style.css', (content) => content.includes('#101828'));
  expect(css).toContain('background-color: #101828');
});
