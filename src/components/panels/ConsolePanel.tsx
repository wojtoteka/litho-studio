import { useEffect, useRef } from 'react';
import { useUiStore } from '@/state/uiStore.js';
import { useEditorStore } from '@/state/editorStore.js';
import { Icon } from '../Icon.js';

/**
 * The in-app console.
 *
 * Shows the same entries that go to the rotating log file, so a user reporting
 * a problem can read exactly what will be in the file they attach. Parser
 * notices for the current page are surfaced at the top, because those explain
 * why a page might look different from what the user expected (a missing
 * stylesheet, a script that could not be found).
 */
export function ConsolePanel(): JSX.Element {
  const logs = useUiStore((state) => state.logs);
  const clearLogs = useUiStore((state) => state.clearLogs);
  const toggleConsole = useUiStore((state) => state.toggleConsole);
  const notices = useEditorStore((state) => state.notices);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && pinnedToBottom.current) body.scrollTop = body.scrollHeight;
  }, [logs]);

  return (
    <section className="console" aria-label="Panel logów">
      <div className="panel__header">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="list_alt" size={15} />
          Konsola
        </span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void openLogFile()}
            title="Pokaż plik dziennika w Eksploratorze"
          >
            <Icon name="description" size={15} />
            Plik dziennika
          </button>
          <button type="button" className="button button--ghost" onClick={clearLogs} title="Wyczyść logi">
            <Icon name="delete_sweep" size={15} />
            Wyczyść
          </button>
          <button
            type="button"
            className="button button--ghost button--icon"
            onClick={toggleConsole}
            aria-label="Zamknij konsolę"
            title="Zamknij konsolę"
          >
            <Icon name="close" size={16} />
          </button>
        </span>
      </div>

      <div
        className="console__body"
        ref={bodyRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          pinnedToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
        }}
      >
        {notices.map((notice, index) => (
          <div key={`notice-${index}`} className="console__entry console__entry--warn">
            <span className="console__time">strona</span>
            <span>{notice}</span>
          </div>
        ))}

        {logs.length === 0 && notices.length === 0 ? (
          <div className="console__entry console__entry--info">
            <span>Brak wpisów.</span>
          </div>
        ) : null}

        {logs.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${index}`}
            className={`console__entry console__entry--${entry.level}`}
          >
            <span className="console__time">
              {entry.scope === 'canvas' ? 'strona' : formatTime(entry.timestamp)}
            </span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

async function openLogFile(): Promise<void> {
  // The log file lives in the OS app-data folder, outside any project, so a
  // dedicated channel reveals it — the project-scoped file APIs would refuse.
  await window.litho.log.reveal().catch(() => undefined);
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
