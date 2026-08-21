import fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import {
  IGNORED_DIRECTORIES,
  MAX_TEXT_FILE_BYTES,
  PLACEHOLDER_SVG,
  TEXT_EXTENSIONS,
  type PageRef,
  type ProjectInfo,
  type ProjectSnapshot,
} from '@shared/project.js';
import { basename, extname, stem, toPosix } from '@shared/paths.js';
import { fail, ok, type IpcResult } from '@shared/result.js';
import { log } from '../logger.js';
import { FileService, pathExists, writeAtomic } from './fileService.js';
import { PathGuard } from './pathGuard.js';
import { listAssets } from './assetService.js';

/**
 * Loading a project means: find the HTML pages, then read every text file that
 * could participate in them.
 *
 * There is deliberately no manifest, no `.litho` folder and no required layout.
 * A folder is a Litho project if it contains at least one HTML file - that is
 * the whole contract, which is what lets the editor open pages written by hand,
 * by another generator, or by an AI.
 */

const MAX_SCAN_DEPTH = 8;
const MAX_TRACKED_FILES = 2000;

export interface LoadedProject {
  guard: PathGuard;
  files: FileService;
  snapshot: ProjectSnapshot;
}

export async function loadProject(rootPath: string): Promise<IpcResult<LoadedProject>> {
  const absolute = path.resolve(rootPath);

  let stats: Stats;
  try {
    stats = await fs.stat(absolute);
  } catch {
    return fail('NOT_FOUND', `Folder nie istnieje: ${absolute}`);
  }
  if (!stats.isDirectory()) {
    return fail('NOT_A_DIRECTORY', 'Wskazana ścieżka nie jest folderem.');
  }

  const guard = await PathGuard.create(absolute);
  const scan = await scanDirectory(absolute);

  if (scan.pages.length === 0) {
    return fail(
      'NOT_A_PROJECT',
      'W tym folderze nie ma żadnego pliku HTML. Wybierz folder ze stroną albo utwórz nowy projekt.',
    );
  }

  const fileService = new FileService(guard);
  const files: Record<string, string> = {};

  for (const relPath of scan.textFiles) {
    const result = await fileService.readText(relPath);
    if (result.ok) {
      files[relPath] = result.value;
      // Seed the write-hash cache so the watcher does not treat the initial
      // read as an external modification.
      fileService.recordExternalContent(relPath, result.value);
    } else if (result.code !== 'TOO_LARGE') {
      log.warn(`[project] skipping ${relPath}: ${result.message}`);
    }
  }

  const pages = await buildPageRefs(scan.pages, files);
  const assets = await listAssets(guard);

  const snapshot: ProjectSnapshot = {
    project: { rootPath: absolute, name: basename(absolute) || absolute, pages },
    files,
    assets: assets.ok ? assets.value : [],
  };

  log.info(`[project] opened ${absolute} (${pages.length} pages, ${Object.keys(files).length} files)`);
  return ok({ guard, files: fileService, snapshot });
}

/** Re-scans pages and assets without re-reading file bodies. */
export async function refreshProjectInfo(guard: PathGuard): Promise<IpcResult<ProjectInfo>> {
  const scan = await scanDirectory(guard.rootPath);
  const titles: Record<string, string> = {};
  for (const relPath of scan.pages) {
    const absolute = path.join(guard.rootPath, relPath);
    try {
      const content = await fs.readFile(absolute, 'utf8');
      titles[relPath] = content;
    } catch {
      titles[relPath] = '';
    }
  }
  const pages = await buildPageRefs(scan.pages, titles);
  return ok({ rootPath: guard.rootPath, name: basename(guard.rootPath), pages });
}

interface ScanResult {
  pages: string[];
  textFiles: string[];
}

async function scanDirectory(rootPath: string): Promise<ScanResult> {
  const pages: string[] = [];
  const textFiles: string[] = [];
  let visited = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_TRACKED_FILES) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      log.warn(`[project] cannot read directory ${directory}: ${String(error)}`);
      return;
    }

    for (const entry of entries) {
      if (visited >= MAX_TRACKED_FILES) return;
      const absolute = path.join(directory, entry.name);
      const relPath = toPosix(path.relative(rootPath, absolute));

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
        await walk(absolute, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue; // symlinks to files are followed via stat below
      const ext = extname(entry.name);
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      try {
        const stats = await fs.stat(absolute);
        if (stats.size > MAX_TEXT_FILE_BYTES) continue;
      } catch {
        continue;
      }

      visited += 1;
      textFiles.push(relPath);
      if (ext === '.html' || ext === '.htm') pages.push(relPath);
    }
  }

  await walk(rootPath, 0);

  // Shallow pages first, then alphabetically - `index.html` ends up on top.
  pages.sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  return { pages, textFiles };
}

