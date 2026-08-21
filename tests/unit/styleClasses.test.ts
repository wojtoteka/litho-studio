import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDeclarations,
  diffDeclarations,
  ensureRule,
  listStyleClasses,
  parseDeclarationBlock,
  parseStyleSheet,
  removeSelectorRules,
  renameClassInSelectors,
  stringifyStyleSheet,
  type StyleSheetModel,
} from '@/engine/cssGenerator.js';
import { useEditorStore } from '@/state/editorStore.js';
import { getAttr, walk, type ElementNode } from '@shared/document.js';
import {
  DEFAULT_BREAKPOINTS,
  type Breakpoint,
  type ProjectSnapshot,
  type StyleSource,
} from '@shared/project.js';

/**
 * Reusable styles: a named class the user creates, fills with properties and
 * then assigns to elements. The engine half checks what lands in the CSS file;
 * the store half reproduces what the panels actually do.
 */

const [desktop, , mobile] = DEFAULT_BREAKPOINTS as [Breakpoint, Breakpoint, Breakpoint];

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

describe('ensureRule', () => {
  it('creates an empty rule so a style can exist before it has properties', () => {
    const model = sheet('body { margin: 0; }\n');
    expect(ensureRule(model, '.page-intro', desktop)).toBe(true);
    expect(stringifyStyleSheet(model)).toContain('.page-intro');
    expect(model.dirty).toBe(true);
  });

  it('leaves an existing rule alone', () => {
    const model = sheet('.page-intro { color: red; }\n');
    expect(ensureRule(model, '.page-intro', desktop)).toBe(false);
    expect(stringifyStyleSheet(model)).toContain('color: red');
  });

  it('refuses to touch a read-only sheet', () => {
    const model = sheet('', { writable: false });
    expect(ensureRule(model, '.page-intro', desktop)).toBe(false);
  });
});

describe('applyDeclarations - keepEmptyRule', () => {
  it('keeps a named style alive after its last property is cleared', () => {
    const model = sheet('.page-intro { color: red; }\n');
    applyDeclarations(model, '.page-intro', desktop, { color: null }, { keepEmptyRule: true });
    const output = stringifyStyleSheet(model);
    expect(output).toContain('.page-intro');
    expect(output).not.toContain('color');
  });

  it('still prunes when the caller does not ask to keep the rule', () => {
    const model = sheet('.page-intro { color: red; }\n');
    applyDeclarations(model, '.page-intro', desktop, { color: null });
    expect(stringifyStyleSheet(model)).not.toContain('.page-intro');
  });
});

describe('removeSelectorRules', () => {
  it('removes the rule at every breakpoint and cleans up the media block', () => {
    const model = sheet(
      '.intro { color: red; }\n.other { color: blue; }\n@media (max-width: 640px) {\n.intro { font-size: 12px; }\n}\n',
    );
    expect(removeSelectorRules(model, '.intro')).toBe(true);
    const output = stringifyStyleSheet(model);
    expect(output).not.toContain('.intro');
    expect(output).toContain('.other');
    expect(output).not.toContain('@media');
  });

  it('keeps the other selectors of a grouped rule', () => {
    const model = sheet('.intro, .lead { color: red; }\n');
    removeSelectorRules(model, '.intro');
    const output = stringifyStyleSheet(model);
    expect(output).toContain('.lead');
    expect(output).not.toContain('.intro');
    expect(output).toContain('color: red');
  });
});

describe('renameClassInSelectors', () => {
  it('renames the class inside compound and descendant selectors', () => {
    const model = sheet('.old { color: red; }\n.card .old.active { color: blue; }\n');
    expect(renameClassInSelectors(model, 'old', 'new-name')).toBe(true);
    const output = stringifyStyleSheet(model);
    expect(output).toContain('.new-name {');
    expect(output).toContain('.card .new-name.active');
    expect(output).not.toContain('.old');
  });

  it('does not rename a class whose name merely starts the same', () => {
    const model = sheet('.old-timer { color: red; }\n');
    renameClassInSelectors(model, 'old', 'new-name');
    expect(stringifyStyleSheet(model)).toContain('.old-timer');
  });

  it('leaves quoted attribute values alone', () => {
    const model = sheet('a[href=".old"] { color: red; }\n');
    renameClassInSelectors(model, 'old', 'new-name');
    expect(stringifyStyleSheet(model)).toContain('a[href=".old"]');
  });
});

