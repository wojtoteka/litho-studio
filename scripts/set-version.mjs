#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bumps the application version.
 *
 * `package.json` is the only place a version number is written down. Everything
 * else derives from it at build or run time:
 *
 *   package.json "version"
 *     ├─ electron-builder  → installer/AppImage/.deb file names and metadata
 *     ├─ app.getVersion()  → the update check's "current" (updateService.ts)
 *     └─ --litho-app-version → preload → window.litho.appVersion → status bar
 *
 * So releasing 1.0.2 is this one command plus a repackage; there is deliberately
 * no second copy of the number to forget about.
 *
 *   npm run version:set 1.0.2
 *   npm run package:linux && npm run package:linux:deb
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(repoRoot, 'package.json');

const requested = process.argv[2];
if (!requested) {
  console.error('Użycie: npm run version:set <wersja>, np. npm run version:set 1.0.2');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/u.test(requested)) {
  console.error(`Nieprawidłowa wersja: "${requested}". Oczekiwano formatu X.Y.Z, np. 1.0.2.`);
  process.exit(1);
}

const raw = await fs.readFile(packagePath, 'utf8');
const manifest = JSON.parse(raw);
const previous = manifest.version;

if (previous === requested) {
  console.log(`Wersja już wynosi ${requested} — nic nie zmieniono.`);
  process.exit(0);
}

// Rewritten by hand rather than by re-serialising the whole manifest: this file
// is hand-maintained and a wholesale `JSON.stringify` would reflow every line,
// turning a one-word change into an unreadable diff.
const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/u, `$1${requested}$2`);
if (updated === raw) {
  console.error('Nie znaleziono pola "version" w package.json — przerwano.');
  process.exit(1);
}

await fs.writeFile(packagePath, updated, 'utf8');
console.log(`Wersja: ${previous} → ${requested}`);
console.log('Teraz przepakuj wydanie:');
console.log('  npm run package:linux         # AppImage');
console.log('  npm run package:linux:deb     # .deb');
console.log('  npm run package:win           # Windows (na maszynie z Windows)');
