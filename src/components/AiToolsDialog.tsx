import { useEffect, useRef } from 'react';
import { AI_TOOLS, describeInstallCommand, type AiToolSpec } from '@shared/aiTools.js';
import { useAiToolsStore } from '@/state/aiToolsStore.js';
import { Icon, type IconName } from './Icon.js';

/**
 * Auto-Installer of AI tools.
 *
 * Four vendor CLIs, one row each, with the exact command shown before it runs.
 * Windows-only — the reasoning is on `AI_TOOLS_PLATFORM` in `shared/aiTools.ts`,
 * and the main process refuses the operation elsewhere regardless of what this
 * component draws.
 *
 * ## The alignment this replaces
 *
 * The previous version laid each row out as its own flex line, so every row
 * measured its own name, its own status text and its own button independently —
 * and the buttons landed wherever the text to their left happened to end. Four
 * install buttons at four different x positions, on a list whose whole job is to
 * be scanned down one column.
 *
 * This is a single grid: `.ai-tools` owns the three column widths and every row
 * inherits them through `grid-template-columns: subgrid`, so the action column is
 * one column across the whole list by construction rather than by four rows
 * agreeing. The action track has a fixed width and the button fills it, which is
 * the other half of the same problem: the label changes with state ("Zainstaluj"
 * → "Aktualizuj" → "Przerwij") and a button sized to its own text would resize
 * under the pointer at the moment it was clicked.
 *
 * Closing the dialog does not stop an install: the process lives in the main
 * process and the progress lives in `aiToolsStore`, so reopening picks the same
 * state back up.
 */
