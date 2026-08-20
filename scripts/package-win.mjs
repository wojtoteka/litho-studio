#!/usr/bin/env node
/**
 * Packages the Windows build — NSIS installer plus the portable .exe.
 *
 * This script exists because the npm script it replaces could not run on
 * Windows. It was:
 *
 *   USE_SYSTEM_SIGNCODE=true CSC_LINK=${CSC_LINK:-certs/...} electron-builder --win
 *
 * which is POSIX shell syntax. `npm run` hands that to cmd.exe on Windows, where
 * `VAR=value command` is not an assignment but a command name — so building the
 * Windows package *on Windows* failed on the first token, and the only machine
 * the script worked on was the Linux box it was written for.
 *
 * Setting the environment in Node instead works on both, and lets the one flag
 * that is genuinely host-specific be decided rather than hardcoded:
 *
 *   USE_SYSTEM_SIGNCODE tells electron-builder to sign with the system
 *   `osslsigncode` instead of the copy it downloads. That is required when
 *   cross-building from Linux — the bundled winCodeSign-2.6.0 is linked against
 *   OpenSSL 1.1 and dies on a modern Debian — and is wrong on Windows, which has
 *   the real signtool.exe and no osslsigncode at all.
 *
 * Signing is skipped, with a warning, when no certificate is present. An
 * unsigned build is a legitimate thing to want (a local test run, a machine
 * without the .pfx) and is better than a build that cannot be produced; what is
 * not acceptable is silently shipping unsigned when signing was expected, hence
 * the notice.
 */
import { build, Arch, Platform } from 'electron-builder';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCertificate = path.join(repoRoot, 'certs/litho-selfsigned.pfx');
const isWindowsHost = process.platform === 'win32';

const certificate = process.env.CSC_LINK ?? (fs.existsSync(defaultCertificate) ? defaultCertificate : null);

if (certificate) {
  process.env.CSC_LINK = certificate;
  process.env.CSC_KEY_PASSWORD = process.env.CSC_KEY_PASSWORD ?? 'litho';
  // Only outside Windows — see the header.
  if (!isWindowsHost) process.env.USE_SYSTEM_SIGNCODE = 'true';
  note(`podpisywanie certyfikatem: ${certificate}`);
} else {
  // electron-builder treats an absent CSC_LINK as "do not sign", but an
  // inherited one from the shell would override that silently.
  delete process.env.CSC_LINK;
  delete process.env.CSC_KEY_PASSWORD;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  note('brak certyfikatu (CSC_LINK ani certs/litho-selfsigned.pfx) — buduję BEZ podpisu.');
}

if (!isWindowsHost) {
  note(`host to ${process.platform}, nie Windows — build krzyżowy, podpis przez osslsigncode.`);
}

try {
  const artifacts = await build({
    targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64),
    publish: 'never',
  });
  process.stdout.write(`\n[package-win] Gotowe:\n${artifacts.map((file) => `  ${file}`).join('\n')}\n`);
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

/*
 * Every NSIS installer carries a CRC32 of its own bytes and refuses to start
 * with "Installer integrity check has failed" when it does not match — before
 * any window is drawn, so there is nothing to log and nothing to see. The build
 * stays green either way, which is exactly why this runs here: a dead installer
 * is otherwise indistinguishable from a good one until someone reports the red
 * dialog. See scripts/verify-installer.mjs.
 */
note('sprawdzam spójność gotowych plików…');
const verify = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/verify-installer.mjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
});
if (verify.status !== 0) {
  fail('gotowe pliki nie przechodzą własnej kontroli spójności — patrz komunikat powyżej.');
}

/* ------------------------------------------------------------------ */

function note(message) {
  process.stdout.write(`[package-win] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n[package-win] ${message}\n`);
  process.exit(1);
}
