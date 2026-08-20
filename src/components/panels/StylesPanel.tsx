import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { findElement, getClassList } from '@shared/document.js';
import { DeclarationEditor } from './StyleFields.js';
import { Icon } from '../Icon.js';

/**
 * Reusable styles — the page's named CSS classes.
 *
 * The whole point is that a style exists *independently of any element*: the
 * user names it (`page-intro`), sets its properties here, and only then decides
 * which elements wear it. That is the opposite of the properties panel, which
 * styles one selected element through a hook the editor generates for it.
 *
 * There is no separate storage behind this list. A style is exactly a rule in
 * the project's stylesheet — creating one writes `.page-intro { }`, editing it
 * adds declarations to that rule, deleting it removes the rule and strips the
 * class from every element. Which means a class the user (or whoever wrote the
 * page) defined by hand in the CSS file shows up here as an ordinary style,
 * with no import step.
 */
export function StylesPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const styleClasses = useEditorStore((state) => state.styleClasses);
  const classDeclarations = useEditorStore((state) => state.classDeclarations);
  const createStyleClass = useEditorStore((state) => state.createStyleClass);
  const setClassStyle = useEditorStore((state) => state.setClassStyle);
  const setClassCss = useEditorStore((state) => state.setClassCss);
  const renameStyleClass = useEditorStore((state) => state.renameStyleClass);
  const deleteStyleClass = useEditorStore((state) => state.deleteStyleClass);
  const setClassOnSelection = useEditorStore((state) => state.setClassOnSelection);
  const breakpoint = useEditorStore((state) => state.currentBreakpoint());
  // The stylesheets are mutated in place, so the models array reference does not
  // change on an edit — `revision` is the "something changed" signal. See the
  // note at the top of editorStore.
  const revision = useEditorStore((state) => state.revision);

  const [draftName, setDraftName] = useState('');
  const [activeName, setActiveName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const classes = useMemo(
    () => styleClasses(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [styleClasses, document, breakpoint.id, revision],
  );

  const declarations = useMemo(
    () => (activeName ? classDeclarations(activeName) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeName, classDeclarations, breakpoint.id, revision],
  );

  /* A style deleted (or renamed) elsewhere must not leave the editor open on a
     name that no longer exists. */
  useEffect(() => {
    if (activeName && !classes.some((entry) => entry.name === activeName)) setActiveName(null);
  }, [activeName, classes]);

  /** Whether every selected element already carries the active style. */
  const selectionHasClass = useMemo(() => {
    if (!document || !activeName || selection.length === 0) return false;
    return selection.every((id) => {
      const element = findElement(document.root, id);
      return element ? getClassList(element).includes(activeName) : false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, activeName, selection, revision]);

  const create = useCallback((): void => {
    const result = createStyleClass(draftName);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    setDraftName('');
    setActiveName(result.value);
  }, [createStyleClass, draftName]);

  const set = useCallback(
    (property: string, value: string): void => {
      if (!activeName) return;
      setClassStyle(
        activeName,
        { [property]: value.trim() === '' ? null : value },
        {
          label: `Styl .${activeName}: ${property}`,
          mergeKey: `class-style:${activeName}:${property}:${breakpoint.id}`,
        },
      );
    },
    [activeName, breakpoint.id, setClassStyle],
  );

  if (!document) {
    return (
      <div className="panel__body">
        <p className="dialog__hint">Otwórz stronę, aby tworzyć style wielokrotnego użytku.</p>
      </div>
    );
  }

  const active = classes.find((entry) => entry.name === activeName) ?? null;

  return (
    <div className="panel__body" style={{ padding: 0 }}>
      <div className="styles__create">
        <label className="field">
          <span className="field__label">Nazwa nowego stylu</span>
          <div className="styles__create-row">
            <input
              className="input"
              type="text"
              value={draftName}
              placeholder="np. page-intro"
              onChange={(event) => {
                setDraftName(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                create();
              }}
            />
            <button
              type="button"
              className="button button--primary"
              onClick={create}
              disabled={draftName.trim() === ''}
            >
              <Icon name="add" size={15} />
              Utwórz
            </button>
          </div>
        </label>
        {error ? (
          <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : (
          <p className="dialog__hint">
            Styl zapisuje się jako reguła CSS w arkuszu strony i od razu jest do wyboru we „Właściwościach”
            zaznaczonego elementu.
          </p>
        )}
      </div>

      <ul className="styles__list">
        {classes.length === 0 ? (
          <li className="sheet-list__empty">Ta strona nie ma jeszcze żadnych stylów.</li>
        ) : (
          classes.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                className={`styles__item${entry.name === activeName ? ' styles__item--active' : ''}`}
                aria-pressed={entry.name === activeName}
                onClick={() => setActiveName(entry.name === activeName ? null : entry.name)}
              >
                <span className="styles__item-name">.{entry.name}</span>
                <span className="styles__item-meta">{describeStyle(entry)}</span>
              </button>
            </li>
          ))
        )}
      </ul>

      {active ? (
        <div className="styles__editor">
          <div className="styles__editor-header">
            <StyleNameField
              key={active.name}
              name={active.name}
              onRename={(next) => {
                const result = renameStyleClass(active.name, next);
                if (!result.ok) {
                  setError(result.message);
                  return false;
                }
                setError(null);
                setActiveName(result.value);
                return true;
              }}
            />
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                deleteStyleClass(active.name);
                setActiveName(null);
              }}
              title="Usuwa regułę CSS i zdejmuje klasę ze wszystkich elementów strony"
            >
              <Icon name="delete" size={15} />
              Usuń styl
            </button>
          </div>

          <div className="styles__editor-actions">
            <button
              type="button"
              className="button"
              disabled={selection.length === 0}
              onClick={() => setClassOnSelection(active.name, !selectionHasClass)}
              title={
                selection.length === 0
                  ? 'Zaznacz element na podglądzie'
                  : 'Przypisuje lub zdejmuje ten styl na zaznaczonych elementach'
              }
            >
              {selectionHasClass ? 'Zdejmij z zaznaczenia' : 'Zastosuj do zaznaczenia'}
            </button>
            <span className="styles__usage">
              {active.usage === 0
                ? 'nieużywany na tej stronie'
                : `używany przez ${active.usage} ${active.usage === 1 ? 'element' : 'elementy'}`}
            </span>
          </div>

          <p className="dialog__hint" style={{ margin: '0 10px 8px' }}>
            Właściwości zapisują się dla breakpointu <strong>{breakpoint.label}</strong>.
          </p>

          <DeclarationEditor key={`${active.name}:${breakpoint.id}`} declarations={declarations} set={set} />

          <RawCssField
            // Re-seed the box whenever the rule the fields wrote changes, or the
            // style/breakpoint switches — otherwise it would show stale text.
            key={`${active.name}:${breakpoint.id}:${revision}`}
            name={active.name}
            declarations={declarations}
            onCommit={(cssText) => {
              const result = setClassCss(active.name, cssText);
              if (!result.ok) {
                setError(result.message);
                return false;
              }
              setError(null);
              return true;
            }}
          />
        </div>
      ) : (
        <p className="dialog__hint" style={{ margin: '8px 10px' }}>
          Wybierz styl z listy, aby ustawić jego właściwości.
        </p>
      )}
    </div>
  );
}

/**
 * The style's name, renamed in place. Committing on blur would fire while the
 * user is still deciding, so the rename is explicit — and the field reverts
 * when it is rejected (a duplicate name), rather than leaving the input showing
 * a name nothing in the project actually has.
 */
function StyleNameField({
  name,
  onRename,
}: {
  name: string;
  /** Returns false when the new name was rejected. */
  onRename: (next: string) => boolean;
}): JSX.Element {
  const [draft, setDraft] = useState(name);

  const commit = (): void => {
    const next = draft.trim();
    if (next === '' || next === name) {
      setDraft(name);
      return;
    }
    if (!onRename(next)) setDraft(name);
  };

  return (
    <label className="field styles__name-field">
      <span className="field__label">Nazwa klasy</span>
      <div className="styles__create-row">
        <input
          className="input"
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') setDraft(name);
          }}
        />
        <button type="button" className="button" onClick={commit} disabled={draft.trim() === name}>
          Zmień nazwę
        </button>
      </div>
    </label>
  );
}

