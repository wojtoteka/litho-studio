import { BrowserWindow, app, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IPC, type LogEntry } from '@shared/ipc.js';
import { appVersion } from './appVersion.js';
import { initLogger, log, writeLog } from './logger.js';
import { buildApplicationMenu } from './menu.js';
import {
  closeCurrentProject,
  getAiToolsService,
  getPreviewService,
  getTerminalService,
  registerIpc,
  resolveProjectAssetPath,
} from './ipc/index.js';

/**
 * Scheme the canvas iframe uses for every project-local asset reference
 * (`<img src>`, `<link href>`, …). A plain `file://` `<base>` only resolves
 * inside the iframe when the *app window itself* is also `file://` - true in
 * a packaged build, false under `npm run dev` where the window loads from the
 * Vite dev server (`http://localhost:*`). Chromium refuses `http:` → `file:`
 * subresource loads unconditionally, so images silently failed to load in
 * development. A custom scheme resolves the same way regardless of what
 * origin the window itself was loaded from.
 */
export const ASSET_PROTOCOL = 'litho-asset';

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/**
 * Main process entry point.
 *
 * Security posture, in order of importance:
 *  - one window, `contextIsolation: true`, `nodeIntegration: false`,
 *    `sandbox: true`; the renderer is a plain web page;
 *  - a Content-Security-Policy header injected for the app's own session, so
 *    even a successful XSS in the editor UI cannot load remote code;
 *  - navigation and `window.open` are locked to the app's own origin;
 *  - a single-instance lock, so two windows can never write the same project.
 */

const isDevelopment = !app.isPackaged;
const devServerUrl = process.env.LITHO_DEV_SERVER_URL || null;

/**
 * Software compositing - on Linux only, and that platform restriction is the
 * whole point of this block.
 *
 * Linux GPU/driver combinations are wildly inconsistent (missing DRI nodes,
 * VM/remote-desktop virtual GPUs, mismatched Mesa vs. kernel driver versions).
 * When Chromium's GPU process fails to initialise on one of these, the whole
 * renderer can be left compositing nothing - a permanently blank/white window
 * with no error dialog, because the failure happens below the web page level.
 * Falling back up front trades rendering performance for a window that reliably
 * paints, and this editor has no 3D workload that needs the GPU.
 *
 * This used to run unconditionally, which quietly wrecked the editor on
 * Windows. Two reasons, both invisible on Linux:
 *
 *  - Chromium only draws text with subpixel antialiasing (ClearType) when it is
 *    compositing on the GPU. Software compositing downgrades every glyph to
 *    greyscale AA, which at the 11-13 px the panels are built from reads as thin,
 *    washed-out, faintly blurry text. Linux hides this because most desktops
 *    ship greyscale AA anyway, so there was nothing to lose there.
 *  - Every panel repaint, canvas drag and scroll goes through the CPU. The start
 *    screen survives that; a dense editor tree being restyled on each pointer
 *    move does not.
 *
 * Escape hatches in both directions, because the failure this guards against is
 * a property of the machine and not of the platform: a Windows box with a broken
 * driver can force the fallback, and a healthy Linux box can opt back into the
 * GPU. Must run before `app.whenReady()` (ideally before any other `app.*` call)
 * - Chromium reads this at GPU-process-launch time, not afterwards.
 */
const forceSoftwareRendering = envFlag('LITHO_DISABLE_GPU');
const forceHardwareRendering = envFlag('LITHO_ENABLE_GPU');
if (forceSoftwareRendering || (process.platform === 'linux' && !forceHardwareRendering)) {
  app.disableHardwareAcceleration();
}

/** Truthy for `1`/`true`/`yes`; anything else (including unset) is false. */
function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * `--user-data-dir` is a Chromium switch: it moves the browser profile but
 * does *not* move `app.getPath('userData')`, which is what the recent-projects
 * store, the log file and the single-instance lock all use. The e2e harness
 * passes this flag for isolation, so honour it at the app level too - without
 * this, every test instance shares (and pollutes) the real user's data and
 * fights over one single-instance lock.
 */