export function AiToolsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const supported = useAiToolsStore((state) => state.supported);
  const statuses = useAiToolsStore((state) => state.statuses);
  const detecting = useAiToolsStore((state) => state.detecting);
  const installing = useAiToolsStore((state) => state.installing);
  const errors = useAiToolsStore((state) => state.errors);
  const output = useAiToolsStore((state) => state.output);
  const activeTool = useAiToolsStore((state) => state.activeTool);
  const initialise = useAiToolsStore((state) => state.initialise);
  const refresh = useAiToolsStore((state) => state.refresh);
  const install = useAiToolsStore((state) => state.install);
  const cancel = useAiToolsStore((state) => state.cancel);
  const select = useAiToolsStore((state) => state.select);

  const anyInstalling = AI_TOOLS.some((tool) => installing[tool.id]);

  useEffect(() => {
    void initialise();
  }, [initialise]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const activeOutput = activeTool ? (output[activeTool] ?? '') : '';
  const activeName = activeTool ? (AI_TOOLS.find((tool) => tool.id === activeTool)?.name ?? '') : '';

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-tools-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id="ai-tools-title">
          <Icon name="bolt" size={20} />
          Narzędzia AI
        </h2>
        <p className="dialog__hint">
          Instaluje agenty AI działające w terminalu. Każde z nich pracuje potem na plikach otwartego projektu
          — wbudowany terminal (Ctrl+`) podchwytuje zmiany na bieżąco.
        </p>

        {supported === false ? (
          <p className="dialog__hint" role="status" style={{ color: 'var(--warning)' }}>
            Auto-Installer działa tylko w wersji dla Windows. Na innych systemach zainstaluj te narzędzia z
            wbudowanego terminala — polecenia widać przy każdej pozycji poniżej.
          </p>
        ) : null}

        <ul className="ai-tools">
          {AI_TOOLS.map((tool) => (
            <AiToolRow
              key={tool.id}
              tool={tool}
              busy={installing[tool.id] === true}
              installed={statuses?.[tool.id]?.installed === true}
              version={statuses?.[tool.id]?.version ?? null}
              path={statuses?.[tool.id]?.path ?? null}
              error={errors[tool.id]}
              detecting={detecting && statuses === null}
              disabled={supported !== true}
              onInstall={() => void install(tool.id)}
              onCancel={() => void cancel(tool.id)}
              onSelect={() => select(tool.id)}
            />
          ))}
        </ul>

        {activeTool && activeOutput !== '' ? <OutputPane name={activeName} text={activeOutput} /> : null}

        <div className="dialog__actions">
          <button
            type="button"
            className="button"
            onClick={() => void refresh()}
            disabled={detecting || supported !== true}
          >
            <Icon name="refresh" size={16} />
            {detecting ? 'Sprawdzanie…' : 'Sprawdź ponownie'}
          </button>
          <button type="button" className="button button--primary" onClick={onClose}>
            {anyInstalling ? 'Ukryj (instalacja trwa)' : 'Zamknij'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  tool: AiToolSpec;
  busy: boolean;
  installed: boolean;
  version: string | null;
  path: string | null;
  error: string | undefined;
  detecting: boolean;
  disabled: boolean;
  onInstall: () => void;
  onCancel: () => void;
  onSelect: () => void;
}

function AiToolRow({
  tool,
  busy,
  installed,
  version,
  path,
  error,
  detecting,
  disabled,
  onInstall,
  onCancel,
  onSelect,
}: RowProps): JSX.Element {
  const status = describeStatus({ busy, installed, version, detecting, error });

  return (
    <li className="ai-tools__row">
      <div className="ai-tools__main">
        <span className="ai-tools__name">
          {tool.name}
          <button
            type="button"
            className="button button--ghost button--icon ai-tools__link"
            title={`Otwórz stronę ${tool.name}`}
            aria-label={`Otwórz stronę ${tool.name}`}
            onClick={() => void window.litho.aiTools.openHomepage(tool.id)}
          >
            <Icon name="open_in_new" size={14} />
          </button>
        </span>
        <span className="ai-tools__desc">{tool.description}</span>
        {/* Stated up front, always — an installer that does not show its command
            is asking the user to trust a black box that writes outside the project. */}
        <code className="ai-tools__command">{describeInstallCommand(tool)}</code>
        {error ? (
          <span className="ai-tools__error" role="alert">
            <Icon name="error" size={14} />
            {error}
          </span>
        ) : null}
      </div>

      <span
        className={`ai-tools__status ai-tools__status--${status.tone}`}
        title={path ?? undefined}
        role="status"
      >
        <Icon name={status.icon} size={15} />
        {status.text}
      </span>

      <div className="ai-tools__action">
        {busy ? (
          <button type="button" className="button ai-tools__button" onClick={onCancel}>
            <Icon name="close" size={16} />
            Przerwij
          </button>
        ) : (
          <button
            type="button"
            className={`button ai-tools__button${installed ? '' : ' button--primary'}`}
            disabled={disabled}
            onClick={() => {
              onSelect();
              onInstall();
            }}
            title={
              installed ? `Uruchom ponownie: ${describeInstallCommand(tool)}` : describeInstallCommand(tool)
            }
          >
            <Icon name={installed ? 'refresh' : 'download'} size={16} />
            {installed ? 'Aktualizuj' : 'Zainstaluj'}
          </button>
        )}
      </div>
    </li>
  );
}

interface RowStatus {
  text: string;
  icon: IconName;
  tone: 'unknown' | 'installed' | 'missing' | 'busy' | 'error';
}

function describeStatus({
  busy,
  installed,
  version,
  detecting,
  error,
}: Pick<RowProps, 'busy' | 'installed' | 'version' | 'detecting' | 'error'>): RowStatus {
  if (busy) return { text: 'Instalowanie…', icon: 'sync', tone: 'busy' };
  if (detecting) return { text: 'Sprawdzanie…', icon: 'pending', tone: 'unknown' };
  // An error is worth showing next to the row, but not at the cost of the fact
  // that the tool *is* on the machine — a failed update of a working install
  // must not read as "not installed".
  if (installed) return { text: version ?? 'Zainstalowane', icon: 'check_circle', tone: 'installed' };
  if (error) return { text: 'Nie udało się', icon: 'error', tone: 'error' };
  return { text: 'Brak', icon: 'remove', tone: 'missing' };
}

/**
 * Live install output.
 *
 * Deliberately a plain scrolling `<pre>` and not an xterm instance: this is a
 * non-interactive log, npm emits no cursor control worth interpreting, and a
 * second terminal emulator in the app would be 250 kB to render text that is
 * already text.
 */
function OutputPane({ name, text }: { name: string; text: string }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null);

  // Follow the tail, the way a terminal does. Keyed on `text` so every chunk
  // scrolls; the user scrolling up is overridden, which is the right trade for a
  // log that is only interesting at the end.
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <section className="ai-tools__output" aria-label={`Wyjście instalacji: ${name}`}>
      <header className="ai-tools__output-title">
        <Icon name="terminal" size={14} />
        {name}
      </header>
      <pre className="ai-tools__output-body" ref={ref}>
        {text}
      </pre>
    </section>
  );
}
