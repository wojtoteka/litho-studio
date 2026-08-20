import { create } from 'zustand';
import type { LogEntry, UpdateStatus } from '@shared/ipc.js';

/**
 * Presentation state: theme, panel visibility, canvas viewport and the console
 * buffer. Kept apart from `editorStore` because none of it belongs to the
 * document — losing all of it would cost the user nothing but a re-arranged
 * workspace, whereas losing editor state would cost them work.
 */

export type Theme = 'dark' | 'light';

/**
 * A viewport-space box of something drawn *over* the app — a menu, a popover, a
 * dialog backdrop. Kept as plain numbers rather than a `DOMRect` so the store
 * stays serialisable and comparable.
 */
export interface LayerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Destinations of the left dock. Named so the tab strip can be data-driven. */
export type LeftPanel = 'elements' | 'components' | 'icons' | 'styles' | 'layers' | 'assets' | 'audit';

const THEME_KEY = 'litho:theme';
const MAX_LOG_ENTRIES = 500;

/** 0.2, not 0.25: 20 % is one of the presets the zoom menu offers, and a preset
 *  the control silently clamps away is worse than no preset. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;

/** The steps the zoom menu offers, as fractions. Bounded by the clamp above. */
export const ZOOM_PRESETS = [0.2, 0.5, 0.8, 1, 1.5, 2, 3, 5] as const;

interface UiState {
  theme: Theme;
  previewVisible: boolean;
  consoleVisible: boolean;
  terminalVisible: boolean;
  shortcutsVisible: boolean;
  newProjectDialogVisible: boolean;
  newPageDialogVisible: boolean;
  /** The AI tool installer. Windows-only; nothing opens it elsewhere. */
  aiToolsDialogVisible: boolean;
  leftPanel: LeftPanel;

  /**
   * 'edit' is today's canvas: clicking selects an element and exposes drag
   * handles / text editing. 'preview' keeps the same click-to-select-and-sync
   * behaviour (the right panel and layers tree still follow the click) but
   * hides every mutation affordance, so clicking around the page to see what's
   * there can never accidentally start a resize or a text edit.
   */
  canvasMode: 'edit' | 'preview';

  zoom: number;
  /**
   * `fit` keeps the whole breakpoint width visible by scaling the canvas to the
   * space available, which is what makes the editor show the same complete page
   * the live preview does. A 1440 px desktop canvas in a 980 px work area is
   * otherwise simply clipped, and the right third of every page disappears.
   * Any manual zoom switches to `manual` and stays put.
   */
  zoomMode: 'fit' | 'manual';
  showGrid: boolean;

  /**
   * Width of the canvas work area, in CSS px, as measured by `Canvas`.
   *
   * The base breakpoint has no width of its own — it renders at whatever the
   * work area happens to be, exactly like a real browser window — so this is
   * the number the breakpoint bar shows for it. Published here purely for
   * display: nothing in the canvas reads it back, so it cannot feed into the
   * layout it was measured from.
   */
  canvasPaneWidth: number;
  setCanvasPaneWidth(width: number): void;

  /**
   * Where every open floating layer currently is, keyed by an id the layer owns
   * for its lifetime.
   *
   * Only one thing reads this: the live preview, which is a native
   * `WebContentsView` composited above the document and therefore in front of
   * anything the DOM draws. See `hasBlockingOverlay` below.
   */
  floatingLayers: Record<string, LayerRect>;
  /** Publishes a layer's box, or removes it when `rect` is `null`. */
  setFloatingLayer(id: string, rect: LayerRect | null): void;

  logs: LogEntry[];

