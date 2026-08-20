import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/state/editorStore.js';
import { getAttr, textContent, type ElementNode } from '@shared/document.js';
import type { ProjectSnapshot } from '@shared/project.js';

/**
 * The complaint this covers: "the editor freezes, goes white and refreshes, I
 * can't edit anything for a few seconds". Every one of those was one reload of
 * the canvas iframe, and typing a heading in the properties panel triggered one
 * per keystroke.
 *
 * `structureRevision` is what the canvas reloads on, so these tests assert the
 * *absence* of a reload — and, just as importantly, that the ops published in
 * its place describe the same change the model just made. An op that lies would
 * leave the canvas rendering something the file does not say.
 */

const HTML = `<!doctype html>
<html lang="pl">
  <head><meta charset="utf-8" /><title>T</title><link rel="stylesheet" href="style.css" /></head>
  <body>
    <h1 class="tytul">Nagłówek</h1>
    <img src="a.png" alt="" width="10" height="20" />
    <p>Akapit</p>
  </body>
</html>
`;

function snapshot(): ProjectSnapshot {
  return {
    project: { rootPath: '/x', name: 'x', pages: [{ relPath: 'index.html', title: 'T', isEntry: true }] },
    files: { 'index.html': HTML, 'style.css': '.tytul { color: red }\n' },
    assets: [],
  };
}

async function loadPage(): Promise<void> {
  useEditorStore.getState().loadSnapshot(snapshot());
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function findByTag(tag: string): ElementNode {
  const stack: ElementNode[] = [useEditorStore.getState().document!.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === tag) return node;
    for (const child of node.children) if (child.kind === 'element') stack.push(child);
  }
  throw new Error(`no <${tag}>`);
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    litho: { files: { write: vi.fn(async () => ({ ok: true, value: { written: [], hashes: {} } })) } },
  };
});

describe('canvas patches instead of reloads', () => {
  it('does not reload the canvas when text changes, and says what to set instead', async () => {
    await loadPage();
    const heading = findByTag('h1');
    const before = useEditorStore.getState().structureRevision;

    useEditorStore.getState().setTextContent(heading.id, 'Nowy tytuł');

    const state = useEditorStore.getState();
    expect(state.structureRevision).toBe(before);
    expect(state.canvasPatch?.ops).toEqual([{ kind: 'text', id: heading.id, value: 'Nowy tytuł' }]);
    // The op and the model agree — that equivalence is the whole contract.
    expect(textContent(findByTag('h1'))).toBe('Nowy tytuł');
  });

  it('publishes a fresh sequence number per edit, so a repeat of the same value still applies', async () => {
    await loadPage();
    const heading = findByTag('h1');

    useEditorStore.getState().setTextContent(heading.id, 'A');
    const first = useEditorStore.getState().canvasPatch!.seq;
    useEditorStore.getState().setTextContent(heading.id, 'B');

    expect(useEditorStore.getState().canvasPatch!.seq).toBeGreaterThan(first);
  });

  it('patches an ordinary attribute rather than reloading', async () => {
    await loadPage();
    const heading = findByTag('h1');
    const before = useEditorStore.getState().structureRevision;

    useEditorStore.getState().setAttribute(heading.id, 'title', 'Podpowiedź');

    expect(useEditorStore.getState().structureRevision).toBe(before);
    expect(useEditorStore.getState().canvasPatch?.ops).toEqual([
      { kind: 'attribute', id: heading.id, name: 'title', value: 'Podpowiedź' },
    ]);
  });

  it('still reloads for an attribute the canvas copy rewrites', async () => {
    await loadPage();
    const heading = findByTag('h1');
    const before = useEditorStore.getState().structureRevision;

    // Inline handlers are stripped from the canvas copy, so "set it on the live
    // node" would not be equivalent to a rebuild.
    useEditorStore.getState().setAttribute(heading.id, 'onclick', 'alert(1)');

    expect(useEditorStore.getState().structureRevision).toBe(before + 1);
  });

  it('swaps an image source, its width and its height in one patch', async () => {
    await loadPage();
    const image = findByTag('img');
    const before = useEditorStore.getState().structureRevision;

    useEditorStore.getState().setImageSource(image.id, 'b.png', 640, 480);

    expect(useEditorStore.getState().structureRevision).toBe(before);
    expect(useEditorStore.getState().canvasPatch?.ops).toEqual([
      { kind: 'attribute', id: image.id, name: 'src', value: 'b.png' },
      { kind: 'attribute', id: image.id, name: 'width', value: '640' },
      { kind: 'attribute', id: image.id, name: 'height', value: '480' },
    ]);
  });

  it('sends the selector hook it had to allocate, instead of reloading for it', async () => {
    await loadPage();
    // The paragraph has neither id nor class, so styling it allocates a hook —
    // the one case where a style edit used to cost a full page reload.
    const paragraph = findByTag('p');
    const before = useEditorStore.getState().structureRevision;

    useEditorStore.getState().setStyle(paragraph.id, { color: '#123456' });

    const state = useEditorStore.getState();
    expect(state.structureRevision).toBe(before);

    const ops = state.canvasPatch?.ops ?? [];
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.kind).toBe('attribute');
      if (op.kind !== 'attribute') continue;
      // Whatever hook was allocated, the op carries the element's real value.
      expect(op.value).toBe(getAttr(findByTag('p'), op.name));
    }
  });

  it('reloads for edits that move nodes around, which no op can express', async () => {
    await loadPage();
    const heading = findByTag('h1');
    const before = useEditorStore.getState().structureRevision;

    useEditorStore.getState().removeNodes([heading.id]);

    expect(useEditorStore.getState().structureRevision).toBe(before + 1);
  });
});
