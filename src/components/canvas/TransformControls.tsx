import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { CANVAS_ID_ATTRIBUTE } from '@/lib/canvasDocument.js';
import { isIconFontClass } from '@shared/document.js';
import { collectSnapBoxes, computeSnap, type SnapGuide } from '@/lib/canvasDrop.js';
import { Icon } from '../Icon.js';

/**
 * Direct-manipulation transform for the selected element.
 *
 * The page renders inside a `scale(zoom)` iframe, so the handles cannot be a
 * third-party widget bolted onto a DOM node in the main window — the geometry
 * would not line up. Instead the handles are drawn in the same scaled overlay as
 * the selection outline, and every pointer delta is divided by `zoom` to convert
 * main-window pixels into page pixels. That single conversion is the whole trick
 * that makes resizing feel correct at any zoom level.
 *
 * Two gestures:
 *  - **Resize** (corner/edge handles) → writes `width`/`height` in px, except
 *    for a font-glyph icon, whose box *is* its glyph: `width`/`height` only
 *    pad the box around a glyph that stays 24 px, so an icon is resized by
 *    scaling `font-size` instead (see `iconFontSize`).
 *  - **Move** (drag the body, or the arrow keys) → free placement, exactly like
 *    a graphics editor: the element follows the pointer and lands wherever it is
 *    released. A *positioned* element just gets new `left`/`top`. An element
 *    still in normal flow is given `position: relative` and an offset from where
 *    it already sits, so it moves anywhere **while keeping its slot in the
 *    layout** — the paragraph under a dragged heading stays put instead of
 *    jumping up to fill the gap. There is no reorder / drop-slot gesture on the
 *    canvas; the pink alignment guides only *suggest* nearby edges to line up
 *    with, and holding **Alt** ignores them entirely. (Structural reordering
 *    still lives in the layers panel.)
 *
 * Dropping *out* of the layout — `position: absolute`, so the space the element
 * held is reclaimed by its siblings — is a separate, explicit action: the ⌖
 * button. Making it a side effect of dragging is what made every move rearrange
 * the page around it.
 *
 * During a resize/move drag the *live* element inside the iframe is styled
 * inline for instant feedback; the authoritative change is committed to the
 * model on release, and the inline styles are then dropped — the committed CSS
 * is patched into the live iframe, and an inline style left behind would have
 * higher specificity and permanently shadow it. Nothing inline is ever written
 * to the user's file. A press that never passes `DRAG_THRESHOLD` commits
 * nothing at all: clicking a handle to grab an element must not move it.
 */

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

interface Props {
  elementId: string;
  rect: DOMRect;
  frameRef: RefObject<HTMLIFrameElement>;
  /** Bumped on every iframe load, so the keyboard listener re-binds to the new document. */
  frameEpoch: number;
  zoom: number;
  /** Re-measure the overlay after the model changes. */
  onCommit: () => void;
  /** Drives the alignment guides `Canvas` draws while dragging an element. */
  onSnapGuidesChange: (guides: SnapGuide[]) => void;
}

interface DragState {
  handle: Handle;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  startLeft: number;
  startTop: number;
  positioned: boolean;
  live: HTMLElement | null;
  /**
   * Set for a font-glyph icon: the `font-size` it started the drag at, which
   * the resize scales instead of writing `width`/`height`. `null` for
   * everything else, which resizes as a box.
   */
  iconFontSize: number | null;
  /**
   * Set when a normal-flow element is grabbed to move: `position: relative` is
   * written to the live element so it can follow the pointer, and the release
   * commits that through `moveNodeFree` in a single undo step. Its offsets start
   * at zero, since a relative offset is measured from the element's own place in
   * the flow — which is where it currently sits.
   */
  converting: boolean;
  /**
   * Whether the pointer has travelled far enough to count as a drag. Until it
   * has, nothing is written anywhere: a click that merely grabs a handle must
   * leave the element alone.
   */
  moved: boolean;
}

const RESIZE_HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Space `.transform__move` needs above the selection box, matching its CSS offset. */
const MOVE_HANDLE_CLEARANCE = 24;
const EDGES: Array<'top' | 'right' | 'bottom' | 'left'> = ['top', 'right', 'bottom', 'left'];
/**
 * How far (in main-window px, so it feels the same at any zoom) the pointer has
 * to travel before a press counts as a drag rather than a click. Without it the
 * hand tremor in a single click moves the element by a pixel and writes a CSS
 * rule for it.
 */
