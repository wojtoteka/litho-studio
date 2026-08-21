import type { IpcResult } from './result.js';
import type { AiToolDonePayload, AiToolId, AiToolOutputPayload, AiToolStatus } from './aiTools.js';
import type {
  AssetRef,
  FileChangeEvent,
  FileWrite,
  ProjectInfo,
  ProjectSnapshot,
  RecentProject,
  WriteReport,
} from './project.js';

/**
 * The complete surface exposed to the renderer through `contextBridge`.
 *
 * Every method is invoke/response and returns an `IpcResult`, so a rejected
 * operation surfaces as data rather than an unhandled promise rejection. Events
 * pushed from the main process use `on*` subscriptions that return an
 * unsubscribe function.
 */
export interface LithoApi {
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  /**
   * The user's home directory, so paths shown in the UI can collapse it to `~`.
   * Purely cosmetic - nothing resolves against it, and it is empty on the rare
   * system that sets neither HOME nor USERPROFILE, which callers must tolerate.
   */
  readonly homeDir: string;
  readonly isDevelopment: boolean;
  /**
   * True only when the app was started with `--litho-enable-test-hooks` in an
   * unpackaged build. Gates the end-to-end test surface; always false in a
   * shipped installer.
   */
  readonly testHooksEnabled: boolean;

  project: {
    /** Opens the OS folder picker, then loads the chosen folder. */
    openDialog(): Promise<IpcResult<ProjectSnapshot>>;
    /**
     * Opens the OS file picker filtered to HTML files, allowing multiple to be
     * selected at once, then loads the first pick's containing folder as the
     * project (so any sibling CSS/JS is still picked up automatically) and
     * reports every picked page so they can all open as tabs.
     */
    openFileDialog(): Promise<IpcResult<ProjectFileOpenResult>>;
    /**
     * Loads a folder by absolute path (used for recents and drag & drop).
     * `filePath` re-selects the specific file the recent entry remembers, so
     * reopening it jumps back to that page and keeps the entry's file-level
     * name/location instead of collapsing to the folder's.
     */
    open(rootPath: string, filePath?: string): Promise<IpcResult<ProjectFileOpenResult>>;
    /** Scaffolds a new project folder with index.html / style.css / script.js. */
    create(parentPath: string, name: string): Promise<IpcResult<ProjectSnapshot>>;
    /** Opens the folder picker in "choose parent for new project" mode. */
    chooseParentDialog(): Promise<IpcResult<string>>;
    close(): Promise<IpcResult<void>>;
    recent(): Promise<IpcResult<RecentProject[]>>;
    forgetRecent(rootPath: string): Promise<IpcResult<RecentProject[]>>;
    /** Re-scans the folder for pages and assets without reloading file bodies. */
    refresh(): Promise<IpcResult<ProjectInfo>>;
    /** Creates a new empty page in the current project. */
    createPage(relPath: string, title: string): Promise<IpcResult<ProjectSnapshot>>;
    deletePage(relPath: string): Promise<IpcResult<ProjectSnapshot>>;
  };

  files: {
    read(relPath: string): Promise<IpcResult<string>>;
    /** Atomic, debounced-by-caller multi-file write with backup rotation. */
    write(writes: FileWrite[]): Promise<IpcResult<WriteReport>>;
    exists(relPath: string): Promise<IpcResult<boolean>>;
    /** Reveals the file in Explorer/Finder. */
    reveal(relPath: string): Promise<IpcResult<void>>;
    /** Opens the file with the OS default handler (VS Code, etc.). */
    openExternally(relPath: string): Promise<IpcResult<void>>;
  };

  assets: {
    list(): Promise<IpcResult<AssetRef[]>>;
    /** Copies files from anywhere on disk into the project's assets folder. */
    import(sourcePaths: string[]): Promise<IpcResult<AssetRef[]>>;
    /** Writes raw bytes (drag & drop from the browser) into the assets folder. */
    importBuffer(name: string, data: Uint8Array): Promise<IpcResult<AssetRef>>;
    delete(relPath: string): Promise<IpcResult<AssetRef[]>>;
    /** Opens the OS file picker filtered to images. */
    pickDialog(): Promise<IpcResult<AssetRef[]>>;
  };

