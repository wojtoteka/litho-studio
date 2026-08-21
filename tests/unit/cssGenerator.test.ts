import { describe, expect, it } from 'vitest';
import {
  applyDeclarations,
  chooseStyleTarget,
  clearRule,
  countClasses,
  parseStyleSheet,
  parseStyleSheets,
  planSelector,
  readDeclarations,
  renameSelector,
  splitSelectorList,
  stringifyStyleSheet,
  type StyleSheetModel,
} from '@/engine/cssGenerator.js';
import { ClassNameAllocator } from '@/engine/idAllocator.js';
import { parseHtml } from '@/engine/htmlParser.js';
import { DEFAULT_BREAKPOINTS, type Breakpoint, type StyleSource } from '@shared/project.js';
import { findFirstTag, getAttr } from '@shared/document.js';
import { multipleStylesheets } from '../fixtures/pages.js';

const [desktop, tablet, mobile] = DEFAULT_BREAKPOINTS as [Breakpoint, Breakpoint, Breakpoint];

function sheet(css: string, overrides: Partial<StyleSource> = {}): StyleSheetModel {
  return parseStyleSheet({
    id: 'test',
    origin: 'external',
    relPath: 'style.css',
    href: 'style.css',
    hostNodeId: null,
    media: null,
    css,
    writable: true,
    order: 1,
    ...overrides,
  });
}

describe('applyDeclarations - base breakpoint', () => {
  it('creates a rule when the selector has none', () => {
    const model = sheet('body { margin: 0; }\n');
    applyDeclarations(model, '.hero', desktop, { color: 'red', 'font-size': '32px' });
    const output = stringifyStyleSheet(model);
    expect(output).toContain('.hero');
    expect(output).toContain('color: red');
    expect(output).toContain('font-size: 32px');
  });

  it('updates an existing declaration in place, keeping its position', () => {
    const model = sheet('.card {\n  border: 1px solid #ddd;\n  padding: 16px;\n  margin: 8px;\n}\n');
    applyDeclarations(model, '.card', desktop, { padding: '24px' });
    const output = stringifyStyleSheet(model);
    expect(output).toContain('padding: 24px');
    expect(output.indexOf('padding')).toBeLessThan(output.indexOf('margin'));
    expect(output).toContain('border: 1px solid #ddd');
  });

  it('removes a declaration when the value is null', () => {
    const model = sheet('.card { padding: 16px; color: red; }\n');
    applyDeclarations(model, '.card', desktop, { padding: null });
    const output = stringifyStyleSheet(model);
    expect(output).not.toContain('padding');
    expect(output).toContain('color: red');
  });

  it('removes the rule entirely once its last declaration goes', () => {
    const model = sheet('.card { padding: 16px; }\n.other { color: red; }\n');
    applyDeclarations(model, '.card', desktop, { padding: null });
    const output = stringifyStyleSheet(model);
    expect(output).not.toContain('.card');
    expect(output).toContain('.other');
  });

  it('handles !important without duplicating the keyword', () => {
    const model = sheet('');
    applyDeclarations(model, '.a', desktop, { color: 'red !important' });
    const output = stringifyStyleSheet(model);
    expect(output).toContain('color: red !important');
    expect(output).not.toContain('!important !important');
  });

  it('refuses to write to a read-only sheet', () => {
    const model = sheet('.a { color: red; }\n', { writable: false });
    applyDeclarations(model, '.a', desktop, { color: 'blue' });
    expect(stringifyStyleSheet(model)).toContain('color: red');
    expect(model.dirty).toBe(false);
  });
});

