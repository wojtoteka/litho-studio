import { useEffect } from 'react';
import type { MenuCommand } from '@shared/ipc.js';
import { findParent, getBody } from '@shared/document.js';
import { useEditorStore } from '@/state/editorStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { logger } from '@/lib/logger.js';

/**
 * The command registry.
 *
 * Menu items and keyboard shortcuts both dispatch into this one map, so a
 * command can never behave differently depending on how it was invoked — the
 * classic source of "the menu works but the shortcut doesn't" bugs.
 *
 * The menu's accelerators are display-only (`registerAccelerator: false`);
 * every keystroke is handled here, where focus is known. Keystrokes are ignored
 * while focus sits in a text field, otherwise typing "d" in the href box would
 * duplicate the selected element. `handleEditorKeydown` is exported because the
 * canvas iframe is a separate document: clicking into it moves focus there, so
 * the canvas attaches this same handler to the iframe document on every load.
 */

export const SHORTCUTS: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: 'Ctrl+O', description: 'Otwórz folder ze stroną' },
  { keys: 'Ctrl+Shift+O', description: 'Otwórz pliki' },
  { keys: 'Ctrl+Shift+N', description: 'Nowy projekt' },
  { keys: 'Ctrl+Z', description: 'Cofnij' },
  { keys: 'Ctrl+Shift+Z', description: 'Ponów' },
  { keys: 'Ctrl+D', description: 'Duplikuj zaznaczenie' },
  { keys: 'Ctrl+C / Ctrl+X / Ctrl+V', description: 'Kopiuj / wytnij / wklej' },
  { keys: 'Ctrl+A', description: 'Zaznacz elementy sąsiednie' },
  { keys: 'Ctrl+G / Ctrl+Shift+G', description: 'Grupuj / rozgrupuj' },
  { keys: 'Strzałki / Shift+strzałki', description: 'Przesuń zaznaczony element o 1 px / 10 px' },
  { keys: 'Delete', description: 'Usuń zaznaczenie' },
  { keys: 'Escape', description: 'Odznacz' },
  { keys: 'Ctrl+plus / Ctrl+minus', description: 'Powiększ / pomniejsz' },
  { keys: 'Ctrl+0', description: 'Rozmiar rzeczywisty' },
  { keys: 'Ctrl+9', description: 'Dopasuj do okna' },
  { keys: 'Ctrl + kółko myszy', description: 'Powiększenie wokół kursora' },
  { keys: 'Ctrl+P', description: 'Podgląd na żywo' },
  { keys: 'Ctrl+Shift+H', description: 'Siatka' },
  { keys: 'Ctrl+Shift+L', description: 'Panel logów' },
  { keys: 'Ctrl+`', description: 'Terminal' },
  { keys: 'Ctrl+Shift+T', description: 'Przełącz motyw' },
  { keys: 'Ctrl+/', description: 'Lista skrótów' },
];

export function executeMenuCommand(command: MenuCommand): void {
  const editor = useEditorStore.getState;
  const ui = useUiStore.getState;

  switch (command) {
    case 'project:new':
      ui().openNewProjectDialog();
      break;
    case 'project:open':
      void openProject();
      break;
    case 'project:open-file':
      void openProjectFile();
      break;
    case 'project:close':
      void closeProject();
      break;
    case 'edit:undo':
      editor().undo();
      break;
    case 'edit:redo':
      editor().redo();
      break;
    case 'edit:duplicate':
      editor().duplicateNodes(editor().selection);
      break;
    case 'edit:delete':
      editor().removeNodes(editor().selection);
      break;
    case 'edit:copy':
      editor().copyNodes(editor().selection);
      break;
    case 'edit:cut':
      editor().cutNodes(editor().selection);
      break;
    case 'edit:paste':
      editor().pasteNodes();
      break;
    case 'edit:group':
      editor().groupNodes(editor().selection);
      break;
    case 'edit:ungroup': {
      const first = editor().selection[0];
      if (first) editor().ungroupNode(first);
      break;
    }
    case 'edit:select-all':
      selectAllSiblings();
      break;
    case 'view:zoom-in':
      ui().zoomBy(1.25);
      break;
    case 'view:zoom-out':
      ui().zoomBy(1 / 1.25);
      break;
    case 'view:zoom-reset':
      ui().resetZoom();
      break;
    case 'view:zoom-fit':
      ui().fitZoom();
      break;
    case 'view:toggle-grid':
      ui().toggleGrid();
      break;
    case 'view:toggle-preview':
      ui().togglePreview();
      break;
    case 'view:toggle-console':
      ui().toggleConsole();
      break;
    case 'view:toggle-terminal':
      ui().toggleTerminal();
      break;
    case 'view:toggle-theme':
      ui().toggleTheme();
      break;
    case 'tools:ai-installer':
      ui().openAiToolsDialog();
      break;
    case 'help:shortcuts':
      ui().toggleShortcuts();
      break;
    /*
     * Full screen, the contact page and quitting are the only commands this
     * registry cannot carry out itself — a web page can neither resize the OS
     * window nor end the process. They go back over the bridge to the main
     * process, which implements exactly these three and refuses anything else.
     */
    case 'view:toggle-fullscreen':
    case 'help:contact':
    case 'app:quit':
      void window.litho.runNativeCommand(command);
      break;
    default:
      break;
  }
}

/**
 * Keyboard dispatch. Attached to the app window *and* to the canvas iframe's
 * document (see `Canvas`), because key events never cross a frame boundary.
 */
