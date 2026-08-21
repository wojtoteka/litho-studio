import { expect, test } from '@playwright/test';
import { launchApp, openProject, readProjectFile, writeProject, type LaunchedApp } from './helpers.js';

/**
 * The canvas as a *window onto the page*, and the guarantees that depend on it.
 *
 * Both behaviours here were regressions found on real imported sites, so they
 * are pinned rather than left to manual checking: a page taller than the canvas
 * must keep the user's scroll position across the reload that every structural
 * edit performs, and no pending edit may be lost when the project closes.
 */

let harness: LaunchedApp;

test.beforeEach(async () => {
  harness = await launchApp();
});

test.afterEach(async () => {
  await harness?.close();
});

/**
 * Deliberately includes `scroll-behavior: smooth` and a viewport-sized hero.
 * Smooth scrolling makes a programmatic restore *animate*, and each frame of
 * that animation fires a scroll event - which is exactly what used to overwrite
 * the remembered position and creep the page back to the top.
 */
const TALL_PROJECT = {
  'index.html': `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Wysoka strona</title>
<style>
html { scroll-behavior: smooth }
body { margin: 0; font-family: sans-serif }
.hero { height: 100vh; background: #ddd }
.blok { height: 600px; padding: 24px }
</style>
</head>
<body>
<div class="hero"><h1>Nagłówek</h1></div>
<div class="blok"><p>Pierwszy blok</p></div>
<div class="blok"><p>Drugi blok</p></div>
<div class="blok"><p id="cel">Element na samym dole</p></div>
</body>
</html>
`,
};

async function frameScrollTop(): Promise<number> {
  return harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    return frame.contentDocument!.scrollingElement!.scrollTop;
  });
}

test('pozycja przewijania przeżywa edycję strukturalną', async () => {
  const projectPath = await writeProject(harness.workspace, 'wysoka', TALL_PROJECT);
  await openProject(harness.page, projectPath);

  // A viewport-sized hero also proves the frame never inflates itself: a canvas
  // sized from its own content would feed `100vh` back into the layout.
  const frameHeight = await harness.page.evaluate(
    () =>
      (document.querySelector('iframe.canvas__frame') as HTMLIFrameElement).getBoundingClientRect().height,
  );
  expect(frameHeight).toBeLessThan(4000);

  await harness.page.evaluate(() => {
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    frame.contentDocument!.scrollingElement!.scrollTo({
      top: 1200,
      behavior: 'instant' as ScrollBehavior,
    });
  });
  await harness.page.waitForTimeout(600);
  expect(await frameScrollTop()).toBe(1200);

  // A structural edit rebuilds the iframe document from scratch.
  await harness.page.evaluate(() => {
    window.__lithoTestHooks!.selectByText('Element na samym dole');
    window.__lithoTestHooks!.duplicateSelection();
  });
  await harness.page.waitForTimeout(2000);

  expect(await frameScrollTop()).toBe(1200);
});

test('canvas wypełnia obszar roboczy także po przeskalowaniu do breakpointu', async () => {
  const projectPath = await writeProject(harness.workspace, 'szeroka', TALL_PROJECT);
  await openProject(harness.page, projectPath);

  // A breakpoint far wider than the pane, so the canvas must scale down. Its
  // frame then has to grow *logically* by the same factor, or the scaled result
  // covers only that fraction of the work area and leaves the rest blank.
  // Done on Tablet rather than the base breakpoint, which has no width of its
  // own to widen - it always spans the work area (see the test below).
  await harness.page.getByRole('button', { name: /Tablet/ }).click();
  await harness.page.getByRole('button', { name: 'Rozmiar' }).click();
  const widthField = harness.page.getByLabel('Szerokość podglądu');
  await widthField.fill('3840');
  await widthField.dispatchEvent('change');
  await harness.page.waitForTimeout(800);

  const fill = await harness.page.evaluate(() => {
    const pane = document.querySelector('.canvas__viewport') as HTMLElement;
    const scaler = document.querySelector('.canvas__scaler') as HTMLElement;
    return {
      paneHeight: pane.clientHeight,
      scaledHeight: scaler.getBoundingClientRect().height,
    };
  });

  // 48 px is the pane's own padding; anything much short of that is the blank
  // dead zone this test exists to catch.
  expect(fill.scaledHeight).toBeGreaterThan(fill.paneHeight - 60);
});