  /**
   * Result of this launch's update check, or `null` while it is still running
   * (or if it never produced anything useful).
   *
   * Held in the store rather than in the banner so the check runs once per
   * launch: the banner is rendered by both the start screen and the editor, and
   * a component-local check would fire again every time the user opened or
   * closed a project.
   */
  update: UpdateStatus | null;
  /**
   * "Ukryj" is deliberately session-scoped and nothing is written to disk: the
   * user asked for the check to run on *every* start, so a dismissal that
   * outlived the process would quietly turn that off.
   */
  updateDismissed: boolean;
  /**
   * Whether the launch-time update dialog has been answered this session.
   *
   * The dialog is the loud half of the notice and the banner is the quiet
   * half: "Później" closes the dialog and leaves the banner behind, so the
   * user can keep working and still has one click to the download page. Like
   * `updateDismissed`, it lives and dies with the process — the check is meant
   * to speak up on *every* start.
   */
  updateNoticeSeen: boolean;
  setUpdate(status: UpdateStatus | null): void;
  dismissUpdate(): void;
  acknowledgeUpdateNotice(): void;

  setTheme(theme: Theme): void;
  toggleTheme(): void;
  togglePreview(): void;
  toggleConsole(): void;
  toggleTerminal(): void;
  toggleShortcuts(): void;
  openNewProjectDialog(): void;
  closeNewProjectDialog(): void;
  openNewPageDialog(): void;
  closeNewPageDialog(): void;
  openAiToolsDialog(): void;
  closeAiToolsDialog(): void;
  setLeftPanel(panel: UiState['leftPanel']): void;
  setCanvasMode(mode: UiState['canvasMode']): void;

  setZoom(zoom: number): void;
  zoomBy(factor: number): void;
  resetZoom(): void;
  /** Re-enables automatic scale-to-fit. */
  fitZoom(): void;
  /** Applies a computed fit scale without leaving `fit` mode. */
  applyFitZoom(zoom: number): void;
  toggleGrid(): void;

  appendLog(entry: LogEntry): void;
  setLogs(entries: LogEntry[]): void;
  clearLogs(): void;
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private mode or a locked-down profile — fall back to the default.
  }
  return 'dark';
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Non-fatal: the theme simply will not survive a restart.
  }
  document.documentElement.dataset.theme = theme;
  applyThemeToWindowFrame(theme);
}

/**
 * Carries the theme past the edge of the document.
 *
 * `data-theme` styles everything this app draws, but the caption bar, the
 * window buttons and the menu bar are drawn by the OS and answer only to
 * `nativeTheme` in the main process — which is why switching to the light theme
 * used to leave a black bar across the top. Optional-chained because the store
 * is also imported by code that runs without the preload bridge (tests).
 */
