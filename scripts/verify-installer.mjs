#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Checks the Windows installers in `release/` the same way the installer checks
 * itself when it is double-clicked.
 *
 * Every NSIS installer ends with a CRC32 of its own bytes, and refuses to start
 * with "Installer integrity check has failed" when that CRC does not match -
 * before any window of ours is drawn, so there is nothing to log and nothing to
 * see. A single flipped byte anywhere in the 88 MB file is enough, and it can
 * be flipped long after makensis finished: an antivirus rewriting the file, a
 * bad sector, a truncated copy onto a pendrive or an interrupted upload. The
 * build itself stays green, so without this step a dead installer looks exactly
 * like a good one until a user reports the red dialog.
 *
 * Reading the check off the file is cheap, so `npm run package:win` runs it on
 * every build. It is also the tool to reach for when someone reports that
 * dialog: run it against their copy to tell "the file you downloaded is
 * damaged, download it again" apart from "the build is broken for everyone".
 *
 *     node scripts/verify-installer.mjs                     # release/, bieżąca wersja
 *     node scripts/verify-installer.mjs "C:\\...\\Litho Studio-1.0.1-x64.exe"
 *
 * Layout of what is read below (NSIS `firstheader`, exehead/fileform.h): after
 * the Windows executable that unpacks everything comes a 28-byte header -
 * flags, the `0xDEADBEEF` + "NullsoftInst" signature, and the size of all the
 * data that follows it. The CRC is the last four bytes of the file and covers
 * everything from offset 512 onwards; the first 512 bytes are skipped by NSIS
 * itself, because code-signing legitimately rewrites parts of the DOS/PE
 * header.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'release');

const SIGNATURE = Buffer.from('\xef\xbe\xad\xdeNullsoftInst', 'latin1');
const CRC_SKIPPED_PREFIX = 512;
const FLAG_NO_CRC = 4;

/**
 * File range holding the Authenticode signature, or `null` when unsigned.
 *
 * This exists because signing breaks the naive "file length must equal the size
 * NSIS declares" rule that this script used to apply - and it did apply it
 * correctly right up until the project got a certificate. `signtool` appends the
 * signature *after* everything NSIS wrote, so a perfectly good signed installer
 * looks ~8 kB too long. NSIS itself is unbothered: it reads its own length from
 * the header and never looks past it.
 *
 * Rather than allowing any trailing slack - which would stop catching genuinely
 * appended junk, the thing this check exists for - the exact range is read from
 * the PE certificate table: data directory 4, the one directory whose "virtual
 * address" is really a file offset.
 */
function authenticodeRange(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 0x18 + 8 > buffer.length) return null;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null; // 'PE\0\0'

  const magic = buffer.readUInt16LE(peOffset + 0x18);
  // PE32 keeps 96 bytes of optional header before the data directories, PE32+ 112.
  const directories = peOffset + 0x18 + (magic === 0x20b ? 112 : 96);
  const entry = directories + 4 * 8;
  if (entry + 8 > buffer.length) return null;

  const start = buffer.readUInt32LE(entry);
  const size = buffer.readUInt32LE(entry + 4);
  if (start === 0 || size === 0 || start + size > buffer.length) return null;
  return { start, end: start + size };
}

/**
 * How long the file is allowed to be: the end of the NSIS data, plus the
 * signature when there is one.
 *
 * The signature is accepted only where it belongs - running to the very end of
 * the file, and beginning at the end of the NSIS data give or take the padding
 * needed to reach the certificate table's 8-byte alignment (6 and 7 bytes on the
 * two artifacts this project builds). A "signature" sitting anywhere else leaves
 * unexplained bytes in between, and those are exactly what this script is for, so
 * it is not treated as one.
 */
function expectedLength(buffer, declaredSize) {
  const cert = authenticodeRange(buffer);
  const aligned = cert !== null && cert.end === buffer.length && cert.start >= declaredSize;
  if (!aligned || cert.start - declaredSize >= 8) return { length: declaredSize, signature: 0 };
  return { length: buffer.length, signature: cert.end - cert.start };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const hex = (value) => `0x${value.toString(16).padStart(8, '0')}`;

/** @returns {{ok: boolean, note: string}} */
function inspect(buffer) {
  const headerStart = buffer.indexOf(SIGNATURE) - 4;
  if (headerStart < 4) {
    // Portable builds are NSIS too, so anything else here is not ours at all.
    return { ok: false, note: 'to nie jest instalator NSIS - plik jest uszkodzony albo podmieniony' };
  }

  const flags = buffer.readUInt32LE(headerStart);
  const declaredSize = headerStart + buffer.readUInt32LE(headerStart + 24);

  // The signature is the only thing allowed to sit past the end of the NSIS data.
  const { length: allowed, signature } = expectedLength(buffer, declaredSize);
  const trailing = buffer.length - allowed;
  const signatureNote = signature === 0 ? 'bez podpisu' : `podpis ${signature} B`;

  if (trailing !== 0) {
    return {
      ok: false,
      note:
        trailing > 0
          ? `plik ma ${trailing} B nadmiarowych danych na końcu, nie licząc podpisu (doklejone przez coś po budowaniu)`
          : `plik jest obcięty o ${-trailing} B - kopiowanie lub pobieranie się nie dokończyło`,
    };
  }

  if (flags & FLAG_NO_CRC) {
    // `portable.nsi` electron-buildera ustawia `CRCCheck off`, więc portable nie
    // ma czego sprawdzać - zostaje sam rozmiar, sprawdzony wyżej.
    return { ok: true, note: `rozmiar zgodny, ${signatureNote} (ten cel nie zapisuje CRC)` };
  }

  // Liczone do końca danych NSIS-a, nie do końca pliku: CRC powstało, gdy podpisu
  // jeszcze nie było, i NSIS sprawdza je dokładnie w tym zakresie.
  const stored = buffer.readUInt32LE(declaredSize - 4);
  const computed = crc32(buffer, CRC_SKIPPED_PREFIX, declaredSize - 4);
  return computed === stored
    ? { ok: true, note: `CRC ${hex(stored)} zgodne, ${signatureNote}` }
    : { ok: false, note: `CRC nie zgadza się: w pliku ${hex(stored)}, policzone ${hex(computed)}` };
}

async function collectTargets() {
  const explicit = process.argv.slice(2);
  if (explicit.length > 0) return explicit.map((file) => path.resolve(file));

  // Only this build's artifacts: release/ keeps whatever earlier versions left
  // behind, and a stale 1.0.0 nobody is shipping must not fail today's build.
  const { version } = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const entries = await fs.readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && entry.name.includes(`-${version}-`),
    )
    .map((entry) => path.join(releaseDir, entry.name));
}

async function main() {
  const targets = await collectTargets();
  if (targets.length === 0) {
    console.error('Nie ma czego sprawdzać - w release/ nie znaleziono żadnego .exe.');
    process.exitCode = 1;
    return;
  }

  let broken = 0;
  for (const target of targets) {
    const { ok, note } = inspect(await fs.readFile(target));
    if (!ok) broken += 1;
    console.log(`${ok ? 'OK  ' : 'BŁĄD'}  ${path.basename(target)} - ${note}`);
  }

  if (broken > 0) {
    console.error(
      `\n${broken} z ${targets.length} plików nie przejdzie własnej kontroli spójności - przy uruchomieniu\n` +
        'pokaże „Installer integrity check has failed”. Zbuduj paczkę ponownie i, jeśli błąd wróci,\n' +
        'sprawdź antywirusa oraz dysk (to on, a nie kompilacja, najczęściej psuje gotowy plik).',
    );
    process.exitCode = 1;
  }
}

await main();
