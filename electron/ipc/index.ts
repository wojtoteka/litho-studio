import { type BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { extname, stem } from '@shared/paths.js';
import {
  CONTACT_URL,
  DOWNLOAD_PAGE_URL,
  IPC,
  type AppTheme,
  type LogEntry,
  type LogLevel,
  type MenuCommand,
  type PreviewBounds,
  type ProjectFileOpenResult,
} from '@shared/ipc.js';
import { PLAUSIBLE_PAGE_COUNT, type FileWrite, type ProjectInfo } from '@shared/project.js';
import { findAiTool, type AiToolId } from '@shared/aiTools.js';
import { toPosix } from '@shared/paths.js';
import { fail, ok, type IpcResult } from '@shared/result.js';
import { log, logPath, tailLog, writeLog } from '../logger.js';
import { AiToolsService } from './aiToolsService.js';
import { type FileService } from './fileService.js';
import { type PathGuard } from './pathGuard.js';
import { PreviewService } from './previewService.js';
import { TerminalService } from './terminalService.js';
import { ProjectWatcher } from './watcherService.js';
import { deleteAsset, importAssetBuffer, importAssetFiles, listAssets } from './assetService.js';
import { createPage, createProject, loadProject, refreshProjectInfo } from './projectService.js';
import { forgetProject, listRecentProjects, rememberProject } from './recentStore.js';
import { checkForUpdate } from './updateService.js';

/**
 * IPC surface registration.
 *
 * Exactly one project is open at a time; its `PathGuard`, `FileService` and
 * watcher live here and are torn down together. Every handler is wrapped by
 * `handle()`, which converts thrown exceptions into structured failures so a
 * bug in one operation can never surface in the renderer as an unhandled
 * rejection.
 */

interface Session {
  guard: PathGuard;
  files: FileService;
  watcher: ProjectWatcher;
}

let current: Session | null = null;
let previewService: PreviewService | null = null;
let terminalService: TerminalService | null = null;
let aiToolsService: AiToolsService | null = null;

let resolveWindow: () => BrowserWindow | null = () => null;

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  previewService = new PreviewService(getWindow, (entry) => send(IPC.eventLogEntry, entry));
  terminalService = new TerminalService(
    (payload) => send(IPC.eventTerminalData, payload),
    (payload) => send(IPC.eventTerminalExit, payload),
  );
  aiToolsService = new AiToolsService({
    onOutput: (id, chunk) => send(IPC.eventAiToolOutput, { id, chunk }),
    onDone: (id, isOk, exitCode, message) => send(IPC.eventAiToolDone, { id, ok: isOk, exitCode, message }),
  });
  resolveWindow = getWindow;

  registerProjectHandlers(getWindow);
  registerFileHandlers();
  registerAssetHandlers();
  registerPreviewHandlers();
  registerWindowHandlers(getWindow);
  registerLogHandlers();
  registerUpdateHandlers();
  registerTerminalHandlers();
  registerAiToolHandlers();
}

export function getPreviewService(): PreviewService | null {
  return previewService;
}

export function getTerminalService(): TerminalService | null {
  return terminalService;
}

export function getAiToolsService(): AiToolsService | null {
  return aiToolsService;
}

/** Absolute path of the currently open project's root, or `null` if none is open. */
export function getCurrentProjectRoot(): string | null {
  return current?.guard.rootPath ?? null;
}

/** Resolves a project-relative asset path to a validated absolute path, honouring the same
 * containment rules as every other file access. */
export async function resolveProjectAssetPath(relPath: string): Promise<string | null> {
  if (!current) return null;
  const result = await current.guard.resolve(relPath);
  return result.ok ? result.value : null;
}

export async function closeCurrentProject(): Promise<void> {
  if (!current) return;
  await current.watcher.dispose();
  current = null;
  previewService?.setProject(null);
  previewService?.destroy();
}

function send(channel: string, payload: unknown): void {
  const window = resolveWindow();
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* Handler plumbing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wraps a handler so that every failure mode — thrown error, rejected promise,
 * missing project — reaches the renderer as a typed `IpcResult`.
 */
function handle<Args extends unknown[], T>(
  channel: string,
  handler: (...args: Args) => Promise<IpcResult<T>> | IpcResult<T>,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await handler(...(args as Args));
    } catch (error) {
      log.error(`[ipc] unhandled error in ${channel}`, error);
      return fail(
        'INTERNAL',
        'Wystąpił nieoczekiwany błąd. Szczegóły znajdziesz w panelu logów.',
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      );
    }
  });
}

