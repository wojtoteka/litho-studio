import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, ancestorsOf, isAudioAsset, isImageAsset } from '@/state/editorStore.js';
import { toAssetUrl } from '@/lib/canvasDocument.js';
import { BackgroundSection, DeclarationEditor, Field, Section, SelectField } from './StyleFields.js';
import {
  classifyElement,
  ELEMENT_KIND_LABELS,
  findElement,
  getAttr,
  getBody,
  textContent,
  type ElementKind,
  type ElementNode,
} from '@shared/document.js';
import { STYLE_STATES, type AssetRef } from '@shared/project.js';
import { definesSelector, type Declarations } from '@/engine/cssGenerator.js';
import { DESCRIPTION_RANGE, TITLE_RANGE, type PageMeta } from '@/engine/headMeta.js';
import { ElementScriptSection } from './ElementScriptSection.js';
import { element as buildElement, text as buildText } from '@/lib/elementFactory.js';
import { relativeHref } from '@shared/paths.js';
import { Icon } from '../Icon.js';

/**
 * The properties panel.
 *
 * Every control writes a real CSS declaration into the project's stylesheet at
 * the active breakpoint - there is no intermediate "style object" and no inline
 * `style` attribute. A field left empty removes the declaration rather than
 * writing an explicit default, so the panel never accumulates noise in the
 * user's CSS for properties they did not set.
 *
 * Values shown are the *declared* ones for this element's own selector, so an
 * empty field means "inherited or from another rule", which is the honest
 * answer - the canvas shows the computed result.
 */