  preview: {
    /** Shows the live preview pane and points it at a page. */
    show(relPath: string, bounds: PreviewBounds): Promise<IpcResult<void>>;
    hide(): Promise<IpcResult<void>>;
    setBounds(bounds: PreviewBounds): Promise<IpcResult<void>>;
    /**
     * Magnification of the previewed page, as a factor (1 = 100 %).
     *
     * The preview is a native view, so the canvas's trick of drawing into a
     * CSS-scaled stage does not reach it - the toolbar's zoom simply did
     * nothing while browsing. Chromium's own page zoom is the equivalent, and
     * it is better than a transform besides: the page's CSS viewport becomes
     * `bounds ÷ factor`, so zooming out shows *more* page at the layout width
     * that width implies, exactly like zooming a browser window.
     */
    setZoom(factor: number): Promise<IpcResult<void>>;
    reload(): Promise<IpcResult<void>>;
    /** Swaps stylesheets in place without a full reload. */
    hotReloadCss(): Promise<IpcResult<void>>;
    openInBrowser(relPath: string): Promise<IpcResult<void>>;
  };

  window: {
    minimize(): Promise<IpcResult<void>>;
    toggleMaximize(): Promise<IpcResult<boolean>>;
    close(): Promise<IpcResult<void>>;
    isMaximized(): Promise<IpcResult<boolean>>;
    /**
     * Tells the OS which way the app's own theme is pointing.
     *
     * The title bar and its minimise/maximise/close buttons are drawn by the
     * *window manager*, not by this app, so no amount of CSS reaches them -
     * switching to the light theme left a black caption bar bolted to a white
     * application. `nativeTheme.themeSource` is the one control that does
     * reach them (and the Chromium-drawn menu bar besides).
     */
    setTheme(theme: AppTheme): Promise<IpcResult<void>>;
  };

  log: {
    /** Forwards renderer diagnostics into the rotating main-process log file. */
    write(level: LogLevel, message: string, context?: Record<string, unknown>): void;
    /** Absolute path of the current log file, for the console panel. */
    path(): Promise<IpcResult<string>>;
    /** Tail of the log file for the in-app console panel. */
    tail(lines: number): Promise<IpcResult<LogEntry[]>>;
    /** Reveals the log file in Explorer/Finder - it lives outside the project. */
    reveal(): Promise<IpcResult<void>>;
  };

