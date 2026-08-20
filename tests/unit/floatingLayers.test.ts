import { describe, expect, it, beforeEach } from 'vitest';
import { isCoveredByLayer, useUiStore } from '../../src/state/uiStore.js';

/**
 * The registry behind "stand the native preview down while something is drawn
 * over it". Worth testing without a renderer because both halves are easy to
 * get subtly wrong: an overlap test that counts touching edges stands the view
 * down for a menu that is merely adjacent, and a setter that allocates a new
 * object for an unchanged box turns a per-commit republish into a render loop.
 */
describe('floating layer registry', () => {
  beforeEach(() => {
    useUiStore.setState({ floatingLayers: {} });
  });

  it('keeps the object identity when a re-published box has not moved', () => {
    const { setFloatingLayer } = useUiStore.getState();
    setFloatingLayer('menu', { left: 10, top: 10, right: 100, bottom: 60 });
    const first = useUiStore.getState().floatingLayers;

    setFloatingLayer('menu', { left: 10, top: 10, right: 100, bottom: 60 });
    expect(useUiStore.getState().floatingLayers).toBe(first);

    // Sub-pixel wobble from getBoundingClientRect is not a move either.
    setFloatingLayer('menu', { left: 10.2, top: 10, right: 100, bottom: 60.3 });
    expect(useUiStore.getState().floatingLayers).toBe(first);

    setFloatingLayer('menu', { left: 10, top: 40, right: 100, bottom: 90 });
    expect(useUiStore.getState().floatingLayers).not.toBe(first);
  });

  it('removes a layer on null and leaves the others alone', () => {
    const { setFloatingLayer } = useUiStore.getState();
    setFloatingLayer('menu', { left: 0, top: 0, right: 10, bottom: 10 });
    setFloatingLayer('popover', { left: 20, top: 0, right: 30, bottom: 10 });

    setFloatingLayer('menu', null);
    expect(Object.keys(useUiStore.getState().floatingLayers)).toEqual(['popover']);

    // Removing something that was never registered must not churn the store.
    const before = useUiStore.getState().floatingLayers;
    setFloatingLayer('menu', null);
    expect(useUiStore.getState().floatingLayers).toBe(before);
  });

  it('reports coverage only for layers that genuinely overlap the box', () => {
    const surface = { left: 400, top: 100, right: 900, bottom: 700 };

    expect(isCoveredByLayer({}, surface)).toBe(false);
    // The ☰ panel on the far side of the window: open, but nowhere near.
    expect(isCoveredByLayer({ a: { left: 0, top: 40, right: 380, bottom: 500 } }, surface)).toBe(false);
    // Edge-to-edge counts as clear — a menu ending exactly where the pane
    // starts hides nothing.
    expect(isCoveredByLayer({ a: { left: 0, top: 40, right: 400, bottom: 500 } }, surface)).toBe(false);
    // The out-of-layout list dropping out of the breakpoint bar into the pane.
    expect(isCoveredByLayer({ a: { left: 380, top: 90, right: 720, bottom: 460 } }, surface)).toBe(true);
    // A dialog backdrop covering the window.
    expect(isCoveredByLayer({ a: { left: 0, top: 0, right: 1440, bottom: 900 } }, surface)).toBe(true);
    // One clear layer must not mask a covering one.
    expect(
      isCoveredByLayer(
        {
          a: { left: 0, top: 40, right: 380, bottom: 500 },
          b: { left: 380, top: 90, right: 720, bottom: 460 },
        },
        surface,
      ),
    ).toBe(true);
  });
});