describe('parseDeclarationBlock', () => {
  it('reads a full rule the way the raw-CSS box shows it', () => {
    expect(parseDeclarationBlock('.x {\n  color: red;\n  margin: 0;\n}')).toEqual({
      color: 'red',
      margin: '0',
    });
  });

  it('accepts a bare declaration list with no braces', () => {
    expect(parseDeclarationBlock('color: red; font-size: 18px')).toEqual({
      color: 'red',
      'font-size': '18px',
    });
  });

  it('preserves !important', () => {
    expect(parseDeclarationBlock('color: red !important')).toEqual({ color: 'red !important' });
  });

  it('rejects text that is not a plain declaration block', () => {
    expect(parseDeclarationBlock('.x { .nested { color: red } }')).toBeNull();
    expect(parseDeclarationBlock('color: red; @media screen {}')).toBeNull();
  });

  it('rejects unparseable garbage', () => {
    expect(parseDeclarationBlock('color: ;;; { { {')).toBeNull();
  });
});

describe('diffDeclarations', () => {
  it('sets changed and added, nulls removed', () => {
    expect(diffDeclarations({ color: 'red', margin: '0' }, { color: 'blue', padding: '8px' })).toEqual({
      color: 'blue',
      margin: null,
      padding: '8px',
    });
  });

  it('is empty when nothing changed', () => {
    expect(diffDeclarations({ color: 'red' }, { color: 'red' })).toEqual({});
  });
});

describe('listStyleClasses', () => {
  it('reports every class with the declarations of its own rule', () => {
    const model = sheet('.intro { color: red; font-size: 18px; }\n.card .title { color: blue; }\n');
    const classes = listStyleClasses([model], desktop);
    const intro = classes.find((entry) => entry.name === 'intro');
    expect(intro?.declarations).toEqual({ color: 'red', 'font-size': '18px' });
    expect(intro?.ownRule).toBe(true);
    // A class that only appears inside a compound selector is still listed -
    // it is a name the user can assign - but has no rule of its own.
    expect(classes.find((entry) => entry.name === 'title')?.ownRule).toBe(false);
  });

  it('reads the declarations of the requested breakpoint', () => {
    const model = sheet(
      '.intro { font-size: 18px; }\n@media (max-width: 640px) {\n.intro { font-size: 14px; }\n}\n',
    );
    expect(listStyleClasses([model], mobile)[0]?.declarations['font-size']).toBe('14px');
  });
});

/* ------------------------------------------------------------------ */
/* Store: what the panels actually do                                   */
/* ------------------------------------------------------------------ */

const HTML = `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>T</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Nagłówek</h1>
    <p>Wprowadzenie</p>
  </body>
</html>
`;

function snapshot(): ProjectSnapshot {
  return {
    project: { rootPath: '/x', name: 'x', pages: [{ relPath: 'index.html', title: 'T', isEntry: true }] },
    files: { 'index.html': HTML, 'style.css': 'body { margin: 0; }\n' },
    assets: [],
  };
}

async function loadPage(): Promise<void> {
  useEditorStore.getState().loadSnapshot(snapshot());
  // loadSnapshot kicks openPage off as a floating promise; let it settle.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function idOfTag(tag: string): string {
  const document = useEditorStore.getState().document!;
  for (const node of walk(document.root)) {
    if (node.kind === 'element' && node.tag === tag) return node.id;
  }
  throw new Error(`no <${tag}> in the page`);
}

function elementOfTag(tag: string): ElementNode {
  const document = useEditorStore.getState().document!;
  for (const node of walk(document.root)) {
    if (node.kind === 'element' && node.tag === tag) return node;
  }
  throw new Error(`no <${tag}> in the page`);
}

function css(): string {
  return useEditorStore
    .getState()
    .styleModels.map((model) => stringifyStyleSheet(model))
    .join('\n');
}

beforeEach(() => {
  // The debounced save reaches for the IPC bridge; stub it so scheduleSave works.
  (globalThis as { window?: unknown }).window = {
    litho: {
      files: { write: vi.fn(async () => ({ ok: true, value: { written: [], hashes: {} } })) },
    },
  };
});

