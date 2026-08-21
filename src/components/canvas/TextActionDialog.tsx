import { useEffect, useMemo, useRef, useState } from 'react';
import type { TextAction, TextActionContext } from '@/engine/richTextEditor.js';
import type { DynamicYearParams, LinkParams } from '@/engine/richTextEditor.js';
import { useFloatingLayer } from '@/lib/useFloatingLayer.js';

/**
 * Parameter form for a text action.
 *
 * Each action supplies its own defaults through `defaultParams`, so the dialog
 * opens pre-filled - selecting `wojtoteka.ovh` and choosing "Zamień na link"
 * needs zero typing. The form itself is keyed off the action id; a new action
 * that takes no parameters needs no case here and confirms immediately.
 */
export function TextActionDialog<Params>({
  action,
  context,
  onCancel,
  onConfirm,
}: {
  action: TextAction<Params>;
  context: TextActionContext;
  onCancel: () => void;
  onConfirm: (params: Params) => void;
}): JSX.Element {
  const defaults = useMemo(() => action.defaultParams(context), [action, context]);
  const [params, setParams] = useState<Params>(defaults);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  /*
   * The other dialogs are opened from `uiStore` flags that `hasBlockingOverlay`
   * knows about; this one is opened by the canvas and was not covered by
   * anything, so with the preview on screen it was drawn behind the native
   * view. Registering the backdrop - which covers the window - stands that view
   * down for exactly as long as the form is up.
   */
  const backdropRef = useRef<HTMLDivElement>(null);
  useFloatingLayer(backdropRef);

  useEffect(() => {
    firstFieldRef.current?.focus();
    firstFieldRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    onConfirm(params);
  };

  return (
    <div className="dialog-backdrop" ref={backdropRef} role="presentation" onMouseDown={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-action-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="dialog__title" id="text-action-title">
          {action.label}
        </h2>
        <p className="dialog__hint">
          Zaznaczony fragment: <strong>{truncate(context.selectedText)}</strong>
        </p>

        <div className="dialog__fields">
          {action.id === 'convert-to-link' ? (
            <LinkFields
              params={params as LinkParams}
              setParams={(next) => setParams(next as Params)}
              firstFieldRef={firstFieldRef}
            />
          ) : null}

          {action.id === 'dynamic-year' ? (
            <DynamicYearFields
              params={params as DynamicYearParams}
              setParams={(next) => setParams(next as Params)}
              firstFieldRef={firstFieldRef}
            />
          ) : null}
        </div>

        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel}>
            Anuluj
          </button>
          <button type="submit" className="button button--primary">
            Zastosuj
          </button>
        </div>
      </form>
    </div>
  );
}

function LinkFields({
  params,
  setParams,
  firstFieldRef,
}: {
  params: LinkParams;
  setParams: (next: LinkParams) => void;
  firstFieldRef: React.RefObject<HTMLInputElement>;
}): JSX.Element {
  return (
    <>
      <label className="field">
        <span className="field__label">Adres docelowy</span>
        <input
          ref={firstFieldRef}
          className="input"
          type="text"
          value={params.href}
          placeholder="https://example.com"
          onChange={(event) => setParams({ ...params, href: event.target.value })}
          required
        />
      </label>

      <label className="field">
        <span className="field__label">Otwieranie</span>
        <select
          className="select"
          value={params.target}
          onChange={(event) => setParams({ ...params, target: event.target.value as LinkParams['target'] })}
        >
          <option value="">W tej samej karcie</option>
          <option value="_blank">W nowej karcie</option>
        </select>
      </label>

      {params.target === '_blank' ? (
        <p className="dialog__hint">
          Do linku zostanie dodane <code>rel=&quot;noopener noreferrer&quot;</code> - bez tego otwierana
          strona może manipulować Twoją.
        </p>
      ) : null}

      <label className="field">
        <span className="field__label">Dodatkowe rel (opcjonalnie)</span>
        <input
          className="input"
          type="text"
          value={params.rel}
          placeholder="nofollow"
          onChange={(event) => setParams({ ...params, rel: event.target.value })}
        />
      </label>
    </>
  );
}

function DynamicYearFields({
  params,
  setParams,
  firstFieldRef,
}: {
  params: DynamicYearParams;
  setParams: (next: DynamicYearParams) => void;
  firstFieldRef: React.RefObject<HTMLInputElement>;
}): JSX.Element {
  const currentYear = new Date().getFullYear();
  const preview =
    params.startYear === null ? String(currentYear) : `${params.startYear}${params.separator}${currentYear}`;

  return (
    <>
      <label className="field">
        <span className="field__label">Rok początkowy (puste = tylko bieżący rok)</span>
        <input
          ref={firstFieldRef}
          className="input"
          type="number"
          min={1900}
          max={currentYear}
          value={params.startYear ?? ''}
          onChange={(event) => {
            const raw = event.target.value.trim();
            setParams({ ...params, startYear: raw === '' ? null : Number(raw) });
          }}
        />
      </label>

      {params.startYear !== null ? (
        <label className="field">
          <span className="field__label">Separator</span>
          <select
            className="select"
            value={params.separator}
            onChange={(event) => setParams({ ...params, separator: event.target.value })}
          >
            <option value="-">- (półpauza)</option>
            <option value="-">- (pauza)</option>
            <option value="-">- (łącznik)</option>
          </select>
        </label>
      ) : null}

      <label className="field">
        <span className="field__label">Identyfikator elementu</span>
        <input
          className="input"
          type="text"
          value={params.elementId}
          onChange={(event) => setParams({ ...params, elementId: event.target.value })}
          pattern="[A-Za-z][\w-]*"
          required
        />
      </label>

      <p className="dialog__hint">
        Na stronie pojawi się <code>{preview}</code>, a kod aktualizujący rok trafi do wydzielonej sekcji w
        pliku ze skryptami.
      </p>
    </>
  );
}

function truncate(value: string, max = 60): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
