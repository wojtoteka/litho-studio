import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MenuCommand } from '@shared/ipc.js';
import { useEditorStore } from '@/state/editorStore.js';
import { useHistoryStore } from '@/state/historyStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { executeMenuCommand } from '@/lib/useCommands.js';
import { useClampedMenuPosition } from '@/lib/useClampedMenuPosition.js';
import { isWindows } from '@/lib/platform.js';
import { Icon, type IconName } from './Icon.js';

/**
 * The application menu, drawn by the app instead of by the platform.
 *
 * On Windows and Linux this is *the* menu. Litho still registers a native one
 * (electron/menu.ts), but only for its accelerators — the platform menu *bar* is
 * hidden on both (see `setMenuBarVisibility` in main.ts), because a
 * Chromium-drawn strip of "Projekt Edycja Widok Pomoc" is painted with the
 * desktop's own font and colours: a pale band welded above a dark editor, and on
 * Windows a second copy of a menu the toolbar already carries. One button
 * opening one panel that shows the whole tree at once is less chrome for the same
 * reach.
 *
 * macOS is the exception and keeps its system menu bar, so there this panel is a
 * duplicate of it rather than the only way in.
 *
 * Nothing here implements a command. Every item dispatches into the same
 * `executeMenuCommand` registry the native menu and the keyboard shortcuts use,
 * so a command can never behave differently depending on which menu ran it —
 * see the note at the top of `useCommands.ts`.
 */

type MenuEntry =
  | { kind: 'separator' }
  | {
      kind: 'item';
      label: string;
      command: MenuCommand;
      icon: IconName;
      /** Display-only accelerator hint; the key handling lives in `useCommands`. */
      keys?: string;
      disabled?: boolean;
      /** Drawn with a tick — for the view toggles, whose state the menu should show. */
      checked?: boolean;
    };

interface MenuSection {
  title: string;
  /**
   * Which of the panel's three columns the section is drawn in. Stated rather
   * than left to grid auto-placement: Projekt and Pomoc are short and share the
   * first column, which is what keeps all three columns roughly level instead
   * of one running half again as long as its neighbours.
   */
  column: 0 | 1 | 2;
  entries: readonly MenuEntry[];
}

const COLUMNS = [0, 1, 2] as const;