  terminal: {
    /**
     * Spawns a real shell (main process only) rooted at the current project's
     * folder, or the user's home folder when no project is open. The result
     * says which backend was used - see `TerminalBackendKind`.
     */
    create(cols: number, rows: number): Promise<IpcResult<TerminalSession>>;
    /** Keystrokes/pasted text going to the pty. Fire-and-forget: this is a data stream, not a request. */
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): void;
  };

  /**
   * The AI tool installer. Windows-only - see `AI_TOOLS_PLATFORM` in
   * `shared/aiTools.ts` for why, and note that the platform gate is enforced in
   * the main process, not just hidden in the UI.
   *
   * `install` resolves as soon as the process has started, not when it finishes:
   * an `npm install -g` runs for tens of seconds and the user needs to watch it.
   * The outcome arrives on `onAiToolDone`, with output streaming through
   * `onAiToolOutput` in the meantime.
   */
  aiTools: {
    /** True when this build can install anything at all. */
    supported(): Promise<IpcResult<boolean>>;
    /** What is already on this machine. Not-installed is data, never a failure. */
    detect(): Promise<IpcResult<AiToolStatus[]>>;
    install(id: AiToolId): Promise<IpcResult<void>>;
    /** Ends a running install and its child processes. No-op if it already finished. */
    cancel(id: AiToolId): Promise<IpcResult<void>>;
    /** Opens the tool's vendor page in the user's own browser. */
    openHomepage(id: AiToolId): Promise<IpcResult<void>>;
  };

  /**
   * Runs the handful of menu commands only the main process can carry out -
   * full screen, quitting, opening the contact page in the system browser.
   *
   * The native menu invokes those through Electron `role`s, which the in-app
   * menu (see `AppMenu.tsx`) has no equivalent of: it is a web page, and a web
   * page cannot full-screen the OS window or close the app. Everything else in
   * that menu stays in the renderer's own command registry, so there is exactly
   * one implementation per command regardless of which menu ran it.
   */
  runNativeCommand(command: MenuCommand): Promise<IpcResult<void>>;

  update: {
    /**
     * Asks the release API whether a newer build exists for this platform.
     * Never rejects and never reports "offline" as a failure - see
     * `updateService.ts`.
     */
    check(): Promise<IpcResult<UpdateStatus>>;
    /** Opens the download page in the user's own browser. */
    openDownloadPage(): Promise<IpcResult<void>>;
  };

  onFileChange(listener: (event: FileChangeEvent) => void): () => void;
  onProjectClosed(listener: () => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onWindowStateChange(listener: (state: { maximized: boolean; focused: boolean }) => void): () => void;
  onLogEntry(listener: (entry: LogEntry) => void): () => void;
  onTerminalData(listener: (payload: TerminalDataPayload) => void): () => void;
  onTerminalExit(listener: (payload: TerminalExitPayload) => void): () => void;
  onAiToolOutput(listener: (payload: AiToolOutputPayload) => void): () => void;
  onAiToolDone(listener: (payload: AiToolDonePayload) => void): () => void;
  /**
   * Fired when the window is about to close: the renderer must flush its
   * debounced save and confirm with `flushDone()`, after which the main process
   * actually closes the window. This is what guarantees the last 180 ms of
   * edits are never lost to a fast Alt+F4.
   */
  onFlushRequest(listener: () => void): () => void;
  flushDone(): void;
}

/** The editor's two appearances. Mirrored by `Theme` in the renderer's ui store. */
export type AppTheme = 'dark' | 'light';

/** Result of picking one or more HTML files: the first pick's folder becomes the project. */
export interface ProjectFileOpenResult {
  snapshot: ProjectSnapshot;
  /** Project-relative path of the file the user actually picked, if any. */
  openRelPath?: string;
}

/**
 * Outcome of one update check.
 *
 * `checked: false` means the question could not be asked at all (no network,
 * server unreachable). It is kept separate from "asked, nothing newer" so the
 * UI can stay silent in both cases while the log still says which happened.
 */
export interface UpdateStatus {
  /** Version of the running build - `package.json`, via `app.getVersion()`. */
  current: string;
  /** Newest version the API offers for this platform, or `null` if unknown. */
  latest: string | null;
  updateAvailable: boolean;
  /** False when the API could not be reached; treat as "we simply do not know". */
  checked: boolean;
}

export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Which mechanism actually backs a terminal session.
 *
 * `pty` is the real thing (node-pty). The other two are degraded fallbacks used
 * where node-pty has no loadable binary - most notably the Linux build, which
 * is cross-packaged from Windows and so cannot compile it. See
 * `electron/ipc/terminalService.ts`.
 */
export type TerminalBackendKind = 'pty' | 'script' | 'pipe';

/** A live embedded terminal session (one shell process, main process only). */
export interface TerminalSession {
  id: string;
  /** Absolute path the shell was started in, shown in the panel header. */
  cwd: string;
  backend: TerminalBackendKind;
  /** Human-readable caveat to print in the terminal, set only for degraded backends. */
  notice?: string;
}

export interface TerminalDataPayload {
  id: string;
  data: string;
}

export interface TerminalExitPayload {
  id: string;
  exitCode: number;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  scope: 'main' | 'renderer' | 'canvas';
  message: string;
}

/** Commands emitted by the native application menu. */
export type MenuCommand =
  | 'project:new'
  | 'project:open'
  | 'project:open-file'
  | 'project:close'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:cut'
  | 'edit:copy'
  | 'edit:paste'
  | 'edit:duplicate'
  | 'edit:delete'
  | 'edit:select-all'
  | 'edit:group'
  | 'edit:ungroup'
  | 'view:zoom-in'
  | 'view:zoom-out'
  | 'view:zoom-reset'
  | 'view:zoom-fit'
  | 'view:toggle-grid'
  | 'view:toggle-preview'
  | 'view:toggle-console'
  | 'view:toggle-terminal'
  | 'view:toggle-theme'
  | 'view:toggle-fullscreen'
  /** Opens the AI tool installer dialog. Windows-only; absent from the menu elsewhere. */
  | 'tools:ai-installer'
  | 'help:shortcuts'
  | 'help:contact'
  | 'app:quit';

