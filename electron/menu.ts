import { Menu, app, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { CONTACT_URL, IPC, type MenuCommand } from '@shared/ipc.js';
import { AI_TOOLS_PLATFORM } from '@shared/aiTools.js';

/**
 * The native application menu.
 *
 * Menu items do not act on the document directly - they emit a `MenuCommand`
 * that the renderer's command registry handles, which is the same path the
 * keyboard shortcuts take. One implementation, two entry points.
 *
 * On Windows and Linux this menu is built but its *bar* is never shown (see
 * `setMenuBarVisibility` in main.ts). That bar is drawn by the platform, so it
 * answers to the desktop's own font, metrics and colours rather than to this
 * app's - on a dark editor it reads as a strip of some other program bolted above
 * the toolbar, and on Windows it was a second menu holding exactly what the
 * toolbar's own already held. The renderer draws the same tree itself
 * (`AppMenu.tsx`); keeping the native menu registered anyway is what keeps
 * `Projekt`'s real accelerators (Ctrl+O, Ctrl+Shift+N…) alive, since those are
 * the only ones this app does not implement in its own key handler. Only macOS
 * still shows a bar, because there it is the system-wide one at the top of the
 * screen and not a strip inside the window.
 *
 * Edit and view items carry `registerAccelerator: false`: a *registered*
 * accelerator is consumed before the renderer ever sees the key, so Ctrl+C in
 * a properties-panel text field would copy the selected element instead of the
 * text, and Delete while typing would delete the element. With registration
 * off the accelerator is display-only and the renderer's keydown handler -
 * which knows whether focus is in a text field - implements the behaviour.
 */

export function buildApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin';

  const emit = (command: MenuCommand) => () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(IPC.eventMenuCommand, command);
  };

  /** A command item whose accelerator is a hint, not a global key grab. */
  const soft = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: emit(command),
  });

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Projekt',
    submenu: [
      { label: 'Nowy projekt…', accelerator: 'CmdOrCtrl+Shift+N', click: emit('project:new') },
      { label: 'Otwórz folder…', accelerator: 'CmdOrCtrl+O', click: emit('project:open') },
      { label: 'Otwórz pliki…', accelerator: 'CmdOrCtrl+Shift+O', click: emit('project:open-file') },
      { type: 'separator' },
      { label: 'Zamknij projekt', accelerator: 'CmdOrCtrl+Shift+W', click: emit('project:close') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'Zakończ' },
    ],
  });

  template.push({
    label: 'Edycja',
    submenu: [
      soft('Cofnij', 'CmdOrCtrl+Z', 'edit:undo'),
      soft('Ponów', 'CmdOrCtrl+Shift+Z', 'edit:redo'),
      { type: 'separator' },
      soft('Wytnij', 'CmdOrCtrl+X', 'edit:cut'),
      soft('Kopiuj', 'CmdOrCtrl+C', 'edit:copy'),
      soft('Wklej', 'CmdOrCtrl+V', 'edit:paste'),
      soft('Duplikuj', 'CmdOrCtrl+D', 'edit:duplicate'),
      soft('Usuń', 'Delete', 'edit:delete'),
      { type: 'separator' },
      soft('Zaznacz wszystko', 'CmdOrCtrl+A', 'edit:select-all'),
      soft('Grupuj', 'CmdOrCtrl+G', 'edit:group'),
      soft('Rozgrupuj', 'CmdOrCtrl+Shift+G', 'edit:ungroup'),
    ],
  });

  template.push({
    label: 'Widok',
    submenu: [
      soft('Powiększ', 'CmdOrCtrl+Plus', 'view:zoom-in'),
      soft('Pomniejsz', 'CmdOrCtrl+-', 'view:zoom-out'),
      soft('Rozmiar rzeczywisty', 'CmdOrCtrl+0', 'view:zoom-reset'),
      soft('Dopasuj do okna', 'CmdOrCtrl+9', 'view:zoom-fit'),
      { type: 'separator' },
      soft('Siatka', 'CmdOrCtrl+Shift+H', 'view:toggle-grid'),
      soft('Podgląd na żywo', 'CmdOrCtrl+P', 'view:toggle-preview'),
      soft('Panel logów', 'CmdOrCtrl+Shift+L', 'view:toggle-console'),
      soft('Terminal', 'CmdOrCtrl+`', 'view:toggle-terminal'),
      soft('Przełącz motyw', 'CmdOrCtrl+Shift+T', 'view:toggle-theme'),
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Pełny ekran' },
      ...(app.isPackaged
        ? []
        : ([{ role: 'toggleDevTools', label: 'Narzędzia deweloperskie' }] as MenuItemConstructorOptions[])),
    ],
  });

  /*
   * "Narzędzia" exists only where it has something in it. The AI installer is
   * Windows-only (see `AI_TOOLS_PLATFORM`), and a menu holding one permanently
   * greyed-out item is worse than no menu - it advertises a feature the build
   * does not have. The in-app menu (`AppMenu.tsx`) hides its copy on the same
   * condition.
   */
  if (process.platform === AI_TOOLS_PLATFORM) {
    template.push({
      label: 'Narzędzia',
      submenu: [{ label: 'Narzędzia AI…', click: emit('tools:ai-installer') }],
    });
  }

  template.push({
    label: 'Pomoc',
    submenu: [
      soft('Skróty klawiszowe', 'CmdOrCtrl+/', 'help:shortcuts'),
      { type: 'separator' },
      { label: 'Kontakt', click: () => void shell.openExternal(CONTACT_URL) },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