const userDataOverride = process.argv
  .find((argument) => argument.startsWith('--user-data-dir='))
  ?.slice('--user-data-dir='.length);
if (userDataOverride) {
  app.setPath('userData', path.resolve(userDataOverride));
  app.setAppLogsPath(path.join(path.resolve(userDataOverride), 'logs'));
}

/**
 * The end-to-end suite needs a way to invoke editor commands that depend on a
 * DOM text selection inside the canvas iframe, which no test driver can produce.
 *
 * The hooks are opt-in via an explicit command-line flag and are refused
 * outright in a packaged build, so a shipped installer cannot be coaxed into
 * exposing them.
 */
const testHooksRequested = !app.isPackaged && process.argv.includes('--litho-enable-test-hooks');

// Available because `scripts/build-electron.mjs` emits CommonJS for the main
// process; Electron's loader and sandboxed preloads are most reliable that way.
const bundleDirectory = __dirname;

let mainWindow: BrowserWindow | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/* ------------------------------------------------------------------ */
/* Content Security Policy for the editor UI                           */
/* ------------------------------------------------------------------ */

/**
 * `unsafe-inline` for styles is required because the canvas renders the user's
 * page inside the editor and applies computed styles inline while dragging.
 * Scripts get no such exemption in a packaged build: `script-src 'self'` means
 * no inline script, no `eval`, and no remote script can execute in the editor
 * window. In development only, `'unsafe-inline'` is added to `script-src`
 * because Vite injects its React Fast Refresh preamble as an inline
 * `<script type="module">` into `index.html` - without this the preamble is
 * silently blocked and the renderer never mounts. This never ships: `isDevelopment`
 * is `!app.isPackaged`.
 *
 * `img-src`/`font-src`/`style-src` allow `https:`/`http:` so the canvas can
 * show a page's CDN-hosted images and web fonts exactly as a browser would -
 * the editor is not a network sandbox, only the write path (files on disk) is
 * ever touched automatically. The live preview pane already loads such
 * resources through its own session; this brings the canvas to parity.
 *
 * `base-uri` must allow `file:` - the canvas injects a `<base href="file://…">`
 * into the page it renders so every relative asset path resolves against the
 * *project* folder instead of the app's own install directory. Leaving this at
 * `'none'` (the previous, over-tightened value) silently discarded that `<base>`
 * tag, which broke every relative image/link/script reference in the canvas.
 */
const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self'" + (isDevelopment ? " 'unsafe-inline'" : ''),
  "style-src 'self' 'unsafe-inline' https: http:",
  `img-src 'self' data: blob: file: ${ASSET_PROTOCOL}: https: http:`,
  `font-src 'self' data: ${ASSET_PROTOCOL}: https: http:`,
  `media-src 'self' file: ${ASSET_PROTOCOL}: https: http:`,
  "connect-src 'self'" + (isDevelopment ? ' ws://localhost:* http://localhost:*' : ''),
  "object-src 'none'",
  // Embeds (maps, video players, …) dropped onto a page still can't load live
  // in the edit canvas: even with this opened up, their own sub-requests
  // (scripts, XHR) would hit `connect-src`/`blockRemoteRequests` piecemeal and
  // fail loudly one request at a time - worse than not loading at all. The
  // canvas shows a static placeholder for `<iframe>` instead (see
  // `EDITOR_OVERLAY_CSS` in canvasDocument.ts); Preview and the exported HTML
  // render the real embed.
  "frame-src 'none'",
  `base-uri 'self' file: ${ASSET_PROTOCOL}:`,
  "form-action 'none'",
].join('; ');

function applySecurityPolicies(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [EDITOR_CSP],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  // The editor UI itself needs no privileged web APIs.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  blockRemoteRequests();
  forwardCanvasResourceErrors();
}

