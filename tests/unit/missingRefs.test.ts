import { describe, expect, it } from 'vitest';
import { findReferenceCandidates, parseHtml } from '@/engine/htmlParser.js';

/**
 * Broken local CSS/JS references: the page links a file that is not in the
 * project. The parser must report *what* is missing, *which element* carries
 * the reference, and *which existing files* plausibly are the intended target —
 * that structure is what the repair banner renders. Nothing is ever fixed
 * automatically; these tests pin down the detection contract.
 */

const PAGE_WITH_BROKEN_REFS = `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>Przeniesiona strona</title>
    <link rel="stylesheet" href="css/style.css" />
    <link rel="stylesheet" href="https://cdn.example.com/framework.css" />
  </head>
  <body>
    <h1>Treść</h1>
    <script src="js/app.js"></script>
  </body>
</html>
`;

describe('parseHtml — missing reference detection', () => {
  it('reports a missing stylesheet with the host element and ranked candidates', () => {
    const files = {
      'index.html': PAGE_WITH_BROKEN_REFS,
      'assets/style.css': 'body { margin: 0; }',
      'other.css': '.a { color: red; }',
    };
    const parsed = parseHtml('index.html', PAGE_WITH_BROKEN_REFS, { files });

    const cssRef = parsed.missingRefs.find((ref) => ref.kind === 'css');
    expect(cssRef).toBeDefined();
    expect(cssRef?.href).toBe('css/style.css');
    expect(cssRef?.resolvedTarget).toBe('css/style.css');
    // Same file name beats same extension.
    expect(cssRef?.candidates[0]).toBe('assets/style.css');
    expect(cssRef?.candidates).toContain('other.css');

    // The host node id must point at the actual <link> element.
    expect(cssRef?.hostNodeId).toBeTruthy();
  });

  it('reports a missing script and never flags remote URLs', () => {
    const files = { 'index.html': PAGE_WITH_BROKEN_REFS, 'scripts/app.js': '// kod' };
    const parsed = parseHtml('index.html', PAGE_WITH_BROKEN_REFS, { files });

    const jsRef = parsed.missingRefs.find((ref) => ref.kind === 'js');
    expect(jsRef?.href).toBe('js/app.js');
    expect(jsRef?.candidates).toEqual(['scripts/app.js']);

    // The CDN stylesheet resolves to null (not project-local) — not "missing".
    const remote = parsed.missingRefs.filter((ref) => ref.href.startsWith('https://'));
    expect(remote).toHaveLength(0);
  });

  it('resolves a reference that only differs by case, without flagging it as missing', () => {
    const page = `<!doctype html>
<html><head><link rel="stylesheet" href="css/Style.CSS" /></head>
<body><script src="JS/App.js"></script></body></html>`;
    const files = {
      'index.html': page,
      'css/style.css': 'body { margin: 0; }',
      'js/app.js': '// kod',
    };
    const parsed = parseHtml('index.html', page, { files });

    expect(parsed.missingRefs).toHaveLength(0);
    const style = parsed.styles.find((s) => s.origin === 'external');
    expect(style?.relPath).toBe('css/style.css');
    expect(style?.css).toBe('body { margin: 0; }');
    expect(style?.writable).toBe(true);

    const script = parsed.scripts.find((s) => s.origin === 'external');
    expect(script?.relPath).toBe('js/app.js');
    expect(script?.code).toBe('// kod');
  });

  it('reports nothing when every reference resolves', () => {
    const files = {
      'index.html': PAGE_WITH_BROKEN_REFS,
      'css/style.css': 'body { margin: 0; }',
      'js/app.js': '// kod',
    };
    const parsed = parseHtml('index.html', PAGE_WITH_BROKEN_REFS, { files });
    expect(parsed.missingRefs).toHaveLength(0);
  });
});

describe('findReferenceCandidates', () => {
  const files = {
    'index.html': '<html></html>',
    'css/main.css': '',
    'style/main.css': '',
    'assets/Main.css': '',
    'theme.css': '',
    'js/main.js': '',
    'app.mjs': '',
    'vendor/lib.js': '',
  };

  it('ranks exact basename matches first (case-insensitive), then same stem, then same type', () => {
    const candidates = findReferenceCandidates(files, 'dist/main.css', 'css');
    expect(candidates.slice(0, 3).sort()).toEqual(['assets/Main.css', 'css/main.css', 'style/main.css']);
    expect(candidates).toContain('theme.css');
    expect(candidates).not.toContain('js/main.js');
    expect(candidates).not.toContain('index.html');
  });

  it('offers both .js and .mjs files for a script reference', () => {
    const candidates = findReferenceCandidates(files, 'build/app.js', 'js');
    expect(candidates).toContain('js/main.js');
    expect(candidates).toContain('app.mjs');
    expect(candidates).toContain('vendor/lib.js');
    expect(candidates).not.toContain('css/main.css');
    // `app.mjs` shares the stem with the missing `app.js`, so it outranks
    // files that merely share the extension.
    expect(candidates[0]).toBe('app.mjs');
  });

  it('never proposes the missing path itself', () => {
    const candidates = findReferenceCandidates({ ...files, 'dist/main.css': '' }, 'dist/main.css', 'css');
    expect(candidates).not.toContain('dist/main.css');
  });
});
