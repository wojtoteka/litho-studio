import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  /** Temporary directory holding the project and the app's user data. */
  workspace: string;
  close(): Promise<void>;
}

/**
 * Launches the built application against a throwaway user-data directory.
 *
 * A fresh `--user-data-dir` per run keeps the recent-projects list and any
 * cached state from leaking between tests, which is what makes the suite
 * order-independent.
 *
 * `extraEnv` overlays the computed environment, for tests that need to steer a
 * main-process switch the UI does not expose (e.g. `LITHO_TERMINAL_BACKEND`).
 */
export async function launchApp(extraEnv: Record<string, string> = {}): Promise<LaunchedApp> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'litho-e2e-'));
  const userDataDirectory = path.join(workspace, 'user-data');
  await fs.mkdir(userDataDirectory, { recursive: true });

  const app = await electron.launch({
    args: [
      path.join(repoRoot, 'dist/electron/main.cjs'),
      `--user-data-dir=${userDataDirectory}`,
      '--litho-enable-test-hooks',
      // Twelve Electron instances launched back-to-back can crash the GPU
      // process on Windows runners; a crashed renderer auto-reloads and the
      // test then dies with "execution context was destroyed". Software
      // rendering removes that whole failure class from the suite.
      '--disable-gpu',
    ],
    cwd: repoRoot,
    env: { ...buildLaunchEnv(), ...extraEnv },
  });

  // Mirror the app's own diagnostics into the test output — when a test dies
  // with "execution context was destroyed", the line that explains it (e.g.
  // "renderer process gone: <reason>") is in this stream, nowhere else.
  const mainOutput: string[] = [];
  const record = (chunk: Buffer | string): void => {
    mainOutput.push(String(chunk));
  };
  app.process().stdout?.on('data', record);
  app.process().stderr?.on('data', record);

  const page = await app.firstWindow();
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainOutput.push(`\n[e2e] MAIN FRAME NAVIGATED: ${frame.url()}\n`);
  });
  page.on('crash', () => mainOutput.push('\n[e2e] PAGE CRASHED\n'));
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    workspace,
    close: async () => {
      await app.close().catch(() => undefined);
      const interesting = mainOutput
        .join('')
        .split(/\r?\n/u)
        .filter((line) => /gone|crash|navigated|uncaught|error|zapis|błąd/iu.test(line));
      if (interesting.length > 0) {
        process.stdout.write(`[litho-main] ${interesting.join('\n[litho-main] ')}\n`);
      }
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Builds the environment for the Electron under test.
 *
 * `ELECTRON_RUN_AS_NODE` is stripped deliberately: when it is set — and it is
 * set inside any Electron-based terminal, which is easy to miss — Electron
 * launches as a bare Node process, rejects Chromium flags and never opens a
 * window. Inheriting it would make the suite fail with an error that looks
 * nothing like its cause.
 */
function buildLaunchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  env.NODE_ENV = 'test';
  // An empty value means "no dev server"; the app then loads the built files.
  env.LITHO_DEV_SERVER_URL = '';
  return env;
}

/**
 * Writes a project folder to disk.
 *
 * Tests pass in whatever file layout they want to exercise — CSS inline, CSS
 * external, several stylesheets — since being indifferent to that layout is the
 * behaviour under test.
 */
