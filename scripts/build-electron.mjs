#!/usr/bin/env node
/**
 * Bundles the Electron main process and preload script with esbuild.
 *
 * Both are emitted as CommonJS (`.cjs`) because Electron's main process loader
 * and `sandbox`-compatible preload scripts are most reliable in CJS, while the
 * repository itself is an ES module package.
 */
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  sourcemap: dev ? 'inline' : true,
  minify: !dev,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
  alias: {
    '@shared': path.join(root, 'shared'),
  },
  // Electron and native/optional modules stay external and are resolved from
  // node_modules at runtime (electron-builder ships them via `files`).
  // `node-pty` is additionally native (a `.node` binary rebuilt against
  // Electron's ABI by the `postinstall` script) - bundling it would strip
  // that binary reference entirely.
  external: ['electron', 'electron-log', 'chokidar', 'fsevents', 'prettier', 'node-pty'],
};

const targets = [
  { entry: 'electron/main.ts', outfile: 'dist/electron/main.cjs' },
  { entry: 'electron/preload.ts', outfile: 'dist/electron/preload.cjs' },
];

async function run() {
  const contexts = await Promise.all(
    targets.map((target) =>
      esbuild.context({
        ...shared,
        entryPoints: [path.join(root, target.entry)],
        outfile: path.join(root, target.outfile),
      }),
    ),
  );

  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
    process.stdout.write('[build-electron] watching for changes\n');
    return;
  }

  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}

run().catch((error) => {
  process.stderr.write(`[build-electron] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
