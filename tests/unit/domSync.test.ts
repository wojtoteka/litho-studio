import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/engine/htmlParser.js';
import {
  applySnippets,
  collectWrites,
  embeddedScriptKey,
  ensureScript,
  ensureStyleSheet,
  findScriptTarget,
  reconcileNodeIds,
} from '@/engine/domSync.js';
import { applyDeclarations, parseStyleSheets } from '@/engine/cssGenerator.js';
import { buildDynamicYearSnippet, parseManagedScript, renderManagedScript } from '@/engine/jsGenerator.js';
import { DEFAULT_BREAKPOINTS, type Breakpoint } from '@shared/project.js';
import { findFirstTag, getAttr, walk } from '@shared/document.js';
import { fragmentPage, inlineEverything, multipleStylesheets } from '../fixtures/pages.js';

const [desktop, , mobile] = DEFAULT_BREAKPOINTS as [Breakpoint, Breakpoint, Breakpoint];

function parseFixture(fixture: typeof inlineEverything) {
  return parseHtml(fixture.entry, fixture.files[fixture.entry] ?? '', { files: fixture.files });
}

describe('reconcileNodeIds - surviving an external edit', () => {
  it('keeps ids stable when the file is re-parsed unchanged', () => {
    const source = multipleStylesheets.files['index.html'] ?? '';
    const first = parseHtml('index.html', source);
    const second = parseHtml('index.html', source);

    reconcileNodeIds(first.document.root, second.document.root);

    const idsOf = (root: typeof first.document.root) =>
      [...walk(root)].filter((n) => n.kind === 'element').map((n) => n.id);
    expect(idsOf(second.document.root)).toEqual(idsOf(first.document.root));
  });

  it('keeps the id of an element whose text changed in VS Code', () => {
    const before = parseHtml('index.html', '<body><h1 id="t">Stary tytuł</h1><p class="x">a</p></body>');
    const after = parseHtml('index.html', '<body><h1 id="t">Nowy tytuł</h1><p class="x">a</p></body>');

    reconcileNodeIds(before.document.root, after.document.root);

    const beforeHeading = findFirstTag(before.document.root, 'h1');
    const afterHeading = findFirstTag(after.document.root, 'h1');
    expect(afterHeading?.id).toBe(beforeHeading?.id);
  });

  it('matches by id or class even when siblings are reordered', () => {
    const before = parseHtml('index.html', '<body><div class="a"></div><div class="b"></div></body>');
    const after = parseHtml('index.html', '<body><div class="b"></div><div class="a"></div></body>');

    const idFor = (parsed: typeof before, className: string) => {
      const body = findFirstTag(parsed.document.root, 'body');
      const match = body?.children.find((n) => n.kind === 'element' && getAttr(n, 'class') === className);
      return match?.id;
    };
    const beforeA = idFor(before, 'a');

    reconcileNodeIds(before.document.root, after.document.root);
    expect(idFor(after, 'a')).toBe(beforeA);
  });

  it('gives a genuinely new element a fresh id rather than stealing one', () => {
    const before = parseHtml('index.html', '<body><p class="a">a</p></body>');
    const after = parseHtml('index.html', '<body><p class="a">a</p><p class="new">b</p></body>');

    reconcileNodeIds(before.document.root, after.document.root);

    const body = findFirstTag(after.document.root, 'body');
    const ids = (body?.children ?? []).filter((n) => n.kind === 'element').map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ensureStyleSheet - adapting to the project layout', () => {
  it('targets the existing writable external sheet without creating a file', () => {
    const parsed = parseFixture(multipleStylesheets);
    const result = ensureStyleSheet(parsed.document, parsed.styles);
    expect(result).toEqual({ relPath: 'css/theme.css', created: false, initialContent: null });
  });

  it('leaves a single-file page single-file', () => {
    const parsed = parseFixture(inlineEverything);
    const result = ensureStyleSheet(parsed.document, parsed.styles);
    expect(result.created).toBe(false);
    // No <link> was added - the page still has exactly one <style> and no <link>.
    const links = [...walk(parsed.document.root)].filter((n) => n.kind === 'element' && n.tag === 'link');
    expect(links).toHaveLength(0);
  });

  it('creates style.css and links it when the page has no stylesheet at all', () => {
    const parsed = parseFixture(fragmentPage);
    const result = ensureStyleSheet(parsed.document, parsed.styles);

    expect(result.created).toBe(true);
    expect(result.relPath).toBe('style.css');
    expect(result.initialContent).toContain('/*');

    const head = findFirstTag(parsed.document.root, 'head');
    const link = head?.children.find((n) => n.kind === 'element' && n.tag === 'link');
    expect(link?.kind).toBe('element');
    if (link?.kind === 'element') expect(getAttr(link, 'href')).toBe('style.css');
  });

  it('writes the link relative to a page in a subdirectory', () => {
    const parsed = parseHtml('pages/about.html', '<html><head></head><body></body></html>');
    const result = ensureStyleSheet(parsed.document, []);
    expect(result.relPath).toBe('pages/style.css');
    const head = findFirstTag(parsed.document.root, 'head');
    const link = head?.children.find((n) => n.kind === 'element' && n.tag === 'link');
    if (link?.kind === 'element') expect(getAttr(link, 'href')).toBe('style.css');
  });
});

describe('ensureScript', () => {
  it('reuses the existing external script', () => {
    const parsed = parseFixture(multipleStylesheets);
    expect(ensureScript(parsed.document, parsed.scripts)).toEqual({
      relPath: 'js/app.js',
      created: false,
      initialContent: null,
    });
  });

  it('creates script.js at the end of body when the page has none', () => {
    const parsed = parseFixture(fragmentPage);
    const result = ensureScript(parsed.document, parsed.scripts);
    expect(result.relPath).toBe('script.js');
    expect(result.created).toBe(true);

    const body = findFirstTag(parsed.document.root, 'body');
    const last = body?.children[body.children.length - 1];
    expect(last?.kind === 'element' && last.tag).toBe('script');
  });

  it('reuses the page inline <script> instead of creating script.js', () => {
    const parsed = parseFixture(inlineEverything);
    const inlineSource = parsed.scripts.find((s) => s.origin === 'embedded');
    expect(inlineSource).toBeTruthy();

    const result = ensureScript(parsed.document, parsed.scripts);
    expect(result.created).toBe(false);
    expect(result.relPath).toBe(embeddedScriptKey(inlineSource!.hostNodeId!));
    expect(result.initialContent).toBe(inlineSource!.code);

    // No new <script src> was appended - the page still has exactly one <script>.
    const scripts = [...walk(parsed.document.root)].filter((n) => n.kind === 'element' && n.tag === 'script');
    expect(scripts).toHaveLength(1);
  });

  /**
   * `scriptSources` is only rebuilt when the page is re-parsed from disk, so
   * between two generated edits the `<script src>` created by the first one is
   * in the document but not in that list. Trusting the list alone made the
   * second edit append a duplicate tag to the page.
   */
  it('does not append a second <script> when it already created one this session', () => {
    const parsed = parseFixture(fragmentPage);

    const first = ensureScript(parsed.document, parsed.scripts);
    const second = ensureScript(parsed.document, parsed.scripts);

    expect(second.relPath).toBe(first.relPath);
    expect(second.created).toBe(false);

    const scripts = [...walk(parsed.document.root)].filter((n) => n.kind === 'element' && n.tag === 'script');
    expect(scripts).toHaveLength(1);
  });
});

describe('findScriptTarget - where generated code would go', () => {
  it('reports the page existing script without touching the document', () => {
    const parsed = parseFixture(multipleStylesheets);
    const before = JSON.stringify(parsed.document);

    expect(findScriptTarget(parsed.scripts)).toEqual({
      relPath: 'js/app.js',
      kind: 'external',
      initialContent: null,
    });
    expect(JSON.stringify(parsed.document)).toBe(before);
  });

  it('reports an inline <script> block as the target', () => {
    const parsed = parseFixture(inlineEverything);
    expect(findScriptTarget(parsed.scripts)?.kind).toBe('embedded');
  });

  it('reports nothing for a page with no usable script', () => {
    const parsed = parseFixture(fragmentPage);
    expect(findScriptTarget(parsed.scripts)).toBeNull();
  });
});

describe('collectWrites - model to disk', () => {
  it('writes a single file for a page that keeps everything inline', () => {
    const parsed = parseFixture(inlineEverything);
    const models = parseStyleSheets(parsed.styles);
    applyDeclarations(models[0]!, '.hero', mobile, { padding: '32px 12px' });

    const writes = collectWrites({ document: parsed.document, styleModels: models, scripts: new Map() });

    expect(writes.map((w) => w.relPath)).toEqual(['index.html']);
    const html = writes[0]?.content ?? '';
    expect(html).toContain('padding: 32px 12px');
    // The user's original CSS is still there.
    expect(html).toContain('.hero h1');
    expect(html).toContain('font-family: Arial');
  });

  it('writes the stylesheet and the page separately for a multi-file project', () => {
    const parsed = parseFixture(multipleStylesheets);
    const models = parseStyleSheets(parsed.styles);
    const theme = models.find((m) => m.source.relPath === 'css/theme.css');
    applyDeclarations(theme!, '.card', desktop, { padding: '32px' });

    const writes = collectWrites({ document: parsed.document, styleModels: models, scripts: new Map() });
    const paths = writes.map((w) => w.relPath).sort();

    expect(paths).toEqual(['css/theme.css', 'index.html']);
    // base.css was untouched, so it is not rewritten.
    expect(paths).not.toContain('css/base.css');
  });

  it('includes generated JavaScript and preserves user code above it', () => {
    const parsed = parseFixture(multipleStylesheets);
    const scripts = applySnippets(
      new Map(),
      'js/app.js',
      multipleStylesheets.files['js/app.js'] ?? '',
      [buildDynamicYearSnippet({ elementId: 'copyright-year', startYear: 2024 })],
      [],
    );

    const writes = collectWrites({
      document: parsed.document,
      styleModels: parseStyleSheets(parsed.styles),
      scripts,
    });

    const appJs = writes.find((w) => w.relPath === 'js/app.js')?.content ?? '';
    expect(appJs).toContain('sklep gotowy');
    expect(appJs.indexOf('sklep gotowy')).toBeLessThan(appJs.indexOf('Litho Studio'));
    expect(appJs).toContain('getFullYear');
  });

  it('writes generated JavaScript back into the inline <script>, not a new file', () => {
    const parsed = parseFixture(inlineEverything);
    const inlineSource = parsed.scripts.find((s) => s.origin === 'embedded')!;
    const key = embeddedScriptKey(inlineSource.hostNodeId!);
    const scripts = applySnippets(
      new Map(),
      key,
      inlineSource.code,
      [buildDynamicYearSnippet({ elementId: 'y', startYear: null })],
      [],
    );

    const writes = collectWrites({ document: parsed.document, styleModels: [], scripts });

    expect(writes.map((w) => w.relPath)).toEqual(['index.html']);
    const html = writes[0]?.content ?? '';
    expect(html).toContain('preventDefault');
    expect(html).toContain('getFullYear');
    expect(html).not.toContain('script.js');
  });

  it('emits one write per path even when a file is created and then updated', () => {
    const parsed = parseFixture(fragmentPage);
    const created = new Map([['style.css', '/* nowy */\n']]);
    const writes = collectWrites({
      document: parsed.document,
      styleModels: [],
      scripts: new Map(),
      createdFiles: created,
    });
    const paths = writes.map((w) => w.relPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('style.css');
    expect(paths).toContain('index.html');
  });
});

describe('applySnippets', () => {
  it('never modifies user code, only the managed region', () => {
    const userCode = 'window.addEventListener("load", () => console.info("gotowe"));\n';
    const scripts = applySnippets(
      new Map(),
      'script.js',
      userCode,
      [buildDynamicYearSnippet({ elementId: 'y', startYear: null })],
      [],
    );
    const output = renderManagedScript(scripts.get('script.js')!);
    expect(output).toContain('window.addEventListener');
    expect(parseManagedScript(output).prefix.trim()).toBe(userCode.trim());
  });

  it('removes a snippet and drops the region when nothing is left', () => {
    const withSnippet = applySnippets(
      new Map(),
      'script.js',
      'const a = 1;\n',
      [buildDynamicYearSnippet({ elementId: 'y', startYear: null })],
      [],
    );
    const cleared = applySnippets(withSnippet, 'script.js', '', [], ['dynamic-year:y']);
    const output = renderManagedScript(cleared.get('script.js')!);

    expect(output).not.toContain('Litho Studio');
    expect(output.trim()).toBe('const a = 1;');
  });
});
