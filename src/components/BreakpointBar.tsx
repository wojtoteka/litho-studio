import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { useFloatingLayer } from '@/lib/useFloatingLayer.js';
import {
  classifyElement,
  ELEMENT_KIND_LABELS,
  findElement,
  textContent,
  type PageDocument,
} from '@shared/document.js';
import { Icon } from './Icon.js';

/**
 * "3 elementy poza układem" — a running count of elements pinned to absolute
 * pixels, and a way to go and look at them.
 *
 * Free placement is easy to do by accident and invisible until someone views
 * the page on a phone. Surfacing the number where the device buttons already
 * are puts the consequence next to the control that reveals it.
 *
 * The count alone was a dead end, though: it said three elements were wrong and
 * gave no way to find out *which* three. Clicking now opens the list, and each
 * entry both selects its element — which scrolls the canvas to it and fills the
 * properties panel, so it can be fixed on the spot — and offers the one-click
 * undo of "put it back in the flow".
 */
function OutOfLayoutCounter(): JSX.Element | null {
  const document = useEditorStore((state) => state.document);
  const outOfLayoutIds = useEditorStore((state) => state.outOfLayoutIds);
  const select = useEditorStore((state) => state.select);
  const selection = useEditorStore((state) => state.selection);
  const returnToLayout = useEditorStore((state) => state.returnToLayout);
  const ignoreOutOfLayout = useEditorStore((state) => state.ignoreOutOfLayout);
  const setBreakpoint = useEditorStore((state) => state.setBreakpoint);
  const breakpoints = useEditorStore((state) => state.breakpoints);
  // Recomputed when anything commits — the tree and stylesheets mutate in place,
  // so `revision` is the signal, exactly as in Canvas.tsx.
  const revision = useEditorStore((state) => state.revision);
  // Subscribed to explicitly, even though `outOfLayoutIds()` already filters by
  // it: dismissing an element mutates *only* this array, and a component that
  // does not read it never re-renders — the count then keeps showing the
  // element the user just told it to forget, which reads as "the button does
  // nothing". `revision` cannot stand in here, since a dismissal is deliberately
  // not a document edit.
  const ignored = useEditorStore((state) => state.ignoredOutOfLayout);

  const [open, setOpen] = useState(false);
  const ids = outOfLayoutIds();
  void revision;
  void ignored;

  /*
   * The list drops out of the bar and straight over the work area — which, in
   * "Przeglądanie" mode or with the side-by-side preview on, is a native
   * `WebContentsView` that composites above the whole document. Registering the
   * popover makes that view stand down while it is open; without it the list
   * was really being rendered, just behind the previewed page, so clicking the
   * warning appeared to do nothing at all.
   */
  const popoverRef = useRef<HTMLDivElement>(null);
  useFloatingLayer(popoverRef, open);

  // The list closes on its own once the last offender is fixed, so the popover
  // never lingers over an empty panel.
  useEffect(() => {
    if (ids.length === 0) setOpen(false);
  }, [ids.length]);

  if (ids.length === 0 || !document) return null;

  const narrowest = breakpoints
    .filter((entry) => entry.maxWidth !== null)
    .sort((a, b) => (a.maxWidth ?? 0) - (b.maxWidth ?? 0))[0];

  const label =
    ids.length === 1
      ? '1 element poza układem'
      : // Polish plurals: 2–4 take "elementy", 5+ take "elementów", and the
        // teens (12–14) take "elementów" despite ending in 2–4.
        `${ids.length} ${pluralElements(ids.length)} poza układem`;

  return (
    <div className="breakpoints__warning-wrap">
      <button
        type="button"
        className={`button breakpoints__warning${open ? ' button--active' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Te elementy są przypięte do konkretnych pikseli i mogą się rozjechać na węższym ekranie. Kliknij, aby zobaczyć listę."
      >
        <Icon name="warning" size={15} />
        {label}
        <Icon name="expand_more" size={14} />
      </button>

      {open ? (
        <div className="outofflow" ref={popoverRef} role="group" aria-label="Elementy poza układem">
          <p className="outofflow__hint">
            Te elementy mają <code>position: absolute</code> lub <code>fixed</code> ze stałymi pikselami.
            Kliknij element, aby go zaznaczyć i poprawić, przywróć go do układu, albo zignoruj, jeśli to
            zamierzone.
          </p>

          <ul className="outofflow__list">
            {ids.map((id) => (
              <li key={id} className="outofflow__item">
                <button
                  type="button"
                  className={`button outofflow__pick${selection.includes(id) ? ' button--active' : ''}`}
                  onClick={() => select([id])}
                  title="Zaznacz ten element"
                >
                  <Icon name="filter_center_focus" size={14} />
                  <span className="outofflow__name">{describeNode(document, id)}</span>
                </button>
                <button
                  type="button"
                  className="button button--icon"
                  onClick={() => returnToLayout(id)}
                  title="Wróć do układu — usuwa position/left/top z tego elementu"
                  aria-label="Wróć do układu"
                >
                  <Icon name="undo" size={14} />
                </button>
                <button
                  type="button"
                  className="button button--icon"
                  onClick={() => ignoreOutOfLayout(id)}
                  title="Ignoruj — to pozycjonowanie jest zamierzone, przestań o nim ostrzegać"
                  aria-label="Ignoruj ten błąd"
                >
                  <Icon name="visibility_off" size={14} />
                </button>
              </li>
            ))}
          </ul>

          {narrowest ? (
            <button
              type="button"
              className="button outofflow__check"
              onClick={() => {
                setBreakpoint(narrowest.id);
                const first = ids[0];
                if (first) select([first]);
              }}
            >
              <Icon name="monitor" size={14} />
              Sprawdź na: {narrowest.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * How an element reads in the list: what kind of thing it is, plus the first
 * few words of its own text. The kind alone produced four identical rows of
 * "Blok · div", which is no more useful than the bare count was.
 */
function describeNode(document: PageDocument, id: string): string {
  const element = findElement(document.root, id);
  if (!element) return id;
  const kind = `${ELEMENT_KIND_LABELS[classifyElement(element)]} · ${element.tag}`;
  const text = textContent(element).replace(/\s+/gu, ' ').trim();
  if (text === '') return kind;
  return `${kind} — „${text.length > 34 ? `${text.slice(0, 34)}…` : text}”`;
}

function pluralElements(count: number): string {
  const lastTwo = count % 100;
  if (lastTwo >= 12 && lastTwo <= 14) return 'elementów';
  const last = count % 10;
  return last >= 2 && last <= 4 ? 'elementy' : 'elementów';
}

/**
 * Breakpoint switcher.
 *
 * Switching here changes *where new declarations are written*, not just what
 * the canvas shows: editing a value while "Telefon" is active produces a real
 * `@media (max-width: 640px)` block in the project's stylesheet. The hint text
 * spells that out, because a responsive editor that silently writes to the
 * wrong place is worse than no responsive editor.
 *
 * The gear opens an editor for the active breakpoint's widths — the canvas
 * width (preview size) and, for non-base breakpoints, the `max-width` that goes
 * into the generated media query.
 */
export function BreakpointBar(): JSX.Element {
  const breakpoints = useEditorStore((state) => state.breakpoints);
  const breakpointId = useEditorStore((state) => state.breakpointId);
  const setBreakpoint = useEditorStore((state) => state.setBreakpoint);
  const updateBreakpoint = useEditorStore((state) => state.updateBreakpoint);

  const canvasMode = useUiStore((state) => state.canvasMode);
  const setCanvasMode = useUiStore((state) => state.setCanvasMode);
  const canvasPaneWidth = useUiStore((state) => state.canvasPaneWidth);

  const [editing, setEditing] = useState(false);
  const active = breakpoints.find((entry) => entry.id === breakpointId) ?? breakpoints[0];

  return (
    <div className="breakpoints" role="group" aria-label="Breakpointy">
      {/* A segmented control, not two loose buttons: browsing and editing are
          two states of one thing, and pairing them in a single recessed track
          says so before the labels are read. */}
      <div className="breakpoints__modes" role="group" aria-label="Tryb obszaru edycji">
        {/* Deliberately not called "Podgląd" — the Toolbar already has an
            unrelated button with that exact label (toggles the separate live
            preview pane), and the two were getting confused for each other. */}
        <button
          type="button"
          className="button"
          aria-pressed={canvasMode === 'preview'}
          onClick={() => setCanvasMode('preview')}
          title="Przeglądanie — kliknięcie w obszarze roboczym pokazuje sekcję w panelach, bez włączania edycji"
        >
          <Icon name="visibility" size={15} />
          Przeglądanie
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={canvasMode === 'edit'}
          onClick={() => setCanvasMode('edit')}
          title="Edycja — kliknięcie w obszarze roboczym zaznacza element do edycji"
        >
          <Icon name="edit" size={15} />
          Edycja
        </button>
      </div>

      <span className="breakpoints__divider" aria-hidden="true" />

      {breakpoints.map((breakpoint) => (
        <button
          key={breakpoint.id}
          type="button"
          className={`button${breakpoint.id === breakpointId ? ' button--active' : ''}`}
          aria-pressed={breakpoint.id === breakpointId}
          onClick={() => setBreakpoint(breakpoint.id)}
          title={
            breakpoint.maxWidth === null
              ? 'Style bazowe — bez media query. Strona zajmuje całą dostępną szerokość obszaru roboczego.'
              : `Style w @media (max-width: ${breakpoint.maxWidth}px)`
          }
        >
          {breakpoint.label}
          <span className="breakpoints__size">
            {/* A fluid breakpoint has no width of its own — it renders at the
                size of the work area, so showing a stored number there would be
                a lie. See `isFluidBreakpoint` in Canvas.tsx. */}
            {breakpoint.fluid
              ? `${canvasPaneWidth > 0 ? canvasPaneWidth : '—'}px`
              : `${breakpoint.canvasWidth}px`}
          </span>
        </button>
      ))}

      {/* Labelled, not a bare gear: the width controls are the answer to "how do
          I change the page size", and an unlabelled icon at the end of a row of
          device buttons was not read as that question's answer. */}
      <button
        type="button"
        className="button"
        onClick={() => setEditing((value) => !value)}
        aria-pressed={editing}
        title="Ustaw szerokość obszaru roboczego i próg media query"
      >
        <Icon name="tune" size={15} />
        Rozmiar
      </button>

      <OutOfLayoutCounter />

      <span className="breakpoints__hint">
        {active?.maxWidth === null
          ? 'Zmiany stylów zapisują się jako reguły bazowe'
          : `Zmiany stylów zapisują się w @media (max-width: ${active?.maxWidth}px)`}
      </span>

      {editing && active ? (
        <div className="breakpoints__editor" role="group" aria-label={`Ustawienia: ${active.label}`}>
          {/* The base breakpoint used to show a paragraph of explanation and no
              control at all, which is what "page size cannot be edited" meant:
              it is the breakpoint selected by default, so that dead end was the
              first — usually only — thing anyone saw. It now chooses between
              filling the work area and a width the user types. */}
          {active.maxWidth === null ? (
            <>
              <div className="breakpoints__field">
                Szerokość obszaru
                <div className="breakpoints__modes" role="group" aria-label="Szerokość obszaru roboczego">
                  <button
                    type="button"
                    className="button"
                    aria-pressed={active.fluid}
                    onClick={() => updateBreakpoint(active.id, { fluid: true })}
                    title="Strona wypełnia cały obszar roboczy, jak w oknie przeglądarki"
                  >
                    Dopasuj do okna
                  </button>
                  <button
                    type="button"
                    className="button"
                    aria-pressed={!active.fluid}
                    onClick={() => updateBreakpoint(active.id, { fluid: false })}
                    title="Strona rysowana w stałej szerokości, którą podajesz obok"
                  >
                    Własna
                  </button>
                </div>
              </div>

              <label className="breakpoints__field">
                Szerokość w px
                <input
                  className="input"
                  type="number"
                  min={200}
                  max={3840}
                  value={active.canvasWidth}
                  disabled={active.fluid}
                  onChange={(event) =>
                    updateBreakpoint(active.id, { canvasWidth: Number(event.target.value) })
                  }
                />
              </label>

              <span className="breakpoints__hint">
                Breakpoint bazowy nie ma media query — szerokość zmienia tylko to, jak szeroko rysowana jest
                strona, a style zapisują się jako reguły bazowe.
              </span>
            </>
          ) : (
            <>
              <label className="breakpoints__field">
                Szerokość podglądu
                <input
                  className="input"
                  type="number"
                  min={200}
                  max={3840}
                  value={active.canvasWidth}
                  onChange={(event) =>
                    updateBreakpoint(active.id, { canvasWidth: Number(event.target.value) })
                  }
                />
              </label>

              <label className="breakpoints__field">
                max-width media query
                <input
                  className="input"
                  type="number"
                  min={200}
                  max={3840}
                  value={active.maxWidth}
                  onChange={(event) => updateBreakpoint(active.id, { maxWidth: Number(event.target.value) })}
                />
              </label>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
