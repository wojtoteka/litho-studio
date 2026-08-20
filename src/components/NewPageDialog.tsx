import { useEffect, useRef, useState } from 'react';
import type { ProjectSnapshot } from '@shared/project.js';

/**
 * "New page" dialog: asks for a name, then creates `<name>.html` in the open
 * project's root with the same starter skeleton `NewProjectDialog` scaffolds,
 * and reports the resulting snapshot plus the page's relative path so the
 * caller can open it as a tab.
 */
export function NewPageDialog({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (snapshot: ProjectSnapshot, relPath: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const slug = slugify(name);
    if (slug === '') {
      setError('Podaj nazwę podstrony, np. "o-nas" albo "kontakt".');
      return;
    }

    setBusy(true);
    setError(null);
    const result = await window.litho.project.createPage(slug, name.trim());
    setBusy(false);

    if (result.ok) onCreated(result.value, `${slug}.html`);
    else setError(result.message);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-page-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h2 className="dialog__title" id="new-page-title">
          Nowa strona
        </h2>
        <p className="dialog__hint">
          Powstanie plik <code>{slugify(name) || 'nazwa'}.html</code> w folderze projektu, od razu gotowy do
          edycji.
        </p>

        <div className="dialog__fields">
          <label className="field">
            <span className="field__label">Nazwa podstrony</span>
            <input
              ref={nameRef}
              className="input"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="np. o-nas"
              required
              maxLength={100}
            />
          </label>
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
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Tworzenie…' : 'Utwórz stronę'}
          </button>
        </div>
      </form>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.html?$/u, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}
