import { useCallback, useMemo, useRef, useState } from 'react';
import { useEditorStore, type StyleSheetInfo } from '@/state/editorStore.js';
import { logger } from '@/lib/logger.js';
import { Icon } from '../Icon.js';

/**
 * Stylesheet manager for the open page.
 *
 * Uploading a `.css` copies it into the project folder (never references it
 * from wherever it happened to live - the folder has to stay uploadable to any
 * host as-is), appends a real `<link rel="stylesheet">` to the page's `<head>`
 * and re-parses the page. From that moment the sheet is an ordinary part of the
 * project: it renders on the canvas and in the preview, its class names appear
 * in the properties panel's class picker, and nothing in the file marks it as
 * "imported by Litho".
 *
 * The new link goes *last*, which is what makes an uploaded theme actually take
 * effect - and it also becomes the sheet new rules are written into, so edits
 * made in the properties panel can still override it without `!important`.
 */
export function StyleSheetsSection(): JSX.Element {
  const pageStyleSheets = useEditorStore((state) => state.pageStyleSheets);
  const unlinkedStyleSheets = useEditorStore((state) => state.unlinkedStyleSheets);
  const attachStyleSheet = useEditorStore((state) => state.attachStyleSheet);
  const detachStyleSheet = useEditorStore((state) => state.detachStyleSheet);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);
  // Both arrays are replaced wholesale when a page is re-parsed; `revision`
  // covers the in-place edits that change a sheet's contents without swapping
  // the array reference (see the note at the top of editorStore).
  const styleModels = useEditorStore((state) => state.styleModels);
  const files = useEditorStore((state) => state.files);
  const revision = useEditorStore((state) => state.revision);

  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheets = useMemo(
    () => pageStyleSheets(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageStyleSheets, styleModels, revision],
  );
  const unlinked = useMemo(
    () => unlinkedStyleSheets(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unlinkedStyleSheets, styleModels, files, revision],
  );

  const upload = useCallback(async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError(null);
    const problems = await importCssFiles(Array.from(list));
    setError(problems.length > 0 ? problems.join(' · ') : null);
    setBusy(false);
  }, []);

  const attach = useCallback(
    async (relPath: string): Promise<void> => {
      setBusy(true);
      setError(null);
      const result = await attachStyleSheet(relPath);
      if (!result.ok) setError(result.message);
      setBusy(false);
    },
    [attachStyleSheet],
  );

  const detach = useCallback(
    async (hostNodeId: string): Promise<void> => {
      setBusy(true);
      setError(null);
      const result = await detachStyleSheet(hostNodeId);
      if (!result.ok) setError(result.message);
      setBusy(false);
    },
    [detachStyleSheet],
  );

  if (!pageRelPath) {
    return <p className="dialog__hint">Otwórz stronę, aby zarządzać jej arkuszami stylów.</p>;
  }

  return (
    <div className="sheets">
      <div className="sheets__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <Icon name="upload_file" size={15} />
          Wgraj plik CSS…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".css,text/css"
          multiple
          style={{ display: 'none' }}
          aria-label="Wybierz plik CSS"
          onChange={(event) => {
            void upload(event.target.files);
            // Clearing lets the same file be picked again after a failure.
            event.target.value = '';
          }}
        />
      </div>

      {error ? (
        <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}

      <p className="dialog__hint">Arkusze używane przez tę stronę:</p>
      <ul className="sheet-list">
        {sheets.length === 0 ? (
          <li className="sheet-list__empty">Ta strona nie ma jeszcze żadnych stylów.</li>
        ) : (
          sheets.map((sheet) => (
            <li key={sheet.id} className="sheet-list__item">
              <Icon name={sheet.remote ? 'code' : 'style'} size={16} />
              <div className="sheet-list__main">
                <span className="sheet-list__name" title={sheet.label}>
                  {sheet.label}
                </span>
                <span className="sheet-list__meta">{describeSheet(sheet)}</span>
              </div>
              {sheet.origin === 'external' && sheet.hostNodeId !== null ? (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => void detach(sheet.hostNodeId!)}
                  title="Usuwa tylko odwołanie ze strony - plik zostaje w projekcie"
                >
                  Odłącz
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {unlinked.length > 0 ? (
        <>
          <p className="dialog__hint">Pliki CSS w projekcie, z których ta strona nie korzysta:</p>
          <ul className="sheet-list">
            {unlinked.map((relPath) => (
              <li key={relPath} className="sheet-list__item">
                <Icon name="draft" size={16} />
                <div className="sheet-list__main">
                  <span className="sheet-list__name" title={relPath}>
                    {relPath}
                  </span>
                </div>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => void attach(relPath)}
                >
                  Podłącz
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function describeSheet(sheet: StyleSheetInfo): string {
  if (sheet.remote) return 'zdalny (CDN) - renderowany, ale nieedytowalny';

  const parts: string[] = [];
  if (sheet.origin === 'embedded') parts.push('wpisany w HTML');
  parts.push(sheet.classCount === 1 ? '1 klasa' : `${sheet.classCount} klas`);
  if (sheet.isTarget) parts.push('tu trafiają nowe style');
  else if (!sheet.writable) parts.push('tylko do odczytu');
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ */
/* Shared with the assets drop zone                                     */
/* ------------------------------------------------------------------ */

export function isCssFile(file: File): boolean {
  return file.type === 'text/css' || /\.css$/iu.test(file.name);
}

/**
 * Imports uploaded stylesheets one at a time and returns the failures as
 * user-readable strings. Sequential on purpose: each import re-parses the page,
 * and two of those racing would have the second one build its `<link>` against
 * a document that is about to be replaced.
 */
export async function importCssFiles(files: File[]): Promise<string[]> {
  const problems: string[] = [];

  for (const file of files) {
    try {
      const css = await file.text();
      const result = await useEditorStore.getState().importStyleSheet(file.name, css);
      if (result.ok) logger.info(`Dodano arkusz stylów ${result.value}`);
      else problems.push(`${file.name}: ${result.message}`);
    } catch (error) {
      logger.error(`Nie udało się wczytać ${file.name}`, error);
      problems.push(`${file.name}: nie udało się odczytać pliku.`);
    }
  }

  return problems;
}