const DRAG_THRESHOLD = 3;
/** Smallest icon a resize may leave behind — below this the glyph is unreadable. */
const MIN_ICON_FONT_SIZE = 8;
/** Arrow-key step, and the bigger one Shift asks for. */
const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;

export function TransformControls({
  elementId,
  rect,
  frameRef,
  frameEpoch,
  zoom,
  onCommit,
  onSnapGuidesChange,
}: Props): JSX.Element {
  const setStyle = useEditorStore((state) => state.setStyle);
  const moveNodeFree = useEditorStore((state) => state.moveNodeFree);
  const drag = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(false);

  const liveElement = useCallback((): HTMLElement | null => {
    const frameDocument = frameRef.current?.contentDocument;
    if (!frameDocument) return null;
    return frameDocument.querySelector<HTMLElement>(`[${CANVAS_ID_ATTRIBUTE}="${CSS.escape(elementId)}"]`);
  }, [elementId, frameRef]);

  /**
   * Takes an element *out of the layout*: `position: absolute` at the exact spot
   * it already renders, so nothing visibly moves but the space it held is
   * released and its siblings close up around it.
   *
   * This is the deliberate version of what dragging used to do by itself. Moving
   * an element is the common act and must not rearrange the page; giving up the
   * slot is the rare one and gets its own button.
   *
   * `offsetLeft`/`offsetTop` are already measured against the nearest positioned
   * ancestor (falling back to `<body>` per spec when there is none) and already
   * include any relative offset a previous drag left on the element, so giving
   * that same ancestor `position: relative` — if it does not already have a
   * positioning context of its own — cements it as the new absolute element's
   * containing block without shifting the numbers just read from it.
   */
  const makeFree = useCallback(() => {
    const live = liveElement();
    const frameDocument = frameRef.current?.contentDocument;
    if (!live || !frameDocument) return;

    const anchor = (live.offsetParent as HTMLElement | null) ?? frameDocument.body;
    const anchorId = anchor?.getAttribute(CANVAS_ID_ATTRIBUTE) ?? null;
    if (!anchorId) return;

    if (!isPositioned(anchor)) {
      setStyle(
        anchorId,
        { position: 'relative' },
        { label: 'Kontekst swobodnego pozycjonowania', mergeKey: `free-context:${anchorId}` },
      );
    }
    setStyle(
      elementId,
      {
        position: 'absolute',
        left: `${Math.round(live.offsetLeft)}px`,
        top: `${Math.round(live.offsetTop)}px`,
      },
      { label: 'Wyjęcie z układu' },
    );
    onCommit();
  }, [elementId, liveElement, frameRef, setStyle, onCommit]);

  /**
   * Keyboard nudge — the precise counterpart to dragging, and the only way to
   * place something to the pixel without fighting the snap. Goes through exactly
   * the same two paths a drag does, so a nudged element ends up with the same
   * CSS as a dragged one.
   */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const live = liveElement();
      if (!live) return;
      if (isPositioned(live)) {
        setStyle(
          elementId,
          {
            left: `${Math.round(cssNumber(live, 'left') + dx)}px`,
            top: `${Math.round(cssNumber(live, 'top') + dy)}px`,
          },
          { label: 'Przesunięcie', mergeKey: `move:${elementId}` },
        );
      } else {
        // Still in flow: the first nudge offsets it from where it sits, so the
        // starting point is zero by definition.
        moveNodeFree(elementId, { left: dx, top: dy }, 'Przesunięcie');
      }
      onCommit();
    },
    [elementId, liveElement, moveNodeFree, setStyle, onCommit],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // Typing in a field — or in the page itself, which is contenteditable
      // while text is being edited — owns the arrow keys.
      const target = event.target as { tagName?: unknown; isContentEditable?: unknown } | null;
      const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : '';
      if (target?.isContentEditable === true) return;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const step = event.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const move = delta[event.key];
      if (!move) return;
      // Otherwise the canvas iframe scrolls out from under the element being
      // placed.
      event.preventDefault();
      nudge(move[0], move[1]);
    };

    const frameDocument = frameRef.current?.contentDocument;
    // Both documents: clicking into the page moves keyboard focus inside the
    // iframe, and key events never cross a frame boundary. `frameEpoch` is a
    // dependency so a structural reload re-binds to the new document.
    window.addEventListener('keydown', onKeyDown);
    frameDocument?.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      frameDocument?.removeEventListener('keydown', onKeyDown);
    };
  }, [nudge, frameRef, frameEpoch]);

  const onPointerDown = useCallback(
    (handle: Handle) => (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);

      const live = liveElement();
      const positioned = live ? isPositioned(live) : false;
      // A normal-flow element is moved by a *relative offset* from where the
      // layout already puts it, so the gesture starts from zero. A positioned
      // one continues from its current `left`/`top`.
      const converting = handle === 'move' && !positioned && !!live;

      drag.current = {
        handle,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        startLeft: converting ? 0 : live ? parseFloat(live.style.left || '0') || cssNumber(live, 'left') : 0,
        startTop: converting ? 0 : live ? parseFloat(live.style.top || '0') || cssNumber(live, 'top') : 0,
        positioned,
        live,
        converting,
        iconFontSize: live && handle !== 'move' && isGlyphIcon(live) ? cssNumber(live, 'font-size') : null,
        moved: false,
      };
      setPreview(rect);
      setActive(true);
    },
    [liveElement, rect],
  );

  useEffect(() => {
    if (!active) return undefined;

    const onMove = (event: PointerEvent): void => {
      const state = drag.current;
      if (!state) return;

      const rawDx = event.clientX - state.startX;
      const rawDy = event.clientY - state.startY;
      // Below the threshold this is still a click, and a click writes nothing —
      // not even the inline styles used for feedback.
      if (!state.moved) {
        if (Math.abs(rawDx) < DRAG_THRESHOLD && Math.abs(rawDy) < DRAG_THRESHOLD) return;
        state.moved = true;
      }

      // Main-window pixels → page pixels.
      const dx = rawDx / zoom;
      const dy = rawDy / zoom;

      let { startWidth: width, startHeight: height, startLeft: left, startTop: top } = state;
      const h = state.handle;

      if (h === 'move') {
        // A flow element follows the pointer as a *relative* offset: it still
        // occupies its original slot, so the elements around it hold their
        // places instead of collapsing into the gap. `left`/`top` come from the
        // shared write below, starting at zero — which is exactly where the
        // element already renders.
        if (state.converting && state.live && state.live.style.position !== 'relative') {
          state.live.style.position = 'relative';
        }

        left = state.startLeft + dx;
        top = state.startTop + dy;

        // Snap is a *hint*, never a cage: it nudges an edge/centre onto a nearby
        // element within a few px so things can be lined up by hand, and holding
        // Alt turns it off entirely. The projected viewport box is the start
        // rect translated by the drag delta; the nudge that lines it up applies
        // equally to the `left`/`top` written.
        const frameDocument = frameRef.current?.contentDocument;
        if (frameDocument && !event.altKey) {
          const projLeft = rect.left + dx;
          const projTop = rect.top + dy;
          const moving = {
            left: projLeft,
            top: projTop,
            right: projLeft + state.startWidth,
            bottom: projTop + state.startHeight,
            centerX: projLeft + state.startWidth / 2,
            centerY: projTop + state.startHeight / 2,
          };
          const {
            dx: sdx,
            dy: sdy,
            guides,
          } = computeSnap(moving, collectSnapBoxes(frameDocument, state.live));
          left += sdx;
          top += sdy;
          onSnapGuidesChange(guides);
        } else {
          onSnapGuidesChange([]);
        }
      } else {
        if (h.includes('e')) width = Math.max(8, state.startWidth + dx);
        if (h.includes('s')) height = Math.max(8, state.startHeight + dy);
        if (h.includes('w')) width = Math.max(8, state.startWidth - dx);
        if (h.includes('n')) height = Math.max(8, state.startHeight - dy);

        // An icon is one glyph: it has no independent width and height to drag
        // to, so the box the handles describe is turned into a scale factor and
        // applied to `font-size`. The outline then follows the element's *own*
        // new box rather than the dragged rectangle — a glyph stays square
        // whichever handle was pulled, and an inline box also shifts on its
        // baseline as it grows, so only the real measurement keeps the handles
        // on the icon.
        if (state.iconFontSize !== null && state.live) {
          const scale =
            h === 'e' || h === 'w'
              ? width / state.startWidth
              : h === 'n' || h === 's'
                ? height / state.startHeight
                : Math.max(width / state.startWidth, height / state.startHeight);
          const fontSize = Math.max(MIN_ICON_FONT_SIZE, Math.round(state.iconFontSize * scale));
          state.live.style.fontSize = `${fontSize}px`;
          const box = state.live.getBoundingClientRect();
          setPreview(new DOMRect(box.left, box.top, box.width, box.height));
          return;
        }
      }

      // Live feedback on the real element.
      if (state.live) {
        if (h !== 'move') {
          if (width !== state.startWidth) state.live.style.width = `${Math.round(width)}px`;
          if (height !== state.startHeight) state.live.style.height = `${Math.round(height)}px`;
        } else {
          state.live.style.left = `${Math.round(left)}px`;
          state.live.style.top = `${Math.round(top)}px`;
        }
      }

      setPreview(
        new DOMRect(
          h.includes('w') ? rect.left + (state.startWidth - width) : rect.left,
          h.includes('n') ? rect.top + (state.startHeight - height) : rect.top,
          width,
          height,
        ),
      );
    };

    const onUp = (): void => {
      const state = drag.current;
      drag.current = null;
      setPreview(null);
      setActive(false);
      onSnapGuidesChange([]);
      if (!state || !state.live) return;
      const live = state.live;
      // A press that never became a drag wrote nothing anywhere — there is
      // nothing to commit and nothing to clean up. Committing here is what used
      // to teleport a positioned element to its container's top-left corner on
      // a bare click of the move handle, since no `left`/`top` had been written
      // for the commit to read back.
      if (!state.moved) {
        onCommit();
        return;
      }

      if (state.handle === 'move') {
        const left = parseFloat(live.style.left || '0');
        const top = parseFloat(live.style.top || '0');
        const structureBefore = useEditorStore.getState().structureRevision;
        if (state.converting) {
          // First drag of a flow element → `position: relative` plus the offset,
          // in one undo step. The element keeps its slot in the layout.
          moveNodeFree(elementId, { left, top }, 'Swobodne przesunięcie');
        } else if (state.positioned) {
          setStyle(
            elementId,
            { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` },
            { label: 'Przesunięcie', mergeKey: `move:${elementId}` },
          );
        }
        // In the one case left — an element that is neither positioned nor
        // convertible — `left`/`top` would be a dead rule CSS ignores, so
        // nothing was committed and only the cleanup below applies.
        dropInlineFeedback(live, ['position', 'left', 'top'], structureBefore);
        onCommit();
        return;
      }

      if (state.iconFontSize !== null) {
        const structureBefore = useEditorStore.getState().structureRevision;
        setStyle(
          elementId,
          {
            'font-size': `${Math.round(cssNumber(live, 'font-size'))}px`,
            // A box sized around the glyph is exactly what made resizing look
            // broken; now that the glyph itself scales, any width/height an
            // earlier drag left on this element would only pad it back out.
            width: null,
            height: null,
          },
          { label: 'Zmiana rozmiaru ikony', mergeKey: `resize:${elementId}` },
        );
        dropInlineFeedback(live, ['font-size'], structureBefore);
        onCommit();
        return;
      }

      const patch: Record<string, string> = {};
      const width = Math.round(live.getBoundingClientRect().width / zoom);
      const height = Math.round(live.getBoundingClientRect().height / zoom);
      if (state.handle !== 'n' && state.handle !== 's') {
        patch.width = `${width}px`;
        // A stylesheet max-width (e.g. the default "Tekst" block's `max-width: 65ch`)
        // would silently clamp the box back down even though `width` now wins the
        // cascade — an explicit resize means the user wants this exact width.
        const maxWidth = cssNumber(live, 'max-width');
        if (maxWidth > 0 && maxWidth < width) patch['max-width'] = 'none';
      }
      if (state.handle !== 'e' && state.handle !== 'w') patch.height = `${height}px`;
      const structureBefore = useEditorStore.getState().structureRevision;
      setStyle(elementId, patch, { label: 'Zmiana rozmiaru', mergeKey: `resize:${elementId}` });
      dropInlineFeedback(live, ['width', 'height'], structureBefore);
      onCommit();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [active, zoom, rect, elementId, setStyle, moveNodeFree, onCommit, onSnapGuidesChange, frameRef]);

  const box = preview ?? rect;
  // The ⌖ button is offered for anything still taking up space in the layout —
  // including an element a drag has already offset, which is exactly when
  // someone may want the gap it left behind to close.
  const inFlow = (() => {
    const live = liveElement();
    return live ? !isOutOfFlow(live) : false;
  })();

  const moveTitle =
    'Przeciągnij lub użyj strzałek, aby przesunąć · układ dookoła zostaje na miejscu · Shift = 10 px · Alt = bez prowadnic';

  return (
    <div className="transform" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      {/* Thin bands along the selection's own border double as a much bigger
          drag-to-move target than the tab alone — dragging a shape by its
          edge is the PowerPoint/Canva convention, and it leaves the interior
          free for clicks/right-clicks meant for nested content underneath. */}
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`transform__edge transform__edge--${edge}`}
          role="presentation"
          onPointerDown={onPointerDown('move')}
          title={moveTitle}
          aria-hidden="true"
        />
      ))}

      <div
        // The stage clips anything drawn outside the frame (see
        // `.canvas__stage`), so for an element flush with the top of the page
        // the handle has to move inside its own box to stay reachable.
        className={`transform__move${box.top < MOVE_HANDLE_CLEARANCE ? ' transform__move--inside' : ''}`}
        role="presentation"
        onPointerDown={onPointerDown('move')}
        title={moveTitle}
        aria-hidden="true"
      >
        <Icon name="drag_indicator" size={16} />
      </div>

      {inFlow ? (
        <button
          type="button"
          className={`transform__free${box.top < MOVE_HANDLE_CLEARANCE ? ' transform__free--inside' : ''}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            makeFree();
          }}
          title="Wyjmij z układu (position: absolute) — element zostaje w miejscu, ale zwalnia zajmowane miejsce i sąsiedzi się przesuwają"
          aria-label="Wyjmij z układu"
        >
          <Icon name="filter_center_focus" size={14} />
        </button>
      ) : null}

      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle}
          className={`transform__handle transform__handle--${handle}`}
          onPointerDown={onPointerDown(handle)}
        />
      ))}
    </div>
  );
}

