import { describe, expect, it } from 'vitest';
import {
  buildCanvasDocument,
  buildStatePreviewCss,
  CANVAS_STATE_PREVIEW_ELEMENT_ID,
} from '@/lib/canvasDocument.js';
import { parseHtml } from '@/engine/htmlParser.js';
import { parseStyleSheets } from '@/engine/cssGenerator.js';

/**
 * The "Stan" section writes `:hover`/`:focus`/`:active` rules correctly and used
 * to show nothing at all while doing it - the pointer is over the properties
 * panel, and `:focus`/`:active` cannot be reached from the canvas by any gesture
 * whatsoever. These pin the preview that makes the section visible.
 */

const PAGE = `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>S</title>
<link rel="stylesheet" href="style.css"></head>
<body><button class="przycisk">Kliknij</button></body></html>`;

describe('state preview stylesheet', () => {
  it('emits the declarations against the element\'s canvas id', () => {
    const css = buildStatePreviewCss('n7', { 'background-color': '#00ff00', color: '#fff' });
    expect(css).toContain('background-color: #00ff00;');
    expect(css).toContain('color: #fff;');
    expect(css).toContain('[data-litho-id="n7"]');
  });

  it('doubles the selector so it outranks the page\'s own class rules', () => {
    const css = buildStatePreviewCss('n7', { color: 'red' });
    expect(css.startsWith('[data-litho-id="n7"][data-litho-id="n7"] {')).toBe(true);
  });

  it('never resorts to !important, which would also beat the user\'s own', () => {
    const css = buildStatePreviewCss('n7', { color: 'red' });
    expect(css).not.toContain('!important');
  });

  it('is empty when the state declares nothing, so nothing is previewed', () => {
    expect(buildStatePreviewCss('n7', {})).toBe('');
    expect(buildStatePreviewCss('n7', { color: '   ' })).toBe('');
  });

  it('escapes a quote in the node id rather than breaking out of the selector', () => {
    expect(buildStatePreviewCss('n"7', { color: 'red' })).not.toContain('"7"]');
  });
});

describe('canvas document: state preview slot', () => {
  const build = (statePreviewCss?: string): string => {
    const files = { 'index.html': PAGE, 'style.css': '.przycisk { background: #6e56cf; }' };
    const parsed = parseHtml('index.html', PAGE, { files });
    return buildCanvasDocument({
      document: parsed.document,
      styleModels: parseStyleSheets(parsed.styles),
      statePreviewCss,
    });
  };

  it('always carries the slot, so a structural reload cannot drop the preview', () => {
    expect(build()).toContain(`<style id="${CANVAS_STATE_PREVIEW_ELEMENT_ID}">`);
  });

  it('bakes the preview into a freshly built document', () => {
    expect(build('[data-litho-id="n7"][data-litho-id="n7"] { color: red; }')).toContain('color: red;');
  });

  it('puts the slot last, so it wins ties against everything above it', () => {
    const html = build();
    expect(html.indexOf(CANVAS_STATE_PREVIEW_ELEMENT_ID)).toBeGreaterThan(html.indexOf('litho-canvas-css'));
  });
});
