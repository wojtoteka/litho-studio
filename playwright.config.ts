import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The tests drive a real Electron window against a real project folder on disk,
 * because that is the only way to verify the product's central claim: that
 * edits land in actual files. There is no dev server and no mocking - the app
 * under test is the built artifact from `npm run build`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Electron instances contend for the same user-data directory, so the suite
  // runs serially rather than fighting over it.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    // Tracing stays off: the trace snapshotter instruments every frame, and
    // the canvas is a sandboxed srcdoc iframe (no allow-scripts) rebuilt on
    // each edit - the instrumentation of those short-lived frames makes
    // `page.evaluate` die with "execution context was destroyed" at random.
    // The failure diagnostics that matter (app logs, main-process output) are
    // mirrored by the launch helper instead.
    trace: 'off',
  },
});
