import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/engine/htmlParser.js';
import { escapeAttribute, escapeText, generateHtml } from '@/engine/htmlGenerator.js';
import { getBody, textContent } from '@shared/document.js';
import { allFixtures, inlineEverything, messyGenerated, multipleStylesheets } from '../fixtures/pages.js';

/**
 * The generator's contract is "regenerate the page without changing what it
 * means". These tests pin down the two things that could silently break a
 * user's site: losing content, and altering whitespace-sensitive inline markup.
 */

function roundTrip(relPath: string, source: string, files: Record<string, string> = {}): string {
  const parsed = parseHtml(relPath, source, { files });
  return generateHtml(parsed.document);
}

describe('generateHtml - round-trip fidelity', () => {
  /**
   * Whitespace is normalised away before comparing. Re-indenting block-level
   * siblings legitimately adds newlines between them - `<h3>a</h3><p>b</p>`
   * renders identically either way, and Prettier reformats it the same. This
   * assertion is therefore about *characters not being lost or invented*;
   * whitespace that genuinely is significant, inside an inline run, is pinned
   * down by the dedicated tests in the next block.
   */
  it('never loses or invents text in any fixture', () => {
    for (const fixture of allFixtures) {
      const source = fixture.files[fixture.entry] ?? '';
      const parsed = parseHtml(fixture.entry, source, { files: fixture.files });
      const regenerated = generateHtml(parsed.document);
      const reparsed = parseHtml(fixture.entry, regenerated, { files: fixture.files });

      const dense = (root: Parameters<typeof textContent>[0]) => textContent(root).replace(/\s+/gu, '');
      expect(dense(reparsed.document.root), `${fixture.name} keeps its text`).toBe(
        dense(parsed.document.root),
      );
    }
  });

  it('is stable - a second round trip changes nothing', () => {
    for (const fixture of allFixtures) {
      const source = fixture.files[fixture.entry] ?? '';
      const once = roundTrip(fixture.entry, source, fixture.files);
      const twice = roundTrip(fixture.entry, once, fixture.files);
      expect(twice, `${fixture.name} is idempotent`).toBe(once);
    }
  });

  it('keeps the stylesheet and script wiring intact', () => {
    const source = multipleStylesheets.files['index.html'] ?? '';
    const output = roundTrip('index.html', source, multipleStylesheets.files);
    expect(output).toContain('href="https://cdn.example.com/reset.css"');
    expect(output).toContain('href="css/base.css"');
    expect(output).toContain('href="css/theme.css"');
    expect(output).toContain('src="js/app.js"');
  });
});

describe('generateHtml - whitespace safety', () => {
  it('does not insert whitespace between inline elements', () => {
    const output = roundTrip('index.html', '<p><b>a</b><i>b</i></p>');
    expect(output).toContain('<p><b>a</b><i>b</i></p>');
  });

  it('preserves a single significant space between inline elements', () => {
    const output = roundTrip('index.html', '<p><b>a</b> <i>b</i></p>');
    expect(output).toContain('<p><b>a</b> <i>b</i></p>');
  });

  it('keeps mixed text and markup on one line', () => {
    const output = roundTrip('index.html', '<p>© <a href="https://x.pl">x.pl</a> 2024-2026</p>');
    expect(output).toContain('<p>© <a href="https://x.pl">x.pl</a> 2024-2026</p>');
  });

  it('preserves <pre> content exactly', () => {
    const output = roundTrip('index.html', '<pre>  line one\n    line two\n</pre>');
    expect(output).toContain('<pre>  line one\n    line two\n</pre>');
  });

  it('re-indents block-only children', () => {
    const output = roundTrip('index.html', '<div><section></section><section></section></div>');
    expect(output).toMatch(/<div>\n\s+<section><\/section>\n\s+<section><\/section>\n\s+<\/div>/u);
  });
});