export function handleEditorKeydown(event: KeyboardEvent): void {
  if (isTypingTarget(event.target)) return;
  const editor = useEditorStore.getState;
  const mod = event.ctrlKey || event.metaKey;

  if (event.key === 'Escape') {
    editor().select([]);
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && editor().selection.length > 0) {
    event.preventDefault();
    executeMenuCommand('edit:delete');
    return;
  }
  if (!mod) return;

  switch (event.key.toLowerCase()) {
    case 'z':
      event.preventDefault();
      executeMenuCommand(event.shiftKey ? 'edit:redo' : 'edit:undo');
      break;
    case 'y':
      event.preventDefault();
      executeMenuCommand('edit:redo');
      break;
    case 'd':
      event.preventDefault();
      executeMenuCommand('edit:duplicate');
      break;
    case 'a':
      event.preventDefault();
      executeMenuCommand('edit:select-all');
      break;
    case 'c':
      if (editor().selection.length > 0) {
        event.preventDefault();
        executeMenuCommand('edit:copy');
      }
      break;
    case 'x':
      if (editor().selection.length > 0) {
        event.preventDefault();
        executeMenuCommand('edit:cut');
      }
      break;
    case 'v':
      if (editor().canPaste()) {
        event.preventDefault();
        executeMenuCommand('edit:paste');
      }
      break;
    case 'g':
      event.preventDefault();
      executeMenuCommand(event.shiftKey ? 'edit:ungroup' : 'edit:group');
      break;
    case 'p':
      event.preventDefault();
      executeMenuCommand('view:toggle-preview');
      break;
    case '0':
      event.preventDefault();
      executeMenuCommand('view:zoom-reset');
      break;
    case '9':
      event.preventDefault();
      executeMenuCommand('view:zoom-fit');
      break;
    case '=':
    case '+':
      event.preventDefault();
      executeMenuCommand('view:zoom-in');
      break;
    case '-':
      event.preventDefault();
      executeMenuCommand('view:zoom-out');
      break;
    case '/':
      event.preventDefault();
      executeMenuCommand('help:shortcuts');
      break;
    case 'h':
      if (event.shiftKey) {
        event.preventDefault();
        executeMenuCommand('view:toggle-grid');
      }
      break;
    case 'l':
      if (event.shiftKey) {
        event.preventDefault();
        executeMenuCommand('view:toggle-console');
      }
      break;
    case '`':
      event.preventDefault();
      executeMenuCommand('view:toggle-terminal');
      break;
    case 't':
      if (event.shiftKey) {
        event.preventDefault();
        executeMenuCommand('view:toggle-theme');
      }
      break;
    default:
      break;
  }
}

export function useCommands(): void {
  useEffect(() => {
    const offMenu = window.litho.onMenuCommand(executeMenuCommand);

    // The main process holds the window open until this flush confirms, so the
    // last debounced edit is on disk before the process goes away.
    const offFlush = window.litho.onFlushRequest(() => {
      void useEditorStore
        .getState()
        .flushSave()
        .catch((error) => logger.error('Zapis przy zamykaniu nie powiódł się', error))
        .finally(() => window.litho.flushDone());
    });

    window.addEventListener('keydown', handleEditorKeydown);
    return () => {
      offMenu();
      offFlush();
      window.removeEventListener('keydown', handleEditorKeydown);
    };
  }, []);
}

/* ------------------------------------------------------------------ */

async function openProject(): Promise<void> {
  await useEditorStore.getState().flushSave();
  const result = await window.litho.project.openDialog();
  if (result.ok) useEditorStore.getState().loadSnapshot(result.value);
  else if (result.code !== 'CANCELLED') logger.warn(`Nie otwarto projektu: ${result.message}`);
}

/**
 * "Open files" still loads the first pick's containing folder as the project —
 * CSS and JS referenced from the page live there and must be tracked too — but
 * it skips straight to the page the user actually picked instead of whatever
 * happens to be `index.html`. Every other HTML page already in that folder
 * shows up in the page switcher on its own, picked or not.
 */
async function openProjectFile(): Promise<void> {
  await useEditorStore.getState().flushSave();
  const result = await window.litho.project.openFileDialog();
  if (result.ok) {
    useEditorStore.getState().loadSnapshot(result.value.snapshot, result.value.openRelPath);
  } else if (result.code !== 'CANCELLED') {
    logger.warn(`Nie otwarto pliku: ${result.message}`);
  }
}

async function closeProject(): Promise<void> {
  await useEditorStore.getState().flushSave();
  await window.litho.project.close();
  useEditorStore.getState().closeProject();
}

/**
 * Ctrl+A selects the *siblings* of the current element rather than everything
 * in the document — selecting a whole page at once is never a useful editing
 * operation, whereas "all the cards in this grid" constantly is.
 */
function selectAllSiblings(): void {
  const state = useEditorStore.getState();
  const document = state.document;
  if (!document) return;

  const body = getBody(document);
  if (!body) return;

  const first = state.selection[0];
  const container = (first ? findParent(document.root, first) : null) ?? body;

  state.select(container.children.filter((child) => child.kind === 'element').map((child) => child.id));
}

/**
 * Realm-safe focus check: elements inside the canvas iframe are instances of
 * *that* document's classes, so an `instanceof HTMLElement` test would wrongly
 * report "not a text field" for every one of them.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}
