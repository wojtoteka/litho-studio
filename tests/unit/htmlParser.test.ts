import { describe, expect, it } from 'vitest';
import { parseHtml, detectIndent, detectLineEnding, looksMinified } from '@/engine/htmlParser.js';
import { classifyElement, getAttr, getBody, textContent, walk } from '@shared/document.js';
import {
  allFixtures,
  fragmentPage,
  inlineEverything,
  messyGenerated,
  multipleStylesheets,
} from '../fixtures/pages.js';

/**
 * The parser is the module the "open any existing folder" promise rests on, so
 * these tests are organised by *how the page is organised*, not by API surface.
 */

function parseFixture(fixture: (typeof allFixtures)[number]) {
  const source = fixture.files[fixture.entry] ?? '';
  return parseHtml(fixture.entry, source, { files: fixture.files });
}

describe('parseHtml — structural agnosticism', () => {
  it('builds an editable tree for every fixture regardless of file layout', () => {
    for (const fixture of allFixtures) {
      const parsed = parseFixture(fixture);
      const body = getBody(parsed.document);
      expect(body, `${fixture.name} has a body`).not.toBeNull();
      expect(body?.children.length, `${fixture.name} has content`).toBeGreaterThan(0);
    }
  });

  it('normalises a bare fragment into html/head/body', () => {
    const parsed = parseFixture(fragmentPage);
    expect(parsed.document.root.tag).toBe('html');
    const body = getBody(parsed.document);
    const wrapper = body?.children.find((node) => node.kind === 'element');
    expect(wrapper?.kind).toBe('element');
    if (wrapper?.kind === 'element') {
      expect(getAttr(wrapper, 'class')).toBe('wrapper');
      // The unclosed <p> is closed by the HTML5 algorithm, yielding two siblings.
      const paragraphs = wrapper.children.filter((n) => n.kind === 'element' && n.tag === 'p');
      expect(paragraphs).toHaveLength(2);
    }
  });

  it('preserves comments and unknown attributes', () => {
    const parsed = parseFixture(messyGenerated);
    const comments = [...walk(parsed.document.root)].filter((node) => node.kind === 'comment');
    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(comments.some((c) => c.kind === 'comment' && c.value.includes('responsywne'))).toBe(true);
  });
});

describe('parseHtml — stylesheet discovery', () => {
  it('finds a single embedded <style> block', () => {
    const parsed = parseFixture(inlineEverything);
    expect(parsed.styles).toHaveLength(1);
    expect(parsed.styles[0]?.origin).toBe('embedded');
    expect(parsed.styles[0]?.writable).toBe(true);
    expect(parsed.styles[0]?.css).toContain('.hero');
  });

  it('finds several external sheets in cascade order and marks the CDN read-only', () => {
    const parsed = parseFixture(multipleStylesheets);
    expect(parsed.styles.map((style) => style.relPath)).toEqual([null, 'css/base.css', 'css/theme.css']);
    expect(parsed.styles[0]?.writable).toBe(false); // remote CDN
    expect(parsed.styles[1]?.writable).toBe(true);
    expect(parsed.styles[2]?.writable).toBe(true);
    expect(parsed.styles[2]?.media).toBe('screen');
    // Order must be ascending so "last writable wins" is meaningful.
    const orders = parsed.styles.map((style) => style.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('handles external and embedded CSS together, keeping document order', () => {
    const parsed = parseFixture(messyGenerated);
    expect(parsed.styles).toHaveLength(2);
    expect(parsed.styles[0]?.origin).toBe('external');
    expect(parsed.styles[0]?.relPath).toBe('styles/main.css');
    expect(parsed.styles[1]?.origin).toBe('embedded');
    expect(parsed.styles[1]?.css).toContain('max-width: 900px');
  });

  it('reports a missing stylesheet as a notice instead of failing', () => {
    const parsed = parseHtml('index.html', '<link rel="stylesheet" href="brak.css">', { files: {} });
    expect(parsed.styles).toHaveLength(1);
    expect(parsed.styles[0]?.writable).toBe(false);
    expect(parsed.notices.some((notice) => notice.message.includes('brak.css'))).toBe(true);
  });

  it('ignores non-stylesheet <link> elements', () => {
    const parsed = parseHtml(
      'index.html',
      '<link rel="icon" href="favicon.ico"><link rel="preload" href="a.css" as="style">',
      { files: {} },
    );
    expect(parsed.styles).toHaveLength(0);
  });
});

describe('parseHtml — script discovery', () => {
  it('finds an embedded script', () => {
    const parsed = parseFixture(inlineEverything);
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.origin).toBe('embedded');
    expect(parsed.scripts[0]?.code).toContain('addEventListener');
  });

  it('finds external scripts and resolves them against the page path', () => {
    const parsed = parseFixture(multipleStylesheets);
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.relPath).toBe('js/app.js');
    expect(parsed.scripts[0]?.code).toContain('sklep gotowy');
  });

  it('distinguishes module scripts and skips data blocks', () => {
    const parsed = parseHtml(
      'index.html',
      `<script type="module">export const a = 1;</script>
       <script type="application/json">{"a":1}</script>
       <script type="text/template"><div></div></script>`,
      { files: {} },
    );
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]?.isModule).toBe(true);
  });

  it('does not escape operators inside script bodies', () => {
    const parsed = parseHtml('index.html', '<script>if (a && b) { c = a < b; }</script>', { files: {} });
    expect(parsed.scripts[0]?.code).toContain('a && b');
    expect(parsed.scripts[0]?.code).toContain('a < b');
  });
});