describe('store: reusable styles', () => {
  it('creates a named style and writes its rule into the page stylesheet', async () => {
    await loadPage();

    const created = useEditorStore.getState().createStyleClass('Page Intro');
    expect(created.ok && created.value).toBe('page-intro');
    expect(css()).toContain('.page-intro');
    // Immediately offered by the properties panel's class picker.
    expect(useEditorStore.getState().availableClassNames()).toContain('page-intro');
  });

  it('rejects a duplicate name', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    const again = useEditorStore.getState().createStyleClass('page-intro');
    expect(again.ok).toBe(false);
  });

  it('writes clicked properties into the class rule and reads them back', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');

    useEditorStore.getState().setClassStyle('page-intro', { 'font-size': '18px', color: '#666' });
    useEditorStore.getState().setClassStyle('page-intro', { margin: '0' });

    const output = css();
    expect(output).toMatch(/\.page-intro\s*\{[^}]*font-size:\s*18px/u);
    expect(output).toMatch(/\.page-intro\s*\{[^}]*color:\s*#666/u);
    expect(useEditorStore.getState().classDeclarations('page-intro')).toEqual({
      'font-size': '18px',
      color: '#666',
      margin: '0',
    });
  });

  it('keeps the style listed after its last property is cleared', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().setClassStyle('page-intro', { color: '#666' });
    useEditorStore.getState().setClassStyle('page-intro', { color: null });

    expect(
      useEditorStore
        .getState()
        .styleClasses()
        .map((entry) => entry.name),
    ).toContain('page-intro');
  });

  it('writes breakpoint overrides into a media query', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().setClassStyle('page-intro', { 'font-size': '18px' });

    useEditorStore.getState().setBreakpoint('mobile');
    useEditorStore.getState().setClassStyle('page-intro', { 'font-size': '14px' });

    const output = css();
    expect(output).toMatch(/@media[^{]*max-width:\s*640px/u);
    expect(useEditorStore.getState().classDeclarations('page-intro')['font-size']).toBe('14px');

    useEditorStore.getState().setBreakpoint('base');
    expect(useEditorStore.getState().classDeclarations('page-intro')['font-size']).toBe('18px');
  });

  it('assigns the style to the selected element', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().select([idOfTag('p')]);
    useEditorStore.getState().setClassOnSelection('page-intro', true);

    expect(getAttr(elementOfTag('p'), 'class')).toBe('page-intro');
    expect(
      useEditorStore
        .getState()
        .styleClasses()
        .find((e) => e.name === 'page-intro')?.usage,
    ).toBe(1);

    useEditorStore.getState().setClassOnSelection('page-intro', false);
    expect(getAttr(elementOfTag('p'), 'class')).toBeUndefined();
  });

  it('applies hand-edited raw CSS, adding and removing declarations', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().setClassStyle('page-intro', { color: '#666', margin: '0' });

    const result = useEditorStore
      .getState()
      .setClassCss('page-intro', '.page-intro {\n  color: #333;\n  transition: all 0.2s;\n}');
    expect(result.ok).toBe(true);

    // color changed, transition added, margin (absent from the edited text) removed.
    expect(useEditorStore.getState().classDeclarations('page-intro')).toEqual({
      color: '#333',
      transition: 'all 0.2s',
    });
  });

  it('rejects invalid raw CSS without touching the rule', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().setClassStyle('page-intro', { color: '#666' });

    const result = useEditorStore.getState().setClassCss('page-intro', '.page-intro { .nested { x: y } }');
    expect(result.ok).toBe(false);
    expect(useEditorStore.getState().classDeclarations('page-intro')).toEqual({ color: '#666' });
  });

  it('renames the class in the CSS and on every element carrying it', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().setClassStyle('page-intro', { color: '#666' });
    useEditorStore.getState().select([idOfTag('p')]);
    useEditorStore.getState().setClassOnSelection('page-intro', true);

    const renamed = useEditorStore.getState().renameStyleClass('page-intro', 'lead');
    expect(renamed.ok && renamed.value).toBe('lead');
    expect(css()).toContain('.lead');
    expect(css()).not.toContain('.page-intro');
    expect(getAttr(elementOfTag('p'), 'class')).toBe('lead');
  });

  it('deletes the rule and strips the class from the page', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().setClassStyle('page-intro', { color: '#666' });
    useEditorStore.getState().select([idOfTag('p')]);
    useEditorStore.getState().setClassOnSelection('page-intro', true);

    useEditorStore.getState().deleteStyleClass('page-intro');

    expect(css()).not.toContain('page-intro');
    expect(getAttr(elementOfTag('p'), 'class')).toBeUndefined();
  });

  it('undoes the creation of a style', async () => {
    await loadPage();
    useEditorStore.getState().createStyleClass('page-intro');
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().availableClassNames()).not.toContain('page-intro');
  });
});