/**
 * The base breakpoint emits no media query, so it has no width of its own: it
 * has to render at whatever the work area is, at 1:1, exactly like a browser
 * window. It used to be pinned to a stored 1440 px and scaled down to fit,
 * which showed the page smaller than the live preview of the same file.
 */
test('breakpoint bazowy zajmuje całą szerokość obszaru roboczego, bez skalowania', async () => {
  const projectPath = await writeProject(harness.workspace, 'pelna', TALL_PROJECT);
  await openProject(harness.page, projectPath);
  await harness.page.waitForTimeout(600);

  const layout = await harness.page.evaluate(() => {
    const pane = document.querySelector('.canvas__viewport') as HTMLElement;
    const frame = document.querySelector('iframe.canvas__frame') as HTMLIFrameElement;
    return {
      paneWidth: pane.clientWidth,
      // 48 px of padding is the only thing that may separate the two.
      frameWidth: frame.getBoundingClientRect().width,
      innerWidth: frame.contentWindow!.innerWidth,
    };
  });

  expect(layout.frameWidth).toBeGreaterThan(layout.paneWidth - 60);
  // Rendered 1:1: the page's own viewport matches the space it occupies on
  // screen, so `@media`/`vw` inside it agree with what the user sees.
  expect(Math.abs(layout.innerWidth - layout.frameWidth)).toBeLessThan(2);
});

/**
 * Selection overlays are drawn from rects measured inside the iframe, so an
 * element taller than the frame produces an overlay box that sticks out past
 * the stage. Unclipped, that box extends `.canvas__viewport`'s scroll range and
 * the work area grows a second scrollbar next to the page's own - appearing and
 * vanishing depending on which element happens to be selected.
 */
test('zaznaczenie wysokiego elementu nie tworzy drugiego paska przewijania', async () => {
  const projectPath = await writeProject(harness.workspace, 'paski', {
    'index.html': `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<title>Bardzo wysoki element</title>
<style>
body { margin: 0; font-family: sans-serif }
.kolumna { height: 3000px; width: 3000px; background: #eee }
</style>
</head>
<body>
<div class="kolumna">Bardzo wysoka kolumna</div>
</body>
</html>
`,
  });
  await openProject(harness.page, projectPath);
  await harness.page.waitForTimeout(600);

  // Far taller and wider than the frame, so its selection outline is drawn
  // well outside the stage in both directions.
  await harness.page.evaluate(() => {
    window.__lithoTestHooks!.selectByText('Bardzo wysoka kolumna');
  });
  await harness.page.waitForTimeout(500);

  const overflow = await harness.page.evaluate(() => {
    const pane = document.querySelector('.canvas__viewport') as HTMLElement;
    return {
      vertical: pane.scrollHeight - pane.clientHeight,
      horizontal: pane.scrollWidth - pane.clientWidth,
    };
  });

  expect(overflow.vertical).toBeLessThanOrEqual(1);
  expect(overflow.horizontal).toBeLessThanOrEqual(1);
});

test('zamknięcie projektu zapisuje edycje, które czekały w kolejce', async () => {
  const projectPath = await writeProject(harness.workspace, 'zapis', TALL_PROJECT);
  await openProject(harness.page, projectPath);

  // Edit and close immediately, without waiting for the debounce to elapse.
  await harness.page.evaluate(() => {
    window.__lithoTestHooks!.selectByText('Pierwszy blok');
    window.__lithoTestHooks!.duplicateSelection();
    window.__lithoTestHooks!.closeProject();
  });
  await harness.page.waitForTimeout(2500);

  const html = await readProjectFile(projectPath, 'index.html');
  expect(html.match(/Pierwszy blok/gu)?.length).toBe(2);
});