export function PropertiesPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const assets = useEditorStore((state) => state.assets);
  const selection = useEditorStore((state) => state.selection);
  const select = useEditorStore((state) => state.select);
  const setStyle = useEditorStore((state) => state.setStyle);
  const setAttribute = useEditorStore((state) => state.setAttribute);
  const setTextContent = useEditorStore((state) => state.setTextContent);
  const insertElement = useEditorStore((state) => state.insertElement);
  const removeNodes = useEditorStore((state) => state.removeNodes);
  const declarationsFor = useEditorStore((state) => state.declarationsFor);
  const availableClassNames = useEditorStore((state) => state.availableClassNames);
  const elementScriptState = useEditorStore((state) => state.elementScriptState);
  const breakpoint = useEditorStore((state) => state.currentBreakpoint());
  const styleState = useEditorStore((state) => state.styleState);
  const setStyleState = useEditorStore((state) => state.setStyleState);
  const revision = useEditorStore((state) => state.revision);

  const selectedId = selection[0] ?? null;

  /*
   * Selecting a different element drops back to the normal state.
   *
   * Unlike the breakpoint - a deliberate "I am designing for phones now" mode
   * that should persist - a pseudo-state belongs to the element in front of
   * you. Leaving it on "Najechanie" while clicking through the page would mean
   * every later edit silently landed in a `:hover` rule.
   */
  useEffect(() => {
    setStyleState('normal');
  }, [selectedId, setStyleState]);
  // Whether the selected element already carries a dynamic script - drives the
  // badge and auto-open on the "Skrypt" section, so re-selecting a scripted
  // element does not look empty.
  const scriptAttached = useMemo(
    () => {
      if (!selectedId) return false;
      const state = elementScriptState(selectedId);
      return state.binding !== null || state.unrecognized;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, elementScriptState, revision],
  );
  const element = useMemo(
    () => (document && selectedId ? findElement(document.root, selectedId) : null),
    // `revision` is included because the tree mutates in place - see editorStore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document, selectedId, revision],
  );

  const declarations: Declarations = useMemo(
    () => (selectedId ? declarationsFor(selectedId) : {}),
    // `declarationsFor` reads live store state; the selection, breakpoint and the
    // model revision are what actually change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedId, breakpoint.id, styleState, document, declarationsFor, revision],
  );

  const set = useCallback(
    (property: string, value: string): void => {
      if (!selectedId) return;
      setStyle(
        selectedId,
        { [property]: value.trim() === '' ? null : value },
        {
          label: `Zmiana: ${property}`,
          mergeKey: `style:${selectedId}:${property}`,
        },
      );
    },
    [selectedId, setStyle],
  );

  if (!document) {
    return (
      <div className="props__empty">
        <Icon name="tune" size={30} />
        Otwórz projekt, aby edytować właściwości.
      </div>
    );
  }

  if (!element || !selectedId) {
    const body = getBody(document);
    if (!body) {
      return (
        <div className="props__empty">
          <Icon name="widgets" size={30} />
          Zaznacz element na stronie, aby zobaczyć jego właściwości.
        </div>
      );
    }
    return <PageBackgroundPanel bodyId={body.id} />;
  }

  if (selection.length > 1) {
    return (
      <div className="props__empty">
        <Icon name="select_all" size={30} />
        Zaznaczono {selection.length} elementów. Wybierz pojedynczy element, aby edytować jego style.
        <button type="button" className="button" onClick={() => select([])}>
          <Icon name="close" size={14} />
          Odznacz
        </button>
      </div>
    );
  }

  const kind = classifyElement(element);
  const ancestors = ancestorsOf(document, selectedId).filter((node) => node.tag !== 'html');
  // Editing text here means *replacing* the element's children with a single
  // text node (see `setTextContent`) - safe only when there is no nested
  // markup to lose. A heading, paragraph or button almost always qualifies; a
  // `<div>` wrapping other elements does not, and is left to be edited
  // element-by-element instead.
  const hasOnlyTextChildren = element.children.every((child) => child.kind !== 'element');
  // Typography properties have nothing to act on for these kinds - an <img>,
  // an <svg> icon, a checkbox/radio input never render text through their own
  // font/line-height/letter-spacing, so a control that visibly does nothing
  // is worse than no control. Left in for every other kind, including
  // containers, since the user may deliberately set inheritable typography
  // there for its children.
  const showTypography = !(['image', 'video', 'audio', 'svg', 'checkbox', 'radio'] as ElementKind[]).includes(
    kind,
  );
  // Every element can carry a reusable style, so the picker is offered for
  // every kind - the styles panel exists precisely so that one named class can
  // be reused across headings, paragraphs, buttons and whole sections alike.
  // Free-form multi-class editing still lives in "Atrybuty i zaawansowane".

  return (
    <>
      <nav className="props__breadcrumb" aria-label="Ścieżka elementu">
        {ancestors.map((ancestor) => (
          <button
            key={ancestor.id}
            type="button"
            className="props__crumb"
            onClick={() => select([ancestor.id])}
          >
            {ancestor.tag}
          </button>
        ))}
        <span className="props__crumb props__crumb--current">{element.tag}</span>
        <button
          type="button"
          className="button button--icon props__deselect"
          onClick={() => select([])}
          title="Odznacz element - nic nie będzie zaznaczone"
          aria-label="Odznacz element"
        >
          <Icon name="close" size={14} />
        </button>
      </nav>

      <div className="panel__body" style={{ padding: 0 }}>
        <p className="props__context">
          <Icon name="info" size={14} />
          <span>
            {ELEMENT_KIND_LABELS[kind]} · styl zapisywany dla breakpointu <strong>{breakpoint.label}</strong>
          </span>
        </p>

        <StyleStateSwitch />

        {styleState === 'normal' ? (
          <OutOfLayoutWarning nodeId={selectedId} declarations={declarations} />
        ) : null}

        <Section title="Nazwa stylu (klasa CSS)" defaultOpen>
          <ClassNameField
            key={selectedId}
            value={getAttr(element, 'class') ?? ''}
            options={availableClassNames()}
            onChange={(value) => setAttribute(selectedId, 'class', value.trim() === '' ? null : value)}
          />
          <p className="dialog__hint" style={{ margin: 0 }}>
            Wybierz styl zdefiniowany w panelu „Style”, albo wpisz nową nazwę - zdefiniujesz ją tam.
          </p>

          <PromoteToStyleClass key={`promote:${selectedId}`} nodeId={selectedId} element={element} />
        </Section>

        {hasOnlyTextChildren && !scriptAttached ? (
          <Section title="Treść" defaultOpen>
            <TextContentField
              key={selectedId}
              initialValue={textContent(element)}
              onCommit={(value) => setTextContent(selectedId, value)}
            />
          </Section>
        ) : hasOnlyTextChildren && scriptAttached ? (
          <p className="dialog__hint" style={{ margin: '0 10px 8px' }}>
            Treść tego elementu ustawia przypisany skrypt (sekcja „Skrypt / Funkcja dynamiczna” niżej) -
            ręczna edycja tekstu tutaj i tak zostałaby nadpisana przy kolejnym „Zastosuj”. Dopisz tekst
            przed/po przez parametry skryptu, albo usuń skrypt, żeby odzyskać to pole.
          </p>
        ) : kind === 'select' ? null : (
          <p className="dialog__hint" style={{ margin: '0 10px 8px' }}>
            Ten element zawiera zagnieżdżone elementy - edytuj ich tekst osobno, po zaznaczeniu każdego z
            nich.
          </p>
        )}

        {/* A picture is an image's content, so it belongs next to "Treść" and
            open by default - not buried under "Atrybuty i zaawansowane", where
            filling a gallery meant knowing to look for a text field called
            "src" behind a collapsed header. */}
        {kind === 'image' ? (
          <Section title="Obraz" defaultOpen>
            <ImageAssetPicker
              key={selectedId}
              assets={assets}
              pageRelPath={document.relPath}
              elementId={selectedId}
              value={getAttr(element, 'src')}
            />
            <Field
              label="Źródło (src)"
              value={getAttr(element, 'src')}
              onChange={(v) => setAttribute(selectedId, 'src', v.trim() === '' ? null : v, 'Zmiana: src')}
            />
            <Field
              label="Tekst alternatywny (alt)"
              value={getAttr(element, 'alt')}
              onChange={(v) => setAttribute(selectedId, 'alt', v.trim() === '' ? null : v, 'Zmiana: alt')}
            />
          </Section>
        ) : null}

        {kind === 'select' ? (
          <Section title="Opcje listy rozwijanej" defaultOpen>
            <OptionsField
              key={selectedId}
              select={element}
              onCommitText={(id, value) => setTextContent(id, value)}
              onCommitValue={(id, value) =>
                setAttribute(id, 'value', value.trim() === '' ? null : value, 'Zmiana: value')
              }
              onAdd={() => {
                const option = buildElement('option', { value: '' }, [buildText('Nowa opcja')]);
                insertElement(
                  option,
                  { parentId: selectedId, index: element.children.length },
                  'Dodanie opcji',
                );
                select([selectedId]);
              }}
              onRemove={(id) => {
                removeNodes([id]);
                select([selectedId]);
              }}
            />
          </Section>
        ) : null}

        <DeclarationEditor
          key={`${selectedId}:${breakpoint.id}:${styleState}`}
          declarations={declarations}
          set={set}
          showTypography={showTypography}
        />

        <Section
          title="Skrypt / Funkcja dynamiczna"
          badge={scriptAttached}
          // Open automatically for an element that already has a script, so the
          // binding is visible the moment it is selected rather than hidden
          // behind a collapsed header.
          defaultOpen={scriptAttached}
        >
          {/* Keyed by element so switching selection re-seeds the form from the
              script actually attached to the newly selected element. */}
          <ElementScriptSection key={selectedId} nodeId={selectedId} />
        </Section>

        {element.tag === 'form' ? (
          <FormDestinationSection
            nodeId={selectedId}
            action={getAttr(element, 'action') ?? null}
            onChange={(value) => setAttribute(selectedId, 'action', value, 'Adres odbioru formularza')}
          />
        ) : null}

        <Section title="Atrybuty i zaawansowane">
          <AttributeFields
            element={element}
            onChange={setAttribute}
            assets={assets}
            pageRelPath={document.relPath}
          />
        </Section>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/**
 * The page's own settings: what it is called, how it is described, what picture
 * represents it, and what shows in the browser tab.
 *
 * None of this was reachable from the UI before - the only way to give a page a
 * description or an Open Graph image was to open the HTML by hand. A site built
 * entirely in Litho therefore shipped with no description and no social card,
 * which looks broken everywhere the link gets pasted, and nothing in the
 * program ever mentioned it.
 *
 * Counters rather than validation: a title of 80 characters is not an error, it
 * just gets cut off in a search result, and knowing that while writing is worth
 * more than a rejection afterwards.
 */
function PageMetaSection(): JSX.Element {
  const pageMeta = useEditorStore((state) => state.pageMeta);
  const setPageMeta = useEditorStore((state) => state.setPageMeta);
  const assets = useEditorStore((state) => state.assets);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);
  const document = useEditorStore((state) => state.document);
  const revision = useEditorStore((state) => state.revision);

  const meta = useMemo(
    () => pageMeta(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageMeta, document, pageRelPath, revision],
  );

  // Local drafts so typing does not commit (and push an undo entry) per
  // keystroke; committed on blur, like every other free-text field here.
  const [draft, setDraft] = useState(meta);
  useEffect(() => {
    setDraft(meta);
  }, [meta]);

  const commit = (key: keyof PageMeta) => (): void => {
    if (draft[key] === meta[key]) return;
    setPageMeta({ [key]: draft[key] }, { label: 'Zmiana danych strony' });
  };

  const imageAssets = assets.filter((asset) => isImageAsset(asset.relPath));

  return (
    <Section title="Strona: tytuł, opis, ikona" defaultOpen>
      <label className="field">
        <span className="field__label">Tytuł strony</span>
        <input
          className="input"
          type="text"
          value={draft.title}
          placeholder="np. Kowalski - stolarnia z Krakowa"
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          onBlur={commit('title')}
        />
        <LengthHint value={draft.title} range={TITLE_RANGE} />
      </label>

      <label className="field">
        <span className="field__label">Opis strony</span>
        <textarea
          className="textarea"
          rows={3}
          value={draft.description}
          placeholder="Jedno-dwa zdania o tym, czym jest ta strona. Widoczne w Google i przy udostępnianiu linku."
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          onBlur={commit('description')}
        />
        <LengthHint value={draft.description} range={DESCRIPTION_RANGE} />
      </label>

      <label className="field">
        <span className="field__label">Język strony</span>
        <input
          className="input"
          type="text"
          value={draft.lang}
          placeholder="pl"
          onChange={(event) => setDraft({ ...draft, lang: event.target.value })}
          onBlur={commit('lang')}
        />
        <span className="field__hint">
          Kod języka, np. <code>pl</code> lub <code>en</code>. Czytniki ekranu i tłumacze go używają.
        </span>
      </label>

      <AssetPickerField
        label="Obrazek przy udostępnianiu (og:image)"
        value={draft.ogImage}
        assets={imageAssets}
        pageRelPath={pageRelPath}
        onPick={(href) => setPageMeta({ ogImage: href }, { label: 'Zmiana obrazka social' })}
        emptyHint="Wgraj obraz w panelu „Zasoby”, aby móc go tu wybrać."
      />

      <AssetPickerField
        label="Ikona strony (favicon)"
        value={draft.favicon}
        assets={imageAssets}
        pageRelPath={pageRelPath}
        onPick={(href) => setPageMeta({ favicon: href }, { label: 'Zmiana ikony strony' })}
        emptyHint="Wgraj obraz (najlepiej kwadratowy, np. 512×512) w panelu „Zasoby”."
      />
    </Section>
  );
}

