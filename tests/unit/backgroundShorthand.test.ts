import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import {
  expandBackgroundShorthand,
  expandBackgroundShorthandInRule,
} from '@/engine/backgroundShorthand.js';
import { applyDeclarations, parseStyleSheet, readDeclarations, stringifyStyleSheet } from '@/engine/cssGenerator.js';
import type { Breakpoint } from '@shared/project.js';

/**
 * The reported bug in one sentence: on the "Licznik / Statystyki" block - whose
 * rule is `background: linear-gradient(…)` - the panel could set neither a
 * transparent background nor a flat colour, because it only ever reads and
 * writes the longhands.
 */

const BASE: Breakpoint = {
  id: 'base',
  label: 'Desktop',
  maxWidth: null,
  canvasWidth: 1440,
  fluid: true,
  builtIn: true,
};

function ruleOf(css: string) {
  const root = postcss.parse(css);
  let found: postcss.Rule | null = null;
  root.walkRules((rule) => {
    found = rule;
  });
  return { root, rule: found as unknown as postcss.Rule };
}

describe('expandBackgroundShorthand', () => {
  it('splits a gradient-only shorthand into background-image', () => {
    expect(expandBackgroundShorthand('linear-gradient(135deg, #6e56cf, #4f8fff)')).toEqual({
      'background-image': 'linear-gradient(135deg, #6e56cf, #4f8fff)',
    });
  });

  it('reads a bare colour as the colour longhand', () => {
    expect(expandBackgroundShorthand('#fff')).toEqual({ 'background-color': '#fff' });
    expect(expandBackgroundShorthand('transparent')).toEqual({ 'background-color': 'transparent' });
  });

  it('separates position from size across the slash', () => {
    expect(expandBackgroundShorthand('url(a.png) center / cover no-repeat')).toEqual({
      'background-image': 'url(a.png)',
      'background-position': 'center',
      'background-size': 'cover',
      'background-repeat': 'no-repeat',
    });
  });

  it('keeps layer order and puts the colour on the last layer only', () => {
    expect(
      expandBackgroundShorthand('url(top.png) no-repeat, linear-gradient(#000, #fff) repeat #123456'),
    ).toEqual({
      'background-image': 'url(top.png), linear-gradient(#000, #fff)',
      'background-repeat': 'no-repeat, repeat',
      'background-color': '#123456',
    });
  });

  it('carries !important onto every longhand', () => {
    expect(expandBackgroundShorthand('red !important')).toEqual({
      'background-color': 'red !important',
    });
  });

  it('handles one and two box keywords', () => {
    expect(expandBackgroundShorthand('red content-box')).toEqual({
      'background-origin': 'content-box',
      'background-clip': 'content-box',
      'background-color': 'red',
    });
    expect(expandBackgroundShorthand('red padding-box content-box')).toEqual({
      'background-origin': 'padding-box',
      'background-clip': 'content-box',
      'background-color': 'red',
    });
  });

  it('refuses anything it cannot classify with certainty, rather than guessing', () => {
    // A custom property could be a colour, a position or an image.
    expect(expandBackgroundShorthand('var(--brand)')).toBeNull();
    // Global keywords mean something different per longhand.
    expect(expandBackgroundShorthand('inherit')).toBeNull();
    // A colour is only legal on the final layer.
    expect(expandBackgroundShorthand('red, url(a.png)')).toBeNull();
    expect(expandBackgroundShorthand('wat')).toBeNull();
    expect(expandBackgroundShorthand('')).toBeNull();
  });
});

describe('expandBackgroundShorthandInRule', () => {
  it('replaces the shorthand in place, keeping the rest of the rule', () => {
    const { root, rule } = ruleOf('.a { color: red; background: url(x.png) no-repeat; margin: 0 }');
    expect(expandBackgroundShorthandInRule(rule)).toBe(true);
    expect(root.toString()).toContain('background-image: url(x.png)');
    expect(root.toString()).toContain('background-repeat: no-repeat');
    expect(root.toString()).toContain('color: red');
    expect(root.toString()).toContain('margin: 0');
    expect(root.toString()).not.toMatch(/background:/u);
  });

  it('writes out the resets the shorthand performed on longhands the rule also declares', () => {
    // `background: red` wipes the image the earlier declaration set; dropping
    // the shorthand without saying so would bring that image back.
    const { root, rule } = ruleOf('.a { background-image: url(old.png); background: red }');
    expandBackgroundShorthandInRule(rule);
    const css = root.toString();
    expect(css).toContain('background-image: none');
    expect(css).toContain('background-color: red');
  });

  it('leaves a shorthand it cannot parse exactly as the user wrote it', () => {
    const { root, rule } = ruleOf('.a { background: var(--brand) }');
    expect(expandBackgroundShorthandInRule(rule)).toBe(false);
    expect(root.toString()).toContain('background: var(--brand)');
  });
});

describe('the statistics block, end to end', () => {
  const STATS_CSS = '.ls-stats {\n  padding: 72px 24px;\n  background: linear-gradient(135deg, #6e56cf, #4f8fff);\n  color: #fff;\n}\n';

  function model() {
    return parseStyleSheet({
      id: 's1',
      origin: 'external',
      relPath: 'style.css',
      href: 'style.css',
      hostNodeId: null,
      media: null,
      css: STATS_CSS,
      writable: true,
      order: 1,
    });
  }

  it('shows the gradient in the panel instead of an empty background section', () => {
    const declarations = readDeclarations([model()], '.ls-stats', BASE);
    expect(declarations['background-image']).toBe('linear-gradient(135deg, #6e56cf, #4f8fff)');
  });

  it('lets a flat colour actually replace the gradient', () => {
    const sheet = model();
    // What the panel does: pick a colour, then set the layer to "Brak".
    applyDeclarations(sheet, '.ls-stats', BASE, { 'background-color': '#101010', 'background-image': null });

    const css = stringifyStyleSheet(sheet);
    expect(css).not.toContain('linear-gradient');
    expect(css).toContain('background-color: #101010');
    // Untouched declarations survive, as everywhere else in this module.
    expect(css).toContain('padding: 72px 24px');
    expect(css).toContain('color: #fff');
  });

  it('lets the background be made transparent', () => {
    const sheet = model();
    applyDeclarations(sheet, '.ls-stats', BASE, {
      'background-color': 'transparent',
      'background-image': null,
    });

    const declarations = readDeclarations([sheet], '.ls-stats', BASE);
    expect(declarations['background-color']).toBe('transparent');
    expect(declarations['background-image']).toBeUndefined();
  });

  it('does not touch the shorthand when the edit has nothing to do with backgrounds', () => {
    const sheet = model();
    applyDeclarations(sheet, '.ls-stats', BASE, { color: '#000' });
    expect(stringifyStyleSheet(sheet)).toContain('background: linear-gradient(135deg, #6e56cf, #4f8fff)');
  });
});
