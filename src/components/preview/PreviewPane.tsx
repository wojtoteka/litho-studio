import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { hasBlockingOverlay, isCoveredByLayer, useUiStore } from '@/state/uiStore.js';
import { logger } from '@/lib/logger.js';
import { Icon } from '../Icon.js';

/**
 * Live preview.
 *
 * The preview is a native `WebContentsView` owned by the main process, not an
 * iframe - that is what lets it load the file straight off disk with the user's
 * own scripts running, in a separate session, exactly as a browser would. React
 * cannot render into it, so this component's job is to *reserve the space* and
 * keep the main process informed of where that space is.
 *
 * The reload strategy distinguishes CSS-only saves from structural ones: a CSS
 * change is hot-swapped so scroll position and any JS-driven state survive,
 * while an HTML change needs a genuine reload.
 *
 * The active breakpoint sizes the surface, which is what makes Tablet/Telefon
 * mean something here: the native view is laid out at exactly the width this
 * element reserves, so the page's own media queries fire for real instead of
 * the preview always showing the desktop layout.
 */
/** Matches `--canvas-padding` on `.preview__stage`; `CANVAS_PADDING` in Canvas.tsx is the same number. */
const PREVIEW_STAGE_PADDING = 24;

export function PreviewPane(): JSX.Element {
  const pageRelPath = useEditorStore((state) => state.pageRelPath);
  const lastSavedAt = useEditorStore((state) => state.lastSavedAt);
  const lastWrittenPaths = useEditorStore((state) => state.lastWrittenPaths);
  const breakpoint = useEditorStore((state) => state.currentBreakpoint());
  const dialogOpen = useUiStore(hasBlockingOverlay);
  const floatingLayers = useUiStore((state) => state.floatingLayers);

  const zoom = useUiStore((state) => state.zoom);
  const zoomMode = useUiStore((state) => state.zoomMode);
  const canvasMode = useUiStore((state) => state.canvasMode);
  const canvasPaneWidth = useUiStore((state) => state.canvasPaneWidth);
  /** True when this pane sits *next to* the editor rather than replacing it. */
  const sideBySide = canvasMode !== 'preview';

  const surfaceRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastHandledSaveRef = useRef<number | null>(null);

  /** Space available to the page, measured - the counterpart of `paneSize` in Canvas.tsx. */
  const [stageWidth, setStageWidth] = useState(0);

  /*
   * Whether a menu, popover or non-modal overlay currently reaches over the
   * native view's box.
   *
   * Tested as a box intersection rather than "is anything open at all": the
   * toolbar and the breakpoint bar span this pane as well as the editor, so
   * their menus *sometimes* land on the preview and sometimes nowhere near it.
   * Standing the view down for every open menu would blank the page - and put
   * up the "wstrzymany" card - every time the user touched the ☰ menu on the
   * far side of the window.
   */
  const [covered, setCovered] = useState(false);
  const obscured = dialogOpen || covered;

  const recheckCoverage = useCallback((): void => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    setCovered(
      isCoveredByLayer(useUiStore.getState().floatingLayers, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      }),
    );
  }, []);

  // A layer opening, moving or closing is one half of the question; the other
  // is this pane moving under a layer that never changed, which the bounds
  // publisher below picks up.
  useLayoutEffect(() => {
    recheckCoverage();
  }, [floatingLayers, recheckCoverage]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = (): void => {
      const width = Math.max(0, stage.clientWidth - PREVIEW_STAGE_PADDING * 2);
      setStageWidth((current) => (Math.abs(current - width) > 1 ? width : current));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  /*
   * The page has to be laid out at the *same* CSS width the canvas lays it out
   * at, or the two halves of a side-by-side comparison are not comparing the
   * same thing - the reported "the preview renders the page bigger than the
   * editor". Two things pulled them apart: the canvas loses a slice of its work
   * area to the page's own scrollbar (`clientWidth` excludes it) while this
   * pane does not, and a scaled-to-fit canvas draws a fixed breakpoint smaller
   * than 1:1 while the native view was always at 100 %.
   *
   * So the width is taken from the canvas's own measurement when both are on
   * screen, and the magnification is applied as *page zoom* on the native view.
   * `bounds ÷ zoom` is the CSS viewport Chromium then gives the page, so
   * reserving `pageWidth × zoom` device pixels makes the page see exactly
   * `pageWidth` - the same number the canvas iframe is given.
   */
  const pageWidth = breakpoint.fluid
    ? sideBySide && canvasPaneWidth > 0
      ? canvasPaneWidth
      : null
    : breakpoint.canvasWidth;

  const localFitScale = pageWidth === null || stageWidth === 0 ? 1 : Math.min(1, stageWidth / pageWidth);
  /*
   * With the canvas on screen its scale is the authority, not a second
   * measurement of a supposedly identical pane: the canvas loses a slice of its
   * width to the page's scrollbar, so computing "fit" here independently lands
   * a percent or two above it and the preview is fractionally bigger again -
   * the exact difference this whole arrangement exists to remove. In fit mode
   * the canvas publishes its scale as `zoom` (see `applyFitZoom`), so taking it
   * from there makes the two identical by construction.
   */
  const zoomFactor = zoomMode === 'fit' ? (sideBySide && canvasPaneWidth > 0 ? zoom : localFitScale) : zoom;

  /*
   * A fluid breakpoint with no canvas beside it has no width of its own to
   * respect - it is whatever the pane is, exactly like a browser window - so
   * the surface simply fills the stage and the zoom factor alone decides how
   * much page fits inside it.
   */
  const surfaceStyle =
    pageWidth === null ? undefined : { width: Math.floor(pageWidth * zoomFactor), flex: 'none' as const };

  useEffect(() => {
    void window.litho.preview.setZoom(zoomFactor);
  }, [zoomFactor]);

  /* Keep the native view aligned with this element's box. */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !pageRelPath) return undefined;

    const publishBounds = (): void => {
      const rect = surface.getBoundingClientRect();
      void window.litho.preview.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      // The pane can slide under a layer that has not moved at all - a panel
      // opening, the window resizing, the console dock appearing. Same signal,
      // same answer.
      recheckCoverage();
    };

    const rect = surface.getBoundingClientRect();
    void window.litho.preview
      .show(pageRelPath, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      .then((result) => {
        if (!result.ok) logger.warn(`Nie udało się otworzyć podglądu: ${result.message}`);
      });

    const observer = new ResizeObserver(publishBounds);
    observer.observe(surface);
    window.addEventListener('resize', publishBounds);
    // Panel layout can shift without a resize event (e.g. the console opening).
    const interval = window.setInterval(publishBounds, 500);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', publishBounds);
      window.clearInterval(interval);
      void window.litho.preview.hide();
    };
  }, [pageRelPath, recheckCoverage]);

  /*
   * Stand the native view down while something is drawn over it, and bring it
   * back when that thing goes away.
   *
   * A `WebContentsView` is composited above the document, so an overlay drawn
   * in the DOM cannot appear in front of it however high its `z-index` - the
   * dialog was really being rendered all along, just behind the previewed page.
   * That is true of every floating thing, not only modal dialogs: the
   * out-of-layout list, the page picker, the zoom menu and the ☰ panel all drop
   * out of bars that span this pane. They now register their boxes (see
   * `useFloatingLayer`) and `covered` above turns that into the same signal.
   *
   * `hide()`/`show()` here are only `setVisible` on an already-loaded view, so
   * this costs no reload and the page keeps its scroll position and JS state.
   *
   * Declared *after* the effect that shows the view, and that order matters:
   * effects run top to bottom, so when both re-run for the same change (opening
   * a page while a dialog is up) this one gets the last word.
   */
  useEffect(() => {
    if (!pageRelPath) return;
    if (obscured) {
      void window.litho.preview.hide();
      return;
    }
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    void window.litho.preview.show(pageRelPath, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, [obscured, pageRelPath]);

  /*
   * Refresh after every save. A save that only touched stylesheets is
   * hot-swapped so scroll position and JS-driven state survive; anything that
   * rewrote HTML or JS needs a genuine reload. A save that wrote nothing new
   * (content identical) does not disturb the preview at all.
   */
  useEffect(() => {
    if (lastSavedAt === null || !pageRelPath) return;
    if (lastHandledSaveRef.current === lastSavedAt) return;
    lastHandledSaveRef.current = lastSavedAt;

    if (lastWrittenPaths.length === 0) return;
    const cssOnly = lastWrittenPaths.every((path) => path.endsWith('.css'));
    if (cssOnly) void window.litho.preview.hotReloadCss();
    else void window.litho.preview.reload();
  }, [lastSavedAt, lastWrittenPaths, pageRelPath]);

  return (
    <section className="preview" aria-label="Podgląd na żywo">
      <div className="preview__toolbar">
        <span className="preview__label">
          <Icon name="visibility" size={15} />
          Podgląd: {pageRelPath ?? '-'} ·{' '}
          {breakpoint.fluid ? 'pełna szerokość' : `${breakpoint.label} ${breakpoint.canvasWidth}px`}
          {Math.round(zoomFactor * 100) === 100 ? '' : ` · ${Math.round(zoomFactor * 100)}%`}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            className="button button--ghost button--icon"
            onClick={() => void window.litho.preview.hotReloadCss()}
            title="Odśwież tylko style, zachowując stan strony"
            aria-label="Odśwież CSS"
          >
            <Icon name="style" size={16} />
          </button>
          <button
            type="button"
            className="button button--ghost button--icon"
            onClick={() => void window.litho.preview.reload()}
            title="Przeładuj stronę"
            aria-label="Przeładuj"
          >
            <Icon name="refresh" size={16} />
          </button>
          <button
            type="button"
            className="button button--ghost button--icon"
            onClick={() => pageRelPath && void window.litho.preview.openInBrowser(pageRelPath)}
            title="Otwórz w przeglądarce"
            aria-label="Otwórz w przeglądarce"
          >
            <Icon name="open_in_new" size={16} />
          </button>
        </span>
      </div>
      {/* The stage centres the surface; the surface is what the native view is
          pinned to, so narrowing it *is* the device preview. */}
      <div className="preview__stage" ref={stageRef}>
        <div className="preview__surface" ref={surfaceRef} style={surfaceStyle} />
        {/*
         * Stood-down state.
         *
         * While something is drawn over the pane the native view is hidden (it
         * composites above the DOM, so nothing else can be drawn in front of
         * it) - and what showed through was the surface's own flat white fill,
         * across the whole pane. That is the reported "open a dialog over the
         * preview and the page behind turns completely white": the page had not
         * broken at all, there was simply nothing left saying so. Saying it is
         * the fix.
         */}
        {obscured ? (
          <div className="preview__paused" role="status">
            <Icon name="visibility_off" size={22} />
            <p>Podgląd wstrzymany, dopóki nad nim otwarte jest okno lub menu.</p>
            <p className="preview__paused-hint">Zamknij je, aby wrócić do strony.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
