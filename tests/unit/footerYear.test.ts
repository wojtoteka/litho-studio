import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/state/editorStore.js';
import { getComponentTemplate } from '@/lib/elementFactory.js';
import { findFirstTag, getAttr, textContent, type ElementNode } from '@shared/document.js';
import type { ProjectSnapshot } from '@shared/project.js';

/**
 * The footer used to ship a hard-coded "© Moja Strona 2024–2026", which is
 * wrong the moment the year turns over. It now carries the `aktualny-rok`
 * element script, so the line keeps itself current — and, because the canvas
 * runs no page script, a matching static value so the editor and a no-JS
 * visitor see a real year rather than a placeholder.
 */

const HTML = `<!doctype html>
<html lang="pl">
  <head><meta charset="utf-8" /><title>T</title></head>
  <body><main></main></body>
</html>
`;

function snapshot(): ProjectSnapshot {
  return {
    project: { rootPath: '/x', name: 'x', pages: [{ relPath: 'index.html', title: 'T', isEntry: true }] },
    files: { 'index.html': HTML },
    assets: [],
  };
}

async function loadPage(): Promise<void> {
  useEditorStore.getState().loadSnapshot(snapshot());
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    litho: { files: { write: vi.fn(async () => ({ ok: true, value: { written: [], hashes: {} } })) } },
  };
});

describe('footer template', () => {
  it('says "Twoja firma" and the current year, not a frozen one', () => {
    const template = getComponentTemplate('footer')!;
    const copy = template.build().children.find((child) => child.kind === 'element') as ElementNode;
    expect(textContent(copy)).toBe(`© Twoja firma ${new Date().getFullYear()}`);
  });

  it('declares the year script rather than relying on the static text', () => {
    const template = getComponentTemplate('footer')!;
    expect(template.scripts).toHaveLength(1);
    expect(template.scripts?.[0]?.binding.presetId).toBe('aktualny-rok');
    // The script has to be able to find its element in a freshly built subtree.
    expect(template.scripts?.[0]?.find(template.build())).not.toBeNull();
  });
});

describe('inserting the footer', () => {
  async function insertFooter(): Promise<ElementNode> {
    await loadPage();
    const template = getComponentTemplate('footer')!;
    const body = findFirstTag(useEditorStore.getState().document!.root, 'body')!;
    const node = template.build();
    useEditorStore
      .getState()
      .insertTemplate(
        { node, css: template.css, scripts: template.scripts },
        { parentId: body.id, index: 0 },
      );
    return node;
  }

  it('attaches the script to the copyright line and gives it an id to hook onto', async () => {
    const node = await insertFooter();
    const copy = node.children.find((child) => child.kind === 'element') as ElementNode;

    const domId = getAttr(copy, 'id');
    expect(domId).toBeTruthy();

    const state = useEditorStore.getState().elementScriptState(copy.id);
    expect(state.binding?.presetId).toBe('aktualny-rok');
    expect(state.binding?.params.przedrostek).toBe('© Twoja firma ');
  });

  it('generates real JavaScript into the page\'s own script file', async () => {
    await insertFooter();
    await useEditorStore.getState().flushSave();

    const code = [...useEditorStore.getState().scripts.values()]
      .flatMap((script) => script.snippets.map((snippet) => snippet.code))
      .join('\n');
    expect(code).toContain('new Date().getFullYear()');
    expect(code).toContain('© Twoja firma ');
  });

  it('stays a single undo step — the script rides along with the insertion', async () => {
    await loadPage();
    const template = getComponentTemplate('footer')!;
    const body = findFirstTag(useEditorStore.getState().document!.root, 'body')!;

    useEditorStore
      .getState()
      .insertTemplate(
        { node: template.build(), css: template.css, scripts: template.scripts },
        { parentId: body.id, index: 0 },
      );

    useEditorStore.getState().undo();

    const body2 = findFirstTag(useEditorStore.getState().document!.root, 'body')!;
    expect(findFirstTag(body2, 'footer')).toBeNull();
  });
});
