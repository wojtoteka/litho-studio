import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, isAudioAsset, isImageAsset, type CanvasPatchOp } from '@/state/editorStore.js';
import { useUiStore } from '@/state/uiStore.js';
import {
  buildCanvasDocument,
  buildStatePreviewCss,
  CANVAS_CSS_ELEMENT_ID,
  CANVAS_ID_ATTRIBUTE,
  CANVAS_STATE_PREVIEW_ELEMENT_ID,
  collectEnclosedIds,
  isSelectableTag,
  syncEmptyMarker,
} from '@/lib/canvasDocument.js';
import { canvasCss } from '@/engine/canvasCss.js';
import { classifyElement, ELEMENT_KIND_LABELS, findElement } from '@shared/document.js';
import {
  getComponentTemplate,
  getElementTemplate,
  buildImageForAsset,
  buildAudioForAsset,
  buildMaterialSymbolIcon,
  MATERIAL_SYMBOLS_CSS,
  element as buildElement,
  text as buildText,
  AUDIO_CSS,
} from '@/lib/elementFactory.js';
import { relativeHref } from '@shared/paths.js';
import { clearDragPayload, currentDragPayload, DRAG_MIME, type DragPayload } from '@/lib/dragPayload.js';
import { ensureMaterialSymbolsHeadLinks } from '@/lib/googleFonts.js';
import { resolveFreeDropPosition, resolveImageDropTarget, type SnapGuide } from '@/lib/canvasDrop.js';
import { handleEditorKeydown } from '@/lib/useCommands.js';
import { TextActionMenu } from './TextActionMenu.js';
import { TransformControls } from './TransformControls.js';
import { Icon } from '../Icon.js';
import { ElementContextMenu } from './ElementContextMenu.js';
import { logger } from '@/lib/logger.js';

/** Matches the `--canvas-padding` token in app.css (`.canvas__viewport`). */
const CANVAS_PADDING = 24;

/** Height of `.canvas__label`, used to decide whether it still fits above its element. */
const LABEL_HEIGHT = 16;

/**
 * How far one wheel notch moves the zoom.
 *
 * Exponential in the delta rather than a fixed step per event, for two reasons.
 * A mouse wheel reports one coarse notch (±100 px in `deltaMode: 0`) while a
 * touchpad reports a stream of small ones, and only a continuous function
 * treats both as the same gesture instead of making the touchpad fly off the
 * scale. And zoom is multiplicative: 50 %→100 % has to feel like the same
 * distance as 100 %→200 %, which a linear step cannot give.
 *
 * 450 is picked so a standard notch lands on ×1.25 — the same step the
 * toolbar's +/− buttons take, so the two ways of zooming agree.
 */
const WHEEL_ZOOM_DIVISOR = 450;

/**
 * The state-preview stylesheet for whatever is selected right now, or `''` when
 * nothing should be previewed — see `buildStatePreviewCss`.
 *
 * Reads the store directly instead of taking arguments: both callers (the
 * `srcDoc` memo and the patch effect below) want the value at the moment they
 * run, and `declarationsFor` returns a freshly built object every time, which
 * makes it unusable as a subscribed selector.
 *
 * Restricted to a single selection on purpose. "Which element's hover state am
 * I editing" has no answer when three are selected, and the properties panel
 * edits one element at a time anyway.
 */
function currentStatePreviewCss(): string {
  const state = useEditorStore.getState();
  const id = state.selection.length === 1 ? state.selection[0] : null;
  if (!id || state.styleState === 'normal') return '';
  return buildStatePreviewCss(id, state.declarationsFor(id));
}

function wheelZoomFactor(event: WheelEvent): number {
  // `deltaMode` 1 counts lines and 2 counts pages; normalising them to pixels
  // is what keeps the gesture the same speed on the desktops (and remote
  // sessions) whose input stack reports one of those instead.
  const pixelsPerUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  return Math.exp((-event.deltaY * pixelsPerUnit) / WHEEL_ZOOM_DIVISOR);
}

/**
 * The editing surface.
 *
 * The page renders in a same-origin `srcdoc` iframe, so layout is computed by
 * the real engine with the real stylesheet — no approximation of the box model,
 * no divergence between what the canvas shows and what the browser will. The
 * editor reads `contentDocument` directly for hit-testing and geometry, and
 * draws selection UI in an overlay *outside* the iframe so it can never end up
 * in the user's file.
 */
