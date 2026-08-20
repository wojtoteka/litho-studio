import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/engine/htmlParser.js';
import { generateHtml } from '@/engine/htmlGenerator.js';
import {
  availableTextActions,
  convertToLinkAction,
  dynamicYearAction,
  getPlainText,
  guessHref,
  isRichTextHost,
  parseYearSelection,
  spliceRange,
  TEXT_ACTIONS,
  type TextActionContext,
} from '@/engine/richTextEditor.js';
import {
  parseManagedScript,
  renderManagedScript,
  REGION_END,
  REGION_START,
  upsertSnippet,
} from '@/engine/jsGenerator.js';
import { findFirstTag, type ElementNode } from '@shared/document.js';

/**
 * Partial rich-text editing — the headline feature. The tests below follow the
 * two worked examples from the specification, then cover the surrounding edge
 * cases that would produce broken HTML if handled naively.
 */

function elementFrom(html: string, tag: string): ElementNode {
  const parsed = parseHtml('index.html', `<body>${html}</body>`);
  const found = findFirstTag(parsed.document.root, tag);
  if (!found) throw new Error(`fixture has no <${tag}>`);
  return found;
}

function contextFor(element: ElementNode, fragment: string): TextActionContext {
  const text = getPlainText(element);
  const start = text.indexOf(fragment);
  if (start === -1) throw new Error(`fragment "${fragment}" not found in "${text}"`);
  const used = new Set<string>();
  return {
    element,
    range: { start, end: start + fragment.length },
    selectedText: fragment,
    allocateDocumentId: (base) => {
      let candidate = base;
      let index = 2;
      while (used.has(candidate)) candidate = `${base}-${index++}`;
      used.add(candidate);
      return candidate;
    },
  };
}

/** Serialises just the element, so assertions read like the resulting markup. */
function renderElement(element: ElementNode): string {
  const parsed = parseHtml('index.html', '<body></body>');
  const body = findFirstTag(parsed.document.root, 'body');
  if (!body) throw new Error('no body');
  body.children = [element];
  return generateHtml(parsed.document);
}

/* ------------------------------------------------------------------ */

describe('plain-text projection', () => {
  it('flattens inline markup into the string the user sees', () => {
    const element = elementFrom('<p>© <b>wojtoteka</b>.ovh 2024–2026</p>', 'p');
    expect(getPlainText(element)).toBe('© wojtoteka.ovh 2024–2026');
  });

  it('recognises elements that can host rich text', () => {
    expect(isRichTextHost(elementFrom('<p>a <em>b</em></p>', 'p'))).toBe(true);
    expect(isRichTextHost(elementFrom('<div><section>a</section></div>', 'div'))).toBe(false);
  });
});

describe('spliceRange', () => {
  it('splits a plain text node into three parts', () => {
    const element = elementFrom('<p>abcdef</p>', 'p');
    const { before, selected, after } = spliceRange(element, { start: 2, end: 4 });
    expect(before.map(textOf)).toEqual(['ab']);
    expect(selected.map(textOf)).toEqual(['cd']);
    expect(after.map(textOf)).toEqual(['ef']);
  });

  it('keeps a fully contained inline element intact', () => {
    const element = elementFrom('<p>a<b>bc</b>d</p>', 'p');
    const { selected } = spliceRange(element, { start: 1, end: 3 });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.kind).toBe('element');
  });

  it('splits an inline element that straddles the selection boundary', () => {
    const element = elementFrom('<p><b>abcd</b></p>', 'p');
    const { before, selected, after } = spliceRange(element, { start: 1, end: 3 });
    // Each part keeps its own <b> wrapper so the bold styling survives.
    expect(before).toHaveLength(1);
    expect(selected).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(before[0]?.kind === 'element' && before[0].tag).toBe('b');
    expect(selected[0]?.kind === 'element' && selected[0].tag).toBe('b');
  });

  it('handles a selection covering the whole element', () => {
    const element = elementFrom('<p>abc</p>', 'p');
    const { before, selected, after } = spliceRange(element, { start: 0, end: 3 });
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(0);
    expect(selected.map(textOf)).toEqual(['abc']);
  });
});

/* ------------------------------------------------------------------ */