function describeStyle(entry: { declarations: Record<string, string>; usage: number }): string {
  const count = Object.keys(entry.declarations).length;
  const properties = count === 1 ? '1 właściwość' : `${count} właściwości`;
  return entry.usage === 0 ? properties : `${properties} · ${entry.usage}×`;
}

/**
 * The style's rule as raw, hand-editable CSS.
 *
 * The fields above are the quick path; this is the escape hatch for anything
 * they do not cover — a `transition`, a `grid-template`, a custom property. It
 * shows the exact rule that is written to the file and writes back whatever the
 * user types, so the two editors are two views of one rule, never two sources of
 * truth. Committing on blur (or Ctrl+Enter) rather than per keystroke keeps a
 * half-typed value from being parsed and discarded mid-edit; an unparseable
 * block is rejected and the text is left in place with an error shown above.
 */
function RawCssField({
  name,
  declarations,
  onCommit,
}: {
  name: string;
  declarations: Record<string, string>;
  /** Returns false when the CSS was rejected, so the box keeps the user's text. */
  onCommit: (cssText: string) => boolean;
}): JSX.Element {
  const initial = previewRule(name, declarations);
  const [draft, setDraft] = useState(initial);

  const commit = (): void => {
    if (draft.trim() === initial.trim()) return;
    onCommit(draft);
  };

  return (
    <div className="styles__preview">
      <label className="field" style={{ gap: 4 }}>
        <span className="field__label">Zapis w arkuszu CSS — możesz edytować ręcznie</span>
        <textarea
          className="textarea styles__preview-code"
          spellCheck={false}
          rows={Math.min(14, Math.max(4, Object.keys(declarations).length + 2))}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit();
            }
          }}
        />
      </label>
      <p className="dialog__hint" style={{ margin: 0 }}>
        Zmiany zapisują się po wyjściu z pola (lub Ctrl+Enter).
      </p>
    </div>
  );
}

/** The rule as it is written to the stylesheet — the honest answer to "what did
 * clicking these fields actually produce". */
function previewRule(name: string, declarations: Record<string, string>): string {
  const entries = Object.entries(declarations);
  if (entries.length === 0) return `.${name} {\n}`;
  return `.${name} {\n${entries.map(([property, value]) => `  ${property}: ${value};`).join('\n')}\n}`;
}