/** Character counter that says what the number means, not just what it is. */
function LengthHint({ value, range }: { value: string; range: { min: number; max: number } }): JSX.Element {
  const length = value.trim().length;
  const tone = length === 0 ? 'empty' : length < range.min ? 'short' : length > range.max ? 'long' : 'ok';
  const message =
    tone === 'empty'
      ? `zalecane ${range.min}-${range.max} znaków`
      : tone === 'short'
        ? `krótko - celuj w ${range.min}-${range.max}`
        : tone === 'long'
          ? `za długo, wyszukiwarka utnie po ~${range.max}`
          : 'dobra długość';

  return (
    <span className={`meta-counter meta-counter--${tone}`}>
      {length} zn. · {message}
    </span>
  );
}

/**
 * Picks a project asset and hands back a page-relative href, so the value
 * written into the file is the same relative path a browser will resolve.
 */
function AssetPickerField({
  label,
  value,
  assets,
  pageRelPath,
  onPick,
  emptyHint,
}: {
  label: string;
  value: string;
  assets: AssetRef[];
  pageRelPath: string | null;
  onPick: (href: string) => void;
  emptyHint: string;
}): JSX.Element {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      {assets.length === 0 ? (
        <span className="field__hint">{emptyHint}</span>
      ) : (
        <div className="bg-asset-picker">
          {assets.map((asset) => {
            const href = pageRelPath ? relativeHref(pageRelPath, asset.relPath) : asset.relPath;
            return (
              <button
                key={asset.relPath}
                type="button"
                className={`bg-asset-picker__item${href === value ? ' bg-asset-picker__item--active' : ''}`}
                onClick={() => onPick(href === value ? '' : href)}
                title={href === value ? `${asset.name} - kliknij, aby usunąć` : asset.name}
              >
                <img src={toAssetUrl(asset.relPath)} alt="" />
              </button>
            );
          })}
        </div>
      )}
      {value ? <span className="field__hint">Wybrano: {value}</span> : null}
    </div>
  );
}