describe('action: zamień na link', () => {
  it('wraps only the selected fragment, exactly as specified', () => {
    const element = elementFrom('<p>© wojtoteka.ovh 2024–2026</p>', 'p');
    const context = contextFor(element, 'wojtoteka.ovh');
    const result = convertToLinkAction.apply(context, {
      href: 'https://wojtoteka.ovh',
      target: '',
      rel: '',
    });
    element.children = result.children;

    expect(renderElement(element)).toContain(
      '<p>© <a href="https://wojtoteka.ovh">wojtoteka.ovh</a> 2024–2026</p>',
    );
  });

  it('pre-fills the URL from the selected text', () => {
    const element = elementFrom('<p>Napisz na wojtoteka.ovh dzisiaj</p>', 'p');
    const context = contextFor(element, 'wojtoteka.ovh');
    expect(convertToLinkAction.defaultParams(context).href).toBe('https://wojtoteka.ovh');
  });

  it('adds rel="noopener noreferrer" whenever the link opens in a new tab', () => {
    const element = elementFrom('<p>zobacz stronę tutaj</p>', 'p');
    const result = convertToLinkAction.apply(contextFor(element, 'stronę'), {
      href: 'https://example.com',
      target: '_blank',
      rel: '',
    });
    element.children = result.children;
    const html = renderElement(element);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('preserves inline markup outside the selection', () => {
    const element = elementFrom('<p><strong>Ważne:</strong> odwiedź example.com teraz</p>', 'p');
    const result = convertToLinkAction.apply(contextFor(element, 'example.com'), {
      href: 'https://example.com',
      target: '',
      rel: '',
    });
    element.children = result.children;
    const html = renderElement(element);
    expect(html).toContain('<strong>Ważne:</strong>');
    expect(html).toContain('<a href="https://example.com">example.com</a>');
  });

  it('is unavailable inside an existing link, so anchors never nest', () => {
    const element = elementFrom('<p><a href="/x">tekst linku</a></p>', 'p');
    expect(convertToLinkAction.isAvailable(contextFor(element, 'linku'))).toBe(false);
  });

  it('is unavailable for an empty selection', () => {
    const element = elementFrom('<p>abc</p>', 'p');
    const context: TextActionContext = {
      element,
      range: { start: 1, end: 1 },
      selectedText: '',
      allocateDocumentId: (base) => base,
    };
    expect(convertToLinkAction.isAvailable(context)).toBe(false);
  });
});

describe('guessHref', () => {
  it('recognises bare domains, emails and full URLs', () => {
    expect(guessHref('wojtoteka.ovh')).toBe('https://wojtoteka.ovh');
    expect(guessHref('www.example.com')).toBe('https://example.com');
    expect(guessHref('https://already.pl/path')).toBe('https://already.pl/path');
    expect(guessHref('kontakt@example.com')).toBe('mailto:kontakt@example.com');
  });

  it('returns nothing for ordinary prose', () => {
    expect(guessHref('kliknij tutaj')).toBe('');
  });
});

/* ------------------------------------------------------------------ */

describe('action: zamień na dynamiczny skrypt (aktualny rok)', () => {
  it('replaces a "2024-aktualna data" placeholder with a span plus a script snippet', () => {
    const element = elementFrom(
      '<small>Copyright 2024-aktualna data, wszystkie prawa zastrzeżone.</small>',
      'small',
    );
    const context = contextFor(element, '2024-aktualna data');
    const params = dynamicYearAction.defaultParams(context);
    expect(params.startYear).toBe(2024);

    const result = dynamicYearAction.apply(context, params);
    element.children = result.children;
    const html = renderElement(element);

    expect(html).toContain(`<span id="${params.elementId}">`);
    // No hard-coded end year is left in the markup.
    expect(html).not.toContain('aktualna data');
    expect(result.scriptSnippets).toHaveLength(1);
    expect(result.scriptSnippets[0]?.code).toContain('new Date().getFullYear()');
    expect(result.scriptSnippets[0]?.code).toContain('2024');
  });

  it('emits only the current year when a bare year is selected', () => {
    const element = elementFrom('<p>© 2026</p>', 'p');
    const context = contextFor(element, '2026');
    const params = dynamicYearAction.defaultParams(context);
    expect(params.startYear).toBeNull();

    const result = dynamicYearAction.apply(context, params);
    expect(result.scriptSnippets[0]?.code).toContain('String(currentYear)');
    expect(result.scriptSnippets[0]?.code).not.toMatch(/"20\d\d–"/u);
  });

  it('leaves a no-JavaScript fallback in the HTML', () => {
    const element = elementFrom('<p>© 2024–2026</p>', 'p');
    const context = contextFor(element, '2024–2026');
    const result = dynamicYearAction.apply(context, dynamicYearAction.defaultParams(context));
    element.children = result.children;
    expect(renderElement(element)).toMatch(/<span id="[^"]+">2024–\d{4}<\/span>/u);
  });

  it('keeps the surrounding text untouched', () => {
    const element = elementFrom(
      '<small>Copyright 2024-aktualna data, wszystkie prawa zastrzeżone.</small>',
      'small',
    );
    const context = contextFor(element, '2024-aktualna data');
    const result = dynamicYearAction.apply(context, dynamicYearAction.defaultParams(context));
    element.children = result.children;
    const html = renderElement(element);
    expect(html).toContain('Copyright ');
    expect(html).toContain(', wszystkie prawa zastrzeżone.');
  });

  it('generates dependency-free, readable JavaScript', () => {
    const element = elementFrom('<p>2024–2026</p>', 'p');
    const context = contextFor(element, '2024–2026');
    const code = dynamicYearAction.apply(context, dynamicYearAction.defaultParams(context)).scriptSnippets[0]
      ?.code as string;

    expect(code).toContain('document.getElementById');
    expect(code).toContain('if (!element) return;');
    expect(code).not.toContain('import ');
    expect(code).not.toContain('require(');
  });
});

describe('parseYearSelection', () => {
  it.each([
    ['2024-aktualna data', 2024],
    ['2024–obecnie', 2024],
    ['2024–2026', 2024],
    ['2024 - 2026', 2024],
    ['od 2019 do teraz', 2019],
  ])('reads %s as a range starting in %i', (input, expected) => {
    expect(parseYearSelection(input).startYear).toBe(expected);
  });

  it.each(['2026', ' 2026 '])('reads a bare year %s as "current year only"', (input) => {
    expect(parseYearSelection(input).startYear).toBeNull();
  });

  it('keeps the separator the author typed', () => {
    expect(parseYearSelection('2024–2026').separator).toBe('–');
    expect(parseYearSelection('2024—2026').separator).toBe('—');
    expect(parseYearSelection('2024 - 2026').separator).toBe('-');
  });

  it('falls back to "current year only" when there is no year at all', () => {
    expect(parseYearSelection('aktualny rok').startYear).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('script snippet integration', () => {
  it('appends generated code in a marked region, below untouched user code', () => {
    const userCode = 'const nav = document.querySelector(".nav");\nnav.classList.add("ready");\n';
    const element = elementFrom('<p>© 2024–2026</p>', 'p');
    const context = contextFor(element, '2024–2026');
    const result = dynamicYearAction.apply(context, dynamicYearAction.defaultParams(context));

    let script = parseManagedScript(userCode);
    for (const snippet of result.scriptSnippets) script = upsertSnippet(script, snippet);
    const output = renderManagedScript(script);

    expect(output.startsWith(userCode.trim())).toBe(true);
    expect(output).toContain(REGION_START);
    expect(output).toContain(REGION_END);
    expect(output.indexOf('nav.classList')).toBeLessThan(output.indexOf(REGION_START));
  });

  it('does not duplicate code when the same action runs twice', () => {
    const element = elementFrom('<p>© 2024–2026</p>', 'p');
    const context = contextFor(element, '2024–2026');
    const params = dynamicYearAction.defaultParams(context);

    let script = parseManagedScript('// user code\n');
    for (let run = 0; run < 3; run += 1) {
      const result = dynamicYearAction.apply(context, params);
      for (const snippet of result.scriptSnippets) script = upsertSnippet(script, snippet);
    }

    const output = renderManagedScript(script);
    expect(script.snippets).toHaveLength(1);
    expect(output.split('document.getElementById')).toHaveLength(2);
  });

  it('round-trips: rendering then reparsing yields the same snippets', () => {
    const element = elementFrom('<p>© 2024–2026</p>', 'p');
    const context = contextFor(element, '2024–2026');
    const result = dynamicYearAction.apply(context, dynamicYearAction.defaultParams(context));

    let script = parseManagedScript('const a = 1;\n');
    for (const snippet of result.scriptSnippets) script = upsertSnippet(script, snippet);

    const reparsed = parseManagedScript(renderManagedScript(script));
    expect(reparsed.snippets.map((s) => s.id)).toEqual(script.snippets.map((s) => s.id));
    expect(reparsed.prefix.trim()).toBe('const a = 1;');
  });
});

/* ------------------------------------------------------------------ */

describe('action registry', () => {
  it('exposes both built-in actions', () => {
    expect(TEXT_ACTIONS.map((action) => action.id)).toEqual(['convert-to-link', 'dynamic-year']);
  });

  it('every action carries the metadata the context menu renders', () => {
    for (const action of TEXT_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.hint.length).toBeGreaterThan(0);
    }
  });

  it('filters the menu down to what applies to the selection', () => {
    const element = elementFrom('<p><a href="/x">rok 2024–2026 tutaj</a></p>', 'p');
    const ids = availableTextActions(contextFor(element, '2024–2026')).map((action) => action.id);
    // Inside a link: no nested anchor, but the year action still applies.
    expect(ids).toEqual(['dynamic-year']);
  });
});

function textOf(node: { kind: string; value?: string }): string {
  return node.kind === 'text' ? (node.value ?? '') : '';
}