/**
 * The one external address this app ever opens by itself, and only when the
 * user picks Pomoc ▸ Kontakt. Kept here so the native menu and the in-app menu
 * cannot drift onto different URLs.
 */
export const CONTACT_URL = 'https://wojtoteka.ovh/kontakt';

/**
 * Where new builds are announced, and where they are downloaded from.
 *
 * The API is read on every launch (see `updateService.ts`); the page is only
 * ever opened when the user clicks "Pobierz" on the update dialog or banner.
 * Both live here so the main process, the preload and the UI cannot drift
 * apart.
 *
 * "Pobierz" hands the page to `shell.openExternal` and stops there. Litho never
 * downloads a build itself: the page offers an AppImage, a .deb and the Windows
 * installers, and which of those is the right file - and how it gets installed -
 * is the user's call, not a guess this app is in any position to make.
 */
export const RELEASES_API_URL = 'https://wojtoteka.ovh/api/litho/releases';
export const DOWNLOAD_PAGE_URL = 'https://wojtoteka.ovh/inne/litho/';

/* ------------------------------------------------------------------ */
/* Channel names - the single source of truth for main <-> preload      */
/* ------------------------------------------------------------------ */

export const IPC = {
  projectOpenDialog: 'project:open-dialog',
  projectOpenFileDialog: 'project:open-file-dialog',
  projectOpen: 'project:open',
  projectCreate: 'project:create',
  projectChooseParent: 'project:choose-parent',
  projectClose: 'project:close',
  projectRecent: 'project:recent',
  projectForgetRecent: 'project:forget-recent',
  projectRefresh: 'project:refresh',
  projectCreatePage: 'project:create-page',
  projectDeletePage: 'project:delete-page',

  filesRead: 'files:read',
  filesWrite: 'files:write',
  filesExists: 'files:exists',
  filesReveal: 'files:reveal',
  filesOpenExternally: 'files:open-externally',

  assetsList: 'assets:list',
  assetsImport: 'assets:import',
  assetsImportBuffer: 'assets:import-buffer',
  assetsDelete: 'assets:delete',
  assetsPickDialog: 'assets:pick-dialog',

  previewShow: 'preview:show',
  previewHide: 'preview:hide',
  previewSetBounds: 'preview:set-bounds',
  previewSetZoom: 'preview:set-zoom',
  previewReload: 'preview:reload',
  previewHotReloadCss: 'preview:hot-reload-css',
  previewOpenInBrowser: 'preview:open-in-browser',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowSetTheme: 'window:set-theme',

  menuRunNative: 'menu:run-native',

  updateCheck: 'update:check',
  updateOpenDownloadPage: 'update:open-download-page',

  logWrite: 'log:write',
  logPath: 'log:path',
  logTail: 'log:tail',
  logReveal: 'log:reveal',

  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',

  aiToolsSupported: 'ai-tools:supported',
  aiToolsDetect: 'ai-tools:detect',
  aiToolsInstall: 'ai-tools:install',
  aiToolsCancel: 'ai-tools:cancel',
  aiToolsOpenHomepage: 'ai-tools:open-homepage',

  appFlushDone: 'app:flush-done',

  eventFileChange: 'event:file-change',
  eventProjectClosed: 'event:project-closed',
  eventMenuCommand: 'event:menu-command',
  eventWindowState: 'event:window-state',
  eventLogEntry: 'event:log-entry',
  eventFlushRequest: 'event:flush-request',
  eventTerminalData: 'event:terminal-data',
  eventTerminalExit: 'event:terminal-exit',
  eventAiToolOutput: 'event:ai-tool-output',
  eventAiToolDone: 'event:ai-tool-done',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