/**
 * Surfaces broken resources on the *edited page* in the in-app console panel.
 *
 * The canvas renders that page as an `about:srcdoc` iframe (see `ASSET_PROTOCOL`
 * comment above), so a missing image or unreachable stylesheet fails inside a
 * nested frame the user never opens DevTools on - Chromium's own diagnostics
 * (`GET … net::ERR_NAME_NOT_RESOLVED`, "Blocked script execution…") only ever
 * reach the *renderer's* built-in DevTools console, which nothing in this app
 * previously read. `webContents.on('console-message')` looked like the natural
 * hook (previewService.ts already uses it for the separate Preview pane), but
 * it turned out not to fire at all for network-diagnostic messages originating
 * in a subframe - verified empirically, not documented. `onErrorOccurred` is
 * session-level and reports every failed request regardless of which frame
 * issued it, which is what actually works here.
 */
function forwardCanvasResourceErrors(): void {
  /*
   * Every `url|error` already reported. This used to remember only the *last*
   * one, which deduplicated nothing in the common case: a page pulling four
   * web-font files re-reported all four on every canvas reload, because no two
   * consecutive failures were ever identical.
   */
  const reported = new Set<string>();
  const MAX_REMEMBERED = 500;

  session.defaultSession.webRequest.onErrorOccurred((details) => {
    // Only the editor canvas uses `srcdoc` - this excludes the app's own UI
    // and (moot anyway, separate partition) the Preview pane.
    if (details.frame?.url !== 'about:srcdoc') return;
    // `ERR_ABORTED` fires constantly as a normal side effect of the canvas
    // reloading mid-request while the user is still editing; deliberate
    // blocks from `blockRemoteRequests` above are already logged there.
    if (details.error === 'net::ERR_ABORTED' || details.error === 'net::ERR_BLOCKED_BY_CLIENT') return;

    const key = `${details.url}|${details.error}`;
    if (reported.has(key)) return;
    if (reported.size >= MAX_REMEMBERED) reported.clear();
    reported.add(key);

    const offline = isUnreachableRemote(details.url, details.error);
    const message = offline
      ? `Zasób z sieci jest niedostępny offline: ${details.url}. Strona wyświetli się bez niego - w przeglądarce z internetem wczyta się normalnie.`
      : `Nie udało się wczytać zasobu strony: ${details.url} (${details.error})`;
    // A web font that cannot be fetched with no connection says nothing about
    // the user's project - reporting it as an error made the console look like
    // the page was broken when the only thing missing was the network.
    const level = offline ? 'warn' : 'error';

    writeLog('canvas', level, message);
    const window = getWindow();
    if (window) {
      const entry: LogEntry = { timestamp: Date.now(), level, scope: 'canvas', message };
      window.webContents.send(IPC.eventLogEntry, entry);
    }
  });
}

/**
 * True when a remote resource failed for a reason that is about the *network*,
 * not about the project: no connection, DNS unavailable, or - the common one
 * for a page referencing Google Fonts while offline - nothing in the HTTP
 * cache to serve and no way to fetch it (`ERR_CACHE_MISS`).
 */
function isUnreachableRemote(url: string, error: string): boolean {
  if (!/^https?:/iu.test(url)) return false;
  return (
    error === 'net::ERR_CACHE_MISS' ||
    error === 'net::ERR_INTERNET_DISCONNECTED' ||
    error === 'net::ERR_NAME_NOT_RESOLVED' ||
    error === 'net::ERR_NAME_RESOLUTION_FAILED' ||
    error.startsWith('net::ERR_CONNECTION_') ||
    error === 'net::ERR_TIMED_OUT' ||
    error === 'net::ERR_NETWORK_CHANGED'
  );
}

