import { useEditorStore } from '@/state/editorStore.js';
import { useHistoryStore } from '@/state/historyStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { AppMenu } from './AppMenu.js';
import { Logo } from './Logo.js';
import { PageSwitcher } from './PageSwitcher.js';
import { ZoomControl } from './ZoomControl.js';
import { Icon, type IconName } from './Icon.js';

/**
 * The top bar: page switcher, history, zoom, view toggles and the save
 * indicator.
 *
 * The save indicator is the most important control here even though it is not
 * a button — the product has no "Save" and no "Export", so the user needs
 * continuous, unambiguous feedback that their files on disk are current.
 *
 * Layout is brand · tools · status, in three grid tracks, and the *tools* track
 * is the one that scrolls. That ordering is not cosmetic: it is what stops the
 * bar from overlapping itself when the window is restored down from maximised.
 * The tool row is the only region that grows without bound (page picker +
 * undo/redo + zoom + four toggles), so it must be the only region allowed to
 * give ground; brand and status sit in `auto` tracks that can never be squeezed
 * under it. See `.toolbar` in app.css.
 */
export function Toolbar(): JSX.Element {
  const project = useEditorStore((state) => state.project);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);
  const openPage = useEditorStore((state) => state.openPage);
  const openNewPageDialog = useUiStore((state) => state.openNewPageDialog);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const dirty = useEditorStore((state) => state.dirty);
  const saving = useEditorStore((state) => state.saving);
  const lastSavedAt = useEditorStore((state) => state.lastSavedAt);
  const saveError = useEditorStore((state) => state.saveError);

  const canUndo = useHistoryStore((state) => state.cursor > 0);
  const canRedo = useHistoryStore((state) => state.cursor < state.entries.length);
  const undoLabel = useHistoryStore((state) => state.entries[state.cursor - 1]?.label ?? null);
  const redoLabel = useHistoryStore((state) => state.entries[state.cursor]?.label ?? null);

  const zoomBy = useUiStore((state) => state.zoomBy);
  const zoomMode = useUiStore((state) => state.zoomMode);
  const fitZoom = useUiStore((state) => state.fitZoom);
  const showGrid = useUiStore((state) => state.showGrid);
  const toggleGrid = useUiStore((state) => state.toggleGrid);
  const previewVisible = useUiStore((state) => state.previewVisible);
  const togglePreview = useUiStore((state) => state.togglePreview);
  const consoleVisible = useUiStore((state) => state.consoleVisible);
  const toggleConsole = useUiStore((state) => state.toggleConsole);
  const terminalVisible = useUiStore((state) => state.terminalVisible);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);

  const save = describeSaveState({ dirty, saving, lastSavedAt, saveError });

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        {/* The app's own menu, and on Windows/Linux the only one — the platform
            menu bar is hidden on both. See AppMenu.tsx. */}
        <AppMenu />
        <Logo className="toolbar__logo" />
        <span className="toolbar__wordmark">Litho Studio</span>
      </div>

      <div className="toolbar__side toolbar__side--left">
        {project ? (
          <div className="toolbar__group">
            <PageSwitcher
              pages={project.pages}
              currentRelPath={pageRelPath}
              onPick={(relPath) => void openPage(relPath)}
            />

            <button
              type="button"
              className="button button--icon"
              onClick={openNewPageDialog}
              title="Utwórz nową podstronę w tym folderze"
              aria-label="Nowa strona"
            >
              <Icon name="note_add" />
            </button>
          </div>
        ) : null}

        <div className="toolbar__separator" />

        <div className="toolbar__group toolbar__group--joined">
          <button
            type="button"
            className="button button--icon"
            onClick={undo}
            disabled={!canUndo}
            title={undoLabel ? `Cofnij: ${undoLabel} (Ctrl+Z)` : 'Cofnij (Ctrl+Z)'}
            aria-label="Cofnij"
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="button button--icon"
            onClick={redo}
            disabled={!canRedo}
            title={redoLabel ? `Ponów: ${redoLabel} (Ctrl+Shift+Z)` : 'Ponów (Ctrl+Shift+Z)'}
            aria-label="Ponów"
          >
            <Icon name="redo" />
          </button>
        </div>

        <div className="toolbar__separator" />

        <div className="toolbar__group toolbar__group--joined">
          <button
            type="button"
            className="button button--icon"
            onClick={() => zoomBy(1 / 1.25)}
            aria-label="Pomniejsz"
            title="Pomniejsz"
          >
            <Icon name="zoom_out" />
          </button>
          <ZoomControl />
          <button
            type="button"
            className="button button--icon"
            onClick={() => zoomBy(1.25)}
            aria-label="Powiększ"
            title="Powiększ"
          >
            <Icon name="zoom_in" />
          </button>
          <button
            type="button"
            className="button button--icon"
            aria-pressed={zoomMode === 'fit'}
            onClick={fitZoom}
            title="Dopasuj szerokość strony do okna edytora"
            aria-label="Dopasuj"
          >
            <Icon name="fit_screen" />
          </button>
        </div>

        <div className="toolbar__separator" />

        <div className="toolbar__group">
          <ToggleButton
            icon="grid_4x4"
            label="Siatka"
            active={showGrid}
            onClick={toggleGrid}
            title="Siatka (Ctrl+Shift+H)"
          />
          <ToggleButton
            icon="visibility"
            label="Podgląd"
            active={previewVisible}
            onClick={togglePreview}
            title="Podgląd na żywo (Ctrl+P)"
          />
          <ToggleButton
            icon="list_alt"
            label="Logi"
            active={consoleVisible}
            onClick={toggleConsole}
            title="Panel logów (Ctrl+Shift+L)"
          />
          <ToggleButton
            icon="terminal"
            label="Terminal"
            active={terminalVisible}
            onClick={toggleTerminal}
            title="Terminal (Ctrl+`)"
          />
        </div>
      </div>

      <div className="toolbar__side toolbar__side--right">
        <span
          className={`toolbar__status toolbar__status--${save.tone}`}
          role="status"
          aria-live="polite"
          title={save.text}
        >
          <Icon name={save.icon} size={15} />
          {save.text}
        </span>

        <button
          type="button"
          className="button button--icon"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Przełącz na jasny motyw' : 'Przełącz na ciemny motyw'}
          title="Przełącz motyw (Ctrl+Shift+T)"
        >
          <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} />
        </button>
      </div>
    </header>
  );
}

