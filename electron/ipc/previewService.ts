import path from 'node:path';
import { WebContentsView, shell, session, type BrowserWindow, type Session } from 'electron';
import type { LogEntry, PreviewBounds } from '@shared/ipc.js';
import { fail, ok, type IpcResult } from '@shared/result.js';
import { log } from '../logger.js';
import type { PathGuard } from './pathGuard.js';
import { isInside } from './pathGuard.js';

/**
 * Live preview pane.
 *
 * The preview renders the *real file from disk* over `file://`, which is the
 * whole point of the product: what you see is what a browser will show after
 * you upload the folder. That means it also runs the user's own JavaScript, so
 * it is treated as untrusted content:
 *
 *  - its own session partition, so storage and cookies never touch the app;
 *  - `sandbox: true`, `contextIsolation: true`, no preload, no Node;
 *  - navigation is confined to the project folder - external links open in the
 *    system browser instead of taking over the pane;
 *  - `window.open` is denied outright.
 */

const PREVIEW_PARTITION = 'litho-preview';

export class PreviewService {
  private view: WebContentsView | null = null;
  private guard: PathGuard | null = null;
  private currentPage: string | null = null;
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0 };
  /**
   * Whether the view is meant to be on screen.
   *
   * Tracked here because `hide()` also collapses the view's box to nothing (see
   * below), and the renderer keeps publishing real bounds from its layout while
   * the pane is standing down - without this flag the next `setBounds` would
   * quietly put a hidden view back at full size.
   */
  private visible = false;
  /** Page magnification; see `setZoom`. */
  private zoomFactor = 1;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    /**
     * Surfaces a navigation problem to the renderer's own log/console panel -
     * a plain `log.warn` only reaches the log file, which is invisible while
     * using the app. "Przeglądanie" is meant to behave like a real page, and a
     * silently-swallowed broken link is the opposite of that.
     */
    private readonly notify: (entry: LogEntry) => void = () => undefined,
  ) {}

  setProject(guard: PathGuard | null): void {
    this.guard = guard;
    // Closing a project must take the *whole* view down, not merely mark it
    // invisible: with no project there is nothing legitimate for it to show,
    // and a view that is only hidden is one repaint away from being seen again.
    if (!guard) this.destroy();
  }

  async show(relPath: string, bounds: PreviewBounds): Promise<IpcResult<void>> {
    const guard = this.guard;
    if (!guard) return fail('NOT_A_PROJECT', 'Nie otwarto żadnego projektu.');

    const resolved = await guard.resolve(relPath);
    if (!resolved.ok) return resolved;

    const window = this.getWindow();
    if (!window || window.isDestroyed()) return fail('INTERNAL', 'Okno aplikacji jest niedostępne.');

    const view = this.ensureView(window);
    this.bounds = bounds;
    view.setBounds(toIntegerBounds(bounds));

    if (this.currentPage !== relPath) {
      this.currentPage = relPath;
      try {
        await view.webContents.loadFile(resolved.value);
      } catch (error) {
        // Leave the page marked as not-loaded so the next `show` retries
        // instead of presenting the failed view as if it were current.
        this.currentPage = null;
        log.warn(`[preview] failed to load ${relPath}`, error);
        return fail('IO_ERROR', `Nie udało się wczytać podglądu strony ${relPath}.`, String(error));
      }
    }
    this.applyZoom();
    this.visible = true;
    view.setVisible(true);
    return ok(undefined);
  }

  /**
   * Takes the preview off screen.
   *
   * `setVisible(false)` alone is not enough on this app's rendering path.
   * Hardware acceleration is disabled outright (see `app.disableHardwareAcceleration`
   * in main.ts, which exists because Linux GPU stacks left the window blank),
   * and under software compositing a native child view that is merely marked
   * invisible can leave its last painted frame on screen - the reported "I leave
   * the project and my page is still sitting on top of the main menu, until I
   * click Edycja". Collapsing the box to zero as well removes the surface those
   * pixels belong to, and the repaint below makes the window redraw what should
   * have been underneath it all along.
   */
  async hide(): Promise<IpcResult<void>> {
    this.visible = false;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false);
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    this.repaintWindow();
    return ok(undefined);
  }

  setBounds(bounds: PreviewBounds): IpcResult<void> {
    this.bounds = bounds;
    // Remembered either way, so `show()` can restore the pane's real box - but
    // only applied while the view is supposed to be on screen. The renderer
    // publishes bounds on a timer and on every resize, including during the
    // moments the pane is standing down for a dialog or being torn down.
    if (this.view && this.visible) this.view.setBounds(toIntegerBounds(bounds));
    return ok(undefined);
  }

  /**
   * Page zoom, remembered across loads.
   *
   * `webContents.setZoomFactor` is per-navigation state in Chromium, so the
   * factor is stored and re-applied on every load - otherwise browsing to a
   * second page through a link would silently snap back to 100 %.
   */
  setZoom(factor: number): IpcResult<void> {
    this.zoomFactor = clampZoomFactor(factor);
    this.applyZoom();
    return ok(undefined);
  }

  private applyZoom(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents.setZoomFactor(this.zoomFactor);
  }

  async reload(): Promise<IpcResult<void>> {
    if (!this.view || this.view.webContents.isDestroyed()) return ok(undefined);
    this.view.webContents.reload();
    return ok(undefined);
  }

  /**
   * Re-fetches every stylesheet without reloading the document, so scroll
   * position, form state and any JS-driven UI survive a CSS-only change.
   */
  async hotReloadCss(): Promise<IpcResult<void>> {
    if (!this.view || this.view.webContents.isDestroyed()) return ok(undefined);
    try {
      await this.view.webContents.executeJavaScript(CSS_HOT_RELOAD_SNIPPET, true);
      return ok(undefined);
    } catch (error) {
      log.warn('[preview] css hot reload failed, falling back to reload', error);
      return this.reload();
    }
  }

  async openInBrowser(relPath: string): Promise<IpcResult<void>> {
    const guard = this.guard;
    if (!guard) return fail('NOT_A_PROJECT', 'Nie otwarto żadnego projektu.');
    const resolved = await guard.resolve(relPath);
    if (!resolved.ok) return resolved;
    try {
      await shell.openPath(resolved.value);
      return ok(undefined);
    } catch (error) {
      return fail('IO_ERROR', 'Nie udało się otworzyć strony w przeglądarce.', String(error));
    }
  }

  /** Invalidates the loaded page so the next `show` performs a full load. */
  invalidate(relPath: string): void {
    if (this.currentPage === relPath) this.currentPage = null;
  }

  /**
   * Marks whatever is loaded as stale. Used after the editor's own saves, which
   * the watcher deliberately never reports - a hidden preview would otherwise
   * come back showing the pre-save file.
   */
  invalidateAll(): void {
    this.currentPage = null;
  }

  destroy(): void {
    const view = this.view;
    this.visible = false;
    this.view = null;
    this.currentPage = null;
    // A fresh view must not inherit the old pane's box: `ensureView` applies
    // `this.bounds` before the renderer has published anything, and the stale
    // rectangle is exactly where the previous page was drawn.
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };

    if (!view) return;

    // Hidden and collapsed *before* it is unparented - see `hide()`. Removing a
    // still-visible child view is what leaves its last frame composited over
    // the window on the software renderer this app runs on.
    if (!view.webContents.isDestroyed()) {
      view.setVisible(false);
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }

    const window = this.getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    view.webContents.close();
    this.repaintWindow();
  }

  /**
   * Forces the window to redraw the area the native view was occupying.
   *
   * `invalidate()` is the only thing that reliably clears a stale composite
   * here; without it the pixels of a removed view can survive until something
   * else happens to dirty that region - which is why the leftover page used to
   * disappear only once the user clicked Edycja and the whole work area was
   * re-laid-out.
   */
  private repaintWindow(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    if (!window.webContents.isDestroyed()) window.webContents.invalidate();
  }

  private ensureView(window: BrowserWindow): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;

    const previewSession = configurePreviewSession();

    const view = new WebContentsView({
      webPreferences: {
        session: previewSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false,
      },
    });

    view.setBackgroundColor('#ffffff');
    this.guardNavigation(view);

    window.contentView.addChildView(view);
    view.setBounds(toIntegerBounds(this.bounds));
    this.view = view;
    return view;
  }

  private guardNavigation(view: WebContentsView): void {
    const contents = view.webContents;

    contents.setWindowOpenHandler(({ url }) => {
      void openExternal(url);
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      const guard = this.guard;
      if (!guard) {
        event.preventDefault();
        return;
      }
      if (!url.startsWith('file://')) {
        event.preventDefault();
        void openExternal(url);
        return;
      }
      const target = fileUrlToPath(url);
      if (!target || !isInside(guard.rootPath, target)) {
        event.preventDefault();
        const message = `Zablokowano odnośnik prowadzący poza folder projektu: ${url}`;
        log.warn(`[preview] blocked navigation outside project: ${url}`);
        this.notify({ timestamp: Date.now(), level: 'error', scope: 'main', message });
        return;
      }
      const relative = guard.toRelative(target);
      if (relative) this.currentPage = relative;
    });

    // Zoom is reset by every navigation, so it is re-asserted after each one.
    contents.on('did-finish-load', () => this.applyZoom());

    contents.on('render-process-gone', (_event, details) => {
      log.warn(`[preview] render process gone: ${details.reason}`);
      this.currentPage = null;
    });

    // The user's own console output belongs in the app's console panel, not in
    // Electron's stdout, so it is forwarded at debug level only.
    contents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) log.info(`[preview:page] ${message} (${sourceId}:${line})`);
    });
  }
}