describe('applyDeclarations - preserving what the editor does not understand', () => {
  it('keeps comments, custom properties and @supports intact', () => {
    const original = `/* Motyw */
:root {
  --brand: #6e56cf;
}

@supports (display: grid) {
  .grid { display: grid; }
}

.card { padding: 16px; }
`;
    const model = sheet(original);
    applyDeclarations(model, '.card', desktop, { padding: '24px' });
    const output = stringifyStyleSheet(model);

    expect(output).toContain('/* Motyw */');
    expect(output).toContain('--brand: #6e56cf');
    expect(output).toContain('@supports (display: grid)');
    expect(output).toContain('padding: 24px');
  });

  it('keeps rule order unchanged', () => {
    const model = sheet('.a{color:red}\n.b{color:green}\n.c{color:blue}\n');
    applyDeclarations(model, '.b', desktop, { color: 'black' });
    const output = stringifyStyleSheet(model);
    expect(output.indexOf('.a')).toBeLessThan(output.indexOf('.b'));
    expect(output.indexOf('.b')).toBeLessThan(output.indexOf('.c'));
  });

  it('treats an unparsable stylesheet as read-only rather than failing', () => {
    const model = sheet('.a { color: red;'.repeat(1) + '\n@media {{{');
    if (model.parseError !== null) {
      expect(model.source.writable).toBe(false);
    }
    // Either way, the app must still have a usable model.
    expect(typeof stringifyStyleSheet(model)).toBe('string');
  });
});

describe('applyDeclarations - breakpoints and media queries', () => {
  it('creates a real @media block for a responsive value', () => {
    const model = sheet('.hero { font-size: 48px; }\n');
    applyDeclarations(model, '.hero', mobile, { 'font-size': '28px' });
    const output = stringifyStyleSheet(model);
    expect(output).toContain('@media (max-width: 640px)');
    expect(output).toContain('font-size: 28px');
  });

  it('reuses an existing media block written by hand, whatever its spacing', () => {
    const model = sheet('@media(max-width:640px){.a{color:red}}\n');
    applyDeclarations(model, '.b', mobile, { color: 'blue' });
    const output = stringifyStyleSheet(model);
    expect(output.match(/@media/gu)).toHaveLength(1);
    expect(output).toContain('.b');
  });

  it('keeps base rules above media blocks so the cascade still works', () => {
    const model = sheet('');
    applyDeclarations(model, '.a', mobile, { color: 'blue' });
    applyDeclarations(model, '.a', desktop, { color: 'red' });
    const output = stringifyStyleSheet(model);
    expect(output.indexOf('color: red')).toBeLessThan(output.indexOf('@media'));
  });

  it('orders media blocks widest-first', () => {
    const model = sheet('');
    applyDeclarations(model, '.a', mobile, { color: 'blue' });
    applyDeclarations(model, '.a', tablet, { color: 'green' });
    const output = stringifyStyleSheet(model);
    expect(output.indexOf('max-width: 1024px')).toBeLessThan(output.indexOf('max-width: 640px'));
  });

  it('reads back the value declared at each breakpoint separately', () => {
    const model = sheet('');
    applyDeclarations(model, '.hero', desktop, { 'font-size': '48px' });
    applyDeclarations(model, '.hero', mobile, { 'font-size': '28px' });

    expect(readDeclarations([model], '.hero', desktop)['font-size']).toBe('48px');
    expect(readDeclarations([model], '.hero', mobile)['font-size']).toBe('28px');
    expect(readDeclarations([model], '.hero', tablet)['font-size']).toBeUndefined();
  });

  it('drops an emptied media block', () => {
    const model = sheet('');
    applyDeclarations(model, '.a', mobile, { color: 'blue' });
    applyDeclarations(model, '.a', mobile, { color: null });
    expect(stringifyStyleSheet(model)).not.toContain('@media');
  });
});

describe('readDeclarations - cascade order', () => {
  it('lets a later sheet win over an earlier one', () => {
    const base = sheet('.a { color: red; }', { order: 1 });
    const theme = sheet('.a { color: blue; }', { order: 2, relPath: 'theme.css' });
    expect(readDeclarations([base, theme], '.a', desktop).color).toBe('blue');
  });
});

