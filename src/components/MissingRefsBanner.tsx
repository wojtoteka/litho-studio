import { useEffect, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import type { MissingReference } from '@/engine/htmlParser.js';
import { Icon } from './Icon.js';

/**
 * Repair strip for broken local CSS/JS references.
 *
 * The page links a stylesheet or script that is not where the link says. The
 * parser has already ranked the project's files as candidates; this banner
 * shows them and lets the user pick the right one - the chosen path is written
 * back into the HTML as a relative href/src. Never automatic: a wrong guess
 * would silently restyle the page with the wrong file.
 */
export function MissingRefsBanner(): JSX.Element | null {
  const missingRefs = useEditorStore((state) => state.missingRefs);
  const fixReference = useEditorStore((state) => state.fixReference);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Dismissals are per page: switching pages (or reloading one) resets them.
  useEffect(() => {
    setDismissed(new Set());
    setChoices({});
  }, [pageRelPath]);

  const visible = missingRefs.filter((ref) => !dismissed.has(refKey(ref)));
  if (visible.length === 0) return null;

  const dismiss = (ref: MissingReference): void => {
    setDismissed((current) => new Set(current).add(refKey(ref)));
  };

  const repair = async (ref: MissingReference): Promise<void> => {
    const chosen = choices[refKey(ref)] ?? ref.candidates[0];
    if (!chosen) return;
    setBusy(true);
    try {
      await fixReference(ref.hostNodeId, chosen);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="missing-refs" role="region" aria-label="Brakujące pliki CSS i JS">
      {visible.map((ref) => (
        <div key={refKey(ref)} className="missing-refs__item">
          <span className="missing-refs__text">
            <Icon name="error" size={16} />
            <span>
              {ref.kind === 'css' ? 'Arkusz stylów' : 'Skrypt'} <code>{ref.href}</code> nie istnieje
              {ref.candidates.length > 0 ? ' - wybierz właściwy plik:' : '.'}
            </span>
          </span>

          {ref.candidates.length > 0 ? (
            <>
              <select
                className="select missing-refs__select"
                value={choices[refKey(ref)] ?? ref.candidates[0]}
                onChange={(event) =>
                  setChoices((current) => ({ ...current, [refKey(ref)]: event.target.value }))
                }
                aria-label={`Plik zastępujący ${ref.href}`}
              >
                {ref.candidates.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void repair(ref)}
              >
                Napraw odnośnik
              </button>
            </>
          ) : (
            <span className="missing-refs__text">Brak pasujących plików w projekcie.</span>
          )}

          <button
            type="button"
            className="button button--ghost"
            onClick={() => dismiss(ref)}
            aria-label={`Pomiń problem z ${ref.href}`}
          >
            Pomiń
          </button>
        </div>
      ))}
    </div>
  );
}

function refKey(ref: MissingReference): string {
  return `${ref.kind}:${ref.hostNodeId}:${ref.href}`;
}
