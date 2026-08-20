import { CANVAS_ID_ATTRIBUTE } from './canvasDocument.js';

/** Tags that may hold arbitrary children — valid "drop inside" targets. */
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'main',
  'article',
  'header',
  'footer',
  'aside',
  'nav',
  'form',
  'ul',
  'ol',
]);

/** How close (in the frame's own px) a point has to be to an edge to snap to it. */
const SNAP_THRESHOLD = 6;

/**
 * A single alignment guide the overlay draws while something is being placed —
 * the "line that suggests you can drop here to line up" the design asks for.
 * Coordinates are in the frame's own viewport space, exactly like the rects the
 * overlay already positions against.
 */
export interface SnapGuide {
  orientation: 'vertical' | 'horizontal';
  /** The line's fixed coordinate: x for a vertical guide, y for a horizontal one. */
  pos: number;
  /** The line's extent along the other axis. */
  start: number;
  end: number;
}

export interface FreeDropTarget {
  parentId: string;
  /** Container-relative offset written to the element's `left`/`top`. */
  left: number;
  top: number;
  /** The (snapped) drop point in frame-viewport coords — for the overlay marker. */
  pointerX: number;
  pointerY: number;
  guides: SnapGuide[];
  /**
   * Whether the container already establishes its own positioning context
   * (`position` other than `static`). If not, the caller has to give it one
   * before an absolute child can anchor to it — otherwise the child anchors
   * to the page's initial containing block instead of the container the user
   * dropped into.
   */
  parentPositioned: boolean;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

function boxOf(rect: { left: number; top: number; width: number; height: number }): Box {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

/**
 * Every element the overlay could snap to: each `[data-litho-id]` box in
 * frame-viewport coords, minus `<html>` (its full-page box only ever produces
 * noise) and minus the element currently being dragged together with its own
 * subtree (whose rects move *with* it, so it must never align to itself).
 */
export function collectSnapBoxes(frameDocument: Document, exclude?: Element | null): Box[] {
  const boxes: Box[] = [];
  frameDocument.querySelectorAll(`[${CANVAS_ID_ATTRIBUTE}]`).forEach((element) => {
    if (element.tagName.toLowerCase() === 'html') return;
    if (exclude && (element === exclude || exclude.contains(element))) return;
    const rect = element.getBoundingClientRect();
    // Non-rendered nodes (every `<head>` child carries an id too, plus anything
    // `display: none`) report a zero box at the origin — snapping to that would
    // yank drops toward the top-left corner. Skip them.
    if (rect.width === 0 && rect.height === 0) return;
    boxes.push(boxOf(rect));
  });
  return boxes;
}

/**
 * Nudges a box so one of its edges/centres lines up with a nearby element,
 * returning the adjustment plus the guide lines to draw for it — the "smart
 * guides" every layout tool shows. A zero-size box (a bare drop point) simply
 * snaps that point to the nearest edge, which is what a panel drop passes in.
 * Picks at most one snap per axis: the closest within the threshold.
 */
export function computeSnap(
  moving: Box,
  others: Box[],
  threshold = SNAP_THRESHOLD,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const movX = [moving.left, moving.centerX, moving.right];
  const movY = [moving.top, moving.centerY, moving.bottom];

  let bestX: { delta: number; dist: number; pos: number; ref: Box } | null = null;
  let bestY: { delta: number; dist: number; pos: number; ref: Box } | null = null;

  for (const other of others) {
    for (const target of [other.left, other.centerX, other.right]) {
      for (const anchor of movX) {
        const dist = Math.abs(anchor - target);
        if (dist <= threshold && (bestX === null || dist < bestX.dist)) {
          bestX = { delta: target - anchor, dist, pos: target, ref: other };
        }
      }
    }
    for (const target of [other.top, other.centerY, other.bottom]) {
      for (const anchor of movY) {
        const dist = Math.abs(anchor - target);
        if (dist <= threshold && (bestY === null || dist < bestY.dist)) {
          bestY = { delta: target - anchor, dist, pos: target, ref: other };
        }
      }
    }
  }

  const dx = bestX?.delta ?? 0;
  const dy = bestY?.delta ?? 0;
  const mLeft = moving.left + dx;
  const mRight = moving.right + dx;
  const mTop = moving.top + dy;
  const mBottom = moving.bottom + dy;

  const guides: SnapGuide[] = [];
  if (bestX) {
    guides.push({
      orientation: 'vertical',
      pos: bestX.pos,
      start: Math.min(mTop, bestX.ref.top),
      end: Math.max(mBottom, bestX.ref.bottom),
    });
  }
  if (bestY) {
    guides.push({
      orientation: 'horizontal',
      pos: bestY.pos,
      start: Math.min(mLeft, bestY.ref.left),
      end: Math.max(mRight, bestY.ref.right),
    });
  }
  return { dx, dy, guides };
}

/**
 * The `<img>` under a point, when there is one.
 *
 * Dropping a photo onto an existing image means "use this picture here", not
 * "put another picture on top of this one". That distinction is what makes a
 * gallery fillable: its tiles are already sized and laid out, so replacing the
 * source of the tile under the cursor finishes the job, whereas placing a new
 * absolutely-positioned image would cover the layout with something the user
 * then has to drag back out and delete.
 */
export function resolveImageDropTarget(frameDocument: Document, x: number, y: number): string | null {
  const target = frameDocument.elementFromPoint(x, y);
  const image = target?.closest('img');
  return image?.getAttribute(CANVAS_ID_ATTRIBUTE) ?? null;
}

/**
 * Resolves a point inside the canvas iframe to an exact pixel position for
 * *free* placement (`position: absolute`). Whatever container is under the
 * point supplies the box the offset is measured against, so the element lands
 * exactly under the cursor regardless of how far the page is scrolled. This is
 * the only drop resolution the canvas uses: a drop from a panel places freely
 * at a pixel, never into a sibling slot. (Structural reordering lives in the
 * layers panel.)
 *
 * Only *new* elements arrive this way, which is why absolute is right for them:
 * they have no place in the layout to keep. Moving an element that is already
 * on the page is the opposite case and goes through `TransformControls`, which
 * offsets it relatively so the layout around it holds.
 *
 * `x`/`y` must already be in `frameDocument`'s own coordinate space.
 */
export function resolveFreeDropPosition(
  frameDocument: Document,
  x: number,
  y: number,
): FreeDropTarget | null {
  if (!frameDocument.body) return null;
  const body = frameDocument.body;
  const bodyId = body.getAttribute(CANVAS_ID_ATTRIBUTE);
  if (!bodyId) return null;

  const view = frameDocument.defaultView;
  const isPositioned = (element: Element): boolean => {
    const position = view?.getComputedStyle(element).position;
    return (
      position === 'absolute' || position === 'relative' || position === 'fixed' || position === 'sticky'
    );
  };

  const target = frameDocument.elementFromPoint(x, y);
  const host = target?.closest(`[${CANVAS_ID_ATTRIBUTE}]`);
  const hostId = host?.getAttribute(CANVAS_ID_ATTRIBUTE) ?? null;
  // A leaf element (a button, an image…) cannot hold children, so a point
  // over one falls back to the page body — anything can be dropped anywhere on
  // the page.
  const isContainer = host != null && hostId !== null && CONTAINER_TAGS.has(host.tagName.toLowerCase());
  const container = isContainer ? (host as Element) : body;
  const containerId = isContainer ? hostId! : bodyId;

  // Snap the bare drop point to nearby element edges so a release near, say, a
  // heading's left edge lands flush under it rather than a few px off — the
  // guide lines the overlay draws for this are what the design asks for.
  const point: Box = { left: x, top: y, right: x, bottom: y, centerX: x, centerY: y };
  const { dx, dy, guides } = computeSnap(point, collectSnapBoxes(frameDocument));
  const snappedX = x + dx;
  const snappedY = y + dy;

  const rect = container.getBoundingClientRect();
  return {
    parentId: containerId,
    left: Math.max(0, Math.round(snappedX - rect.left)),
    top: Math.max(0, Math.round(snappedY - rect.top)),
    pointerX: snappedX,
    pointerY: snappedY,
    guides,
    parentPositioned: isPositioned(container),
  };
}