export function Canvas(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const styleModels = useEditorStore((state) => state.styleModels);
  const project = useEditorStore((state) => state.project);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);
  const error = useEditorStore((state) => state.error);
  const selection = useEditorStore((state) => state.selection);
  const hovered = useEditorStore((state) => state.hovered);
  const select = useEditorStore((state) => state.select);
  const toggleSelection = useEditorStore((state) => state.toggleSelection);
  const setHovered = useEditorStore((state) => state.setHovered);
  const placeFreeElement = useEditorStore((state) => state.placeFreeElement);
  const ensureHeadLink = useEditorStore((state) => state.ensureHeadLink);
  const setImageSource = useEditorStore((state) => state.setImageSource);
  const syncFreeLayoutHeight = useEditorStore((state) => state.syncFreeLayoutHeight);
  const breakpoint = useEditorStore((state) => state.currentBreakpoint());
  // The tree mutates in place, so this counter — not the `document` reference —
  // is what tells the canvas to rebuild the iframe after a structural edit
  // (inserts, removals, attribute/text changes). Pure style edits bump
  // `revision` but not this, and are patched into the live iframe instead —
  // see the effect below — so typing in the properties panel never reloads
  // the page and flashes the selection outline away.
  const structureRevision = useEditorStore((state) => state.structureRevision);
  // Stylesheet models mutate their rules in place too (same reasoning as
  // `document` above), so the `styleModels` array reference is frequently
  // unchanged after a style edit. `revision` — bumped on every commit,
  // style or structural — is the reliable signal for the CSS-patch effect.
  const revision = useEditorStore((state) => state.revision);
  // Markup edits small enough to apply to the loaded document instead of
  // reloading it — see the `canvasPatch` doc comment in editorStore.
  const canvasPatch = useEditorStore((state) => state.canvasPatch);
  // Which pseudo-state the properties panel is editing. Only the id is read
  // here; the declarations themselves are pulled from the store inside the
  // effect, because `declarationsFor` builds a fresh object on every call and a
  // selector returning one would re-render this component without end.
  const styleState = useEditorStore((state) => state.styleState);

  const manualZoom = useUiStore((state) => state.zoom);
  const zoomMode = useUiStore((state) => state.zoomMode);
  const showGrid = useUiStore((state) => state.showGrid);
  const canvasMode = useUiStore((state) => state.canvasMode);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  /**
   * Where the user had scrolled to inside the page.
   *
   * A structural edit rebuilds `srcDoc`, and a reloaded document always starts
   * at the top — so without this, editing anything below the fold would throw
   * the user back to the header on every keystroke. Kept in a ref, not state,
   * because it changes on every scroll frame and must never trigger a render.
   */
  const scrollPositionRef = useRef({ top: 0, left: 0 });

  /**
   * The canvas iframe is a *window*, exactly like the browser window the live
   * preview runs in — the page scrolls inside it. Its size comes from the work
   * area, never from the content it renders: pages routinely size themselves
   * against the viewport (`100vh` sections, `height: 100%`, `position: fixed`
   * decoration), so deriving the frame from the content it lays out is
   * circular — taller frame → taller `vh` → taller content → taller frame. One
   * real page ran away to 427 000 px that way.
   *
   * The size of the work area, measured — never inferred from the page.
   *
   * This is the one external input the layout below is derived from. Keeping it
   * a pure measurement is what makes the whole arrangement loop-free: the page
   * cannot influence the pane, so nothing the page renders can feed back into
   * the frame's size.
   */
  const [paneSize, setPaneSize] = useState({ width: 1200, height: 900 });

  /**
   * Width the page is laid out at.
   *
   * The base breakpoint emits no media query, so it has no width of its own to
   * respect: it *is* whatever the browser window happens to be. Pinning it to a
   * stored number (1440 by default) meant the desktop canvas was a narrow strip
   * scaled down inside a much wider work area — smaller and less faithful than
   * the live preview of the same page. It now takes the whole work area at 1:1,
   * which is both the largest and the most honest thing to show.
   *
   * The device breakpoints keep their fixed widths, because that width is the
   * entire point of them: a phone canvas has to be 390 px wide for the page's
   * own `@media (max-width: 640px)` rules to apply.
   *
   * Reads the explicit `fluid` flag rather than inferring it from `maxWidth`,
   * so the desktop breakpoint can also be pinned to a width the user typed in
   * (see the breakpoint bar's size editor) without gaining a media query.
   */
  const isFluidBreakpoint = breakpoint.fluid;
  const canvasWidth = isFluidBreakpoint ? Math.max(320, paneSize.width) : breakpoint.canvasWidth;

  const [frameReady, setFrameReady] = useState(false);
  // Bumped every time the iframe finishes loading a new document, so overlays
  // that hold listeners on `contentDocument` know to re-attach them.
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [rects, setRects] = useState<Map<string, DOMRect>>(new Map());
  // Where a panel drop would land: a single pixel under the cursor, since a
  // drop places freely (`position: absolute`) rather than into a sibling slot.
  // (There is no sibling-slot drop indicator any more: both panel drops and
  // dragging an existing element place freely at a pixel — see `freePoint`.)
  const [freePoint, setFreePoint] = useState<{ x: number; y: number } | null>(null);
  // Alignment guide lines to draw while placing/moving — shared by panel drops
  // and by dragging a positioned element (TransformControls). Empty most of the
  // time; a line only appears when an edge actually lines up with another.
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  // Ctrl-drag marquee (rubber-band) select, in the iframe's own coordinate
  // space like the other overlays — see the pointerdown/move/up trio below.
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );

  const setCanvasPaneWidth = useUiStore((state) => state.setCanvasPaneWidth);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return undefined;

    const measurePane = (): void => {
      const width = Math.max(120, container.clientWidth - CANVAS_PADDING * 2);
      const height = Math.max(200, container.clientHeight - CANVAS_PADDING * 2);
      setPaneSize((current) =>
        Math.abs(current.width - width) > 1 || Math.abs(current.height - height) > 1
          ? { width, height }
          : current,
      );
      // Display only — the breakpoint bar labels the base breakpoint with it.
      setCanvasPaneWidth(width);
    };

    measurePane();
    const observer = new ResizeObserver(measurePane);
    observer.observe(container);
    return () => observer.disconnect();
    // `document` is a dependency because the canvas renders an empty-state
    // placeholder until a page is open, so the container does not exist on the
    // first render.
  }, [document, setCanvasPaneWidth]);

  /**
   * Scale that keeps the *whole* breakpoint width visible. Never scales up: a
   * 390 px phone canvas blown up to fill a wide monitor would misrepresent the
   * design at that size.
   */
  const fitScale = Math.min(1, paneSize.width / canvasWidth);
  const zoom = zoomMode === 'fit' ? fitScale : manualZoom;

  /**
   * The frame is a window onto the page, living inside a `scale(zoom)` stage.
   * To cover the pane *after* that transform its own untransformed height must
   * be the pane height divided by the zoom — otherwise a scaled-down canvas (a
   * 3840 px breakpoint fitted into a 1790 px pane) paints only that fraction of
   * the pane and leaves the rest of the work area empty.
   *
   * Derived during render rather than stored: an effect that both reads and
   * writes the zoom is how this previously became an infinite update loop.
   */
  const viewportHeight = Math.max(400, Math.floor(paneSize.height / zoom));

  // Mirror the applied scale into the store purely so the toolbar can display
  // it. `fitScale` never depends on the stored zoom, so this cannot loop.
  //
  // `zoomMode` is a dependency and has to be: pressing "Dopasuj" switches the
  // mode without moving the pane, so `fitScale` is unchanged and an effect keyed
  // on it alone never re-ran. The canvas scaled to fit (it reads `fitScale`
  // directly) while the toolbar went on displaying whatever the last *manual*
  // zoom had been — the reported "% does not update when the page is fitted to
  // the window". `applyFitZoom` still ignores the call outside `fit` mode, so
  // this cannot clobber a manual zoom.
  const applyFitZoom = useUiStore((state) => state.applyFitZoom);
  useEffect(() => {
    applyFitZoom(fitScale);
  }, [applyFitZoom, fitScale, zoomMode]);

  /* ---------------------------------------------------------------- */
  /* Ctrl + wheel zoom, anchored at the pointer                        */
  /* ---------------------------------------------------------------- */

  /**
   * The zoom the DOM currently reflects.
   *
   * The wheel handlers run outside React's render, on listeners that are
   * deliberately registered once (see below) — they need whatever scale the
   * stage is actually drawn at right now, not the value captured when the
   * listener was created.
   */
  const zoomRef = useRef(zoom);
  useLayoutEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  /**
   * The point the next zoom step has to keep still, captured before that step
   * is applied.
   *
   * `lx` is in the stage's own *unscaled* coordinate space — which is also the
   * canvas iframe's viewport space, since the frame fills the stage 1:1 inside
   * the `scale()`. `pageY` is a position in the edited document, not on screen,
   * because the page scrolls *inside* the frame: the vertical half of "keep
   * this spot under the cursor" is a frame scroll, not a stage offset.
   * `clientX`/`clientY` are the cursor in window coordinates — the target the
   * anchor has to land back on.
   */
  const wheelAnchorRef = useRef<{ lx: number; pageY: number; clientX: number; clientY: number } | null>(null);
  /** Notches accumulated since the last frame, as one multiplicative factor. */
  const wheelFactorRef = useRef(1);
  const wheelFrameRef = useRef<number | null>(null);

  /**
   * Applies one wheel notch.
   *
   * Coalesced to one zoom change per animation frame. A zoom step resizes the
   * canvas iframe (its height is the work area divided by the scale), and a
   * resized frame re-lays-out the whole page inside it — doing that once per
   * wheel event would mean up to a hundred full page reflows a second on a
   * touchpad, on a build that deliberately runs without GPU acceleration.
   * Accumulating the factor loses nothing: zooming is multiplicative, so four
   * notches in a frame and one step of `factor⁴` are the same magnification.
   */
  const zoomAtPoint = useCallback(
    (factor: number, lx: number, ly: number, clientX: number, clientY: number): void => {
      // Only the first event of a batch captures geometry: the later ones in
      // the same frame arrive before the DOM has moved, so re-reading it would
      // just record the same thing — and once a step *has* been applied the
      // reading would belong to the new scale, not to the one being left.
      if (wheelFrameRef.current === null) {
        const scroller = frameRef.current?.contentDocument?.scrollingElement;
        wheelAnchorRef.current = { lx, pageY: (scroller?.scrollTop ?? 0) + ly, clientX, clientY };
      }
      wheelFactorRef.current *= factor;

      if (wheelFrameRef.current !== null) return;
      wheelFrameRef.current = requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const pending = wheelFactorRef.current;
        wheelFactorRef.current = 1;
        if (pending !== 1) useUiStore.getState().zoomBy(pending);
      });
    },
    [],
  );

  useEffect(
    () => () => {
      if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
    },
    [],
  );

  /**
   * Puts the anchored point back under the cursor once the new scale is on
   * screen.
   *
   * Measured rather than predicted. The stage is centred by auto margins when
   * it is narrower than the work area, so its screen position is not a pure
   * function of the scroll offset and the zoom — deriving the correction
   * arithmetically drifted exactly at the zoom levels where the page stops
   * overflowing. Reading where the anchor *actually* landed and moving the
   * difference is correct at every scale, and self-correcting besides: once the
   * point is in place the second pass computes a delta of zero.
   */
  useLayoutEffect(() => {
    const anchor = wheelAnchorRef.current;
    if (!anchor) return undefined;
    wheelAnchorRef.current = null;

    const recentre = (): void => {
      const viewport = viewportRef.current;
      const stage = stageRef.current;
      if (!viewport || !stage) return;
      const box = stage.getBoundingClientRect();
      // Horizontally the page does not move inside the frame — the stage does,
      // within the scrolling work area.
      viewport.scrollLeft += box.left + anchor.lx * zoom - anchor.clientX;
      // Vertically it is the other way round: the stage always covers the work
      // area, and it is the document inside the frame that slides.
      const scroller = frameRef.current?.contentDocument?.scrollingElement;
      if (scroller) scroller.scrollTop = anchor.pageY - (anchor.clientY - box.top) / zoom;
    };

    recentre();
    // The frame's height is derived from the zoom, so the document inside it
    // re-lays-out as a consequence of this very render. Until that settles the
    // page can still be shorter than the scroll position just asked for, and
    // the browser clamps it; one more pass on the next frame lands it.
    const handle = requestAnimationFrame(recentre);
    return () => cancelAnimationFrame(handle);
  }, [zoom]);

  /**
   * Ctrl+wheel over the margin around the page.
   *
   * Registered by hand rather than through React's `onWheel`, because React
   * attaches wheel listeners to the root as passive: `preventDefault` inside a
   * passive listener does nothing, and without it Chromium keeps the scroll (or
   * its own zoom gesture) on top of ours.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const stage = stageRef.current;
      if (!stage) return;
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      const scale = zoomRef.current;
      zoomAtPoint(
        wheelZoomFactor(event),
        (event.clientX - box.left) / scale,
        (event.clientY - box.top) / scale,
        event.clientX,
        event.clientY,
      );
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
    // The viewport element only exists once a page is open.
  }, [document, zoomAtPoint]);

  // Opening a different page starts at its top; only edits to the *same* page
  // restore the remembered position.
  useEffect(() => {
    scrollPositionRef.current = { top: 0, left: 0 };
    // A different page has an unrelated set of node ids — nothing this cache
    // remembers about the previous one is still meaningful.
    appliedFreeHeightsRef.current.clear();
  }, [pageRelPath]);

  const srcDoc = useMemo(() => {
    if (!document || !project) return '';
    try {
      // Read the live stylesheet models rather than subscribing to them: a
      // structural reload always wants *current* CSS, but a style-only edit
      // must not be a dependency here — that path is handled by patching the
      // already-loaded iframe below, without a reload.
      const currentStyleModels = useEditorStore.getState().styleModels;
      return buildCanvasDocument({
        document,
        styleModels: currentStyleModels,
        statePreviewCss: currentStatePreviewCss(),
      });
    } catch (error) {
      logger.error('Nie udało się zbudować podglądu canvas', error);
      return '';
    }
    // `structureRevision` is a dependency on purpose: the model is mutated in
    // place, so without it the memo would keep returning the pre-edit document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, project, structureRevision]);

  /* ---------------------------------------------------------------- */
  /* Geometry                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Remembers the `min-height` this session last wrote onto each free-layout
   * container, keyed by node id — so `syncFreeLayoutHeights` below can tell
   * "still the right height, nothing to write" from "shrank back to 0, the
   * override needs to come off" without re-reading the stylesheet on every
   * pass. Component-local on purpose: it is a cache of what was *sent*, not
   * state the rest of the app needs to know about.
   */
  const appliedFreeHeightsRef = useRef(new Map<string, number>());

  /**
   * Grows (or shrinks) every free-layout container to fit its out-of-flow
   * children.
   *
   * `position: absolute` children — and `position: relative` ones a drag has
   * offset — never contribute to their parent's auto height (that's the whole
   * point of taking a box out of flow), so a free element placed or dragged
   * near the bottom of its container would otherwise hang past the visible
   * page edge with nothing to scroll to it. This walks every element that has
   * at least one such child, takes the lowest bottom edge among them, and
   * syncs it to the store as a `min-height` floor — which shrinks back (or is
   * removed) on its own once no free child needs the room any more, since it
   * is only ever a floor under the container's natural content height, never
   * a fixed height that could clip normal-flow content.
   *
   * Reads live layout only — like `measure`, this cannot feed back into the
   * page's own sizing (`min-height` on a container is not `100vh` on the
   * frame), so calling it from every place `measure` already runs is safe.
   */
  const syncFreeLayoutHeights = useCallback(() => {
    const frameDocument = frameRef.current?.contentDocument;
    const view = frameDocument?.defaultView;
    if (!frameDocument?.body || !view) return;

    const containers = new Set<HTMLElement>([frameDocument.body]);
    for (const element of frameDocument.querySelectorAll<HTMLElement>(`[${CANVAS_ID_ATTRIBUTE}]`)) {
      containers.add(element);
    }

    for (const container of containers) {
      const containerId = container.getAttribute(CANVAS_ID_ATTRIBUTE);
      if (!containerId) continue;

      let freeBottom = 0;
      for (const child of container.children) {
        if (!(child instanceof HTMLElement)) continue;
        const position = view.getComputedStyle(child).position;
        // Only children taken out of normal flow (or offset within it) can
        // extend past what the container would naturally be tall enough for
        // — a `position: static` child already grows the container on its
        // own, the ordinary way.
        if (position !== 'absolute' && position !== 'relative') continue;
        const bottom = child.offsetTop + child.offsetHeight;
        if (bottom > freeBottom) freeBottom = bottom;
      }

      const required = freeBottom > 0 ? Math.ceil(freeBottom) : 0;
      const previous = appliedFreeHeightsRef.current.get(containerId) ?? 0;
      if (Math.abs(required - previous) < 2) continue;

      if (required > 0) appliedFreeHeightsRef.current.set(containerId, required);
      else appliedFreeHeightsRef.current.delete(containerId);
      syncFreeLayoutHeight(containerId, required > 0 ? required : null);
    }
  }, [syncFreeLayoutHeight]);

  /**
   * Recomputes the rect of every element the overlay needs. Called on load, on
   * selection change, and from a ResizeObserver on the iframe body — polling
   * would either lag behind or burn a frame budget for nothing.
   */
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const frameDocument = frame?.contentDocument;
    if (!frameDocument?.body) return;

    const next = new Map<string, DOMRect>();
    const ids = new Set([...selection, ...(hovered ? [hovered] : [])]);
    for (const id of ids) {
      const target = frameDocument.querySelector(`[${CANVAS_ID_ATTRIBUTE}="${CSS.escape(id)}"]`);
      if (target) next.set(id, target.getBoundingClientRect());
    }
    setRects(next);
    // Every place that needs fresh geometry needs an up-to-date free-layout
    // page height too — piggybacking here means a drag commit, a structural
    // reload, and the resize observer below all stay a single call site.
    syncFreeLayoutHeights();
  }, [selection, hovered, syncFreeLayoutHeights]);

  useEffect(() => {
    measure();
    // Imported pages routinely finish laying out *after* the iframe's `load`
    // event — web fonts swap in without blocking it (FOUT/FOIT reflow) and
    // remote CDN stylesheets settle a beat later — which moves every element
    // the overlay has already measured. Re-reading a few times keeps the
    // selection outline on its element instead of stranding it where the
    // element used to be. This only ever updates overlay geometry; it can no
    // longer affect layout, so it cannot feed back into the page.
    const timers = [100, 400, 1000, 2000].map((delay) => window.setTimeout(measure, delay));
    const frameDocument = frameRef.current?.contentDocument;
    frameDocument?.fonts?.ready?.then(measure).catch(() => {});
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [measure, srcDoc]);

  /**
   * Pure CSS edits (the common case while someone is dragging a slider or
   * typing in the properties panel) patch the already-loaded iframe's
   * stylesheet in place instead of going through `srcDoc` above, which would
   * force a full reload — flashing the page blank and dropping the selection
   * outline on every keystroke.
   */
  useEffect(() => {
    const frameDocument = frameRef.current?.contentDocument;
    const styleElement = frameDocument?.getElementById(CANVAS_CSS_ELEMENT_ID);
    if (!styleElement) return;
    try {
      styleElement.textContent = canvasCss(styleModels);
    } catch (error) {
      logger.error('Nie udało się odświeżyć stylów w podglądzie canvas', error);
    }
    // A layout-affecting property (width, padding, font-size…) resizes the
    // iframe body, which the ResizeObserver above already reacts to — this
    // call just avoids waiting a frame for the common case.
    requestAnimationFrame(measure);
    // `revision`, not `styleModels`, is the real trigger here — see the note
    // where `revision` is read above. `styleModels` stays in the array so the
    // effect also re-reads it on the (rarer) case where its reference *does*
    // change, e.g. a brand-new stylesheet file being created.
  }, [revision, styleModels, measure]);

  /**
   * Keeps the state preview in step with the panel — see `buildStatePreviewCss`
   * for why it exists at all.
   *
   * Patched into the loaded document like the stylesheet above, so switching
   * between Normalny/Najechanie and typing a colour into the state both take
   * effect immediately without a reload. `srcDoc` is a dependency so the
   * preview is re-applied to the *new* document after a structural reload —
   * the freshly built one already carries the same CSS, so this is a no-op
   * whenever the two agree.
   */
  useEffect(() => {
    const frameDocument = frameRef.current?.contentDocument;
    const styleElement = frameDocument?.getElementById(CANVAS_STATE_PREVIEW_ELEMENT_ID);
    if (!styleElement) return;
    try {
      styleElement.textContent = currentStatePreviewCss();
    } catch (error) {
      logger.error('Nie udało się pokazać podglądu stanu elementu', error);
    }
    requestAnimationFrame(measure);
  }, [styleState, selection, revision, breakpoint, srcDoc, measure]);

  /**
   * Markup edits applied to the loaded document, the same way style edits are
   * applied to the loaded stylesheet above — and for the same reason. Typing a
   * heading in the properties panel used to rebuild `srcDoc` on every
   * keystroke, and a reload is a blank page, a re-fetch of every web font and
   * image, and a fresh layout: the editor went white and stopped responding
   * for as long as that took, over and over, while the user was still typing.
   *
   * Ops emitted *after* the last `srcDoc` rebuild but *before* the resulting
   * document finished loading would land on the document being replaced, so
   * they are kept here and replayed once the new one is in. They are plain
   * assignments — set this text, set this attribute — so replaying one that
   * did land changes nothing.
   */
  const pendingOpsRef = useRef<CanvasPatchOp[]>([]);
  const appliedPatchSeqRef = useRef(0);
  /** True between a `srcDoc` rebuild and the resulting document's `load`. */
  const frameLoadingRef = useRef(true);

  const applyCanvasOps = useCallback(
    (ops: CanvasPatchOp[]): void => {
      const frameDocument = frameRef.current?.contentDocument;
      if (!frameDocument?.body || ops.length === 0) return;

      for (const op of ops) {
        const target = frameDocument.querySelector(`[${CANVAS_ID_ATTRIBUTE}="${CSS.escape(op.id)}"]`);
        // A node the canvas does not carry is not an error: `annotateTree`
        // drops scripts and inlined stylesheets from its copy on purpose.
        if (!target) continue;
        if (op.kind === 'text') {
          target.textContent = op.value;
          syncEmptyMarker(target);
        } else if (op.value === null) {
          target.removeAttribute(op.name);
        } else {
          target.setAttribute(op.name, op.value);
        }
      }
      // New text reflows the page, so every rect the overlay holds is stale.
      requestAnimationFrame(measure);
    },
    [measure],
  );

  // A new document is on its way. It already contains every op committed
  // before it was built, so the queue starts empty — and anything arriving
  // from here until it lands belongs to it, not to the document it replaces.
  useEffect(() => {
    frameLoadingRef.current = true;
    pendingOpsRef.current = [];
  }, [srcDoc]);

  useEffect(() => {
    if (!canvasPatch || canvasPatch.seq <= appliedPatchSeqRef.current) return;
    appliedPatchSeqRef.current = canvasPatch.seq;
    if (frameLoadingRef.current) pendingOpsRef.current.push(...canvasPatch.ops);
    else applyCanvasOps(canvasPatch.ops);
  }, [canvasPatch, applyCanvasOps]);

  // `frameEpoch` changes once per completed load: the new document is in, so
  // whatever was queued while it loaded is applied to it and the queue is done.
  useEffect(() => {
    frameLoadingRef.current = false;
    const pending = pendingOpsRef.current;
    pendingOpsRef.current = [];
    applyCanvasOps(pending);
  }, [frameEpoch, applyCanvasOps]);

  /**
   * Brings a newly selected element into view when it is off screen.
   *
   * Selecting is how every list in the app — the layer tree, the out-of-layout
   * warning, the audit results — says "this one": without this, picking an item
   * three screens down highlighted something the user could not see, and the
   * feature read as broken. Only elements that are genuinely outside the frame
   * are scrolled to, so clicking an element on the canvas never yanks the page
   * out from under the click, and `instant` keeps the page's own
   * `scroll-behavior: smooth` from animating (the same trap the scroll restore
   * in `handleFrameLoad` documents).
   */
  useEffect(() => {
    if (selection.length !== 1) return;
    const frameDocument = frameRef.current?.contentDocument;
    const target = frameDocument?.querySelector(`[${CANVAS_ID_ATTRIBUTE}="${CSS.escape(selection[0]!)}"]`);
    if (!target || !frameDocument?.documentElement) return;
    const rect = target.getBoundingClientRect();
    const viewHeight = frameDocument.documentElement.clientHeight;
    if (rect.bottom > 0 && rect.top < viewHeight) return;
    target.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    requestAnimationFrame(measure);
  }, [selection, measure]);

  /* ---------------------------------------------------------------- */
  /* Wiring the iframe                                                 */
  /* ---------------------------------------------------------------- */

  const nodeIdFromEvent = useCallback((event: Event): string | null => {
    // `event.target` belongs to the iframe's own JS realm (every <iframe> gets
    // its own global object, `allow-same-origin` or not), so `instanceof
    // Element` against *this* window's `Element` constructor is always false
    // for it — a cross-realm check that silently no-ops every click. Duck-type
    // instead of checking the constructor identity.
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return null;
    const host = target.closest(`[${CANVAS_ID_ATTRIBUTE}]`);
    if (!host) return null;
    const tag = host.tagName.toLowerCase();
    if (!isSelectableTag(tag)) return null;
    return host.getAttribute(CANVAS_ID_ATTRIBUTE);
  }, []);

  const handleFrameLoad = useCallback(() => {
    const frame = frameRef.current;
    const frameDocument = frame?.contentDocument;
    if (!frameDocument) return;

    const onClick = (event: MouseEvent) => {
      // The canvas is an editing surface: links must not navigate and forms
      // must not submit while the user is arranging the page.
      event.preventDefault();
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      const id = nodeIdFromEvent(event);
      if (!id) {
        select([]);
        return;
      }
      if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelection(id);
      else select([id]);
    };

    const onPointerMove = (event: PointerEvent) => {
      setHovered(nodeIdFromEvent(event));
    };

    const onPointerLeave = () => setHovered(null);
    const onSubmit = (event: Event) => event.preventDefault();

    /*
     * Ctrl+wheel over the page itself.
     *
     * A native `<iframe>` owns the wheel events for the area it covers, so the
     * listener on `.canvas__viewport` never sees these — the same reason the
     * click and drag handling lives in here. The coordinates arrive in the
     * frame's own space, which *is* the stage's unscaled space, so they need
     * multiplying by the zoom (not dividing) to say where the cursor is on
     * screen.
     */
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const stage = stageRef.current;
      if (!stage) return;
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      const scale = zoomRef.current;
      zoomAtPoint(
        wheelZoomFactor(event),
        event.clientX,
        event.clientY,
        box.left + event.clientX * scale,
        box.top + event.clientY * scale,
      );
    };

    // Ctrl+drag marquee (rubber-band) multi-select, à la a desktop file
    // manager. A bare Ctrl+click still means what it already did — toggle
    // that one element in/out of the selection — so this only becomes a
    // marquee once the pointer actually moves past a small threshold, and
    // `suppressNextClick` stops the click that follows the eventual pointerup
    // from re-running the plain click-to-select logic on top of it.
    let pendingMarquee: { x: number; y: number; active: boolean } | null = null;
    let suppressNextClick = false;
    // The pointer's last known position in the iframe's own coordinate space,
    // kept up to date both by real `pointermove` events and — while
    // autoscrolling — by compensating for the scroll delta, since scrolling
    // moves the page under a cursor that never itself sent a new event.
    let currentPoint: { x: number; y: number } | null = null;
    let autoScrollHandle: number | null = null;

    const AUTOSCROLL_EDGE = 36;
    const AUTOSCROLL_SPEED = 16;

    const updateMarqueeRect = () => {
      if (!pendingMarquee || !currentPoint) return;
      setMarquee({
        left: Math.min(pendingMarquee.x, currentPoint.x),
        top: Math.min(pendingMarquee.y, currentPoint.y),
        width: Math.abs(currentPoint.x - pendingMarquee.x),
        height: Math.abs(currentPoint.y - pendingMarquee.y),
      });
    };

    // Runs continuously (via rAF) while a marquee drag is active, independent
    // of `pointermove` — so the selection box keeps growing even when the
    // pointer is held still against the edge of the viewport, the same way
    // a Windows Explorer rubber-band select auto-scrolls the list.
    const tickAutoScroll = () => {
      autoScrollHandle = null;
      const scroller = frameDocument.scrollingElement ?? frameDocument.documentElement;
      if (!pendingMarquee?.active || !currentPoint || !scroller) return;

      // Everything here is already in the frame's own viewport coordinates,
      // which is exactly the space the marquee is drawn in — no conversion
      // through the outer container or the zoom transform is needed.
      const viewHeight = frameDocument.documentElement.clientHeight;
      const viewWidth = frameDocument.documentElement.clientWidth;

      const edgeFactor = (distanceInsideEdge: number) =>
        AUTOSCROLL_SPEED * (1 - Math.max(0, distanceInsideEdge) / AUTOSCROLL_EDGE);

      let dy = 0;
      if (currentPoint.y < AUTOSCROLL_EDGE) dy = -edgeFactor(currentPoint.y);
      else if (currentPoint.y > viewHeight - AUTOSCROLL_EDGE) dy = edgeFactor(viewHeight - currentPoint.y);

      let dx = 0;
      if (currentPoint.x < AUTOSCROLL_EDGE) dx = -edgeFactor(currentPoint.x);
      else if (currentPoint.x > viewWidth - AUTOSCROLL_EDGE) dx = edgeFactor(viewWidth - currentPoint.x);

      if (dx !== 0 || dy !== 0) {
        const beforeTop = scroller.scrollTop;
        const beforeLeft = scroller.scrollLeft;
        scroller.scrollTop += dy;
        scroller.scrollLeft += dx;
        // The cursor has not moved, but the content slid under it. The anchor
        // was dropped on a *point in the page*, so it has to slide with the
        // content to stay on it; the cursor's own viewport position does not.
        pendingMarquee.x -= scroller.scrollLeft - beforeLeft;
        pendingMarquee.y -= scroller.scrollTop - beforeTop;
        updateMarqueeRect();
      }

      autoScrollHandle = requestAnimationFrame(tickAutoScroll);
    };

    const onMarqueeDown = (event: PointerEvent) => {
      if (canvasMode !== 'edit' || !event.ctrlKey || event.button !== 0) return;
      event.preventDefault();
      pendingMarquee = { x: event.clientX, y: event.clientY, active: false };
      currentPoint = { x: event.clientX, y: event.clientY };
    };

    const onMarqueeMove = (event: PointerEvent) => {
      const pending = pendingMarquee;
      if (!pending) return;
      currentPoint = { x: event.clientX, y: event.clientY };
      if (
        !pending.active &&
        (Math.abs(event.clientX - pending.x) > 4 || Math.abs(event.clientY - pending.y) > 4)
      ) {
        pending.active = true;
        if (autoScrollHandle === null) autoScrollHandle = requestAnimationFrame(tickAutoScroll);
      }
      if (!pending.active) return;
      updateMarqueeRect();
    };

    const onMarqueeUp = () => {
      const pending = pendingMarquee;
      pendingMarquee = null;
      if (autoScrollHandle !== null) {
        cancelAnimationFrame(autoScrollHandle);
        autoScrollHandle = null;
      }
      if (!pending?.active || !currentPoint) {
        setMarquee(null);
        return;
      }
      suppressNextClick = true;
      const rect = {
        left: Math.min(pending.x, currentPoint.x),
        top: Math.min(pending.y, currentPoint.y),
        right: Math.max(pending.x, currentPoint.x),
        bottom: Math.max(pending.y, currentPoint.y),
      };
      select(collectEnclosedIds(frameDocument, rect));
      setMarquee(null);
    };

    // A generic "act on this element" menu — delete/duplicate/copy/paste/group
    // — for right-clicking an element itself. `TextActionMenu` owns the case
    // where the user has a partial *text* selection instead; the two never
    // fight over the same click because each backs off when the other's
    // condition holds, regardless of listener registration order.
    const onContextMenu = (event: MouseEvent) => {
      if (canvasMode !== 'edit') return;
      const textSelection = frameDocument.getSelection();
      if (textSelection && !textSelection.isCollapsed && textSelection.rangeCount > 0) return;
      const id = nodeIdFromEvent(event);
      if (!id) return;
      event.preventDefault();
      select([id]);
      const frameRect = frame.getBoundingClientRect();
      setContextMenu({
        x: frameRect.left + event.clientX * zoom,
        y: frameRect.top + event.clientY * zoom,
        nodeId: id,
      });
    };

    // Drag-and-drop from the element/component/assets panels has to be wired
    // up *inside* the iframe's own document, not on an outer wrapper div: a
    // native `<iframe>` owns drag events for the screen area it covers, so a
    // handler on an ancestor in the parent document never sees them — the
    // same reason click/pointer listeners live here instead of on
    // `.canvas__viewport`.
    const onDragEnter = (event: DragEvent) => {
      if (canvasMode !== 'edit' || !event.dataTransfer?.types.includes(DRAG_MIME)) return;
      event.preventDefault();
    };

    /** The image a photo released here would replace, if any. */
    const replaceTargetAt = (x: number, y: number): string | null => {
      const payload = currentDragPayload();
      if (payload?.kind !== 'asset' || !isImageAsset(payload.relPath)) return null;
      return resolveImageDropTarget(frameDocument, x, y);
    };

    const onDragOver = (event: DragEvent) => {
      if (canvasMode !== 'edit' || !event.dataTransfer?.types.includes(DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';

      // Over an image, the drop swaps that image's source. Outlining the tile
      // (and dropping the placement marker) is what tells the user that before
      // they let go — otherwise "replace" and "add on top" look identical.
      const replaceId = replaceTargetAt(event.clientX, event.clientY);
      if (replaceId) {
        setFreePoint(null);
        setSnapGuides([]);
        setHovered(replaceId);
        return;
      }
      setHovered(null);

      // A drop always places freely at the exact pixel released over — the
      // pointer marker shows where, the guides suggest what it would line up
      // with. No sibling-slot line: that gesture belongs to reordering an
      // existing flow element, not to adding a new one.
      const free = resolveFreeDropPosition(frameDocument, event.clientX, event.clientY);
      setFreePoint(free ? { x: free.pointerX, y: free.pointerY } : null);
      setSnapGuides(free?.guides ?? []);
    };

    const onDrop = (event: DragEvent) => {
      setFreePoint(null);
      setSnapGuides([]);
      setHovered(null);
      if (canvasMode !== 'edit' || !document) return;
      const raw = event.dataTransfer?.getData(DRAG_MIME);
      if (!raw) return;
      event.preventDefault();
      // The affordance shown during `dragover` had to guess from module state,
      // but the drop itself carries the real payload — decide from that, so a
      // drag the app did not start still lands correctly.
      clearDragPayload();

      const free = resolveFreeDropPosition(frameDocument, event.clientX, event.clientY);
      if (!free) return;

      const target = {
        parentId: free.parentId,
        left: free.left,
        top: free.top,
        parentPositioned: free.parentPositioned,
      };

      try {
        const payload = JSON.parse(raw) as DragPayload;

        if (payload.kind === 'icon') {
          ensureMaterialSymbolsHeadLinks(ensureHeadLink, payload.style);
          placeFreeElement(
            { node: buildMaterialSymbolIcon(payload.iconName, payload.style), css: MATERIAL_SYMBOLS_CSS },
            target,
            `Dodanie ikony: ${payload.iconName}`,
          );
          return;
        }
        if (payload.kind === 'customIcon') {
          const node = buildElement('span', { class: payload.className, 'aria-hidden': 'true' }, [
            buildText(payload.glyph),
          ]);
          placeFreeElement({ node, css: payload.css }, target, 'Dodanie własnej ikony');
          return;
        }
        if (payload.kind === 'element') {
          const template = getElementTemplate(payload.templateId);
          if (!template) return;
          placeFreeElement(
            { node: template.build(), css: template.css, scripts: template.scripts },
            target,
            `Dodanie: ${template.label}`,
          );
          return;
        }
        if (payload.kind === 'component') {
          const template = getComponentTemplate(payload.templateId);
          if (!template) return;
          placeFreeElement(
            { node: template.build(), css: template.css, scripts: template.scripts },
            target,
            `Dodanie: ${template.name}`,
          );
          return;
        }
        const relHref = relativeHref(document.relPath, payload.relPath);
        if (isAudioAsset(payload.relPath)) {
          placeFreeElement({ node: buildAudioForAsset(relHref), css: AUDIO_CSS }, target, 'Dodanie audio');
          return;
        }
        // Released over an existing image: swap its source in place, keeping
        // whatever layout the surrounding block already gives it.
        const replaceId = isImageAsset(payload.relPath)
          ? resolveImageDropTarget(frameDocument, event.clientX, event.clientY)
          : null;
        if (replaceId) {
          setImageSource(replaceId, relHref, payload.width, payload.height);
          select([replaceId]);
          return;
        }
        placeFreeElement(
          { node: buildImageForAsset(relHref, payload.width, payload.height) },
          target,
          'Dodanie obrazu',
        );
      } catch (dropError) {
        logger.error('Nieprawidłowe dane przeciągania', dropError);
      }
    };

    frameDocument.addEventListener('click', onClick, true);
    frameDocument.addEventListener('pointermove', onPointerMove, true);
    frameDocument.addEventListener('pointerleave', onPointerLeave, true);
    frameDocument.addEventListener('submit', onSubmit, true);
    frameDocument.addEventListener('contextmenu', onContextMenu, true);
    frameDocument.addEventListener('pointerdown', onMarqueeDown, true);
    frameDocument.addEventListener('pointermove', onMarqueeMove, true);
    frameDocument.addEventListener('pointerup', onMarqueeUp, true);
    frameDocument.addEventListener('wheel', onWheel, { passive: false, capture: true });
    frameDocument.addEventListener('dragenter', onDragEnter);
    frameDocument.addEventListener('dragover', onDragOver);
    frameDocument.addEventListener('drop', onDrop);
    // Clicking into the iframe moves keyboard focus into its document; without
    // this, Delete/Ctrl+Z/copy-paste would go dead the moment the user clicks
    // the page they are editing.
    frameDocument.addEventListener('keydown', handleEditorKeydown);
    // The page scrolls inside the frame now, so every overlay rect the editor
    // holds goes stale the moment it does — and the position has to be
    // remembered, because the next structural edit reloads this document.
    // True while the code below is restoring the position, so the `scroll`
    // events that restoring itself fires are not mistaken for the user
    // scrolling. Without this the restore destroys its own target: right after
    // a reload the page is still short (images and fonts have not landed), the
    // browser clamps `scrollTop` to that smaller height, and the resulting
    // `scroll` event writes the clamped value back over the remembered one —
    // so every later attempt restores a position closer and closer to the top,
    // usually 0. That is the "first save jumps me back to the top" bug.
    let restoring = false;

    const onScroll = () => {
      const scroller = frameDocument.scrollingElement ?? frameDocument.documentElement;
      if (scroller && !restoring) {
        scrollPositionRef.current = { top: scroller.scrollTop, left: scroller.scrollLeft };
      }
      requestAnimationFrame(measure);
    };
    frameDocument.addEventListener('scroll', onScroll, { passive: true, capture: true });

    // Put the user back where they were before this reload. Images and web
    // fonts land after `load` and change the page's height, so a single
    // restore can be clamped short — repeating it as the layout settles is
    // what actually holds the position.
    const restoreScroll = (): void => {
      const scroller = frameDocument.scrollingElement ?? frameDocument.documentElement;
      if (!scroller) return;
      const { top, left } = scrollPositionRef.current;
      if (top === 0 && left === 0) return;
      restoring = true;
      // `behavior: 'instant'` overrides the page's own `scroll-behavior: smooth`,
      // which is otherwise fatal here: a smooth restore *animates*, and every
      // intermediate position it passes through fires a scroll event of its
      // own. Those land after the one-frame guard below has been released and
      // overwrite the remembered position with a partial one, so each restore
      // aims lower than the last and the page creeps back to the top.
      scroller.scrollTo({ top, left, behavior: 'instant' as ScrollBehavior });
      // Released after the scroll event this just queued has been delivered.
      requestAnimationFrame(() => {
        restoring = false;
      });
    };
    restoreScroll();
    const restoreTimers = [0, 60, 200, 500, 900].map((delay) => window.setTimeout(restoreScroll, delay));

    // Measuring synchronously inside the observer callback re-triggers layout
    // and trips "ResizeObserver loop completed with undelivered notifications";
    // deferring one frame breaks the cycle.
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    if (frameDocument.body) observer.observe(frameDocument.body);
    // `body` alone misses growth that only shows up on `<html>` — e.g. a page
    // whose real content lives in `position: absolute`/`fixed` descendants
    // that never affect `body`'s own box.
    observer.observe(frameDocument.documentElement);

    setFrameReady(true);
    setFrameEpoch((epoch) => epoch + 1);
    measure();

    return () => {
      observer.disconnect();
      if (autoScrollHandle !== null) cancelAnimationFrame(autoScrollHandle);
      frameDocument.removeEventListener('click', onClick, true);
      frameDocument.removeEventListener('pointermove', onPointerMove, true);
      frameDocument.removeEventListener('pointerleave', onPointerLeave, true);
      frameDocument.removeEventListener('submit', onSubmit, true);
      frameDocument.removeEventListener('contextmenu', onContextMenu, true);
      frameDocument.removeEventListener('pointerdown', onMarqueeDown, true);
      frameDocument.removeEventListener('pointermove', onMarqueeMove, true);
      frameDocument.removeEventListener('pointerup', onMarqueeUp, true);
      frameDocument.removeEventListener('wheel', onWheel, true);
      frameDocument.removeEventListener('dragenter', onDragEnter);
      frameDocument.removeEventListener('dragover', onDragOver);
      frameDocument.removeEventListener('drop', onDrop);
      frameDocument.removeEventListener('keydown', handleEditorKeydown);
      frameDocument.removeEventListener('scroll', onScroll, true);
      restoreTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    canvasMode,
    // Read by `onDrop`, which resolves the drop against the live tree — listing
    // it stops a future edit from silently capturing a stale document.
    document,
    measure,
    nodeIdFromEvent,
    select,
    setHovered,
    toggleSelection,
    placeFreeElement,
    ensureHeadLink,
    setImageSource,
    zoomAtPoint,
    zoom,
  ]);

  // React cannot return a cleanup from an event handler, so the listeners set
  // up on load are torn down when the document is replaced.
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const onLoad = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = handleFrameLoad();
  }, [handleFrameLoad]);

  useEffect(() => () => cleanupRef.current?.(), []);

  // A structural reload replaces the iframe's document — any open context
  // menu was positioned against the old one and its target may no longer
  // exist in the same place.
  useEffect(() => {
    setContextMenu(null);
  }, [frameEpoch]);

  /* ---------------------------------------------------------------- */

  const width = canvasWidth;
  /*
   * Floored, not raw: `width * zoom` is a float (1440 × (1183/1440) lands on
   * 1183.0000000000002), and half a device pixel of overflow is enough for the
   * work area to grow a scrollbar. That scrollbar then eats ~15 px of
   * `clientWidth`, which re-measures the pane, which re-derives the fit zoom —
   * the page visibly twitching between two layouts for as long as the window
   * sits at that width.
   */
  const scaledWidth = Math.floor(width * zoom);
  const scaledHeight = Math.floor(viewportHeight * zoom);
  const soleSelectionRect = selection.length === 1 ? (rects.get(selection[0]!) ?? null) : null;

  if (!document) {
    return (
      <div className="canvas">
        <div className="canvas__empty">
          <Icon name={error ? 'error' : 'web'} size={34} />
          {error ? <p role="alert">{error}</p> : <p>Wybierz stronę z listy, aby zacząć edycję.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="canvas">
      <div
        ref={viewportRef}
        className="canvas__viewport"
        // The real drag/drop handling lives inside the iframe's own document
        // (see `handleFrameLoad`) — this is just a safety net for clearing
        // the drop indicator if the cursor leaves the canvas area entirely
        // without dropping.
        onDragLeave={() => {
          setFreePoint(null);
          setSnapGuides([]);
        }}
      >
        {/* Sized to the scaled stage so scrollbars cover the whole page at any zoom. */}
        <div className="canvas__scaler" style={{ width: scaledWidth, height: scaledHeight }}>
          <div
            ref={stageRef}
            className="canvas__stage"
            style={{ width, height: viewportHeight, transform: `scale(${zoom})` }}
          >
            <iframe
              ref={frameRef}
              className="canvas__frame"
              title="Obszar edycji strony"
              srcDoc={srcDoc}
              width={width}
              height={viewportHeight}
              onLoad={onLoad}
              // The canvas runs no page scripts; this is belt-and-braces so a
              // stray inline handler in the markup cannot execute either.
              sandbox="allow-same-origin"
            />

            {showGrid ? <div className="canvas__grid" aria-hidden="true" /> : null}

            <div className="canvas__overlay" aria-hidden="true">
              {hovered && !selection.includes(hovered) ? (
                <Outline rect={rects.get(hovered)} variant="hover" />
              ) : null}

              {selection.map((id) => (
                <Outline key={id} rect={rects.get(id)} variant="selected" label={labelFor(document, id)} />
              ))}

              {snapGuides.map((guide, index) => (
                <div
                  key={index}
                  className={`canvas__guide canvas__guide--${guide.orientation}`}
                  style={
                    guide.orientation === 'vertical'
                      ? { left: guide.pos, top: guide.start, height: guide.end - guide.start }
                      : { top: guide.pos, left: guide.start, width: guide.end - guide.start }
                  }
                />
              ))}

              {freePoint ? (
                <div
                  className="canvas__free-indicator"
                  style={{ left: freePoint.x, top: freePoint.y }}
                  aria-hidden="true"
                />
              ) : null}

              {marquee ? (
                <div
                  className="canvas__marquee"
                  style={{
                    left: marquee.left,
                    top: marquee.top,
                    width: marquee.width,
                    height: marquee.height,
                  }}
                />
              ) : null}
            </div>

            {canvasMode === 'edit' && frameReady && selection.length === 1 && soleSelectionRect ? (
              <TransformControls
                elementId={selection[0]!}
                rect={soleSelectionRect}
                frameRef={frameRef}
                frameEpoch={frameEpoch}
                zoom={zoom}
                onCommit={measure}
                onSnapGuidesChange={setSnapGuides}
              />
            ) : null}
          </div>
        </div>
      </div>

      {canvasMode === 'edit' && frameReady ? (
        <TextActionMenu frameRef={frameRef} frameEpoch={frameEpoch} />
      ) : null}

      {canvasMode === 'edit' && contextMenu ? (
        <ElementContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

function Outline({
  rect,
  variant,
  label,
}: {
  rect: DOMRect | undefined;
  variant: 'hover' | 'selected';
  label?: string;
}): JSX.Element | null {
  if (!rect) return null;
  // The stage clips its overlay (see `.canvas__stage` in app.css), so a label
  // drawn above an element sitting at the very top of the frame would be cut
  // off. Flip it inside the box in that case, the way a tooltip flips when it
  // runs out of room.
  const labelInside = rect.top < LABEL_HEIGHT;
  return (
    <>
      <div
        className={`canvas__outline${variant === 'hover' ? ' canvas__outline--hover' : ''}`}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      />
      {label ? (
        <div
          className={`canvas__label${labelInside ? ' canvas__label--inside' : ''}`}
          style={{ left: rect.left, top: rect.top }}
        >
          {label}
        </div>
      ) : null}
    </>
  );
}

function labelFor(
  document: NonNullable<ReturnType<typeof useEditorStore.getState>['document']>,
  id: string,
): string {
  const element = findElement(document.root, id);
  if (!element) return '';
  return `${ELEMENT_KIND_LABELS[classifyElement(element)]} · ${element.tag}`;
}