/**
 * Clears the inline styles a drag wrote for live feedback, now that the real
 * values are in the stylesheet — an inline style left behind has higher
 * specificity and would permanently shadow them, including any later edit from
 * the properties panel.
 *
 * Unless the commit was *structural*. Allocating a selector hook rewrites the
 * markup, so the canvas answers with a full iframe reload rather than patching
 * the live stylesheet — and a reload takes long enough that clearing these
 * styles first would visibly snap the element back to where it started until
 * the new document lands. The reload discards them anyway.
 */
function dropInlineFeedback(element: HTMLElement, properties: string[], structureBefore: number): void {
  if (useEditorStore.getState().structureRevision !== structureBefore) return;
  properties.forEach((property) => element.style.removeProperty(property));
}

/**
 * Whether the element's visible size comes from `font-size` rather than
 * `width`/`height` — it draws a glyph from an icon font.
 *
 * The class name is the reliable signal for anything this editor inserted (and
 * for the usual hand-written `material-symbols-…` / `ikona-…` markup); the
 * computed font family catches an icon that was styled some other way, once
 * the web font has actually loaded.
 */
function isGlyphIcon(element: HTMLElement): boolean {
  if ([...element.classList].some(isIconFontClass)) return true;
  const family = element.ownerDocument.defaultView?.getComputedStyle(element).fontFamily ?? '';
  return /material\s+(symbols|icons)/iu.test(family);
}

function isPositioned(element: HTMLElement): boolean {
  const position = element.ownerDocument.defaultView?.getComputedStyle(element).position;
  return position === 'absolute' || position === 'fixed' || position === 'relative';
}

/** Whether the element has given up its slot in the layout, so siblings flow past it. */
function isOutOfFlow(element: HTMLElement): boolean {
  const position = element.ownerDocument.defaultView?.getComputedStyle(element).position;
  return position === 'absolute' || position === 'fixed';
}

function cssNumber(element: HTMLElement, property: string): number {
  const view = element.ownerDocument.defaultView;
  if (!view) return 0;
  const value = parseFloat(view.getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}
