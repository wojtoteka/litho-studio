import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The application's own version — 1.0.1, not Electron's.
 *
 * `app.getVersion()` reads the version out of the app bundle's `package.json`,
 * which only exists once the app *is* a bundle. Run unpackaged — `electron
 * dist/electron/main.cjs`, which is `npm run dev` and the whole test suite —
 * there is no manifest at the app path and Electron quietly answers with its
 * own version instead. That is how the update check ended up comparing "33.4.11"
 * against the released "1.0.1" and concluding, reasonably, that nothing newer
 * existed.
 *
 * Packaged builds keep using `app.getVersion()`: electron-builder writes the
 * real `package.json` into the asar, so it is both correct and the cheapest
 * answer. Everywhere else the manifest is looked up by walking out of the
 * bundle directory, which is where `package.json` sits in a checkout.
 *
 * `package.json` therefore stays the single place a version number is written —
 * see `scripts/set-version.mjs`.
 */

let cached: string | null = null;

export function appVersion(): string {
  if (cached !== null) return cached;
  cached = app.isPackaged ? app.getVersion() : (readManifestVersion() ?? app.getVersion());
  return cached;
}

/** Walks up from this file looking for the project manifest. */
function readManifestVersion(): string | null {
  let directory = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(directory, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      // Guard against picking up a dependency's manifest on the way out.
      if (manifest.name === 'litho-studio' && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // No manifest here (or an unreadable one) — keep climbing.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