describe('chooseStyleTarget', () => {
  it('picks the last writable sheet, so new rules win the cascade', () => {
    const models = parseStyleSheets([
      {
        id: '1',
        origin: 'external',
        relPath: null,
        href: 'https://cdn/x.css',
        hostNodeId: null,
        media: null,
        css: '',
        writable: false,
        order: 1,
      },
      {
        id: '2',
        origin: 'external',
        relPath: 'base.css',
        href: 'base.css',
        hostNodeId: null,
        media: null,
        css: '',
        writable: true,
        order: 2,
      },
      {
        id: '3',
        origin: 'external',
        relPath: 'theme.css',
        href: 'theme.css',
        hostNodeId: null,
        media: null,
        css: '',
        writable: true,
        order: 3,
      },
    ]);
    expect(chooseStyleTarget(models)?.model.source.relPath).toBe('theme.css');
  });

  it('falls back to an embedded <style> when there is no external sheet', () => {
    const models = parseStyleSheets([
      {
        id: '1',
        origin: 'embedded',
        relPath: null,
        href: null,
        hostNodeId: 'n1',
        media: null,
        css: '.a{color:red}',
        writable: true,
        order: 1,
      },
    ]);
    expect(chooseStyleTarget(models)?.model.source.origin).toBe('embedded');
  });

  it('returns null when nothing is writable, so the caller creates a sheet', () => {
    const models = parseStyleSheets([
      {
        id: '1',
        origin: 'external',
        relPath: null,
        href: 'https://cdn/x.css',
        hostNodeId: null,
        media: null,
        css: '',
        writable: false,
        order: 1,
      },
    ]);
    expect(chooseStyleTarget(models)).toBeNull();
  });

  it('targets theme.css in the multi-stylesheet fixture', () => {
    const parsed = parseHtml('index.html', multipleStylesheets.files['index.html'] ?? '', {
      files: multipleStylesheets.files,
    });
    const models = parseStyleSheets(parsed.styles);
    expect(chooseStyleTarget(models)?.model.source.relPath).toBe('css/theme.css');
  });
});

describe('planSelector', () => {
  const parse = (html: string) => {
    const parsed = parseHtml('index.html', `<body>${html}</body>`);
    const body = findFirstTag(parsed.document.root, 'body');
    if (!body) throw new Error('no body');
    return { body, parsed };
  };

  it('prefers an existing id', () => {
    const { body } = parse('<section id="features"></section>');
    const element = body.children.find((n) => n.kind === 'element');
    if (element?.kind !== 'element') throw new Error('no element');
    const plan = planSelector(element, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
    });
    expect(plan).toEqual({ selector: '#features', addClass: null, addId: null });
  });

  it('reuses a class that is unique in the page', () => {
    const { body } = parse('<div class="hero"></div><div class="card"></div>');
    const element = body.children.find((n) => n.kind === 'element');
    if (element?.kind !== 'element') throw new Error('no element');
    const plan = planSelector(element, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
    });
    expect(plan).toEqual({ selector: '.hero', addClass: null, addId: null });
  });

  it('allocates a new id (not a class) when the existing one is shared', () => {
    const { body } = parse('<div class="card"></div><div class="card"></div>');
    const element = body.children.find((n) => n.kind === 'element');
    if (element?.kind !== 'element') throw new Error('no element');
    const plan = planSelector(element, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
      label: 'karta produktu',
    });
    // Styling one of two `.card` elements must not restyle both - and an id
    // (not a fresh single class) guarantees the new rule wins the cascade
    // even if some other rule targets `.card` with a compound selector.
    expect(plan.addClass).toBeNull();
    expect(plan.addId).toBe('karta-produktu');
    expect(plan.selector).toBe('#karta-produktu');
  });

  it("never styles through an icon-font class, even for the page's only icon", () => {
    const { body } = parse('<span class="material-symbols-outlined">home</span>');
    const element = body.children.find((n) => n.kind === 'element');
    if (element?.kind !== 'element') throw new Error('no element');
    const plan = planSelector(element, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
      label: 'ikona home',
    });
    // The class belongs to the icon library, not to this element: writing this
    // icon's own size into it would resize every icon added to the page later.
    expect(plan.selector).toBe('#ikona-home');
    expect(plan.addId).toBe('ikona-home');
  });

  it('never collides with a class or id the page already uses', () => {
    const { body } = parse('<div class="hero hero-2"></div><div class="hero"></div>');
    const element = body.children.find((n) => n.kind === 'element');
    if (element?.kind !== 'element') throw new Error('no element');
    const plan = planSelector(element, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
      label: 'hero',
    });
    expect(['hero', 'hero-2']).not.toContain(plan.addId);
  });

  it('ignores an id that is not a valid CSS identifier', () => {
    const { body } = parse('<div id="123 broken"></div>');
    const element = body.children.find((n) => n.kind === 'element');
    if (element?.kind !== 'element') throw new Error('no element');
    const plan = planSelector(element, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
    });
    expect(plan.selector.startsWith('#')).toBe(true);
    expect(plan.addId).not.toBeNull();
  });
});

