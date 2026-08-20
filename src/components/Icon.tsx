import { ICON_PATHS, type IconName } from '@/lib/icons.js';

export type { IconName };

/**
 * A Material Symbols glyph, drawn inline as SVG.
 *
 * Every icon in the editor's own chrome goes through here. Two consequences
 * that are the whole reason it is not an icon font:
 *
 *  - **It works offline.** `electron/main.ts` blocks outbound requests except
 *    passive resources for the *edited page*; the editor itself must never
 *    depend on a CDN being reachable. An icon font would render its ligature
 *    name as literal text ("settings", "undo") in the toolbar until — or
 *    unless — the network answered.
 *  - **It inherits colour and size from CSS.** `fill: currentColor` means an
 *    icon inside a ghost button, an active tab or a danger action is tinted by
 *    the same token that colours the text next to it, with no per-icon rules.
 *
 * Always `aria-hidden`: an icon here is decoration next to a label, or sits in
 * a control that carries its own `aria-label`. Naming it twice is worse than
 * not naming it at all.
 *
 * The `0 -960 960 960` viewBox is Material Symbols' own coordinate system —
 * the path data is used exactly as Google publishes it, unscaled and unedited.
 */
export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  /** Rendered box in px. 18 for inline controls, 20–22 for standalone buttons. */
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
