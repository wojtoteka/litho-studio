import { useEffect, useRef, useState } from 'react';
import type { ProjectSnapshot } from '@shared/project.js';
import { useEditorStore } from '@/state/editorStore.js';

/**
 * New-project dialog.
 *
 * A new project is a folder with `index.html`, `style.css` and `script.js` in
 * it - nothing else, no manifest, no hidden state. That is deliberate: the
 * folder a user creates here is indistinguishable from one they wrote by hand,
 * which is exactly what makes it openable by anything else.
 */
export function NewProjectDialog({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (snapshot: ProjectSnapshot) => void;
}): JSX.Element {
  const [name, setName] = useState('moja-strona');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const chooseFolder = async (): Promise<void> => {
    const result = await window.litho.project.chooseParentDialog();
    if (result.ok) {
      setParentPath(result.value);
      setError(null);
    } else if (result.code !== 'CANCELLED') {
      setError(result.message);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!parentPath) {
      setError('Wybierz najpierw lokalizację projektu.');
      return;
    }
    setBusy(true);
    setError(null);

    // A project may already be open with a save still debouncing; it must land
    // before its IPC session is replaced by the newly created project's.
    await useEditorStore.getState().flushSave();

    const result = await window.litho.project.create(parentPath, name.trim());
    setBusy(false);

    if (result.ok) onCreated(result.value);
    else setError(result.message);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h2 className="dialog__title" id="new-project-title">
          Nowy projekt
        </h2>
        <p className="dialog__hint">
          Powstanie zwykły folder ze stroną - możesz go od razu otworzyć w VS Code albo wrzucić na hosting.
        </p>

        <div className="dialog__fields">
          <label className="field">
            <span className="field__label">Nazwa folderu</span>
            <input
              ref={nameRef}
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={100}
            />
          </label>

          <div className="field">
            <span className="field__label">Lokalizacja</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                type="text"
                value={parentPath ?? ''}
                readOnly
                placeholder="Nie wybrano"
              />
              <button type="button" className="button" onClick={() => void chooseFolder()}>
                Wybierz…
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)', marginTop: 10 }}>
            {error}
          </p>
        ) : null}

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>
            Anuluj
          </button>
          <button type="submit" className="button button--primary" disabled={busy || !parentPath}>
            {busy ? 'Tworzenie…' : 'Utwórz projekt'}
          </button>
        </div>
      </form>
    </div>
  );
}
