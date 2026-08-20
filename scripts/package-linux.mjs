#!/usr/bin/env node
/**
 * Packages the Linux build.
 *
 * AppImage is the default target: one file that runs on any distribution
 * without installing anything. Pass `--target=tar.gz` for the plain archive
 * instead (no `mksquashfs`/mount tooling required, useful for containers or
 * distros that block FUSE).
 */
import { build, Arch, Platform } from 'electron-builder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = path.join(repoRoot, 'release');
const instructions = path.join(repoRoot, 'resources/linux/JAK-URUCHOMIC.md');

const forced = readArgument('target');
if (forced && !['appimage', 'tar.gz'].includes(forced)) {
  fail(`Nieznany cel: ${forced}. Dozwolone: appimage, tar.gz.`);
}

const target = forced ?? 'appimage';

try {
  const artifacts = await build({
    targets: Platform.LINUX.createTarget(target === 'appimage' ? 'AppImage' : 'tar.gz', Arch.x64),
    publish: 'never',
  });
  // A copy next to the archive as well as inside it: whoever is about to send
  // the .tar.gz somewhere should be able to read what the recipient will need
  // to do, without unpacking it first.
  const readme = path.join(releaseDirectory, path.basename(instructions));
  fs.copyFileSync(instructions, readme);

  const produced = [...artifacts, readme];
  process.stdout.write(`\n[package-linux] Gotowe:\n${produced.map((file) => `  ${file}`).join('\n')}\n`);
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

/* ------------------------------------------------------------------ */

function readArgument(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length).toLowerCase() : null;
}

function fail(message) {
  process.stderr.write(`\n[package-linux] ${message}\n`);
  process.exit(1);
}