/**
 * Offline-by-default network policy.
 *
 * Litho Studio never sends anything anywhere: there is no telemetry, no
 * auto-update, and no app code that fetches or posts data over the network.
 * This handler enforces the "no outgoing data" half of that at the network
 * layer, cancelled before the request leaves the machine - defence in depth on
 * top of `connect-src 'self'` in the CSP above, which already blocks
 * `fetch`/`XHR`/`WebSocket` from application code.
 *
 * The one deliberate exception is passive display resources - images, fonts
 * and stylesheets - which the canvas needs to render a page exactly as a
 * browser would when that page references a CDN or a web font. Loading those
 * is a read with no user data attached, unlike a script (which could execute
 * arbitrary code) or a `fetch`/`xhr`/`websocket` (which could exfiltrate
 * something); both remain blocked.
 */
function blockRemoteRequests(): void {
  const allowed = new Set([
    'file:',
    'devtools:',
    'blob:',
    'data:',
    'chrome-extension:',
    `${ASSET_PROTOCOL}:`,
  ]);
  const passiveDisplayTypes = new Set(['image', 'stylesheet', 'font', 'media']);
  const filter = { urls: ['*://*/*'] };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    let protocol: string;
    try {
      protocol = new URL(details.url).protocol;
    } catch {
      callback({ cancel: true });
      return;
    }

    if (allowed.has(protocol)) {
      callback({ cancel: false });
      return;
    }

    const isHttp = /^https?:$/u.test(protocol);

    // Only the local dev server is permitted for everything else, and only in
    // development.
    const isLocalDev =
      isDevelopment && isHttp && /^(localhost|127\.0\.0\.1)(:\d+)?$/u.test(new URL(details.url).host);

    if (isLocalDev || (isHttp && passiveDisplayTypes.has(details.resourceType))) {
      callback({ cancel: false });
      return;
    }

    log.warn(`[security] zablokowano żądanie sieciowe: ${details.url}`);
    callback({ cancel: true });
  });
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#1a1b23',
    title: 'Litho Studio',
    icon: resolveIcon(),
    /*
     * No platform menu bar anywhere but macOS; the app draws its own (see
     * menu.ts and `AppMenu.tsx`).
     *
     * This used to be Linux-only, which left Windows showing *two* menus with
     * the same contents: a Chromium-drawn "Projekt Edycja Widok Narzędzia Pomoc"
     * strip welded under the title bar, and the identical tree behind the
     * toolbar's ☰. One of them had to go, and the platform one is the one that
     * cannot be styled - it answers to the desktop's own font and colours, so on
     * a dark editor it reads as a band belonging to some other program.
     *
     * macOS keeps its bar: there the menu is not a strip inside the window but
     * the system-wide bar at the top of the screen, which is where every Mac
     * application's menu belongs and which no app should be hiding.
     *
     * The native menu stays *registered* on every platform - only its bar is
     * hidden. That is what keeps Projekt's real accelerators (Ctrl+O,
     * Ctrl+Shift+N…) working, since those are the only ones this app does not
     * implement in its own key handler. `autoHideMenuBar` is also what makes
     * `setMenuBarVisibility` below stick - with it off, some window managers put
     * the bar back on the next resize - and it leaves Alt summoning the native
     * bar for anyone who wants it.
     */
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(bundleDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Surfaces a few facts to the preload without exposing all of `process`.
      additionalArguments: [
        `--litho-app-version=${appVersion()}`,
        ...(testHooksRequested ? ['--litho-test-hooks'] : []),
      ],
    },
  });

  if (process.platform !== 'darwin') window.setMenuBarVisibility(false);

  window.once('ready-to-show', () => {
    window.show();
    // Auto-open devtools for humans only: under the e2e harness the extra
    // detached window steals focus and destabilises the suite.
    if (isDevelopment && !testHooksRequested) window.webContents.openDevTools({ mode: 'detach' });
  });

  const emitWindowState = () => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC.eventWindowState, {
      maximized: window.isMaximized(),
      focused: window.isFocused(),
    });
  };
  window.on('maximize', emitWindowState);
  window.on('unmaximize', emitWindowState);
  window.on('focus', emitWindowState);
  window.on('blur', emitWindowState);

  installFlushOnClose(window);
  lockDownNavigation(window);

  window.on('closed', () => {
    mainWindow = null;
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(bundleDirectory, '../renderer/index.html'));
  }

  return window;
}

