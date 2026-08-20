import { useId } from 'react';

/**
 * The Litho Studio mark: a code bracket `< / >` whose slash is a mouse cursor —
 * the round trip between writing code and editing visually, which is the whole
 * premise of the product.
 *
 * Inlined as a component rather than loaded from `resources/logo.svg` so the
 * gradient can carry a unique id per instance (duplicate ids in a document
 * break the second instance's fill) and so it renders under the app's strict
 * CSP without an extra network request.
 *
 * `resources/logo.svg` and `resources/logo-mono.svg` carry the same geometry;
 * they are what `scripts/generate-icons.mjs` renders the packaging icons from,
 * so the three files have to be edited together or the shipped icon drifts from
 * the one in the toolbar.
 */

/**
 * The cursor, laid out on the classic arrow-pointer grid rather than by eye.
 *
 * Spelled out because the proportions are the whole problem the old mark had:
 * its arrow was 22 units tall with a 3-unit tail hanging off one corner and a
 * bottom edge that met the left edge at ~48°, which at the 16 and 24 px sizes
 * the toolbar and the OS task switcher ask for stopped resolving as a pointer
 * and started reading as a lightning bolt.
 *
 * Every angle below is deliberate, and they are the ones a real pointer has:
 *
 *   - the right edge, tip (15.6,10.1) → wing (32.5,27), runs at exactly 45°,
 *     so it rhymes with the brackets either side instead of nearly matching;
 *   - the bottom edge, (15.6,34.1) → notch (20.7,29), runs at exactly 45° too;
 *   - the tail is a parallelogram 4.4 units thick — a third wider than the
 *     pointer it is traced from, which is what keeps it from vanishing when a
 *     512 px source is resampled down to a 16 px favicon;
 *   - the whole glyph's bounding box centres on (24,24), the brackets' own
 *     centre. The old one sat 1.6 units right of it.
 */
const CURSOR_PATH =
  'M15.6 10.1 L15.6 34.1 L20.7 29 L25.2 37.9 L29.1 35.9 L24.6 27 L32.5 27 Z';

/**
 * Pulled in from x=5/x=43 and shortened by a unit at each end, so the gap to the
 * cursor is the same on both sides — it was 5.5 units on the left and 2.2 on the
 * right before, which is what made the mark look as though it had slipped.
 */
const BRACKET_LEFT = 'M11 16 L5 24 L11 32';
const BRACKET_RIGHT = 'M37 16 L43 24 L37 32';

/** Matched to the cursor's 4.6-unit tail; 3.6 left the brackets looking faint. */
const BRACKET_WIDTH = 4;

export function Logo({
  className,
  title = 'Litho Studio',
}: {
  className?: string;
  title?: string;
}): JSX.Element {
  const gradientId = `litho-logo-${useId()}`;

  return (
    <svg className={className} viewBox="0 0 48 48" role="img" aria-label={title} focusable="false">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6E56CF" />
          <stop offset="100%" stopColor="#4F8FFF" />
        </linearGradient>
      </defs>

      <g
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={BRACKET_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={BRACKET_LEFT} />
        <path d={BRACKET_RIGHT} />
      </g>

      <path d={CURSOR_PATH} fill={`url(#${gradientId})`} />
    </svg>
  );
}