let previewSessionConfigured = false;

function configurePreviewSession(): Session {
  const previewSession = session.fromPartition(PREVIEW_PARTITION, { cache: false });
  if (previewSessionConfigured) return previewSession;
  previewSessionConfigured = true;

  // The preview never needs privileged web APIs; denying them keeps a page's
  // JavaScript from prompting the user through our window.
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);

  return previewSession;
}

async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//iu.test(url) && !/^mailto:/iu.test(url)) return;
  try {
    await shell.openExternal(url);
  } catch (error) {
    log.warn(`[preview] could not open ${url} externally`, error);
  }
}

function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(parsed.pathname);
    return path.normalize(pathname);
  } catch {
    return null;
  }
}

/** Mirrors the renderer's own zoom clamp (`uiStore`), defensively. */
function clampZoomFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(5, Math.max(0.2, factor));
}

function toIntegerBounds(bounds: PreviewBounds): Electron.Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

/**
 * Swaps every same-origin stylesheet for a cache-busted copy, then removes the
 * old node only once the new one has loaded - that ordering avoids the flash of
 * unstyled content a naive `href` reassignment produces.
 */
const CSS_HOT_RELOAD_SNIPPET = `(() => {
  const links = Array.from(document.querySelectorAll('link[rel~="stylesheet"][href]'));
  const stamp = Date.now();
  for (const link of links) {
    const url = new URL(link.getAttribute('href'), document.baseURI);
    if (url.protocol !== 'file:') continue;
    url.searchParams.set('litho', String(stamp));
    const replacement = link.cloneNode(false);
    replacement.setAttribute('href', url.href);
    const drop = () => link.remove();
    replacement.addEventListener('load', drop, { once: true });
    replacement.addEventListener('error', drop, { once: true });
    link.parentNode.insertBefore(replacement, link.nextSibling);
  }
  return links.length;
})()`;