export async function writeProject(
  workspace: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const projectPath = path.join(workspace, name);
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(projectPath, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return projectPath;
}

/**
 * Polls a predicate with short, immediately-resolving evaluates.
 *
 * `waitForFunction`/`waitForSelector` hold one *long-pending* promise alive
 * only through the debugger; under Electron, V8 is free to garbage-collect
 * such a promise mid-wait, which surfaces as the protocol error "Promise was
 * collected" and fails the test as "execution context was destroyed". A chain
 * of sub-millisecond evaluates has no long-lived promise to collect.
 */
export async function waitForCondition(
  page: Page,
  predicate: () => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Przekroczono czas oczekiwania (${timeoutMs} ms): ${what}`);
}

/**
 * Opens a project through the real IPC path, bypassing only the native folder
 * picker (which Playwright cannot drive).
 *
 * The open itself is kicked off fire-and-forget and its outcome is parked on
 * `window` — the polling above then reads it with short evaluates, so no
 * debugger-held promise stays pending long enough to be collected.
 */
export async function openProject(page: Page, projectPath: string): Promise<void> {
  await waitForCondition(page, () => Boolean(window.__lithoTestHooks), 'hooki testowe');

  await page.evaluate((target: string) => {
    const hooks = window.__lithoTestHooks;
    if (!hooks) throw new Error('Hooki testowe nie są dostępne');
    const holder = window as { __lithoOpenOutcome?: string };
    holder.__lithoOpenOutcome = undefined;
    void hooks.openProject(target).then(
      () => {
        holder.__lithoOpenOutcome = 'ok';
      },
      (error: unknown) => {
        holder.__lithoOpenOutcome = `error: ${String(error)}`;
      },
    );
  }, projectPath);

  await waitForCondition(
    page,
    () => (window as { __lithoOpenOutcome?: string }).__lithoOpenOutcome !== undefined,
    'otwarcie projektu',
  );
  const outcome = await page.evaluate(() => (window as { __lithoOpenOutcome?: string }).__lithoOpenOutcome);
  if (outcome !== 'ok') throw new Error(`Nie udało się otworzyć projektu: ${outcome}`);

  await waitForCondition(page, () => document.querySelector('.canvas__frame') !== null, 'obszar edycji');
  await waitForCanvasReady(page);
}

/**
 * Waits until the canvas iframe has finished loading its document.
 *
 * The `<iframe>` *element* appears as soon as React renders it, but every
 * listener the canvas relies on — click-to-select, and crucially `drop` — is
 * attached by `Canvas.handleFrameLoad`, which runs on the frame's `load` event.
 * A test that dispatches a synthetic `drop` in the gap between those two moments
 * hits a document with no handler: the event is swallowed, nothing is written,
 * and the failure surfaces much later as a `waitForFile` timeout that says
 * nothing about the cause. Measured, that gap loses the drop reliably rather
 * than occasionally — it was simply narrow enough on some fixtures to look like
 * random flakiness.
 *
 * Every probe is a short, immediately-resolving `evaluate`, for the same reason
 * `waitForCondition` above is: anything that leaves a promise pending inside the
 * page — `requestAnimationFrame`, a timer, `waitForFunction` — can be
 * garbage-collected mid-wait under Electron and surfaces as "Promise was
 * collected".
 */
export async function waitForCanvasReady(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (frame) {
      // `.catch` because the frame can be swapped out mid-evaluate by a reload.
      const loaded = await frame.evaluate(() => document.readyState === 'complete').catch(() => false);
      if (loaded) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Obszar edycji nie zakończył wczytywania w ciągu ${timeoutMs} ms`);
}

/**
 * Presses at a point, drags by an offset and releases.
 *
 * Deliberately *not* `page.mouse.move(x, y, { steps: n })`. That form dispatches
 * all `n` moves back-to-back with no gap, and this suite runs Electron with
 * `--disable-gpu` (software rendering, see `launchApp`), where the canvas is
 * already competing for the main thread with guide recalculation and the
 * debounced style write that each move triggers. Measured on this machine, the
 * batched form failed 10–20 % of runs by timing out *inside* `mouse.move` — and
 * it did so before the visual redesign as well, so it is the gesture, not any
 * one feature, that is fragile.
 *
 * Yielding between steps lets the renderer drain the work each move creates,
 * which is what a human dragging a handle does implicitly.
 */
export async function dragBy(
  page: Page,
  from: { x: number; y: number },
  delta: { x: number; y: number },
  steps = 8,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (delta.x * step) / steps, from.y + (delta.y * step) / steps);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await page.mouse.up();
}

export async function readProjectFile(projectPath: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(projectPath, relPath), 'utf8');
}

/** Waits until a project file satisfies a predicate, or times out. */
export async function waitForFile(
  projectPath: string,
  relPath: string,
  predicate: (content: string) => boolean,
  timeoutMs = 12_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await readProjectFile(projectPath, relPath);
      if (predicate(last)) return last;
    } catch {
      // File may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Plik ${relPath} nie spełnił warunku w czasie ${timeoutMs} ms. Ostatnia treść:\n${last}`);
}