describe('countClasses', () => {
  it('counts how many elements carry each class', () => {
    const parsed = parseHtml('index.html', '<body><i class="a b"></i><i class="a"></i></body>');
    const body = findFirstTag(parsed.document.root, 'body');
    if (!body) throw new Error('no body');
    const counts = countClasses(body);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });
});

describe('renameSelector and clearRule', () => {
  it('renames a selector everywhere, including inside media queries', () => {
    const model = sheet('.old { color: red; }\n@media (max-width: 640px) { .old { color: blue; } }\n');
    renameSelector(model, '.old', '.new');
    const output = stringifyStyleSheet(model);
    expect(output).not.toContain('.old');
    expect(output.match(/\.new/gu)).toHaveLength(2);
  });

  it('only renames exact matches in a selector list', () => {
    const model = sheet('.a, .ab { color: red; }\n');
    renameSelector(model, '.a', '.z');
    expect(stringifyStyleSheet(model)).toContain('.ab');
    expect(stringifyStyleSheet(model)).toContain('.z');
  });

  it('clears a rule at one breakpoint only', () => {
    const model = sheet('');
    applyDeclarations(model, '.a', desktop, { color: 'red' });
    applyDeclarations(model, '.a', mobile, { color: 'blue' });
    clearRule(model, '.a', mobile);
    const output = stringifyStyleSheet(model);
    expect(output).toContain('color: red');
    expect(output).not.toContain('@media');
  });
});

describe('splitSelectorList', () => {
  it('splits on top-level commas', () => {
    expect(splitSelectorList('.a, .b , .c')).toEqual(['.a', '.b', '.c']);
  });

  it('does not split inside :is() or attribute values', () => {
    expect(splitSelectorList(':is(.a, .b), .c')).toEqual([':is(.a, .b)', '.c']);
    expect(splitSelectorList('[data-x="a,b"], .c')).toEqual(['[data-x="a,b"]', '.c']);
  });
});

describe('integration with a real project', () => {
  it('edits theme.css without disturbing base.css or the CDN link', () => {
    const parsed = parseHtml('index.html', multipleStylesheets.files['index.html'] ?? '', {
      files: multipleStylesheets.files,
    });
    const models = parseStyleSheets(parsed.styles);
    const target = chooseStyleTarget(models);
    expect(target).not.toBeNull();

    applyDeclarations(target!.model, '.card', mobile, { padding: '4px' });

    const themeOutput = stringifyStyleSheet(target!.model);
    expect(themeOutput).toContain('padding: 4px');
    // The hand-written media block is reused rather than duplicated.
    expect(themeOutput.match(/@media/gu)).toHaveLength(1);

    const baseModel = models.find((model) => model.source.relPath === 'css/base.css');
    expect(baseModel?.dirty).toBe(false);
    expect(models[0]?.dirty).toBe(false);
  });

  it('keeps the styling hook the page already used', () => {
    const parsed = parseHtml('index.html', multipleStylesheets.files['index.html'] ?? '', {
      files: multipleStylesheets.files,
    });
    const body = findFirstTag(parsed.document.root, 'body');
    const header = findFirstTag(parsed.document.root, 'header');
    if (!body || !header) throw new Error('fixture changed');

    const plan = planSelector(header, {
      allocator: new ClassNameAllocator([body]),
      classCounts: countClasses(body),
    });
    expect(plan.selector).toBe('#top');
    expect(getAttr(header, 'id')).toBe('top');
  });
});
