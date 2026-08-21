import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/state/editorStore.js';
import { findFirstTag, type DocNode, type ElementNode } from '@shared/document.js';
import type { ProjectSnapshot } from '@shared/project.js';

/**
 * Reproduces, at the store level, what a user does in the panel: select an
 * element, attach a script, then re-read it. This is the layer the UI complaint
 * ("nothing shows when I go back to an element with a script") lives at.
 */

const HTML = `<!doctype html>
<html lang="pl">
  <head><meta charset="utf-8" /><title>T</title></head>
  <body>
    <h1>Nagłówek</h1>
    <p>© 2024 Moja Firma</p>
    <footer><span>stopka</span></footer>
  </body>
</html>
`;

function snapshot(): ProjectSnapshot {
  return {
    project: {
      rootPath: '/x',
      name: 'x',
      pages: [{ relPath: 'index.html', title: 'T', isEntry: true }],
    },
    files: { 'index.html': HTML },
    assets: [],
  };
}

async function loadPage(): Promise<void> {
  useEditorStore.getState().loadSnapshot(snapshot());
  // loadSnapshot kicks openPage off as a floating promise; let it settle.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function idOfText(needle: string): string {
  const doc = useEditorStore.getState().document!;
  const stack = [doc.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind !== 'element') continue;
    const text = node.children
      .filter((c) => c.kind === 'text')
      .map((c) => (c.kind === 'text' ? c.value : ''))
      .join('');
    if (text.includes(needle)) return node.id;
    for (const child of node.children) if (child.kind === 'element') stack.push(child);
  }
  throw new Error(`no element with ${needle}`);
}

beforeEach(() => {
  // The debounced save reaches for the IPC bridge; stub it so scheduleSave works.
  (globalThis as { window?: unknown }).window = {
    litho: {
      files: { write: vi.fn(async () => ({ ok: true, value: { written: [], hashes: {} } })) },
    },
  };
});

describe('store: attach and re-read an element script', () => {
  it('shows the binding immediately after applying a preset', async () => {
    await loadPage();
    const id = idOfText('© 2024 Moja Firma');

    useEditorStore.getState().setElementScript(id, {
      presetId: 'aktualny-rok',
      params: { rokStartowy: '', separator: '-', przedrostek: '', przyrostek: '' },
    });

    const state = useEditorStore.getState().elementScriptState(id);
    expect(state.binding).not.toBeNull();
    expect(state.binding?.presetId).toBe('aktualny-rok');
  });

  it('re-reads the binding after the debounced save has run', async () => {
    await loadPage();
    const id = idOfText('© 2024 Moja Firma');

    useEditorStore.getState().setElementScript(id, {
      presetId: 'aktualny-rok',
      params: { rokStartowy: '2020', separator: '-', przedrostek: '© ', przyrostek: '' },
    });
    await useEditorStore.getState().flushSave();

    const state = useEditorStore.getState().elementScriptState(id);
    expect(state.binding?.params.rokStartowy).toBe('2020');
  });

  it('writes the computed preview as the element\'s static text, so the canvas shows a real value', async () => {
    await loadPage();
    const id = idOfText('© 2024 Moja Firma');

    useEditorStore.getState().setElementScript(id, {
      presetId: 'aktualny-rok',
      params: { rokStartowy: '2020', separator: '-', przedrostek: '© ', przyrostek: '' },
    });

    const doc = useEditorStore.getState().document!;
    const element = findById(doc.root, id);
    const text = element?.children.map((c) => (c.kind === 'text' ? c.value : '')).join('') ?? '';
    expect(text).toBe(`© 2020-${new Date().getFullYear()}`);
  });

  it('leaves nested markup alone rather than flattening it to plain text', async () => {
    await loadPage();
    const doc = useEditorStore.getState().document!;
    const footer = findFirstTag(doc.root as ElementNode, 'footer')!;
    const id = footer.id;

    useEditorStore.getState().setElementScript(id, {
      presetId: 'wlasny-kod',
      params: { kod: 'element.textContent = "custom";' },
    });

    const element = findById(doc.root, id)!;
    // The footer's <span> child must survive - custom-code preview is `null`,
    // and even for readable presets a container with element children is
    // skipped so its structure is never flattened to plain text.
    expect(element.children.some((c) => c.kind === 'element')).toBe(true);
  });
});

function findById(root: DocNode, id: string): ElementNode | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind === 'element') {
      if (node.id === id) return node;
      for (const child of node.children) stack.push(child);
    }
  }
  return null;
}
