#!/usr/bin/env node
/**
 * Development launcher: starts the Vite dev server for the renderer, bundles the
 * Electron entry points in watch mode, then boots Electron pointed at the dev
 * server. Electron is restarted whenever the main-process bundle changes.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainBundle = path.join(root, 'dist/electron/main.cjs');

let electronProcess = null;
let restartTimer = null;
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[dev] ${message}\n`);
}

function startElectron(devServerUrl) {
  if (electronProcess) {
    electronProcess.removeAllListeners('exit');
    electronProcess.kill();
  }

  electronProcess = spawn(electronPath, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', LITHO_DEV_SERVER_URL: devServerUrl },
  });

  electronProcess.on('exit', (code) => {
    if (!shuttingDown) {
      log(`Electron exited (code ${code ?? 0}) — shutting down dev server`);
      shutdown(code ?? 0);
    }
  });
}

function scheduleRestart(devServerUrl) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    log('main process bundle changed — restarting Electron');
    startElectron(devServerUrl);
  }, 150);
}

let viteServer = null;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  if (electronProcess) electronProcess.kill();
  if (viteServer) await viteServer.close().catch(() => undefined);
  process.exit(code);
}

async function waitForBundle() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(mainBundle)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${mainBundle}`);
}

async function main() {
  viteServer = await createServer({ configFile: path.join(root, 'vite.config.ts') });
  await viteServer.listen();
  const resolvedUrls = viteServer.resolvedUrls?.local ?? [];
  const devServerUrl = resolvedUrls[0] ?? 'http://localhost:5273/';
  log(`renderer dev server at ${devServerUrl}`);

  const bundler = spawn(process.execPath, [path.join(root, 'scripts/build-electron.mjs'), '--watch'], {
    cwd: root,
    stdio: 'inherit',
  });
  bundler.on('exit', (code) => {
    if (!shuttingDown) {
      log(`electron bundler exited (code ${code ?? 0})`);
      shutdown(code ?? 1);
    }
  });

  await waitForBundle();
  startElectron(devServerUrl);

  fs.watch(path.dirname(mainBundle), (_event, filename) => {
    if (filename && filename.endsWith('.cjs')) scheduleRestart(devServerUrl);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch(async (error) => {
  process.stderr.write(`[dev] ${error instanceof Error ? error.stack : String(error)}\n`);
  await shutdown(1);
});