/**
 * Closing the window races the debounced save: the renderer may still be
 * holding up to ~180 ms of edits it has not written yet. The first close
 * request is therefore intercepted, the renderer is asked to flush, and the
 * window closes only after it confirms - with a hard timeout so a hung
 * renderer can never make the window unclosable.
 */
function installFlushOnClose(window: BrowserWindow): void {
  let flushed = false;

  window.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();

    const finish = (): void => {
      if (flushed) return;
      flushed = true;
      clearTimeout(timeout);
      ipcMain.removeListener(IPC.appFlushDone, onDone);
      if (!window.isDestroyed()) window.close();
    };

    const onDone = (senderEvent: Electron.IpcMainEvent): void => {
      if (senderEvent.sender === window.webContents) finish();
    };

    const timeout = setTimeout(() => {
      log.warn('[main] renderer did not confirm flush before close - closing anyway');
      finish();
    }, 2000);

    ipcMain.on(IPC.appFlushDone, onDone);
    window.webContents.send(IPC.eventFlushRequest);
  });
}

/**
 * The editor window may never navigate away from its own document and may never
 * spawn a second window. External links go to the system browser.
 */
function lockDownNavigation(window: BrowserWindow): void {
  const contents = window.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl ? url.startsWith(devServerUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//iu.test(url)) void shell.openExternal(url);
      log.warn(`[security] blocked navigation to ${url}`);
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('[security] blocked <webview> attachment');
  });

  contents.on('render-process-gone', (_event, details) => {
    log.error(`[main] renderer process gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason !== 'clean-exit') {
      void dialog.showMessageBox({
        type: 'error',
        title: 'Litho Studio',
        message: 'Interfejs edytora przestał odpowiadać i został ponownie uruchomiony.',
        detail: 'Twoje zmiany były zapisywane na bieżąco. Sprawdź panel logów, aby poznać szczegóły.',
        buttons: ['OK'],
      });
      contents.reload();
    }
  });
}

/**
 * Serves project files under `litho-asset://project/<posix-relative-path>` -
 * the same containment guard (`resolveProjectAssetPath`, which goes through
 * `PathGuard`) that every other file access uses, so this cannot be coaxed
 * into reading outside the open project. `net.fetch` on a `file://` URL
 * reuses Chromium's own MIME sniffing/range-request handling instead of
 * reimplementing it.
 */
function registerAssetProtocol(): void {
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'project') {
      return new Response(null, { status: 404 });
    }
    const relPath = decodeURIComponent(url.pathname.replace(/^\/+/u, ''));
    const absolute = await resolveProjectAssetPath(relPath);
    if (!absolute) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(absolute).toString());
  });
}

function resolveIcon(): string | undefined {
  const candidates = process.platform === 'darwin' ? ['icon.icns'] : ['icon-512.png'];

  for (const name of candidates) {
    const packaged = path.join(process.resourcesPath ?? '', 'icons', name);
    const local = path.join(bundleDirectory, '../../resources/icons', name);
    for (const candidate of [packaged, local]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* fall through to the next candidate */
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app
    .whenReady()
    .then(() => {
      initLogger();
      applySecurityPolicies();
      registerAssetProtocol();

      mainWindow = createWindow();
      registerIpc(getWindow);
      buildApplicationMenu(getWindow);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
      });
    })
    .catch((error) => {
      log.error('[main] startup failed', error);
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    getPreviewService()?.destroy();
    getTerminalService()?.disposeAll();
    // An `npm install -g` left running past app exit would keep writing to the
    // npm prefix with no window left to report to.
    getAiToolsService()?.disposeAll();
    void closeCurrentProject();
  });
}