describe('parseHtml — classification', () => {
  it('classifies elements without relying on editor-specific markers', () => {
    const parsed = parseHtml(
      'index.html',
      `<body>
        <h2>Tytuł</h2>
        <p>Tekst</p>
        <img src="a.png" alt="">
        <button>Klik</button>
        <a href="/x">Link</a>
        <input type="checkbox">
        <input type="email">
        <textarea></textarea>
        <section></section>
      </body>`,
      { files: {} },
    );
    const body = getBody(parsed.document);
    const kinds = (body?.children ?? [])
      .filter((node) => node.kind === 'element')
      .map((node) => (node.kind === 'element' ? classifyElement(node) : null));

    expect(kinds).toEqual([
      'heading',
      'text',
      'image',
      'button',
      'link',
      'checkbox',
      'input',
      'textarea',
      'container',
    ]);
  });
});

describe('source-style detection', () => {
  it('detects tab indentation', () => {
    expect(detectIndent('<html>\n\t<body>\n\t\t<p>a</p>\n\t</body>\n</html>')).toBe('\t');
  });

  it('detects the smallest space step', () => {
    expect(detectIndent('<html>\n  <body>\n    <p>a</p>\n  </body>\n</html>')).toBe('  ');
    expect(detectIndent('<html>\n    <body>\n        <p>a</p>\n    </body>\n</html>')).toBe('    ');
  });

  it('falls back to two spaces when there is nothing to learn from', () => {
    expect(detectIndent('<p>a</p>')).toBe('  ');
  });

  it('detects CRLF line endings', () => {
    expect(detectLineEnding('<p>a</p>\r\n<p>b</p>')).toBe('\r\n');
    expect(detectLineEnding('<p>a</p>\n<p>b</p>')).toBe('\n');
  });
});

describe('looksMinified', () => {
  it('leaves ordinary hand-written files writable', () => {
    const readable = `${'.a { color: red; }\n'.repeat(400)}`;
    expect(looksMinified(readable)).toBe(false);
  });

  it('flags a large single-line bundle as read-only', () => {
    expect(looksMinified(`.a{color:red}`.repeat(1000))).toBe(true);
  });

  it('never flags a short file', () => {
    expect(looksMinified('.a{color:red}')).toBe(false);
  });
});

describe('parseHtml — resilience', () => {
  it('produces a usable page for empty input', () => {
    const parsed = parseHtml('index.html', '', { files: {} });
    expect(parsed.document.root.tag).toBe('html');
    expect(getBody(parsed.document)).not.toBeNull();
  });

  it('keeps text content intact through parsing', () => {
    const parsed = parseFixture(inlineEverything);
    expect(textContent(parsed.document.root)).toContain('wojtoteka.ovh 2024–2026');
  });

  it('assigns a unique id to every node', () => {
    const parsed = parseFixture(multipleStylesheets);
    const ids = [...walk(parsed.document.root)].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