function applyThemeToWindowFrame(theme: Theme): void {
  void window.litho?.window?.setTheme?.(theme);
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStoredTheme(),
  previewVisible: false,
  consoleVisible: false,
  terminalVisible: false,
  shortcutsVisible: false,
  newProjectDialogVisible: false,
  newPageDialogVisible: false,
  aiToolsDialogVisible: false,
  leftPanel: 'elements',
  canvasMode: 'edit',

  zoom: 1,
  zoomMode: 'fit',
  showGrid: false,
  canvasPaneWidth: 0,
  floatingLayers: {},

  logs: [],
  update: null,
  updateDismissed: false,
  updateNoticeSeen: false,

  setUpdate: (update) => set({ update }),
  dismissUpdate: () => set({ updateDismissed: true }),
  acknowledgeUpdateNotice: () => set({ updateNoticeSeen: true }),

  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  togglePreview: () => set((state) => ({ previewVisible: !state.previewVisible })),
  toggleConsole: () => set((state) => ({ consoleVisible: !state.consoleVisible })),
  toggleTerminal: () => set((state) => ({ terminalVisible: !state.terminalVisible })),
  toggleShortcuts: () => set((state) => ({ shortcutsVisible: !state.shortcutsVisible })),
  openNewProjectDialog: () => set({ newProjectDialogVisible: true }),
  closeNewProjectDialog: () => set({ newProjectDialogVisible: false }),
  openNewPageDialog: () => set({ newPageDialogVisible: true }),
  closeNewPageDialog: () => set({ newPageDialogVisible: false }),
  openAiToolsDialog: () => set({ aiToolsDialogVisible: true }),
  closeAiToolsDialog: () => set({ aiToolsDialogVisible: false }),
  setLeftPanel: (leftPanel) => set({ leftPanel }),
  setCanvasMode: (canvasMode) => set({ canvasMode }),

  setZoom: (zoom) => set({ zoom: clampZoom(zoom), zoomMode: 'manual' }),
  zoomBy: (factor) => set((state) => ({ zoom: clampZoom(state.zoom * factor), zoomMode: 'manual' })),
  resetZoom: () => set({ zoom: 1, zoomMode: 'manual' }),
  fitZoom: () => set({ zoomMode: 'fit' }),
  applyFitZoom: (zoom) => set((state) => (state.zoomMode === 'fit' ? { zoom: clampZoom(zoom) } : {})),
  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),

  setCanvasPaneWidth: (width) =>
    set((state) => (Math.abs(state.canvasPaneWidth - width) > 1 ? { canvasPaneWidth: width } : {})),

  /*
   * Re-published on every commit of the owning layer (see `useFloatingLayer`),
   * so the no-op returns are what keep that from being a render loop: an
   * unchanged box leaves the `floatingLayers` object identity alone, and a
   * selector reading it never re-runs.
   */
  setFloatingLayer: (id, rect) =>
    set((state) => {
      const current = state.floatingLayers[id];
      if (rect === null) {
        if (!current) return {};
        const next = { ...state.floatingLayers };
        delete next[id];
        return { floatingLayers: next };
      }
      if (current && sameRect(current, rect)) return {};
      return { floatingLayers: { ...state.floatingLayers, [id]: rect } };
    }),

  appendLog: (entry) =>
    set((state) => {
      const logs = [...state.logs, entry];
      return { logs: logs.length > MAX_LOG_ENTRIES ? logs.slice(-MAX_LOG_ENTRIES) : logs };
    }),

  setLogs: (entries) => set({ logs: entries.slice(-MAX_LOG_ENTRIES) }),
  clearLogs: () => set({ logs: [] }),
}));

/**
 * True while something modal is drawn over the whole app.
 *
 * This exists for one reason: the live preview is a native `WebContentsView`,
 * not part of the document. Native views are composited *above* the page no
 * matter what `z-index` the DOM asks for, so a dialog opened while the preview
 * was on screen was simply painted underneath it — the reported "open the
 * shortcuts dialog while previewing and the panel sinks behind the page". The
 * preview pane subscribes to this and stands its view down while an overlay is
 * up (see PreviewPane.tsx).
 *
 * Modal dialogs are the easy half: they cover the window, so a flag is enough.
 * Everything else that floats — menus, popovers, the out-of-layout list — is
 * handled by `floatingLayers` + `isCoveredByLayer`, which stands the view down
 * only when the layer genuinely reaches over it.
 */
export function hasBlockingOverlay(state: UiState): boolean {
  return (
    state.shortcutsVisible ||
    state.newProjectDialogVisible ||
    state.newPageDialogVisible ||
    state.aiToolsDialogVisible
  );
}

/** Whether any open floating layer overlaps `box`. */
export function isCoveredByLayer(layers: Record<string, LayerRect>, box: LayerRect): boolean {
  return Object.values(layers).some(
    (layer) =>
      layer.left < box.right && layer.right > box.left && layer.top < box.bottom && layer.bottom > box.top,
  );
}

function sameRect(a: LayerRect, b: LayerRect): boolean {
  // Sub-pixel drift is not worth a store update: the boxes this compares come
  // from `getBoundingClientRect`, which reports fractions that wobble with zoom.
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.right - b.right) < 0.5 &&
    Math.abs(a.bottom - b.bottom) < 0.5
  );
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Applies the stored theme before React mounts, avoiding a flash. */
export function applyInitialTheme(): void {
  const theme = readStoredTheme();
  document.documentElement.dataset.theme = theme;
  // The frame is painted before the first React commit, so it has to be told
  // here too — otherwise a light-themed session starts with a dark caption bar
  // until the user happens to toggle the theme.
  applyThemeToWindowFrame(theme);
}
