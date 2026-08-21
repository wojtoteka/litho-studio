import { useLayoutEffect, useRef, useState } from 'react';
import { useFloatingLayer } from './useFloatingLayer.js';

/**
 * Keeps a fixed-position popup menu on screen: flips it above/left of the
 * anchor point when it would otherwise overflow the bottom/right edge of the
 * viewport, instead of always growing down-and-right from the cursor.
 *
 * The menu renders hidden on the first frame so its real size can be
 * measured before the final position is committed, avoiding a flash at the
 * wrong spot.
 *
 * Menus positioned through here are also registered as floating layers, so the
 * native preview stands down rather than swallowing them - see
 * `useFloatingLayer`. Doing it here and not at each call site means a new menu
 * gets that for free.
 */
export function useClampedMenuPosition(anchor: { x: number; y: number }): {
  ref: React.RefObject<HTMLDivElement>;
  style: React.CSSProperties;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    left: anchor.x,
    top: anchor.y,
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const { offsetWidth: width, offsetHeight: height } = node;
    const margin = 8;

    let left = anchor.x;
    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, anchor.x - width);
    }

    let top = anchor.y;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, anchor.y - height);
    }

    setStyle({ left, top, visibility: 'visible' });
  }, [anchor.x, anchor.y]);

  useFloatingLayer(ref);

  return { ref, style };
}