export function AppMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback(() => {
    const box = triggerRef.current?.getBoundingClientRect();
    if (box) setAnchor({ x: box.left, y: box.bottom + 6 });
    setOpen(true);
  }, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  return (
    <div className="app-menu">
      <button
        ref={triggerRef}
        type="button"
        className={`button button--icon app-menu__trigger${open ? ' button--active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu aplikacji"
        title="Menu aplikacji"
        onClick={() => (open ? close(false) : openMenu())}
      >
        <Icon name="menu" />
      </button>

      {open ? <AppMenuPanel anchor={anchor} triggerRef={triggerRef} onClose={close} /> : null}
    </div>
  );
}

function AppMenuPanel({
  anchor,
  triggerRef,
  onClose,
}: {
  anchor: { x: number; y: number };
  triggerRef: React.RefObject<HTMLButtonElement>;
  onClose: (returnFocus: boolean) => void;
}): JSX.Element {
  const { ref, style } = useClampedMenuPosition(anchor);

  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const canPaste = useEditorStore((state) => state.canPaste());
  const canUndo = useHistoryStore((state) => state.cursor > 0);
  const canRedo = useHistoryStore((state) => state.cursor < state.entries.length);

  const showGrid = useUiStore((state) => state.showGrid);
  const previewVisible = useUiStore((state) => state.previewVisible);
  const consoleVisible = useUiStore((state) => state.consoleVisible);
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const theme = useUiStore((state) => state.theme);

  const hasSelection = selection.length > 0;

  const sections = useMemo<readonly MenuSection[]>(
    () => [
      {
        title: 'Projekt',
        column: 0,
        entries: [
          {
            kind: 'item',
            label: 'Nowy projekt…',
            command: 'project:new',
            icon: 'add_circle',
            keys: 'Ctrl+Shift+N',
          },
          {
            kind: 'item',
            label: 'Otwórz folder…',
            command: 'project:open',
            icon: 'folder_open',
            keys: 'Ctrl+O',
          },
          {
            kind: 'item',
            label: 'Otwórz pliki…',
            command: 'project:open-file',
            icon: 'description',
            keys: 'Ctrl+Shift+O',
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: 'Zamknij projekt',
            command: 'project:close',
            icon: 'close',
            keys: 'Ctrl+Shift+W',
            disabled: !project,
          },
          { kind: 'separator' },
          { kind: 'item', label: 'Zakończ', command: 'app:quit', icon: 'power_settings_new', keys: 'Ctrl+Q' },
        ],
      },
      {
        title: 'Edycja',
        column: 1,
        entries: [
          {
            kind: 'item',
            label: 'Cofnij',
            command: 'edit:undo',
            icon: 'undo',
            keys: 'Ctrl+Z',
            disabled: !canUndo,
          },
          {
            kind: 'item',
            label: 'Ponów',
            command: 'edit:redo',
            icon: 'redo',
            keys: 'Ctrl+Shift+Z',
            disabled: !canRedo,
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: 'Wytnij',
            command: 'edit:cut',
            icon: 'content_cut',
            keys: 'Ctrl+X',
            disabled: !hasSelection,
          },
          {
            kind: 'item',
            label: 'Kopiuj',
            command: 'edit:copy',
            icon: 'content_copy',
            keys: 'Ctrl+C',
            disabled: !hasSelection,
          },
          {
            kind: 'item',
            label: 'Wklej',
            command: 'edit:paste',
            icon: 'content_paste',
            keys: 'Ctrl+V',
            disabled: !canPaste,
          },
          {
            kind: 'item',
            label: 'Duplikuj',
            command: 'edit:duplicate',
            icon: 'library_add',
            keys: 'Ctrl+D',
            disabled: !hasSelection,
          },
          {
            kind: 'item',
            label: 'Usuń',
            command: 'edit:delete',
            icon: 'delete',
            keys: 'Delete',
            disabled: !hasSelection,
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: 'Zaznacz sąsiednie',
            command: 'edit:select-all',
            icon: 'select_all',
            keys: 'Ctrl+A',
            disabled: !project,
          },
          {
            kind: 'item',
            label: 'Grupuj',
            command: 'edit:group',
            icon: 'layers',
            keys: 'Ctrl+G',
            disabled: !hasSelection,
          },
          {
            kind: 'item',
            label: 'Rozgrupuj',
            command: 'edit:ungroup',
            icon: 'call_split',
            keys: 'Ctrl+Shift+G',
            disabled: !hasSelection,
          },
        ],
      },
      {
        title: 'Widok',
        column: 2,
        entries: [
          { kind: 'item', label: 'Powiększ', command: 'view:zoom-in', icon: 'zoom_in', keys: 'Ctrl++' },
          { kind: 'item', label: 'Pomniejsz', command: 'view:zoom-out', icon: 'zoom_out', keys: 'Ctrl+−' },
          {
            kind: 'item',
            label: 'Rozmiar rzeczywisty',
            command: 'view:zoom-reset',
            icon: 'filter_center_focus',
            keys: 'Ctrl+0',
          },
          {
            kind: 'item',
            label: 'Dopasuj do okna',
            command: 'view:zoom-fit',
            icon: 'fit_screen',
            keys: 'Ctrl+9',
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: 'Siatka',
            command: 'view:toggle-grid',
            icon: 'grid_4x4',
            keys: 'Ctrl+Shift+H',
            checked: showGrid,
          },
          {
            kind: 'item',
            label: 'Podgląd na żywo',
            command: 'view:toggle-preview',
            icon: 'visibility',
            keys: 'Ctrl+P',
            checked: previewVisible,
          },
          {
            kind: 'item',
            label: 'Panel logów',
            command: 'view:toggle-console',
            icon: 'list_alt',
            keys: 'Ctrl+Shift+L',
            checked: consoleVisible,
          },
          {
            kind: 'item',
            label: 'Terminal',
            command: 'view:toggle-terminal',
            icon: 'terminal',
            keys: 'Ctrl+`',
            checked: terminalVisible,
          },
          { kind: 'separator' },
          {
            kind: 'item',
            label: theme === 'dark' ? 'Motyw jasny' : 'Motyw ciemny',
            command: 'view:toggle-theme',
            icon: theme === 'dark' ? 'light_mode' : 'dark_mode',
            keys: 'Ctrl+Shift+T',
          },
          {
            kind: 'item',
            label: 'Pełny ekran',
            command: 'view:toggle-fullscreen',
            icon: 'fullscreen',
            keys: 'F11',
          },
        ],
      },
      /*
       * Windows-only, and omitted rather than disabled elsewhere — the native
       * menu does the same (see menu.ts). A permanently greyed "Narzędzia AI…"
       * on Linux would advertise something that build cannot do.
       *
       * Column 0 for the reason stated on `MenuSection.column`: it is the short
       * one. Placed in column 2 this sat below Widok, which is already the
       * longest list — the panel grew a section taller than either neighbour and
       * left a block of dead space under Projekt and Edycja. Here it fills that
       * space instead of creating more, and the three columns come out level.
       */
      ...(isWindows
        ? ([
            {
              title: 'Narzędzia',
              column: 0,
              entries: [
                {
                  kind: 'item',
                  label: 'Narzędzia AI…',
                  command: 'tools:ai-installer',
                  icon: 'bolt',
                },
              ],
            },
          ] as const satisfies readonly MenuSection[])
        : []),
      {
        title: 'Pomoc',
        column: 0,
        entries: [
          {
            kind: 'item',
            label: 'Skróty klawiszowe',
            command: 'help:shortcuts',
            icon: 'keyboard',
            keys: 'Ctrl+/',
          },
          { kind: 'item', label: 'Kontakt', command: 'help:contact', icon: 'contact_mail' },
        ],
      },
    ],
    [
      canPaste,
      canRedo,
      canUndo,
      consoleVisible,
      hasSelection,
      previewVisible,
      project,
      showGrid,
      terminalVisible,
      theme,
    ],
  );

  /* Dismissal: a click anywhere else. */
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node)) return;
      if (triggerRef.current?.contains(event.target as Node)) return;
      onClose(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [onClose, ref, triggerRef]);

  /**
   * Escape, caught on the window in the *capture* phase.
   *
   * It cannot ride on the panel's own `onKeyDown`, because the app already has
   * a global Escape: `handleEditorKeydown` clears the canvas selection. That
   * listener sits on the window in the bubble phase, so it would run whether or
   * not the menu was open — closing the menu *and* silently deselecting the
   * element the user was working on. Capturing first and stopping propagation
   * is what makes Escape mean one thing at a time.
   */
  useEffect(() => {
    const onKeyDownCapture = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => window.removeEventListener('keydown', onKeyDownCapture, true);
  }, [onClose]);

  /*
   * Focus lands on the first item, so the menu is usable from the keyboard the
   * moment it opens rather than after a Tab the user has to guess at.
   *
   * Deliberately keyed on the committed `style`, not on mount. The panel is
   * rendered `visibility: hidden` for one pass so `useClampedMenuPosition` can
   * measure it, and `focus()` on a hidden element is a silent no-op — the first
   * version of this focused nothing at all, and Escape then went to the global
   * handler instead of to the menu.
   */
  useEffect(() => {
    if (style.visibility === 'hidden') return;
    ref.current?.querySelector<HTMLButtonElement>('.app-menu__item:not(:disabled)')?.focus();
  }, [ref, style]);

  /**
   * Arrow keys walk the *enabled* items in reading order — including across the
   * column break, which is what makes a three-column panel still behave like
   * one menu rather than three lists that trap the caret.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;

    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('.app-menu__item:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();

    if (event.key === 'Home') {
      items[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      items[items.length - 1]?.focus();
      return;
    }

    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = current === -1 ? 0 : (current + step + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      className="app-menu__panel"
      style={style}
      role="menu"
      aria-label="Menu aplikacji"
      onKeyDown={onKeyDown}
    >
      {COLUMNS.map((column) => (
        <div className="app-menu__column" key={column}>
          {sections
            .filter((section) => section.column === column)
            .map((section) => (
              <section className="app-menu__section" key={section.title}>
                <h2 className="app-menu__section-title">{section.title}</h2>
                {section.entries.map((entry, index) =>
                  entry.kind === 'separator' ? (
                    // eslint-disable-next-line react/no-array-index-key
                    <div className="app-menu__separator" key={`sep-${index}`} role="separator" />
                  ) : (
                    <button
                      key={entry.command}
                      type="button"
                      role="menuitem"
                      className="app-menu__item"
                      disabled={entry.disabled}
                      aria-checked={entry.checked}
                      onClick={() => {
                        onClose(false);
                        executeMenuCommand(entry.command);
                      }}
                    >
                      <Icon name={entry.icon} size={16} />
                      <span className="app-menu__label">{entry.label}</span>
                      {entry.checked ? <Icon name="check" size={15} className="app-menu__check" /> : null}
                      {entry.keys ? <kbd className="app-menu__keys">{entry.keys}</kbd> : null}
                    </button>
                  ),
                )}
              </section>
            ))}
        </div>
      ))}
    </div>
  );
}
