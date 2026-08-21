import { describe, expect, it } from 'vitest';
import { buildCanvasDocument, isSelectableTag, toAssetBaseUrl, toAssetUrl } from '@/lib/canvasDocument.js';
import { parseHtml } from '@/engine/htmlParser.js';
import { parseStyleSheets } from '@/engine/cssGenerator.js';

/**
 * The canvas document is the page as rendered inside the editing iframe. The
 * contract: scripts never survive, project-local stylesheet links are replaced
 * by the injected in-memory CSS, remote (CDN) stylesheet links survive so the
 * page renders with its framework, and every element carries `data-litho-id`.
 */

const PAGE = `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>Strona</title>
    <link rel="stylesheet" href="https://cdn.example.com/bootstrap.min.css" />
    <link rel="stylesheet" href="style.css" />
    <link rel="icon" href="favicon.ico" />
  </head>
  <body>
    <div class="hero"><h1>Tytuł</h1></div>
    <div class="pusty-kontener"></div>
    <script src="script.js"></script>
    <script>console.log("inline");</script>
  </body>
</html>
`;

function build() {
  const files = { 'index.html': PAGE, 'style.css': '.hero { padding: 40px; }', 'script.js': '// kod' };
  const parsed = parseHtml('index.html', PAGE, { files });
  const styleModels = parseStyleSheets(parsed.styles);
  return buildCanvasDocument({
    document: parsed.document,
    styleModels,
  });
}

describe('buildCanvasDocument', () => {
  it('drops every script but keeps the page content annotated with node ids', () => {
    const html = build();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('console.log');
    expect(html).toContain('data-litho-id=');
    expect(html).toContain('Tytuł');
  });

  it('keeps remote stylesheet links and drops project-local ones', () => {
    const html = build();
    expect(html).toContain('https://cdn.example.com/bootstrap.min.css');
    // The local sheet is injected from the model instead of linked.
    expect(html).not.toContain('href="style.css"');
    expect(html).toContain('.hero { padding: 40px; }');
    // Non-stylesheet links survive untouched.
    expect(html).toContain('favicon.ico');
  });

  it('injects a litho-asset:// base pointing at the page directory', () => {
    const html = build();
    expect(html).toContain('<base href="litho-asset://project/"');
  });

  it('marks empty containers as drop targets, but never containers with content', () => {
    const html = build();
    expect(html).toMatch(/class="pusty-kontener"[^>]*data-litho-empty="true"/u);
    expect(html).not.toMatch(/class="hero"[^>]*data-litho-empty/u);
  });
});

describe('toAssetBaseUrl', () => {
  it('points at the project root for a top-level page', () => {
    expect(toAssetBaseUrl('index.html')).toBe('litho-asset://project/');
  });

  it('resolves against the page directory for nested pages', () => {
    expect(toAssetBaseUrl('pages/o-nas.html')).toBe('litho-asset://project/pages/');
  });
});

describe('toAssetUrl', () => {
  it('percent-encodes segments that would break an attribute', () => {
    expect(toAssetUrl('assets/moje zdjęcie.png')).toBe(
      'litho-asset://project/assets/moje%20zdj%C4%99cie.png',
    );
  });
});

describe('isSelectableTag', () => {
  it('rejects structural and non-visual tags, accepts content tags', () => {
    for (const tag of ['html', 'body', 'script', 'style', 'link', 'meta', 'head', 'title']) {
      expect(isSelectableTag(tag), tag).toBe(false);
    }
    for (const tag of ['div', 'h1', 'p', 'img', 'button', 'section']) {
      expect(isSelectableTag(tag), tag).toBe(true);
    }
  });
});

/**
 * Inline handlers are script, and the canvas runs no script. They could never
 * execute anyway (the frame is sandboxed without `allow-scripts`), but leaving
 * them in made Chromium log "Blocked script execution in 'about:srcdoc'" once
 * per handler on every rebuild - pages of warnings about a defence working.
 */
describe('inline scripting on the canvas', () => {
  const HANDLERS = `<!doctype html>
<html lang="pl">
  <body>
    <button onclick="alert('nie')" onmouseover="track()" class="cta">Kliknij</button>
    <a href="javascript:void(0)">Pseudo-link</a>
    <a href="o-nas.html">Prawdziwy link</a>
    <img src="foto.png" onerror="fallback()" alt="Zdjęcie" />
  </body>
</html>
`;

  function buildHandlers(): string {
    const parsed = parseHtml('index.html', HANDLERS, { files: { 'index.html': HANDLERS } });
    return buildCanvasDocument({ document: parsed.document, styleModels: parseStyleSheets(parsed.styles) });
  }

  it('strips every inline event handler', () => {
    const html = buildHandlers();
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('onerror');
  });

  it('neutralises javascript: URLs but leaves real links alone', () => {
    const html = buildHandlers();
    expect(html).not.toContain('javascript:');
    expect(html).toContain('o-nas.html');
  });

  it('keeps the non-scripting attributes of the same elements', () => {
    const html = buildHandlers();
    expect(html).toContain('class="cta"');
    expect(html).toContain('alt="Zdjęcie"');
    expect(html).toContain('foto.png');
  });
});

/**
 * The editing surface holds animations at their end state: a page whose content
 * fades and slides in replayed that entrance on every canvas rebuild, under the
 * pointer trying to click it, and an infinite animation never stopped at all.
 * The page's own CSS is untouched - this lives in the canvas-only overlay, and
 * the live preview still plays everything.
 */
describe('canvas document: motion', () => {
  it('runs animations out instantly and holds the final frame', () => {
    const html = build();
    expect(html).toContain('animation-duration: 1ms !important');
    expect(html).toContain('animation-iteration-count: 1 !important');
    expect(html).toContain('animation-fill-mode: forwards !important');
  });

  it('removes transition delay and duration, so the canvas never lags a change', () => {
    const html = build();
    expect(html).toContain('transition-duration: 0s !important');
    expect(html).toContain('transition-delay: 0s !important');
  });

  it('leaves the project\'s own stylesheet alone', () => {
    const files = { 'index.html': PAGE, 'style.css': '.hero { animation: fade 2s infinite; }' };
    const parsed = parseHtml('index.html', PAGE, { files });
    const styleModels = parseStyleSheets(parsed.styles);
    buildCanvasDocument({ document: parsed.document, styleModels });
    expect(styleModels.some((model) => model.dirty)).toBe(false);
  });
});