/**
 * A view toggle. The label is wrapped so a narrow window can drop it to the
 * icon alone (see the 1240 px media query) while `title`/`aria-label` keep the
 * control named for tooltips and screen readers alike.
 */
function ToggleButton({
  icon,
  label,
  active,
  onClick,
  title,
}: {
  icon: IconName;
  label: string;
  active: boolean;
  onClick: () => void;
  title: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`button${active ? ' button--active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={title}
    >
      <Icon name={icon} />
      <span className="toolbar__toggle-label">{label}</span>
    </button>
  );
}

interface SaveState {
  text: string;
  icon: IconName;
  /** `idle` is the neutral chip: nothing has been written yet, so nothing to
   *  reassure the user about — a green "saved" tint there would be a claim the
   *  editor cannot back up. */
  tone: 'idle' | 'saved' | 'saving' | 'pending' | 'error';
}

function describeSaveState({
  dirty,
  saving,
  lastSavedAt,
  saveError,
}: {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  saveError: string | null;
}): SaveState {
  if (saveError) return { text: `Błąd zapisu: ${saveError}`, icon: 'error', tone: 'error' };
  if (saving) return { text: 'Zapisywanie…', icon: 'sync', tone: 'saving' };
  if (dirty) return { text: 'Niezapisane zmiany', icon: 'pending', tone: 'pending' };
  if (lastSavedAt === null) return { text: 'Gotowe', icon: 'check', tone: 'idle' };
  const date = new Date(lastSavedAt);
  return {
    text: `Zapisano ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    icon: 'cloud_done',
    tone: 'saved',
  };
}
