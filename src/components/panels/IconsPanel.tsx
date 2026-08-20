import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { relativeHref } from '@shared/paths.js';
import { resolveInsertionTarget } from '@/lib/insertionTarget.js';
import { setDragPayload } from '@/lib/dragPayload.js';
import { slugify } from '@/engine/idAllocator.js';
import { ALL_MATERIAL_SYMBOLS, MATERIAL_SYMBOL_GROUPS } from '@/lib/materialSymbolIcons.js';
import {
  MATERIAL_SYMBOLS_CSS,
  buildMaterialSymbolIcon,
  element as buildElement,
  text as buildText,
  type MaterialSymbolStyle,
} from '@/lib/elementFactory.js';
import {
  ensureMaterialSymbolsHeadLinks,
  materialSymbolsHref,
  materialSymbolStyleParam,
} from '@/lib/googleFonts.js';
import { Icon } from '../Icon.js';

/**
 * Icon library: Material Symbols (Google Fonts) plus any custom `.ttf`/`.otf`
 * icon font the user uploads.
 *
 * Material Symbols icons are inserted as a `<span>` carrying the icon's
 * ligature name (see `buildMaterialSymbolIcon`) and the page pulls the font
 * from Google's CDN — the same "reference, don't bundle" choice
 * `googleFonts.ts` documents. A custom upload instead gets copied into the
 * project's own `assets/` folder (like any other asset) and an `@font-face`
 * rule written into the project stylesheet, because there is no CDN to point
 * at for a font only this project has.
 *
 * Both kinds support click-insert (appends after the current selection, or to
 * the end of the page — same convention as `ElementsPanel`) and drag-and-drop
 * (free placement at the cursor, via `Canvas.tsx`'s drop handler), so an icon
 * can be positioned precisely without first clicking it in, then dragging it.
 */

const STYLE_LABELS: Record<MaterialSymbolStyle, string> = {
  outlined: 'Outlined',
  rounded: 'Rounded',
  sharp: 'Sharp',
};

/** Loads a stylesheet into the app's own document, once per href. */
function usePreviewStylesheet(href: string): void {
  useEffect(() => {
    if (window.document.querySelector(`link[href="${href}"]`)) return;
    const link = window.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    window.document.head.appendChild(link);
  }, [href]);
}

