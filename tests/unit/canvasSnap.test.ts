import { describe, expect, it } from 'vitest';
import { computeSnap } from '@/lib/canvasDrop.js';

/**
 * `computeSnap` is the pure core of free placement: it decides when a box being
 * placed or dragged should line up with a nearby element, and returns both the
 * nudge to apply and the guide lines the overlay draws. It is exercised in two
 * shapes - a real box (dragging an existing element) and a zero-size box (a
 * bare drop point) - so both are covered here.
 */

function box(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2,
  };
}

describe('computeSnap', () => {
  it('leaves a point alone when nothing is within the threshold', () => {
    const point = box(500, 500, 0, 0);
    const other = box(0, 0, 100, 40);
    const { dx, dy, guides } = computeSnap(point, [other]);
    expect(dx).toBe(0);
    expect(dy).toBe(0);
    expect(guides).toHaveLength(0);
  });

  it('snaps a drop point to a nearby left edge and emits a vertical guide', () => {
    // A heading at x=40; the point is 3px to its right - within the 6px default.
    const point = box(43, 200, 0, 0);
    const heading = box(40, 100, 200, 32);
    const { dx, dy, guides } = computeSnap(point, [heading]);
    expect(dx).toBe(-3); // pulled left onto the heading's left edge
    expect(dy).toBe(0);
    expect(guides).toEqual([
      { orientation: 'vertical', pos: 40, start: 100, end: 200 },
    ]);
  });

  it('aligns element centres when a real box is dragged near one', () => {
    // Moving centreX=100; reference centreX=102, and every edge pair is far
    // apart, so the centre snap is the only one within threshold.
    const moving = box(50, 300, 100, 50);
    const reference = box(0, 0, 204, 40);
    const { dx, guides } = computeSnap(moving, [reference]);
    expect(dx).toBe(2); // pushed 2px right so the centres line up
    expect(guides.some((g) => g.orientation === 'vertical' && g.pos === 102)).toBe(true);
  });

  it('picks the closest candidate per axis independently', () => {
    const point = box(105, 205, 0, 0);
    const near = box(100, 0, 0, 0); // single edge at x=100 → 5px away on x
    const far = box(0, 200, 0, 0); // single edge at y=200 → 5px away on y
    const { dx, dy } = computeSnap(point, [near, far]);
    expect(dx).toBe(-5);
    expect(dy).toBe(-5);
  });

  it('honours a custom threshold', () => {
    const point = box(48, 0, 0, 0);
    const other = box(40, 0, 0, 0); // single edge at x=40 → 8px away
    expect(computeSnap(point, [other], 6).dx).toBe(0); // outside 6px
    expect(computeSnap(point, [other], 10).dx).toBe(-8); // inside 10px
  });
});