function requireSession(): IpcResult<Session> {
  if (!current) return fail('NOT_A_PROJECT', 'Nie otwarto żadnego projektu.');
  return ok(current);
}

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

function registerProjectHandlers(getWindow: () => BrowserWindow | null): void {
  handle(IPC.projectOpenDialog, async () => {
    const window = getWindow();
    if (!window) return fail('INTERNAL', 'Okno aplikacji jest niedostępne.');
    const picked = await dialog.showOpenDialog(window, {
      title: 'Otwórz folder ze stroną',
      buttonLabel: 'Otwórz projekt',
      properties: ['openDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return fail('CANCELLED', 'Anulowano wybór folderu.');
    }
    return openProject(picked.filePaths[0] ?? '');
  });

  handle(IPC.projectOpenFileDialog, async () => {
    const window = getWindow();
    if (!window) return fail('INTERNAL', 'Okno aplikacji jest niedostępne.');
    const picked = await dialog.showOpenDialog(window, {
      title: 'Otwórz pliki stron',
      buttonLabel: 'Otwórz',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Strony HTML', extensions: ['html', 'htm'] },
        { name: 'Wszystkie pliki', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return fail('CANCELLED', 'Anulowano wybór pliku.');
    }
    // A multi-selection is expected to sit in one folder — the picker starts
    // there and has no way to browse elsewhere mid-selection. The first pick
    // decides the project root and the page to jump to; every other HTML page
    // already in that folder shows up on its own via the normal project scan,
    // so the rest of the selection needs no special handling.
    const filePath = picked.filePaths[0] ?? '';
    const folder = path.dirname(filePath);
    const opened = await openProject(folder, filePath);
    if (!opened.ok) return opened;

    const openRelPath = toPosix(path.relative(folder, filePath));
    const result: ProjectFileOpenResult = { snapshot: opened.value, openRelPath };
    return ok(result);
  });

  handle(IPC.projectOpen, async (rootPath: string, filePath?: string) => {
    if (typeof rootPath !== 'string' || rootPath.trim() === '') {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka projektu.');
    }
    if (filePath !== undefined && typeof filePath !== 'string') {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka pliku.');
    }
    const opened = await openProject(rootPath, filePath);
    if (!opened.ok) return opened;

    const result: ProjectFileOpenResult = {
      snapshot: opened.value,
      ...(filePath ? { openRelPath: toPosix(path.relative(rootPath, filePath)) } : {}),
    };
    return ok(result);
  });

  handle(IPC.projectChooseParent, async () => {
    const window = getWindow();
    if (!window) return fail('INTERNAL', 'Okno aplikacji jest niedostępne.');
    const picked = await dialog.showOpenDialog(window, {
      title: 'Wybierz lokalizację nowego projektu',
      buttonLabel: 'Wybierz folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return fail('CANCELLED', 'Anulowano wybór folderu.');
    }
    return ok(picked.filePaths[0] ?? '');
  });

  handle(IPC.projectCreate, async (parentPath: string, name: string) => {
    if (typeof parentPath !== 'string' || typeof name !== 'string') {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowe dane nowego projektu.');
    }
    const created = await createProject(parentPath, name);
    if (!created.ok) return created;
    return openProject(created.value);
  });

  handle(IPC.projectClose, async () => {
    await closeCurrentProject();
    send(IPC.eventProjectClosed, undefined);
    return ok(undefined);
  });

  handle(IPC.projectRecent, async () => ok(await listRecentProjects()));

  handle(IPC.projectForgetRecent, async (rootPath: string) => {
    if (typeof rootPath !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka.');
    return ok(await forgetProject(rootPath));
  });

  handle(IPC.projectRefresh, async () => {
    const session = requireSession();
    if (!session.ok) return session;
    return refreshProjectInfo(session.value.guard);
  });

  handle(IPC.projectCreatePage, async (relPath: string, title: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (typeof relPath !== 'string' || typeof title !== 'string') {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowe dane strony.');
    }
    const created = await createPage(session.value.guard, relPath, title);
    if (!created.ok) return created;
    return openProject(session.value.guard.rootPath);
  });

  handle(IPC.projectDeletePage, async (relPath: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (typeof relPath !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka strony.');
    const removed = await session.value.files.deleteFile(relPath);
    if (!removed.ok) return removed;
    previewService?.invalidate(relPath);
    return openProject(session.value.guard.rootPath);
  });
}

async function openProject(rootPath: string, openedFilePath?: string) {
  const loaded = await loadProject(rootPath);
  if (!loaded.ok) return loaded;

  // Asked *before* `closeCurrentProject`, so declining leaves whatever the user
  // already had open exactly as it was.
  if (!(await confirmImplausibleProject(loaded.value.snapshot.project))) {
    return fail('CANCELLED', 'Anulowano otwieranie folderu.');
  }

  await closeCurrentProject();

  const watcher = new ProjectWatcher(loaded.value.guard, loaded.value.files, (event) => {
    send(IPC.eventFileChange, event);

    // A file changed by something *other* than this app's own save path — most
    // notably a CLI tool run in the embedded terminal (`claude`, a build script,
    // `git checkout`) — must still refresh the live preview if it is currently
    // showing that page. The renderer's own save pipeline already does this for
    // its own writes (PreviewPane watches `lastSavedAt`), but that signal never
    // fires for edits that land on disk from outside the app.
    const ext = extname(event.relPath);
    if (['.html', '.htm'].includes(ext)) {
      previewService?.invalidate(event.relPath);
      void previewService?.reload();
    } else if (ext === '.css') {
      void previewService?.hotReloadCss();
    } else if (ext === '.js') {
      void previewService?.reload();
    }
  });
  watcher.start();

  current = { guard: loaded.value.guard, files: loaded.value.files, watcher };
  previewService?.setProject(loaded.value.guard);

  // Opening a single file records the file's own name (without extension) so
  // "Recently opened" shows what the user picked, not the folder it lives in.
  const recentName = openedFilePath
    ? stem(path.basename(openedFilePath))
    : loaded.value.snapshot.project.name;
  await rememberProject(loaded.value.snapshot.project.rootPath, recentName, openedFilePath);
  return ok(loaded.value.snapshot);
}

/**
 * Asks for confirmation when a folder does not look like one website.
 *
 * The scanner walks up to eight levels deep, and nothing stops someone pointing
 * it at a repository checkout, a documentation export or their home directory —
 * where it dutifully produces a page list hundreds of entries long that is
 * useless to edit and slow to open. Rather than guess, the app states what it
 * found and lets the person decide; opening a genuinely large site is still one
 * click away.
 *
 * Returns true when the open should proceed.
 */
async function confirmImplausibleProject(project: ProjectInfo): Promise<boolean> {
  const pageCount = project.pages.length;
  if (pageCount <= PLAUSIBLE_PAGE_COUNT) return true;

  const window = resolveWindow();
  // With no window there is nobody to ask; refusing silently would be worse
  // than honouring what was requested.
  if (!window || window.isDestroyed()) return true;

  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['Otwórz mimo to', 'Anuluj'],
    defaultId: 1,
    cancelId: 1,
    title: 'Litho Studio',
    message: `Znaleziono ${pageCount} stron HTML w folderze „${project.name}”.`,
    detail:
      'To dużo jak na jedną stronę WWW — czy na pewno wskazano właściwy folder, a nie np. katalog z kodem albo folder domowy?\n\nOtwarcie zadziała, ale lista podstron będzie długa, a wczytywanie potrwa dłużej.',
    noLink: true,
  });

  if (response !== 0) {
    log.info(`[project] user declined to open ${project.rootPath} (${pageCount} pages)`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

function registerFileHandlers(): void {
  handle(IPC.filesRead, async (relPath: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (typeof relPath !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka pliku.');
    return session.value.files.readText(relPath);
  });

  handle(IPC.filesWrite, async (writes: FileWrite[]) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (!Array.isArray(writes)) return fail('INVALID_ARGUMENT', 'Nieprawidłowa lista zapisów.');

    // Mute the watcher for these paths *before* touching the disk, so an event
    // can never arrive between the write and the suppression being installed.
    session.value.watcher.beginOwnWrite(writes.map((entry) => entry?.relPath).filter(isString));
    const report = await session.value.files.writeBatch(writes);

    // Our own writes are invisible to the watcher by design, so the preview
    // must be told directly that its loaded copy is stale — otherwise hiding
    // and re-showing it would present the pre-save page.
    if (report.ok && report.value.written.length > 0) previewService?.invalidateAll();
    return report;
  });

  handle(IPC.filesExists, async (relPath: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (typeof relPath !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka pliku.');
    return session.value.files.exists(relPath);
  });

  handle(IPC.filesReveal, async (relPath: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    const resolved = await session.value.guard.resolve(relPath);
    if (!resolved.ok) return resolved;
    shell.showItemInFolder(resolved.value);
    return ok(undefined);
  });

  handle(IPC.filesOpenExternally, async (relPath: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    const resolved = await session.value.guard.resolve(relPath);
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.value);
    if (error) return fail('IO_ERROR', `Nie udało się otworzyć pliku: ${error}`);
    return ok(undefined);
  });
}

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

function registerAssetHandlers(): void {
  handle(IPC.assetsList, async () => {
    const session = requireSession();
    if (!session.ok) return session;
    return listAssets(session.value.guard);
  });

  handle(IPC.assetsImport, async (sourcePaths: string[]) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (!Array.isArray(sourcePaths) || !sourcePaths.every(isString)) {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowa lista plików.');
    }
    return importAssetFiles(session.value.guard, sourcePaths);
  });

  handle(IPC.assetsImportBuffer, async (name: string, data: Uint8Array) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (typeof name !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa nazwa pliku.');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
    return importAssetBuffer(session.value.guard, name, bytes);
  });

  handle(IPC.assetsDelete, async (relPath: string) => {
    const session = requireSession();
    if (!session.ok) return session;
    if (typeof relPath !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka.');
    return deleteAsset(session.value.guard, relPath);
  });

  handle(IPC.assetsPickDialog, async () => {
    const session = requireSession();
    if (!session.ok) return session;
    const window = resolveWindow();
    if (!window) return fail('INTERNAL', 'Okno aplikacji jest niedostępne.');
    const picked = await dialog.showOpenDialog(window, {
      title: 'Dodaj pliki do projektu',
      buttonLabel: 'Dodaj',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Obrazy', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'] },
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'weba'] },
        { name: 'Wszystkie pliki', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return fail('CANCELLED', 'Anulowano wybór plików.');
    }
    return importAssetFiles(session.value.guard, picked.filePaths);
  });
}

/* ------------------------------------------------------------------ */
/* Preview, window, updates, logs                                      */
/* ------------------------------------------------------------------ */

function registerPreviewHandlers(): void {
  handle(IPC.previewShow, async (relPath: string, bounds: PreviewBounds) => {
    if (!previewService) return fail('INTERNAL', 'Podgląd jest niedostępny.');
    if (typeof relPath !== 'string' || !isBounds(bounds)) {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowe parametry podglądu.');
    }
    return previewService.show(relPath, bounds);
  });

  handle(IPC.previewHide, async () => previewService?.hide() ?? ok(undefined));

  handle(IPC.previewSetBounds, (bounds: PreviewBounds) => {
    if (!previewService) return ok(undefined);
    if (!isBounds(bounds)) return fail('INVALID_ARGUMENT', 'Nieprawidłowe wymiary podglądu.');
    return previewService.setBounds(bounds);
  });

  handle(IPC.previewSetZoom, (factor: number) => {
    if (!previewService) return ok(undefined);
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
      return fail('INVALID_ARGUMENT', 'Nieprawidłowe powiększenie podglądu.');
    }
    return previewService.setZoom(factor);
  });

  handle(IPC.previewReload, async () => previewService?.reload() ?? ok(undefined));
  handle(IPC.previewHotReloadCss, async () => previewService?.hotReloadCss() ?? ok(undefined));

  handle(IPC.previewOpenInBrowser, async (relPath: string) => {
    if (!previewService) return fail('INTERNAL', 'Podgląd jest niedostępny.');
    if (typeof relPath !== 'string') return fail('INVALID_ARGUMENT', 'Nieprawidłowa ścieżka strony.');
    return previewService.openInBrowser(relPath);
  });
}

function registerWindowHandlers(getWindow: () => BrowserWindow | null): void {
  handle(IPC.windowMinimize, () => {
    getWindow()?.minimize();
    return ok(undefined);
  });

  handle(IPC.windowToggleMaximize, () => {
    const window = getWindow();
    if (!window) return ok(false);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return ok(window.isMaximized());
  });

  handle(IPC.windowClose, () => {
    getWindow()?.close();
    return ok(undefined);
  });

  handle(IPC.windowIsMaximized, () => ok(getWindow()?.isMaximized() ?? false));

  /*
   * The window frame is not ours to style.
   *
   * Everything above the toolbar — the caption bar, the title, the
   * minimise/maximise/close buttons, and the Chromium-drawn menu bar — is
   * painted by the platform, which asks `nativeTheme` (not the page) which way
   * to paint it. Without this the app switched to its light theme while the
   * frame stayed black, which reads as a rendering bug rather than a theme.
   *
   * `backgroundColor` is set in the same breath: it is what the compositor
   * paints during a resize and before the first frame of a reload, so leaving
   * it dark makes a light-themed window flash black at exactly those moments.
   */
  handle(IPC.windowSetTheme, (theme: AppTheme) => {
    if (theme !== 'dark' && theme !== 'light') {
      return fail('INVALID_ARGUMENT', 'Nieznany motyw.');
    }
    nativeTheme.themeSource = theme;
    // Matches `--surface-1` for each theme in src/styles/app.css.
    getWindow()?.setBackgroundColor(theme === 'dark' ? '#15161d' : '#f6f7fa');
    return ok(undefined);
  });

  /*
   * The three menu commands a web page cannot carry out for itself.
   *
   * The in-app menu is the only menu on Linux (see `buildApplicationMenu` and
   * the `setMenuBarVisibility` call in main.ts), and unlike the native one it
   * has no Electron `role` to lean on for full screen, quitting or opening a
   * link in the system browser. Deliberately a closed set rather than a generic
   * `shell.openExternal` bridge: the renderer may ask for *these* three things
   * and nothing else, so a compromised renderer gains no way to launch
   * arbitrary URLs or programs.
   */
  handle(IPC.menuRunNative, (command: MenuCommand) => {
    switch (command) {
      case 'view:toggle-fullscreen': {
        const window = getWindow();
        window?.setFullScreen(!window.isFullScreen());
        return ok(undefined);
      }
      case 'help:contact':
        void shell.openExternal(CONTACT_URL);
        return ok(undefined);
      case 'app:quit':
        // Goes through the window, not `app.quit()`, so the close handshake in
        // `installFlushOnClose` still runs and the last debounced edit lands.
        getWindow()?.close();
        return ok(undefined);
      default:
        return fail('INVALID_ARGUMENT', 'To polecenie nie jest obsługiwane przez proces główny.');
    }
  });
}

function registerLogHandlers(): void {
  // Fire-and-forget: logging must never block the renderer.
  ipcMain.on(IPC.logWrite, (_event, level: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (typeof message !== 'string') return;
    const safeLevel: LogLevel = ['error', 'warn', 'info', 'debug'].includes(level) ? level : 'info';
    writeLog('renderer', safeLevel, message.slice(0, 4000), context);
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: safeLevel,
      scope: 'renderer',
      message: message.slice(0, 4000),
    };
    send(IPC.eventLogEntry, entry);
  });

  handle(IPC.logPath, () => ok(logPath()));

  handle(IPC.logTail, async (lines: number) => {
    const count = Number.isFinite(lines) ? Math.trunc(lines) : 200;
    return ok(await tailLog(count));
  });

  // The log file lives in the OS app-data folder, outside any project, so it
  // cannot go through the project-scoped file handlers.
  handle(IPC.logReveal, () => {
    shell.showItemInFolder(logPath());
    return ok(undefined);
  });
}

/* ------------------------------------------------------------------ */
/* Updates                                                              */
/* ------------------------------------------------------------------ */

function registerUpdateHandlers(): void {
  handle(IPC.updateCheck, () => checkForUpdate());

  // A fixed address, never one supplied by the renderer: "open this URL" is
  // exactly the primitive a compromised renderer would want, so the only URL
  // this handler can ever be talked into opening is our own download page.
  handle(IPC.updateOpenDownloadPage, async () => {
    await shell.openExternal(DOWNLOAD_PAGE_URL);
    return ok(undefined);
  });
}

/* ------------------------------------------------------------------ */
/* Terminal                                                             */
/* ------------------------------------------------------------------ */

/**
 * Every embedded terminal starts in the current project's root, matching the
 * requirement that it behave like a project-scoped shell rather than a bare
 * system console. With no project open it falls back to the user's home
 * folder rather than refusing outright, since a shell is still useful there.
 */
function registerTerminalHandlers(): void {
  handle(IPC.terminalCreate, (cols: number, rows: number) => {
    if (!terminalService) return fail('INTERNAL', 'Terminal jest niedostępny.');
    const cwd = current?.guard.rootPath ?? os.homedir();
    return ok(terminalService.create(cwd, Number(cols), Number(rows)));
  });

  // Fire-and-forget, like `log:write` — these are a high-frequency data stream,
  // not requests that need an acknowledgement.
  ipcMain.on(IPC.terminalWrite, (_event, id: string, data: string) => {
    if (typeof id === 'string' && typeof data === 'string') terminalService?.write(id, data);
  });

  ipcMain.on(IPC.terminalResize, (_event, id: string, cols: number, rows: number) => {
    if (typeof id === 'string' && Number.isFinite(cols) && Number.isFinite(rows)) {
      terminalService?.resize(id, cols, rows);
    }
  });

  ipcMain.on(IPC.terminalKill, (_event, id: string) => {
    if (typeof id === 'string') terminalService?.kill(id);
  });
}

/* ------------------------------------------------------------------ */
/* AI tool installer                                                    */
/* ------------------------------------------------------------------ */

/**
 * Windows-only, and refused here rather than merely hidden in the UI — the
 * renderer decides what to draw, the main process decides what may run. See the
 * note on `AI_TOOLS_PLATFORM`.
 *
 * Every handler takes an id and validates it against the static catalogue before
 * doing anything, so nothing that arrived over the bridge can reach a shell.
 */
function registerAiToolHandlers(): void {
  handle(IPC.aiToolsSupported, () => ok(AiToolsService.supported));

  handle(IPC.aiToolsDetect, async () => {
    if (!aiToolsService || !AiToolsService.supported) {
      return fail('UNSUPPORTED_PLATFORM', 'Auto-Installer narzędzi AI jest dostępny tylko na Windows.');
    }
    return ok(await aiToolsService.detect());
  });

  handle(IPC.aiToolsInstall, async (id: unknown) => {
    const tool = validateToolId(id);
    if (!tool.ok) return tool;
    if (!aiToolsService) return fail('INTERNAL', 'Instalator jest niedostępny.');

    const started = await aiToolsService.start(tool.value);
    if (started.ok) return ok(undefined);
    return fail(started.unsupported ? 'UNSUPPORTED_PLATFORM' : 'IO_ERROR', started.message);
  });

  handle(IPC.aiToolsCancel, (id: unknown) => {
    const tool = validateToolId(id);
    if (!tool.ok) return tool;
    aiToolsService?.cancel(tool.value);
    return ok(undefined);
  });

  // Like `update:open-download-page`, the URL is never taken from the renderer —
  // only an id is, and it can only resolve to an address written in the
  // catalogue.
  handle(IPC.aiToolsOpenHomepage, async (id: unknown) => {
    const tool = validateToolId(id);
    if (!tool.ok) return tool;
    const spec = findAiTool(tool.value);
    if (!spec) return fail('NOT_FOUND', 'Nieznane narzędzie.');
    await shell.openExternal(spec.homepage);
    return ok(undefined);
  });
}

function validateToolId(id: unknown): IpcResult<AiToolId> {
  if (!isString(id) || !findAiTool(id)) {
    return fail('INVALID_ARGUMENT', 'Nieznane narzędzie AI.');
  }
  return ok(id as AiToolId);
}

/* ------------------------------------------------------------------ */

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBounds(value: unknown): value is PreviewBounds {
  if (typeof value !== 'object' || value === null) return false;
  const bounds = value as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]),
  );
}