/**
 * Offers to turn an element's generated `#id` hook into a named, reusable class.
 *
 * Styling an element that has no class of its own makes the editor invent an id
 * to hang the rules on - correct, but private: an hour of work leaves the
 * stylesheet full of one-off `#naglowek-3 { … }` blocks nobody would choose to
 * maintain by hand, which quietly undercuts the promise that the files stay
 * yours. This is where that becomes reversible.
 *
 * Only shown when there is something to promote: an id hook *and* rules
 * attached to it. An element that already has a real class needs nothing.
 */
function PromoteToStyleClass({
  nodeId,
  element,
}: {
  nodeId: string;
  element: ElementNode;
}): JSX.Element | null {
  const promoteToStyleClass = useEditorStore((state) => state.promoteToStyleClass);
  const styleModels = useEditorStore((state) => state.styleModels);
  const revision = useEditorStore((state) => state.revision);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hookId = getAttr(element, 'id');
  const hasRules = useMemo(
    () => (hookId ? styleModels.some((model) => definesSelector(model, `#${hookId}`)) : false),
    // The models mutate in place, so `revision` is the signal - see editorStore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hookId, styleModels, revision],
  );

  if (!hookId || !hasRules) return null;

  const submit = (): void => {
    const result = promoteToStyleClass(nodeId, name);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    setName('');
    setError(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        className="button promote-style__trigger"
        onClick={() => setOpen(true)}
        title={`Style tego elementu są zapisane pod #${hookId} - zamień je na nazwaną klasę, której da się użyć ponownie`}
      >
        <Icon name="sell" size={15} />
        Zapisz jako styl…
      </button>
    );
  }

  return (
    <div className="promote-style">
      <label className="field">
        <span className="field__label">Nazwa nowego stylu</span>
        <input
          className="input"
          type="text"
          autoFocus
          value={name}
          placeholder="np. karta-oferty"
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') setOpen(false);
          }}
        />
      </label>

      {error ? (
        <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)', margin: 0 }}>
          {error}
        </p>
      ) : (
        <p className="dialog__hint" style={{ margin: 0 }}>
          Reguły spod <code>#{hookId}</code> przeniosą się do <code>.{slugifyPreview(name)}</code> - razem ze
          stanami i breakpointami. Od tej chwili styl będzie w panelu „Style”.
        </p>
      )}

      <div className="promote-style__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={submit}
          disabled={name.trim() === ''}
        >
          Zapisz styl
        </button>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Anuluj
        </button>
      </div>
    </div>
  );
}

/** Mirrors `slugify`'s shape for the preview line, without importing the engine. */
function slugifyPreview(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug === '' ? 'nazwa-stylu' : slug;
}

/** `action` values that mean "this form has nowhere to send anything". */
function formHasNoDestination(action: string | null): boolean {
  const trimmed = (action ?? '').trim();
  return trimmed === '' || trimmed === '#';
}

/**
 * Tells the truth about a form that cannot submit anywhere.
 *
 * The contact-form component ships with `action="#"`, which looks complete and
 * does nothing: the visitor fills it in, presses Wyślij, and the message goes
 * nowhere. Nobody finds out until a customer complains that they wrote and got
 * no answer.
 *
 * A static site genuinely cannot receive form posts by itself - so rather than
 * pretend otherwise, this states the constraint plainly and offers the one
 * thing that fixes it: somewhere to send the data. No integration, no account,
 * no network access from the editor; just an honest explanation and a field for
 * a URL the user gets from a form-handling service or their own backend.
 */
