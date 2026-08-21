import { useEffect, useId, useLayoutEffect } from 'react';
import { useUiStore } from '@/state/uiStore.js';

/**
 * Declares an element as a layer drawn *over* the app, and keeps the store told
 * where it is.
 *
 * The live preview is a native `WebContentsView`, composited above the document
 * - no `z-index` can put a menu in front of it, so a popover that opens over
 * the previewed page is not "behind" it by some fixable amount, it is simply
 * invisible. The only remedy is to stand the native view down while something
 * covers it, which is what PreviewPane does with the boxes published here.
 *
 * Every floating thing should call this, not just the ones known to overlap
 * today: the panes move (side-by-side preview, "Przeglądanie" mode, a resized
 * window), so which menu reaches the preview is a matter of layout, not of the
 * menu. Publishing the box rather than a bare "something is open" flag is what
 * keeps the preview from blacking out for a menu that opens nowhere near it.
 */
export function useFloatingLayer(ref: React.RefObject<HTMLElement | null>, active = true): void {
  const id = useId();
  const setFloatingLayer = useUiStore((state) => state.setFloatingLayer);

  /*
   * Deliberately without a dependency array - the box has to be re-read after
   * *every* commit of the owning component.
   *
   * Menus decide their own final position in a layout effect of their own and
   * then re-render (`useClampedMenuPosition` and friends render hidden at the
   * raw anchor for one pass, then commit the clamped position), and their
   * contents resize as lists filter or entries are fixed. A deps array that
   * captured "when it opened" would publish the first, provisional box and keep
   * it. The store no-ops on an unchanged box, so this stays free.
   */
  useLayoutEffect(() => {
    const node = active ? ref.current : null;
    if (!node) {
      setFloatingLayer(id, null);
      return;
    }
    const rect = node.getBoundingClientRect();
    setFloatingLayer(id, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  });

  // Unmounting is the usual way a menu closes, and it produces no final commit
  // of its own - without this the layer would stay registered forever and the
  // preview would never come back.
  useEffect(() => () => setFloatingLayer(id, null), [id, setFloatingLayer]);
}
