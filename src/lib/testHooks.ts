import { useEditorStore } from '@/state/editorStore.js';
import { getPlainText, getTextAction } from '@/engine/richTextEditor.js';
import { findElement, isElement, textContent, walk, type ElementNode } from '@shared/document.js';
import { logger } from './logger.js';

/**
 * Test-only surface for the end-to-end suite.
 *
 * Two operations in this editor start from a *DOM text selection inside the
 * canvas iframe* - applying a text action, and selecting an element by what it
 * says. Playwright cannot construct that selection across the iframe boundary,
 * so rather than weakening the production code to be testable, these hooks
 * express the same intent ("act on the element containing this text") through
 * the exact store actions the UI calls.
 *
 * They are registered only when the main process was launched with
 * `--litho-enable-test-hooks` in an unpackaged build, so a shipped installer
 * never has them.
 */

export interface LithoTestHooks {
  /**
   * Opens a project folder end to end: the same IPC call the start screen makes,
   * followed by the same `loadSnapshot` it performs on success. Only the native
   * folder picker is skipped, because Playwright cannot drive an OS dialog.
   */
  openProject(rootPath: string): Promise<void>;
  /** Selects the innermost element whose text contains `needle`. */
  selectByText(needle: string): void;
  /** Selects several elements at once, each identified by its text. */
  selectManyByText(needles: string[]): void;
  /** Applies a text action to the fragment `needle` in the element containing it. */
  applyTextActionByText(needle: string, actionId: string, params: unknown): void;
  /** Applies a style patch to the current selection at the active breakpoint. */
  setStyleOnSelection(patch: Record<string, string | null>): void;
  /** Groups the current selection into a `<div>`. */
  groupSelection(): void;
  /** Copies the current selection into the internal clipboard. */
  copySelection(): void;
  /** Pastes the clipboard content. */
  paste(): void;
  /** Duplicates the current selection. */
  duplicateSelection(): void;
  /** Forces the debounced save to complete, for deterministic assertions. */
  flushSave(): Promise<void>;
  /**
   * Closes the project through the same path the menu command uses, so the
   * "nothing is lost on close" guarantee is exercised rather than assumed.
   */
  closeProject(): Promise<void>;
}

export function registerTestHooks(): void {
  if (!window.litho?.testHooksEnabled) return;

  const hooks: LithoTestHooks = {
    async openProject(rootPath) {
      const result = await window.litho.project.open(rootPath);
      if (!result.ok) throw new Error(result.message);
      useEditorStore.getState().loadSnapshot(result.value.snapshot, result.value.openRelPath);
    },

    selectByText(needle) {
      const node = findElementContaining(needle);
      if (!node) throw new Error(`Nie znaleziono elementu zawierającego "${needle}"`);
      useEditorStore.getState().select([node.id]);
    },

    selectManyByText(needles) {
      const ids = needles.map((needle) => {
        const node = findElementContaining(needle);
        if (!node) throw new Error(`Nie znaleziono elementu zawierającego "${needle}"`);
        return node.id;
      });
      useEditorStore.getState().select(ids);
    },

    groupSelection() {
      const state = useEditorStore.getState();
      state.groupNodes(state.selection);
    },

    copySelection() {
      const state = useEditorStore.getState();
      state.copyNodes(state.selection);
    },

    paste() {
      useEditorStore.getState().pasteNodes();
    },

    duplicateSelection() {
      const state = useEditorStore.getState();
      state.duplicateNodes(state.selection);
    },

    applyTextActionByText(needle, actionId, params) {
      const node = findElementContaining(needle);
      if (!node) throw new Error(`Nie znaleziono elementu zawierającego "${needle}"`);

      const action = getTextAction(actionId);
      if (!action) throw new Error(`Nieznana akcja tekstowa: ${actionId}`);

      const plain = getPlainText(node);
      const start = plain.indexOf(needle);
      if (start === -1) throw new Error(`Fragment "${needle}" nie występuje w tekście elementu`);

      useEditorStore
        .getState()
        .applyTextAction(node.id, action, { start, end: start + needle.length }, params);
    },

    setStyleOnSelection(patch) {
      const state = useEditorStore.getState();
      const id = state.selection[0];
      if (!id) throw new Error('Brak zaznaczenia');
      state.setStyle(id, patch, { label: 'Test' });
    },

    flushSave: () => useEditorStore.getState().flushSave(),

    async closeProject() {
      // Mirrors the menu command exactly: flush first, then tear down.
      await useEditorStore.getState().flushSave();
      await window.litho.project.close();
      useEditorStore.getState().closeProject();
    },
  };

  window.__lithoTestHooks = hooks;
  logger.info('Hooki testowe włączone (--litho-enable-test-hooks)');
}

/**
 * Finds the *innermost* element containing the text, which is what a user
 * selecting that text on screen would have landed in.
 */
function findElementContaining(needle: string): ElementNode | null {
  const document = useEditorStore.getState().document;
  if (!document) return null;

  let best: ElementNode | null = null;
  let bestLength = Infinity;

  for (const node of walk(document.root)) {
    if (!isElement(node)) continue;
    if (node.tag === 'script' || node.tag === 'style') continue;
    const content = textContent(node);
    if (!content.includes(needle)) continue;
    if (content.length < bestLength) {
      best = node;
      bestLength = content.length;
    }
  }

  return best ? (findElement(document.root, best.id) as ElementNode | null) : null;
}
