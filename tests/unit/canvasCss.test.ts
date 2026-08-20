import { describe, expect, it } from 'vitest';
import { analyzeSelector, neutralizeHiddenReveals } from '@/engine/canvasCss.js';

/**
 * The canvas runs no page scripts, so content a page hides until a scroll
 * observer reveals it would stay invisible while editing. These cases are taken
 * from a real hand-written page: the hiding is done with the author's own class
 * names and — crucially — through descendant selectors, where the hidden
 * element itself carries no marker at all. Nothing here may rely on knowing a
 * library name.
 */

describe('analyzeSelector', () => {
  it('splits a selector into structure and required state tokens', () => {
    expect(analyzeSelector('.reveal-group.visible > *')).toEqual({
      skeleton: '> *',
      tokens: new Set(['.reveal-group', '.visible']),
    });
  });

  it('treats attributes as state, and is not fooled by dots inside them', () => {
    expect(analyzeSelector('a[href=".x"].fx')).toEqual({
      skeleton: 'a',
      tokens: new Set(['[href=".x"]', '.fx']),
    });
  });

  it('gives a hidden rule and its revealed counterpart the same skeleton', () => {
    expect(analyzeSelector('.timeline .stage').skeleton).toBe(
      analyzeSelector('.timeline.visible .stage').skeleton,
    );
  });
});

describe('neutralizeHiddenReveals', () => {
  it('reveals a class hidden until a script adds a second class', () => {
    const css = `
      .reveal { opacity: 0; transform: translateY(28px); }
      .reveal.visible { opacity: 1; transform: translateY(0); }
    `;

    const out = neutralizeHiddenReveals(css);

    expect(out).toContain('.reveal');
    expect(out).toContain('opacity: 1 !important');
  });

  it('reveals children hidden through a descendant selector', () => {
    // The child carries no class of its own — a name-based override cannot see it.
    const css = `
      .reveal-group > * { opacity: 0; transform: translateY(20px); }
      .reveal-group.visible > * { opacity: 1; transform: translateY(0); }
    `;

    expect(neutralizeHiddenReveals(css)).toContain('.reveal-group > *');
  });

  it('reveals a descendant hidden by an ancestor state class', () => {
    const css = `
      .timeline .stage { opacity: 0; }
      .timeline.visible .stage { opacity: 1; }
    `;

    expect(neutralizeHiddenReveals(css)).toContain('.timeline .stage');
  });

  it('reveals a state expressed as an attribute rather than a class', () => {
    const css = `.fx { opacity: 0; } .fx[data-shown] { opacity: 1; }`;

    expect(neutralizeHiddenReveals(css)).toContain('.fx');
  });

  it('shows the end state of a CSS entrance animation straight away', () => {
    const css = `.hero h1 { opacity: 0; animation: fadeUp 0.8s ease forwards; }`;

    const out = neutralizeHiddenReveals(css);

    expect(out).toContain('.hero h1');
    // Otherwise the fade replays on every structural reload — and stays blank
    // entirely when the OS asks for reduced motion.
    expect(out).toContain('animation: none !important');
  });

  it('leaves a deliberately hidden element hidden', () => {
    // No rule anywhere reveals `.modal` by adding a class, so it is not a
    // scroll-reveal state and the editor must not force it visible.
    const css = `
      .modal { opacity: 0; }
      .sidebar { display: none; }
      .card { color: red; }
    `;

    expect(neutralizeHiddenReveals(css)).toBe('');
  });

  it('never rewrites @keyframes steps into selectors', () => {
    const css = `
      @keyframes fadeUp {
        from { opacity: 0; transform: translateY(22px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;

    const out = neutralizeHiddenReveals(css);

    expect(out).not.toContain('from');
    expect(out).toBe('');
  });

  it('survives a stylesheet it cannot parse rather than blanking the canvas', () => {
    expect(neutralizeHiddenReveals('.broken { color: ')).toBe('');
  });

  it('is stable when run over its own output', () => {
    const css = `
      .reveal { opacity: 0; }
      .reveal.visible { opacity: 1; }
    `;
    const once = `${css}\n${neutralizeHiddenReveals(css)}`;

    // The appended override sets opacity: 1, which must not itself be treated
    // as a new "revealed" partner that drags more rules in.
    expect(neutralizeHiddenReveals(once)).toContain('.reveal');
  });
});