function FormDestinationSection({
  nodeId,
  action,
  onChange,
}: {
  nodeId: string;
  action: string | null;
  onChange: (value: string | null) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(action ?? '');
  const missing = formHasNoDestination(action);

  // Re-seed when a different form is selected.
  useEffect(() => {
    setDraft(action ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === (action ?? '')) return;
    onChange(trimmed === '' ? null : trimmed);
  };

  return (
    <Section title="Wysyłka formularza" badge={missing} defaultOpen={missing}>
      {missing ? (
        <p className="form-destination__warning" role="note">
          <Icon name="warning" size={15} />
          <span>
            Ten formularz nie ma dokąd wysyłać danych - po kliknięciu „Wyślij” nic się nie stanie. Zwykła
            strona WWW nie obsłuży wysyłki sama.
          </span>
        </p>
      ) : null}

      <label className="field">
        <span className="field__label">Adres odbioru (action)</span>
        <input
          className="input"
          type="text"
          value={draft}
          placeholder="np. https://formspree.io/f/twoj-klucz"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      </label>

      <p className="dialog__hint" style={{ margin: 0 }}>
        Wklej adres z darmowej usługi odbierającej formularze (Formspree, Basin, Web3Forms) albo własny
        endpoint. Litho tylko zapisze go w atrybucie <code>action</code> - nic nigdzie nie wysyła.
      </p>
    </Section>
  );
}

/**
 * Chooses which *state* of the element the controls below edit.
 *
 * The second axis of the same idea as the breakpoint bar: that one decides
 * which `@media` block a declaration is written into, this one decides which
 * pseudo-class the selector carries. Picking "Najechanie" and setting a
 * background writes `.przycisk:hover { background: … }` - the thing that
 * previously required leaving the app and editing CSS by hand.
 *
 * Deliberately worded in plain language rather than as `:hover`/`:focus`: the
 * pseudo-class name is shown as a hint for people who know it, and the
 * behaviour is described for people who do not.
 */
function StyleStateSwitch(): JSX.Element {
  const styleState = useEditorStore((state) => state.styleState);
  const setStyleState = useEditorStore((state) => state.setStyleState);

  return (
    <div className="style-state">
      <span className="style-state__label">Stan</span>
      <div className="style-state__options" role="group" aria-label="Stan elementu">
        {STYLE_STATES.map((state) => (
          <button
            key={state.id}
            type="button"
            className="button"
            aria-pressed={styleState === state.id}
            onClick={() => setStyleState(state.id)}
            title={state.hint}
          >
            {state.label}
          </button>
        ))}
      </div>
      {styleState !== 'normal' ? (
        <p className="style-state__hint">
          Zmiany zapisują się jako <code>:{styleState}</code> - działają tylko w tym stanie. Zaznaczony
          element pokazuje ten stan w obszarze edycji, dopóki tu jesteś; wróć do „Normalny”, żeby zobaczyć
          go zwyczajnie.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Warns that the selected element has been lifted out of the page's layout.
 *
 * Dragging something to an empty spot is the most natural gesture the editor
 * offers, and it writes `position: absolute` with `left`/`top` in pixels
 * measured against the *current* canvas. That looks perfect on Desktop and
 * frequently lands off-screen on Telefon, because those pixels mean nothing at
 * 390 px wide. The program used to say nothing, so the page looked finished
 * right up until someone opened it on a phone.
 *
 * Three ways out, all one click: look at the damage, undo the cause, or say
 * it's fine - not every fixed/absolute element is a mistake (a sticky header,
 * a badge deliberately placed inside a relatively positioned parent), and a
 * warning with no "you're wrong about this one" gets tuned out entirely.
 */
function OutOfLayoutWarning({
  nodeId,
  declarations,
}: {
  nodeId: string;
  declarations: Declarations;
}): JSX.Element | null {
  const returnToLayout = useEditorStore((state) => state.returnToLayout);
  const setBreakpoint = useEditorStore((state) => state.setBreakpoint);
  const breakpoints = useEditorStore((state) => state.breakpoints);
  const breakpoint = useEditorStore((state) => state.currentBreakpoint());
  const isIgnored = useEditorStore((state) => state.isOutOfLayoutIgnored(nodeId));
  const ignoreOutOfLayout = useEditorStore((state) => state.ignoreOutOfLayout);
  const unignoreOutOfLayout = useEditorStore((state) => state.unignoreOutOfLayout);

  const position = declarations.position;
  if (position !== 'absolute' && position !== 'fixed') return null;

  if (isIgnored) {
    return (
      <div className="layout-warning layout-warning--ignored" role="note">
        <p className="layout-warning__text">
          <Icon name="visibility_off" size={15} />
          <span>To ostrzeżenie jest zignorowane dla tego elementu.</span>
        </p>
        <div className="layout-warning__actions">
          <button type="button" className="button" onClick={() => unignoreOutOfLayout(nodeId)}>
            <Icon name="visibility" size={15} />
            Przestań ignorować
          </button>
        </div>
      </div>
    );
  }

  // The narrowest breakpoint is where this kind of damage shows up first.
  const narrowest = breakpoints
    .filter((entry) => entry.maxWidth !== null)
    .sort((a, b) => (a.maxWidth ?? 0) - (b.maxWidth ?? 0))[0];

  return (
    <div className="layout-warning" role="note">
      <p className="layout-warning__text">
        <Icon name="warning" size={15} />
        <span>
          Ten element jest wyjęty z układu strony i przypięty do konkretnych pikseli. Na węższym ekranie może
          wylądować w złym miejscu albo poza stroną.
        </span>
      </p>
      <div className="layout-warning__actions">
        {narrowest && breakpoint.id !== narrowest.id ? (
          <button type="button" className="button" onClick={() => setBreakpoint(narrowest.id)}>
            <Icon name="monitor" size={15} />
            Sprawdź na: {narrowest.label}
          </button>
        ) : null}
        <button
          type="button"
          className="button"
          onClick={() => returnToLayout(nodeId)}
          title="Usuwa position/left/top - element wraca na swoje miejsce w normalnym przepływie strony"
        >
          <Icon name="undo" size={15} />
          Wróć do układu
        </button>
        <button
          type="button"
          className="button"
          onClick={() => ignoreOutOfLayout(nodeId)}
          title="To pozycjonowanie jest zamierzone - przestań o nim ostrzegać dla tego elementu"
        >
          <Icon name="visibility_off" size={15} />
          Ignoruj
        </button>
      </div>
    </div>
  );
}

/**
 * Shown instead of "select an element" once nothing is selected - which is
 * also what happens right after clicking empty canvas background, since
 * `<body>` itself is not a selectable canvas target (see `isSelectableTag`).
 * Writes through the same `setStyle` used for every other element, targeting
 * the page's own `<body>` node, so page background follows the exact same
 * selector/breakpoint rules as any other style edit.
 */
function PageBackgroundPanel({ bodyId }: { bodyId: string }): JSX.Element {
  const setStyle = useEditorStore((state) => state.setStyle);
  const declarationsFor = useEditorStore((state) => state.declarationsFor);
  const breakpoint = useEditorStore((state) => state.currentBreakpoint());
  const revision = useEditorStore((state) => state.revision);
  const document = useEditorStore((state) => state.document);

  const declarations: Declarations = useMemo(
    () => declarationsFor(bodyId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bodyId, breakpoint.id, document, declarationsFor, revision],
  );

  const set = useCallback(
    (property: string, value: string): void => {
      setStyle(
        bodyId,
        { [property]: value.trim() === '' ? null : value },
        {
          label: `Zmiana tła strony: ${property}`,
          mergeKey: `style:${bodyId}:${property}`,
        },
      );
    },
    [bodyId, setStyle],
  );

  return (
    <div className="panel__body" style={{ padding: 0 }}>
      <p className="props__context">
        <Icon name="info" size={14} />
        <span>
          Tło całej strony · zapisywane dla breakpointu <strong>{breakpoint.label}</strong>. Zaznacz element
          na podglądzie, aby zamiast tego edytować jego własne właściwości.
        </span>
      </p>
      <PageMetaSection />

      <Section title="Tło strony" defaultOpen>
        <BackgroundSection key={breakpoint.id} declarations={declarations} set={set} />
      </Section>
    </div>
  );
}

/**
 * Text content, edited here instead of directly on the canvas - the canvas
 * only supports two narrow rich-text transforms (link, dynamic year) via a
 * selected-text context menu, which is not the same thing as just retyping a
 * heading or a button's label. Commits on blur rather than per keystroke: a
 * text change replaces the element's children, which is a structural edit
 * that reloads the canvas iframe, and doing that on every character typed
 * would make typing feel broken.
 */
function TextContentField({
  initialValue,
  onCommit,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(initialValue);
  return (
    <label className="field">
      <span className="field__label">Tekst</span>
      <textarea
        className="textarea"
        rows={3}
        style={{ height: 'auto', resize: 'vertical' }}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== initialValue) onCommit(value);
        }}
      />
    </label>
  );
}

/**
 * The choices inside a `<select>`. These can't be reached by clicking on the
 * canvas - a closed native dropdown renders its option list as an OS-level
 * popup outside the iframe's DOM, so there is nothing for the canvas' click
 * handler to hit-test against - so this is the only place to edit an
 * option's label, its `value` attribute, or add/remove a choice.
 */
function OptionsField({
  select: selectElement,
  onCommitText,
  onCommitValue,
  onAdd,
  onRemove,
}: {
  select: ElementNode;
  onCommitText: (id: string, value: string) => void;
  onCommitValue: (id: string, value: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const options = selectElement.children.filter(
    (child): child is ElementNode => child.kind === 'element' && child.tag === 'option',
  );

  return (
    <div className="props__options">
      {options.length === 0 ? (
        <p className="dialog__hint" style={{ margin: '0 0 8px' }}>
          Ta lista nie ma jeszcze żadnych opcji.
        </p>
      ) : (
        options.map((option) => (
          <OptionRow
            key={option.id}
            option={option}
            onCommitText={(value) => onCommitText(option.id, value)}
            onCommitValue={(value) => onCommitValue(option.id, value)}
            onRemove={() => onRemove(option.id)}
          />
        ))
      )}
      <button type="button" className="button" onClick={onAdd}>
        <Icon name="add" size={15} />
        Dodaj opcję
      </button>
    </div>
  );
}

function OptionRow({
  option,
  onCommitText,
  onCommitValue,
  onRemove,
}: {
  option: ElementNode;
  onCommitText: (value: string) => void;
  onCommitValue: (value: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const initialLabel = textContent(option);
  const initialValue = getAttr(option, 'value') ?? '';
  const [label, setLabel] = useState(initialLabel);
  const [value, setValue] = useState(initialValue);

  return (
    <div className="props__option-row">
      <label className="field">
        <span className="field__label">Etykieta</span>
        <input
          className="input"
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => {
            if (label !== initialLabel) onCommitText(label);
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">Wartość (value)</span>
        <input
          className="input"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => {
            if (value !== initialValue) onCommitValue(value);
          }}
        />
      </label>
      <button
        type="button"
        className="button button--icon"
        onClick={onRemove}
        aria-label="Usuń opcję"
        title="Usuń opcję"
      >
        <Icon name="delete" size={15} />
      </button>
    </div>
  );
}

/**
 * Assigns a CSS class to an element from a combobox of classes the page's
 * stylesheets already define - typing a name that does not exist yet still
 * works, so this doubles as "create a new style hook". Existing classes show
 * as removable chips; the effect of picking one is visible on the canvas
 * immediately, since `onChange` writes the real `class` attribute.
 *
 * The suggestion list is built by hand rather than with a native `<datalist>`.
 * A real project defines hundreds of class names, and the native popup gives
 * no control over its height, its scrolling or how it filters - on a long list
 * it either ran off the window or showed a handful of entries with no way to
 * reach the rest. A plain scroll container does exactly what is wanted: a
 * fixed-height, scrollable, substring-filtered list.
 */
function ClassNameField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const classes = value.split(/\s+/u).filter(Boolean);

  const query = draft.trim().toLowerCase();
  const suggestions = options.filter(
    (name) => !classes.includes(name) && (query === '' || name.toLowerCase().includes(query)),
  );

  const addClass = (name: string): void => {
    const trimmed = name.trim();
    setDraft('');
    setOpen(false);
    if (trimmed === '' || classes.includes(trimmed)) return;
    onChange([...classes, trimmed].join(' '));
  };

  const removeClass = (name: string): void => {
    onChange(classes.filter((entry) => entry !== name).join(' '));
  };

  /* A click anywhere else dismisses the list, exactly like a native popup. */
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  /* Keyboard navigation is useless if the highlighted row is scrolled out of
     sight, which on a long list it usually is. */
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const moveActive = (delta: number): void => {
    if (suggestions.length === 0) return;
    setOpen(true);
    setActiveIndex((current) => {
      const next = current + delta;
      if (next < 0) return suggestions.length - 1;
      if (next >= suggestions.length) return 0;
      return next;
    });
  };

  return (
    <div className="field class-picker" ref={rootRef}>
      <span className="field__label">Klasa CSS</span>
      {classes.length > 0 ? (
        <div className="class-picker__chips">
          {classes.map((name) => (
            <span key={name} className="class-picker__chip">
              {name}
              <button
                type="button"
                className="class-picker__chip-remove"
                aria-label={`Usuń klasę ${name}`}
                onClick={() => removeClass(name)}
              >
                <Icon name="close" size={13} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="class-picker__add">
        <input
          className="input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="litho-class-options"
          aria-autocomplete="list"
          value={draft}
          placeholder="Wybierz lub wpisz nazwę stylu…"
          onChange={(event) => {
            setDraft(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              // A highlighted suggestion wins over the raw text, so arrowing
              // to an existing class and pressing Enter picks that class
              // rather than creating one named after the partial query.
              addClass(open && suggestions[activeIndex] ? suggestions[activeIndex]! : draft);
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveActive(1);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveActive(-1);
              return;
            }
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              setOpen(false);
            }
          }}
          onBlur={(event) => {
            // Focus moving to one of the suggestion buttons is not "leaving the
            // field" - committing the half-typed query here would add a bogus
            // class alongside the one being clicked.
            if (rootRef.current?.contains(event.relatedTarget as Node | null)) return;
            setOpen(false);
            if (draft.trim() !== '') addClass(draft);
          }}
        />
        <button
          type="button"
          className="button button--icon"
          onClick={() => setOpen((current) => !current)}
          aria-label={open ? 'Ukryj listę klas' : 'Pokaż listę klas'}
          title="Lista klas zdefiniowanych w arkuszach strony"
        >
          <Icon name={open ? 'expand_less' : 'expand_more'} size={16} />
        </button>
        <button
          type="button"
          className="button button--icon"
          onClick={() => addClass(draft)}
          aria-label="Dodaj klasę"
          title="Dodaj klasę"
        >
          <Icon name="add" size={16} />
        </button>
      </div>

      {open ? (
        <ul className="class-picker__list" id="litho-class-options" role="listbox" ref={listRef}>
          {suggestions.length === 0 ? (
            <li className="class-picker__empty">
              {options.length === 0
                ? 'Arkusze tej strony nie definiują jeszcze żadnych klas.'
                : 'Brak pasujących klas - Enter utworzy nową.'}
            </li>
          ) : (
            suggestions.map((name, index) => (
              <li key={name} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  className={`class-picker__option${index === activeIndex ? ' class-picker__option--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => addClass(name)}
                >
                  {name}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** Attribute editors that differ per element kind, plus a generic escape hatch. */
function AttributeFields({
  element,
  onChange,
  assets,
  pageRelPath,
}: {
  element: ElementNode;
  onChange: (id: string, name: string, value: string | null, label?: string) => void;
  assets: AssetRef[];
  pageRelPath: string;
}): JSX.Element {
  const kind = classifyElement(element);
  const set = (name: string, value: string) =>
    onChange(element.id, name, value.trim() === '' ? null : value, `Zmiana: ${name}`);

  return (
    <>
      <Field label="Identyfikator (id)" value={getAttr(element, 'id')} onChange={(v) => set('id', v)} />
      <Field label="Klasy CSS" value={getAttr(element, 'class')} onChange={(v) => set('class', v)} />

      {kind === 'link' ? (
        <>
          <Field label="Adres (href)" value={getAttr(element, 'href')} onChange={(v) => set('href', v)} />
          <SelectField
            label="Cel (target)"
            value={getAttr(element, 'target')}
            onChange={(v) => set('target', v)}
            options={['', '_self', '_blank']}
          />
        </>
      ) : null}

      {/* `src`/`alt` for an image live in the "Obraz" section above, where they
          are visible without expanding anything. */}

      {kind === 'video' ? (
        <Field label="Źródło / adres (src)" value={getAttr(element, 'src')} onChange={(v) => set('src', v)} />
      ) : null}

      {kind === 'audio' ? (
        <>
          <AudioAssetPicker
            assets={assets}
            pageRelPath={pageRelPath}
            value={getAttr(element, 'src')}
            onChange={(v) => set('src', v)}
          />
          <Field label="Źródło (src)" value={getAttr(element, 'src')} onChange={(v) => set('src', v)} />
        </>
      ) : null}

      {kind === 'input' ||
      kind === 'textarea' ||
      kind === 'select' ||
      kind === 'checkbox' ||
      kind === 'radio' ? (
        <>
          <Field label="Nazwa (name)" value={getAttr(element, 'name')} onChange={(v) => set('name', v)} />
          <Field
            label="Podpowiedź (placeholder)"
            value={getAttr(element, 'placeholder')}
            onChange={(v) => set('placeholder', v)}
          />
        </>
      ) : null}

      {kind === 'form' ? (
        <>
          <Field
            label="Adres wysyłki (action)"
            value={getAttr(element, 'action')}
            onChange={(v) => set('action', v)}
          />
          <SelectField
            label="Metoda"
            value={getAttr(element, 'method')}
            onChange={(v) => set('method', v)}
            options={['', 'get', 'post']}
          />
        </>
      ) : null}

      <Field
        label="Etykieta dostępności (aria-label)"
        value={getAttr(element, 'aria-label')}
        onChange={(v) => set('aria-label', v)}
      />
    </>
  );
}

/**
 * Picks the picture for the selected `<img>`, and imports new files without a
 * detour through the Zasoby panel.
 *
 * Typing a project-relative path into a text field was previously the only way
 * to do this, which falls apart on the case that matters most: a gallery of six
 * tiles, where the entire task is "put my six photos here". Thumbnails also
 * answer "which file is which" in a way a list of names cannot.
 *
 * Writes through `setImageSource` rather than `setAttribute` so the picture's
 * own dimensions replace the previous one's in a single undo step.
 */
function ImageAssetPicker({
  assets,
  pageRelPath,
  elementId,
  value,
}: {
  assets: AssetRef[];
  pageRelPath: string;
  elementId: string;
  value: string | undefined;
}): JSX.Element {
  const setAssets = useEditorStore((state) => state.setAssets);
  const setImageSource = useEditorStore((state) => state.setImageSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imageAssets = assets.filter((asset) => isImageAsset(asset.relPath));

  const upload = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.litho.assets.pickDialog();
    if (result.ok) setAssets(result.value);
    else if (result.code !== 'CANCELLED') setError(result.message);
    setBusy(false);
  };

  return (
    <div className="field">
      <span className="field__label">Obraz z zasobów</span>
      {imageAssets.length > 0 ? (
        <div className="bg-asset-picker">
          {imageAssets.map((asset) => {
            const href = relativeHref(pageRelPath, asset.relPath);
            return (
              <button
                key={asset.relPath}
                type="button"
                className={`bg-asset-picker__item${href === value ? ' bg-asset-picker__item--active' : ''}`}
                title={asset.name}
                aria-label={`Ustaw obraz: ${asset.name}`}
                onClick={() => setImageSource(elementId, href, asset.width, asset.height)}
              >
                <img src={toAssetUrl(asset.relPath)} alt="" loading="lazy" />
              </button>
            );
          })}
        </div>
      ) : (
        <p className="dialog__hint" style={{ margin: '0 0 6px' }}>
          Brak obrazów w zasobach.
        </p>
      )}
      <button type="button" className="button" onClick={() => void upload()} disabled={busy}>
        <Icon name="upload_file" size={15} />
        Wgraj obraz z dysku…
      </button>
      {error ? (
        <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Lets the user pick an already-uploaded audio file for a selected `<audio>`
 * element, instead of having to know/type its project-relative path by hand -
 * the same "pick from Zasoby" affordance `BackgroundSection` offers for
 * images, just as a plain list since there is no useful thumbnail for audio.
 */
function AudioAssetPicker({
  assets,
  pageRelPath,
  value,
  onChange,
}: {
  assets: AssetRef[];
  pageRelPath: string;
  value: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element {
  const audioAssets = assets.filter((asset) => isAudioAsset(asset.relPath));

  if (audioAssets.length === 0) {
    return (
      <p className="dialog__hint" style={{ margin: 0 }}>
        Brak plików audio w zasobach - dodaj je w panelu „Zasoby”.
      </p>
    );
  }

  return (
    <label className="field">
      <span className="field__label">Plik z zasobów</span>
      <select
        className="select"
        value={value ?? ''}
        onChange={(event) => {
          if (event.target.value !== '') onChange(event.target.value);
        }}
      >
        <option value="">- wybierz plik -</option>
        {audioAssets.map((asset) => {
          const href = relativeHref(pageRelPath, asset.relPath);
          return (
            <option key={asset.relPath} value={href}>
              {asset.name}
            </option>
          );
        })}
      </select>
    </label>
  );
}