export function IconsPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const insertTemplate = useEditorStore((state) => state.insertTemplate);
  const ensureHeadLink = useEditorStore((state) => state.ensureHeadLink);

  const [search, setSearch] = useState('');
  const [style, setStyle] = useState<MaterialSymbolStyle>('outlined');

  usePreviewStylesheet(materialSymbolsHref(materialSymbolStyleParam(style)));

  const query = search.trim().toLowerCase().replace(/\s+/gu, '_');
  const filtered = useMemo(
    () => (query === '' ? null : ALL_MATERIAL_SYMBOLS.filter((icon) => icon.includes(query))),
    [query],
  );

  const insert = (iconName: string): void => {
    if (!document) return;
    const target = resolveInsertionTarget(document, selection);
    if (!target) return;

    ensureMaterialSymbolsHeadLinks(ensureHeadLink, style);
    insertTemplate(
      { node: buildMaterialSymbolIcon(iconName, style), css: MATERIAL_SYMBOLS_CSS },
      target,
      `Dodanie ikony: ${iconName}`,
    );
  };

  const iconClass = `material-symbols-${style}`;
  const customFonts = useCustomIconFonts();

  return (
    <div className="panel__body">
      {/*
       * Search, style and "upload your own" stay pinned while the icon grid
       * scrolls under them. Uploading used to live at the very bottom of the
       * panel — below every one of the ~500 Material Symbols — so reaching it
       * meant a long scroll past content that had nothing to do with it, and
       * most people never found out the feature existed. Sticky is what makes
       * "put my own icons in" a first-class action instead of a footnote.
       */}
      <div className="icons__header">
        <div className="search-field">
          <Icon name="search" size={16} />
          <input
            className="input"
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Szukaj ikony… (np. accessible_forward)"
            aria-label="Szukaj ikony"
          />
        </div>

        <div className="icons__header-row">
          <label className="icons__style">
            <span className="field__label">Styl</span>
            <select
              className="select"
              value={style}
              onChange={(event) => setStyle(event.target.value as MaterialSymbolStyle)}
            >
              {(Object.keys(STYLE_LABELS) as MaterialSymbolStyle[]).map((key) => (
                <option key={key} value={key}>
                  {STYLE_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="button icons__upload"
            onClick={customFonts.pickFile}
            disabled={customFonts.busy}
            title="Wgraj własną czcionkę ikon (.ttf/.otf) — np. z IcoMoon albo Fontello"
          >
            <Icon name="upload_file" size={15} />
            {customFonts.busy ? 'Wgrywanie…' : 'Wgraj ikony'}
          </button>
        </div>
      </div>

      {customFonts.input}

      {customFonts.error ? (
        <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)' }}>
          {customFonts.error}
        </p>
      ) : null}

      <CustomIconFontList fonts={customFonts.fonts} />

      <p className="dialog__hint" style={{ marginTop: 6 }}>
        Przeciągnij ikonę na stronę, aby umieścić ją dokładnie tam, gdzie chcesz — kliknięcie wstawia ją za
        zaznaczeniem (lub na końcu strony).
      </p>

      {filtered ? (
        <IconGrid
          icons={filtered}
          iconClass={iconClass}
          style={style}
          onInsert={insert}
          emptyLabel="Brak ikon pasujących do wyszukiwania."
        />
      ) : (
        MATERIAL_SYMBOL_GROUPS.map((group) => (
          <section key={group.label} className="palette__group">
            <h3 className="palette__group-title">{group.label}</h3>
            <IconGrid icons={group.icons} iconClass={iconClass} style={style} onInsert={insert} />
          </section>
        ))
      )}
    </div>
  );
}

function IconGrid({
  icons,
  iconClass,
  style,
  onInsert,
  emptyLabel,
}: {
  icons: string[];
  iconClass: string;
  style: MaterialSymbolStyle;
  onInsert: (iconName: string) => void;
  emptyLabel?: string;
}): JSX.Element {
  if (icons.length === 0) return <p className="dialog__hint">{emptyLabel}</p>;
  return (
    <div className="icon-grid">
      {icons.map((iconName) => (
        <button
          key={iconName}
          type="button"
          className="icon-grid__item"
          draggable
          onDragStart={(event) => setDragPayload(event, { kind: 'icon', iconName, style })}
          onClick={() => onInsert(iconName)}
          title={`${iconName} — przeciągnij na stronę lub kliknij, aby wstawić`}
        >
          <span className={iconClass} aria-hidden="true" translate="no">
            {iconName}
          </span>
          <span className="icon-grid__name">{iconName}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Custom icon fonts (.ttf / .otf)                                      */
/* ------------------------------------------------------------------ */

interface CustomIconFont {
  fontFamily: string;
  className: string;
  css: string;
}

/** `@font-face` + a class rendering it, written once per uploaded font. */
function customIconFontCss(fontFamily: string, className: string, href: string, format: string): string {
  return (
    `@font-face {\n` +
    `  font-family: "${fontFamily}";\n` +
    `  src: url("${href}") format("${format}");\n` +
    `  font-display: swap;\n` +
    `}\n\n` +
    `.${className} {\n` +
    `  font-family: "${fontFamily}";\n` +
    `  display: inline-block;\n` +
    `  font-size: 24px;\n` +
    `  line-height: 1;\n` +
    `}\n`
  );
}

/**
 * Upload state for custom icon fonts, kept as a hook so the *button* can live
 * in the panel's sticky header while the *list* of uploaded fonts stays down in
 * the scrolling flow. Those two need the same state but not the same place on
 * screen, which is exactly what a component could not give us.
 */
function useCustomIconFonts(): {
  fonts: CustomIconFont[];
  busy: boolean;
  error: string | null;
  pickFile: () => void;
  /** The hidden `<input type="file">`; render it once, anywhere. */
  input: JSX.Element;
} {
  const document = useEditorStore((state) => state.document);

  const [fonts, setFonts] = useState<CustomIconFont[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const ext = (/\.[^.]+$/u.exec(file.name)?.[0] ?? '').toLowerCase();
      if (ext !== '.ttf' && ext !== '.otf') {
        setError('Obsługiwane są tylko pliki .ttf i .otf.');
        return;
      }
      const buffer = new Uint8Array(await file.arrayBuffer());
      const result = await window.litho.assets.importBuffer(file.name, buffer);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (!document) return;

      const fontFamily =
        file.name
          .replace(/\.[^.]+$/u, '')
          .replace(/[_-]+/gu, ' ')
          .trim() || 'Custom Icons';
      const className = `ikona-${slugify(fontFamily, 'custom')}`;
      const href = relativeHref(document.relPath, result.value.relPath);
      const format = ext === '.otf' ? 'opentype' : 'truetype';
      const css = customIconFontCss(fontFamily, className, href, format);

      setFonts((previous) => [
        ...previous.filter((font) => font.className !== className),
        { fontFamily, className, css },
      ]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(false);
    }
  };

  const input = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".ttf,.otf"
      style={{ display: 'none' }}
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) void upload(file);
      }}
    />
  );

  return { fonts, busy, error, pickFile: () => fileInputRef.current?.click(), input };
}

/**
 * The fonts the user has uploaded this session, each with the field for the
 * glyph to insert. Renders nothing at all until there is a font — an empty
 * "your fonts" heading above 500 stock icons is just noise.
 */
function CustomIconFontList({ fonts }: { fonts: CustomIconFont[] }): JSX.Element | null {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const insertTemplate = useEditorStore((state) => state.insertTemplate);
  const [glyphs, setGlyphs] = useState<Record<string, string>>({});

  if (fonts.length === 0) return null;

  const insertCustom = (font: CustomIconFont): void => {
    if (!document) return;
    const glyph = glyphs[font.className] || '?';
    const target = resolveInsertionTarget(document, selection);
    if (!target) return;
    const node = buildElement('span', { class: font.className, 'aria-hidden': 'true' }, [buildText(glyph)]);
    insertTemplate({ node, css: font.css }, target, `Dodanie ikony: ${font.fontFamily}`);
  };

  return (
    <section className="icons__custom">
      <h3 className="palette__group-title">Twoje czcionki ikon</h3>
      <p className="dialog__hint">
        Znak ikony to zwykle kod Unicode z prywatnego obszaru — wklej tu znak wygenerowany przez narzędzie,
        którym stworzono czcionkę (np. IcoMoon, Fontello).
      </p>

      {fonts.map((font) => (
        <div key={font.className} className="field" style={{ marginTop: 10 }}>
          <span className="field__label">{font.fontFamily}</span>
          <div className="props__row">
            <input
              className="input"
              type="text"
              value={glyphs[font.className] ?? ''}
              onChange={(event) =>
                setGlyphs((previous) => ({ ...previous, [font.className]: event.target.value }))
              }
              placeholder="Znak ikony"
              maxLength={4}
            />
            <button
              type="button"
              className="icon-grid__item"
              draggable
              onDragStart={(event) =>
                setDragPayload(event, {
                  kind: 'customIcon',
                  fontFamily: font.fontFamily,
                  className: font.className,
                  glyph: glyphs[font.className] || '?',
                  css: font.css,
                })
              }
              onClick={() => insertCustom(font)}
              title={`Wstaw ikonę: ${font.fontFamily}`}
              style={{ height: 40, width: 56 }}
            >
              <span className={font.className} aria-hidden="true">
                {glyphs[font.className] || '?'}
              </span>
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
