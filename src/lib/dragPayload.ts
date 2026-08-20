/**
 * Drag payloads exchanged between the panels and the canvas.
 *
 * A custom MIME type is used rather than `text/plain` so the canvas can tell an
 * internal drag from a file dropped in from Explorer, and so dragging editor
 * content into an unrelated application produces nothing rather than JSON.
 */
export const DRAG_MIME = 'application/x-litho-drag';

export type DragPayload =
  | { kind: 'element'; templateId: string }
  | { kind: 'component'; templateId: string }
  | { kind: 'asset'; relPath: string; width: number | null; height: number | null }
  | { kind: 'icon'; iconName: string; style: 'outlined' | 'rounded' | 'sharp' }
  | { kind: 'customIcon'; fontFamily: string; className: string; glyph: string; css: string };

/**
 * The payload of the drag currently in flight, or `null` between drags.
 *
 * `dataTransfer.getData` is deliberately unreadable during `dragover` — the
 * spec exposes only the *types* until the drop actually happens — but the
 * canvas has to know what is being dragged *before* it lands, to show the right
 * affordance: an outline on the image that is about to be replaced, versus the
 * free-placement marker for everything else. Every drag inside the app starts
 * at `setDragPayload`, so a module-level copy is both accurate and far cheaper
 * than smuggling the payload through the MIME type.
 */
let inFlight: DragPayload | null = null;

export function setDragPayload(event: React.DragEvent, payload: DragPayload): void {
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = 'copy';
  inFlight = payload;
  // A drag that ends any way at all — dropped, cancelled with Escape, or
  // released outside the window — must not leave a stale payload behind for the
  // next `dragover` to read.
  event.currentTarget.addEventListener('dragend', clearDragPayload, { once: true });
}

export function currentDragPayload(): DragPayload | null {
  return inFlight;
}

export function clearDragPayload(): void {
  inFlight = null;
}
