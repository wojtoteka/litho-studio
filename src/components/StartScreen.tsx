import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RecentProject } from '@shared/project.js';
import { useEditorStore } from '@/state/editorStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { logger } from '@/lib/logger.js';
import { displayPath, relativeDay } from '@/lib/displayPath.js';
import { Logo } from './Logo.js';
import { Icon, type IconName } from './Icon.js';

/**
 * The screen shown when no project is open.
 *
 * Laid out as one left-aligned column rather than a centred stack. The centred
 * version put a 34 px gradient headline and three centred buttons above a
 * left-aligned list, so nothing in the composition shared an edge with anything
 * else, and the recents list had to be padded by exactly the width of its own
 * ✕ buttons to fake its way back onto the centre line. One column, one left
 * edge, and the alignment is a property of the layout instead of a correction
 * applied to it.
 *
 * "Open a folder" is the primary action, not "New project" - the product's
 * distinguishing promise is that it edits websites that already exist, so the
 * first thing the user sees should invite them to point it at one. It is the
 * first tile and the only one carrying the brand.
 */

interface StartAction {
  icon: IconName;
  label: string;
  hint: string;
  primary?: boolean;
  run: () => void;
}

export function StartScreen(): JSX.Element {
  const loadSnapshot = useEditorStore((state) => state.loadSnapshot);
  const openNewProjectDialog = useUiStore((state) => state.openNewProjectDialog);

  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshRecent = useCallback(async (): Promise<void> => {
    const result = await window.litho.project.recent();
    if (result.ok) setRecent(result.value);
  }, []);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  const openFolder = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.litho.project.openDialog();
    setBusy(false);

    if (result.ok) {
      loadSnapshot(result.value);
      return;
    }
    if (result.code === 'CANCELLED') return;
    setError(result.message);
    logger.warn(`Nie udało się otworzyć projektu: ${result.message}`);
  }, [loadSnapshot]);

  const openFile = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.litho.project.openFileDialog();
    setBusy(false);

    if (result.ok) {
      loadSnapshot(result.value.snapshot, result.value.openRelPath);
      return;
    }
    if (result.code === 'CANCELLED') return;
    setError(result.message);
    logger.warn(`Nie udało się otworzyć pliku: ${result.message}`);
  }, [loadSnapshot]);

  const openPath = useCallback(
    async (rootPath: string, filePath?: string): Promise<void> => {
      setBusy(true);
      setError(null);
      const result = await window.litho.project.open(rootPath, filePath);
      setBusy(false);

      if (result.ok) {
        loadSnapshot(result.value.snapshot, result.value.openRelPath);
        return;
      }
      setError(result.message);
      await refreshRecent();
    },
    [loadSnapshot, refreshRecent],
  );

  const forget = useCallback(async (rootPath: string): Promise<void> => {
    const result = await window.litho.project.forgetRecent(rootPath);
    if (result.ok) setRecent(result.value);
  }, []);

  const actions = useMemo<readonly StartAction[]>(
    () => [
      {
        icon: 'folder_open',
        label: 'Otwórz folder',
        hint: 'Cała strona z podstronami i grafiką',
        primary: true,
        run: () => void openFolder(),
      },
      {
        icon: 'description',
        label: 'Otwórz pliki',
        hint: 'Wybrane strony HTML z katalogu',
        run: () => void openFile(),
      },
      {
        icon: 'add_circle',
        label: 'Nowy projekt',
        hint: 'Pusty szkielet: HTML, CSS i JS',
        run: openNewProjectDialog,
      },
    ],
    [openFile, openFolder, openNewProjectDialog],
  );

  return (
    <div className="start">
      <div className="start__sheet">
        <header className="start__hero">
          <Logo className="start__logo" />
          <div>
            <h1 className="start__title">Litho Studio</h1>
            <p className="start__subtitle">
              Wizualny edytor stron WWW. Zmiany zapisują się natychmiast w plikach HTML, CSS i JS - bez
              formatu projektu i bez eksportu.
            </p>
          </div>
        </header>

        <div className="start__actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`start-action${action.primary ? ' start-action--primary' : ''}`}
              onClick={action.run}
              disabled={busy}
            >
              <Icon name={action.icon} size={22} className="start-action__icon" />
              <span className="start-action__label">{action.label}</span>
              <span className="start-action__hint">{action.hint}</span>
            </button>
          ))}
        </div>

        {error ? (
          <p className="start__error" role="alert">
            <Icon name="error" size={18} />
            {error}
          </p>
        ) : null}

        {recent.length > 0 ? (
          <section className="start__recent">
            <h2 className="start__section-title">Ostatnio otwierane</h2>
            <ul className="recent-list">
              {recent.map((entry) => (
                <RecentRow
                  key={entry.rootPath}
                  entry={entry}
                  busy={busy}
                  onOpen={openPath}
                  onForget={forget}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="start__credit">
          <span>
            Projekt i wykonanie{' '}
            <a href="https://wojtoteka.ovh" target="_blank" rel="noreferrer">
              Wojtoteka
            </a>{' '}
            2024-{new Date().getFullYear()}
          </span>
          <span className="start__version">v{window.litho.appVersion}</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * One entry in the recents list.
 *
 * Two lines, not one. Squeezing the folder name and its path onto a single row
 * meant the path began at a different x on every row - it started wherever the
 * name happened to end - so five entries read as five ragged fragments rather
 * than a list. Stacking them puts every path on the same left edge, and lets
 * the name keep the weight it needs to be the thing you actually scan for.
 */
function RecentRow({
  entry,
  busy,
  onOpen,
  onForget,
}: {
  entry: RecentProject;
  busy: boolean;
  onOpen: (rootPath: string, filePath?: string) => void;
  onForget: (rootPath: string) => void;
}): JSX.Element {
  const target = entry.filePath ?? entry.rootPath;
  const shown = displayPath(target, window.litho.homeDir);

  return (
    <li className={`recent${entry.available ? '' : ' recent--missing'}`}>
      <button
        type="button"
        className="recent__open"
        onClick={() => onOpen(entry.rootPath, entry.filePath)}
        disabled={!entry.available || busy}
        title={entry.available ? target : `Nie znaleziono: ${target}`}
      >
        <Icon
          name={entry.available ? (entry.filePath ? 'description' : 'folder') : 'error'}
          size={18}
          className="recent__icon"
        />
        <span className="recent__name">{entry.name}</span>
        <span className="recent__when">
          {entry.available ? relativeDay(entry.openedAt) : 'nie znaleziono'}
        </span>
        <span className="recent__path">{shown}</span>
      </button>

      <button
        type="button"
        className="recent__forget"
        onClick={() => onForget(entry.rootPath)}
        aria-label={`Usuń ${entry.name} z listy ostatnich`}
        title="Usuń z listy ostatnich"
      >
        <Icon name="close" size={16} />
      </button>
    </li>
  );
}
