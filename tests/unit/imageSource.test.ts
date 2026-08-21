import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/state/editorStore.js';
import { resolveImageDropTarget } from '@/lib/canvasDrop.js';
import { CANVAS_ID_ATTRIBUTE } from '@/lib/canvasDocument.js';
import { getAttr, type DocNode, type ElementNode } from '@shared/document.js';
import type { ProjectSnapshot } from '@shared/project.js';
import { generateHtml } from '@/engine/htmlGenerator.js';

/**
 * Putting your own photos into a gallery. Before this, the only way to point an
 * `<img>` at a different file was to type its project-relative path into a text
 * field, and dropping a photo from Zasoby onto a tile stacked a new
 * absolutely-positioned image on top of the layout instead of filling the tile.
 */

const HTML = `<!doctype html>
<html lang="pl">
  <head><meta charset="utf-8" /><title>T</title></head>
  <body>
    <section class="ls-gallery">
      <img class="ls-gallery__item" src="assets/placeholder.svg" alt="" width="100" height="100" />
      <img class="ls-gallery__item" src="assets/placeholder.svg" alt="" />
    </section>
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
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function allImages(): ElementNode[] {
  const found: ElementNode[] = [];
  const walk = (node: DocNode): void => {
    if (node.kind !== 'element') return;
    if (node.tag === 'img') found.push(node);
    for (const child of node.children) walk(child);
  };
  walk(useEditorStore.getState().document!.root);
  return found;
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    litho: {
      files: { write: vi.fn(async () => ({ ok: true, value: { written: [], hashes: {} } })) },
    },
  };
});

describe('setImageSource', () => {
  it('swaps the picture and its intrinsic size in one undoable step', async () => {
    await loadPage();
    const [first] = allImages();

    useEditorStore.getState().setImageSource(first!.id, 'assets/kot.jpg', 800, 600);

    const swapped = allImages()[0]!;
    expect(getAttr(swapped, 'src')).toBe('assets/kot.jpg');
    expect(getAttr(swapped, 'width')).toBe('800');
    expect(getAttr(swapped, 'height')).toBe('600');

    // One Ctrl+Z has to put the whole swap back, not just the height.
    useEditorStore.getState().undo();
    const restored = allImages()[0]!;
    expect(getAttr(restored, 'src')).toBe('assets/placeholder.svg');
    expect(getAttr(restored, 'width')).toBe('100');
    expect(getAttr(restored, 'height')).toBe('100');
  });

  it('drops stale dimensions when the new picture has none', async () => {
    await loadPage();
    const [first] = allImages();

    // The old 100x100 would letterbox a picture of unknown size into a square.
    useEditorStore.getState().setImageSource(first!.id, 'assets/panorama.jpg', null, null);

    const swapped = allImages()[0]!;
    expect(getAttr(swapped, 'width')).toBeUndefined();
    expect(getAttr(swapped, 'height')).toBeUndefined();
  });

  it('touches only the image it was given', async () => {
    await loadPage();
    const [first] = allImages();

    useEditorStore.getState().setImageSource(first!.id, 'assets/kot.jpg', 800, 600);

    expect(getAttr(allImages()[1]!, 'src')).toBe('assets/placeholder.svg');
  });

  it('writes a plain <img src> to the file - nothing hints at the editor', async () => {
    await loadPage();
    const [first] = allImages();
    useEditorStore.getState().setImageSource(first!.id, 'assets/kot.jpg', 800, 600);

    const html = generateHtml(useEditorStore.getState().document!);
    expect(html).toContain('src="assets/kot.jpg"');
    expect(html).toContain('width="800"');
    expect(html).not.toContain(CANVAS_ID_ATTRIBUTE);
  });

  it('ignores an id that is not in the document', async () => {
    await loadPage();
    expect(() => useEditorStore.getState().setImageSource('nie-ma', 'a.jpg', 1, 1)).not.toThrow();
  });
});

/**
 * `resolveImageDropTarget` is what decides "replace this tile" versus "place a
 * new floating image", so it is tested against the shapes the canvas actually
 * hands it.
 */
describe('resolveImageDropTarget', () => {
  function fakeDocument(atPoint: Element | null): Document {
    return { elementFromPoint: () => atPoint } as unknown as Document;
  }

  function fakeImage(id: string | null): Element {
    return {
      closest: (selector: string) => (selector === 'img' ? fakeImage(id) : null),
      getAttribute: (name: string) => (name === CANVAS_ID_ATTRIBUTE ? id : null),
    } as unknown as Element;
  }

  it('returns the id of the image under the pointer', () => {
    expect(resolveImageDropTarget(fakeDocument(fakeImage('n7')), 10, 10)).toBe('n7');
  });

  it('returns null over anything that is not an image', () => {
    const paragraph = { closest: () => null } as unknown as Element;
    expect(resolveImageDropTarget(fakeDocument(paragraph), 10, 10)).toBeNull();
  });

  it('returns null over empty space', () => {
    expect(resolveImageDropTarget(fakeDocument(null), 10, 10)).toBeNull();
  });

  it('returns null for an image the editor does not track', () => {
    // Without an id there is nothing to write the new source to - falling back
    // to free placement is the honest outcome.
    expect(resolveImageDropTarget(fakeDocument(fakeImage(null)), 10, 10)).toBeNull();
  });
});
