import type { NodeId } from './document.js';

/**
 * Where a stylesheet or script physically lives.
 *
 * Litho never assumes a layout. A project may keep CSS in `style.css`, in three
 * separate files, in a `<style>` block in `<head>`, or in all of those at once -
 * every variant becomes a `SourceRef` and participates in the cascade in
 * document order.
 */
export type SourceOrigin = 'external' | 'embedded';

export interface StyleSource {
  id: string;
  origin: SourceOrigin;
  /** Project-relative POSIX path (`external` only). */
  relPath: string | null;
  /** The `href` exactly as written in the HTML (`external` only). */
  href: string | null;
  /** Id of the `<style>` element carrying this CSS (`embedded` only). */
  hostNodeId: NodeId | null;
  /** Media attribute on the `<link>`/`<style>` element, if any. */
  media: string | null;
  css: string;
  /**
   * False for sources Litho must not modify: cross-origin CDN links, files
   * outside the project root, minified vendor bundles.
   */
  writable: boolean;
  /** Document order; later sources win in the cascade. */
  order: number;
}

export interface ScriptSource {
  id: string;
  origin: SourceOrigin;
  relPath: string | null;
  src: string | null;
  hostNodeId: NodeId | null;
  code: string;
  writable: boolean;
  order: number;
  isModule: boolean;
}

export interface PageRef {
  /** Project-relative POSIX path of the HTML file. */
  relPath: string;
  /** `<title>` if present, otherwise a humanised file name. */
  title: string;
  /** True for the page the app opens first (`index.html` when present). */
  isEntry: boolean;
}

export interface AssetRef {
  relPath: string;
  name: string;
  /** Bytes. */
  size: number;
  mimeType: string;
  /** Image dimensions when the asset is a raster/vector image. */
  width: number | null;
  height: number | null;
  modifiedAt: number;
}

export interface ProjectInfo {
  /** Absolute path of the project folder. */
  rootPath: string;
  /** Folder name, used as the display name. */
  name: string;
  pages: PageRef[];
}

export interface RecentProject {
  rootPath: string;
  name: string;
  openedAt: number;
  /** False once the folder no longer exists on disk. */
  available: boolean;
  /** Absolute path of the specific file opened, when the entry came from "Open file" rather than "Open folder". */
  filePath?: string;
}

/* ------------------------------------------------------------------ */
/* Responsive breakpoints                                              */
/* ------------------------------------------------------------------ */

export interface Breakpoint {
  id: string;
  label: string;
  /** `null` for the base (desktop-first) breakpoint, which emits no media query. */
  maxWidth: number | null;
  /** Canvas width used when previewing this breakpoint. */
  canvasWidth: number;
  /**
   * True to render at whatever the work area happens to be, ignoring
   * `canvasWidth` - the way a real browser window behaves, and the honest
   * default for the base breakpoint since it emits no media query.
   *
   * It is a flag of its own rather than being inferred from `maxWidth === null`
   * because the two answer different questions: `maxWidth` decides *where the
   * CSS is written*, while this decides *how wide the page is drawn*. Conflating
   * them left the desktop breakpoint with no editable width at all - the
   * reported "page size cannot be edited, there is nowhere to even type a
   * number".
   */
  fluid: boolean;
  /** Built-in breakpoints cannot be deleted, only re-sized. */
  builtIn: boolean;
}

/**
 * Which *state* of an element a style edit is written for.
 *
 * The second axis of the same idea as `Breakpoint`: a breakpoint decides which
 * `@media` block a declaration lands in, a state decides which pseudo-class the
 * selector carries. `normal` writes `.przycisk`, `hover` writes
 * `.przycisk:hover`. Everything downstream - the cascade, the generator, the
 * declaration reader - needs no knowledge of the distinction.
 *
 * Without this there was no way to give a button a hover colour except by
 * hand-writing CSS, which is precisely what the program exists to avoid.
 */
export type StyleState = 'normal' | 'hover' | 'focus' | 'active';

/** Label and explanation for each state, in the order the switch shows them. */
export const STYLE_STATES: readonly { id: StyleState; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normalny', hint: 'Zwykły wygląd elementu' },
  { id: 'hover', label: 'Najechanie', hint: 'Gdy kursor jest nad elementem (:hover)' },
  {
    id: 'focus',
    label: 'Zaznaczenie',
    hint: 'Gdy element jest wybrany klawiaturą lub kliknięty w formularzu (:focus)',
  },
  {
    id: 'active',
    label: 'Wciśnięcie',
    hint: 'W trakcie kliknięcia, zanim przycisk zostanie puszczony (:active)',
  },
];

/** Appends the pseudo-class for a state; `normal` leaves the selector alone. */
export function selectorForState(selector: string, state: StyleState): string {
  return state === 'normal' ? selector : `${selector}:${state}`;
}

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'base', label: 'Desktop', maxWidth: null, canvasWidth: 1440, fluid: true, builtIn: true },
  { id: 'tablet', label: 'Tablet', maxWidth: 1024, canvasWidth: 834, fluid: false, builtIn: true },
  { id: 'mobile', label: 'Telefon', maxWidth: 640, canvasWidth: 390, fluid: false, builtIn: true },
];

/* ------------------------------------------------------------------ */
/* File payloads                                                        */
/* ------------------------------------------------------------------ */

export interface ProjectSnapshot {
  project: ProjectInfo;
  /** Raw contents of every text file Litho tracks, keyed by relative path. */
  files: Record<string, string>;
  assets: AssetRef[];
}

export interface FileWrite {
  relPath: string;
  content: string;
}

export interface WriteReport {
  /** Files actually written - unchanged files are skipped. */
  written: string[];
  /** Content hashes after the write, used to suppress watcher echo. */
  hashes: Record<string, string>;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  relPath: string;
  /** Present for `add`/`change` on text files. */
  content: string | null;
  hash: string | null;
}

/** Text file extensions Litho loads into the editor model. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.svg',
  '.txt',
  '.md',
]);

export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.bmp',
]);

export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
  '.weba',
]);

/** Directories never scanned when opening a project. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.litho-backups',
  // Bundled third-party code. Not the user's site, invariably huge, and the
  // one thing an editor must never invite someone to hand-edit.
  'vendor',
  'bower_components',
  'out',
  '.output',
  '.venv',
  'venv',
  '__pycache__',
]);

/**
 * Above this many HTML files, a folder is more likely a code checkout, a
 * documentation dump or a home directory than "one website" - so the app asks
 * before committing to it. See `confirmLargeProject` in electron/ipc/index.ts.
 */
export const PLAUSIBLE_PAGE_COUNT = 50;

/** Hard ceiling for a single text file, to keep the editor responsive. */
export const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

/** Hard ceiling for an imported asset. */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;

/** Folder inside the project where Litho keeps rolling backups. */
export const BACKUP_DIRECTORY = '.litho-backups';

/**
 * The stand-in image referenced by the palette's image templates. Created by
 * the project scaffold, and re-created on demand when a template that uses it
 * is dropped into a project that does not have it.
 */
export const PLACEHOLDER_ASSET_PATH = 'assets/placeholder.svg';

export const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" role="img" aria-label="Obraz zastępczy">
  <rect width="800" height="600" fill="#e9ebf2" />
  <path d="M0 470 L210 300 L360 420 L520 250 L800 480 L800 600 L0 600 Z" fill="#c9cede" />
  <circle cx="590" cy="150" r="70" fill="#c9cede" />
  <text x="400" y="560" text-anchor="middle" font-family="system-ui, sans-serif" font-size="28" fill="#8a90a6">Podmień ten obraz</text>
</svg>
`;