describe('generateHtml - raw text elements', () => {
  it('never escapes JavaScript operators', () => {
    const output = roundTrip('index.html', '<script>if (a && b && c < d) { e = "<x>"; }</script>');
    expect(output).toContain('a && b && c < d');
    expect(output).not.toContain('&amp;&amp;');
  });

  it('never escapes CSS', () => {
    const output = roundTrip('index.html', '<style>.a > .b { content: "<"; }</style>');
    expect(output).toContain('.a > .b');
    expect(output).not.toContain('&gt;');
  });

  it('keeps the embedded stylesheet of a single-file page', () => {
    const source = inlineEverything.files['index.html'] ?? '';
    const output = roundTrip('index.html', source, inlineEverything.files);
    expect(output).toContain('@media (max-width: 640px)');
    expect(output).toContain('.hero h1');
  });
});

describe('generateHtml - attributes', () => {
  it('emits boolean attributes bare', () => {
    const output = roundTrip(
      'index.html',
      '<input type="checkbox" checked><script defer src="a.js"></script>',
    );
    expect(output).toContain('checked');
    expect(output).not.toContain('checked=""');
    expect(output).toContain('defer');
  });

  it('normalises unquoted and single-quoted attributes to double quotes', () => {
    const output = roundTrip('index.html', "<div class=wrapper id='main'></div>");
    expect(output).toContain('class="wrapper"');
    expect(output).toContain('id="main"');
  });

  it('preserves data- and aria- attributes', () => {
    const output = roundTrip('index.html', '<div data-role="x" aria-label="Opis" tabindex="0"></div>');
    expect(output).toContain('data-role="x"');
    expect(output).toContain('aria-label="Opis"');
    expect(output).toContain('tabindex="0"');
  });

  it('writes void elements self-closed', () => {
    const output = roundTrip('index.html', '<br><hr><img src="a.png" alt="">');
    expect(output).toContain('<br />');
    expect(output).toContain('<hr />');
    expect(output).toContain('<img src="a.png" alt="" />');
  });
});

describe('generateHtml - doctype and line endings', () => {
  it('emits a modern doctype', () => {
    expect(roundTrip('index.html', '<!DOCTYPE html><html></html>')).toMatch(/^<!doctype html>/u);
  });

  it('omits the doctype when the source had none', () => {
    expect(roundTrip('index.html', '<div>a</div>')).not.toContain('doctype');
  });

  it('honours the source line ending', () => {
    const parsed = parseHtml('index.html', '<html>\r\n<body>\r\n<p>a</p>\r\n</body>\r\n</html>');
    const output = generateHtml(parsed.document);
    expect(output).toContain('\r\n');
  });
});

describe('escaping helpers', () => {
  it('escapes text content', () => {
    expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes attribute values without touching apostrophes', () => {
    expect(escapeAttribute('a "b" & c\'s')).toBe("a &quot;b&quot; &amp; c's");
  });

  it('makes non-breaking spaces visible', () => {
    expect(escapeAttribute('a b')).toBe('a&nbsp;b');
  });
});

describe('generateHtml - structural preservation', () => {
  it('keeps SVG markup usable', () => {
    const output = roundTrip(
      'index.html',
      '<svg viewBox="0 0 24 24" fill="none"><path d="M4 4 L20 20" stroke="currentColor"/></svg>',
    );
    expect(output).toContain('viewBox="0 0 24 24"');
    expect(output).toContain('d="M4 4 L20 20"');
  });

  it('keeps comments in place', () => {
    const source = messyGenerated.files['index.html'] ?? '';
    const output = roundTrip('index.html', source, messyGenerated.files);
    expect(output).toContain('<!-- Główne style -->');
  });

  it('keeps unused classes the author left behind', () => {
    const source = messyGenerated.files['index.html'] ?? '';
    const output = roundTrip('index.html', source, messyGenerated.files);
    expect(output).toContain('unused-legacy-class');
  });

  it('does not drop body attributes', () => {
    const parsed = parseHtml('index.html', messyGenerated.files['index.html'] ?? '');
    const body = getBody(parsed.document);
    expect(body?.attrs.find((attr) => attr.name === 'class')?.value).toBe('theme-dark');
  });
});