function depthOf(relPath: string): number {
  return relPath.split('/').length;
}

async function buildPageRefs(pages: string[], files: Record<string, string>): Promise<PageRef[]> {
  const entryIndex = pages.findIndex((relPath) => /^index\.html?$/iu.test(relPath));
  const entry = entryIndex >= 0 ? pages[entryIndex] : pages[0];

  return pages.map((relPath) => ({
    relPath,
    title: extractTitle(files[relPath] ?? '') ?? humanise(stem(relPath)),
    isEntry: relPath === entry,
  }));
}

/** Cheap `<title>` extraction - the full parse happens in the renderer. */
function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  if (!match?.[1]) return null;
  const text = match[1]
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
  return text === '' ? null : text;
}

function humanise(value: string): string {
  const spaced = value.replace(/[-_]+/gu, ' ').trim();
  if (spaced === '') return 'Strona';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ------------------------------------------------------------------ */
/* Scaffolding                                                          */
/* ------------------------------------------------------------------ */

export async function createProject(parentPath: string, name: string): Promise<IpcResult<string>> {
  const folderName = name.trim();
  if (folderName === '') return fail('INVALID_ARGUMENT', 'Nazwa projektu nie może być pusta.');

  const target = path.resolve(parentPath, folderName);
  if (!target.startsWith(path.resolve(parentPath))) {
    return fail('INVALID_ARGUMENT', 'Nieprawidłowa nazwa projektu.');
  }
  if (await pathExists(target)) {
    return fail('ALREADY_EXISTS', `Folder "${folderName}" już istnieje w tej lokalizacji.`);
  }

  try {
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.join(target, 'assets'), { recursive: true });
    await writeAtomic(path.join(target, 'index.html'), starterHtml(folderName));
    await writeAtomic(path.join(target, 'style.css'), starterCss());
    await writeAtomic(path.join(target, 'script.js'), starterJs());
    // The image templates in the palette reference this file, so a fresh
    // project must ship it - otherwise the first dropped image is broken.
    await writeAtomic(path.join(target, 'assets', 'placeholder.svg'), PLACEHOLDER_SVG);
    return ok(target);
  } catch (error) {
    log.error('[project] scaffold failed', error);
    return fail('IO_ERROR', 'Nie udało się utworzyć projektu.', String(error));
  }
}

/** Creates an additional page inside an already-open project. */
export async function createPage(
  guard: PathGuard,
  relPath: string,
  title: string,
): Promise<IpcResult<string>> {
  const normalised = relPath.endsWith('.html') ? relPath : `${relPath}.html`;
  const resolved = await guard.resolve(normalised);
  if (!resolved.ok) return resolved;
  if (await pathExists(resolved.value)) {
    return fail('ALREADY_EXISTS', `Strona ${normalised} już istnieje.`);
  }
  try {
    await writeAtomic(resolved.value, starterHtml(title || humanise(stem(normalised))));
    return ok(normalised);
  } catch (error) {
    return fail('IO_ERROR', `Nie udało się utworzyć strony ${normalised}.`, String(error));
  }
}

function starterHtml(title: string): string {
  const safeTitle = title.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main class="page">
      <h1 class="page-title">${safeTitle}</h1>
      <p class="page-intro">Zacznij edytować tę stronę, przeciągając elementy z lewego panelu.</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`;
}

function starterCss(): string {
  return `:root {
  --color-text: #1a1b23;
  --color-muted: #5b5f73;
  --color-accent: #6e56cf;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--color-text);
  background: #ffffff;
  line-height: 1.6;
}

.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 64px 24px;
}

.page-title {
  font-size: 48px;
  line-height: 1.15;
  margin: 0 0 16px;
}

.page-intro {
  font-size: 18px;
  color: var(--color-muted);
  margin: 0;
}
`;
}

function starterJs(): string {
  return `// Twój kod JavaScript.
// Litho Studio dopisuje generowany kod w osobnej, oznaczonej sekcji na końcu
// tego pliku i nigdy nie modyfikuje kodu napisanego powyżej.
`;
}
