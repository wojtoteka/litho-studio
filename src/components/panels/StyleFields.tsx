import { useEffect, useState } from 'react';
import type { Declarations } from '@/engine/cssGenerator.js';
import { useEditorStore, isImageAsset } from '@/state/editorStore.js';
import { toAssetUrl } from '@/lib/canvasDocument.js';
import { relativeHref } from '@shared/paths.js';
import { GOOGLE_FONTS, GOOGLE_FONTS_PRECONNECT, fontFamilyValue, googleFontHref } from '@/lib/googleFonts.js';
import { Icon } from '../Icon.js';

/**
 * The style controls, shared by the two places that write CSS declarations:
 * the properties panel (which styles one selected element) and the styles panel
 * (which styles a named class).
 *
 * They are one module on purpose. A reusable style has to be able to express
 * everything an element's own style can, or "move this into a class" would
 * quietly lose properties — so both editors render the *same* `DeclarationEditor`
 * and differ only in which selector the patch is written to.
 */

/**
 * A collapsible properties group.
 *
 * Open state is tracked internally so the section can be *opened* in response to
 * `defaultOpen` becoming true (a script just got attached, or a scripted element
 * was selected) without ever being yanked *closed* against the user — driving a
 * bare `<details open={prop}>` off changing props does exactly that, collapsing
 * the section the moment an unrelated edit re-renders the panel.
 */
export function Section({
  title,
  children,
  defaultOpen = false,
  badge = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /**
   * Marks a collapsed section that already holds something — currently only
   * "this element has a script attached". A dot rendered next to the heading,
   * never appended *to* it: the title is the section's identity, and gluing a
   * bullet onto the string made the same section read as two different ones
   * depending on state (and made it awkward to address in tests).
   */
  badge?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  return (
    <details className="props__section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="props__summary">
        {title}
        {badge ? <span className="props__badge" aria-hidden="true" /> : null}
      </summary>
      <div className="props__content">{children}</div>
    </details>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  autoPx,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * CSS length properties silently ignore a bare number (`font-size: 20` does
   * nothing — the declaration is invalid) — which is exactly what someone
   * used to typing "20" for a size in most other software would type here.
   * Appending `px` to a value that is *only* digits turns that into the
   * valid declaration they meant, without touching anything that already has
   * a unit, a keyword, or a CSS function.
   *
   * This has to happen on *blur*, not on every keystroke: rewriting the
   * input's value while the user is still typing moves the browser's own
   * caret to the end of the field (React does not reliably preserve it
   * across a value the app itself rewrote), so typing "40" one digit at a
   * time turned into "4px" then "4px0" — normalizing mid-input actively
   * corrupted the value instead of fixing it.
   */
  autoPx?: boolean;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="input"
        type="text"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={
          autoPx
            ? (event) => {
                const normalized = withPxFallback(event.target.value);
                if (normalized !== event.target.value) onChange(normalized);
              }
            : undefined
        }
      />
    </label>
  );
}

/** Appends `px` to a value that is nothing but a (possibly negative,
 * possibly decimal) number — see `Field`'s `autoPx` prop. */
export function withPxFallback(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return value;
  return /^-?\d+(\.\d+)?$/u.test(trimmed) ? `${trimmed}px` : value;
}

/**
 * The font-size field pairs the usual text input with -/+ steppers: typing a
 * bare number already works (see `withPxFallback`), but a one-click nudge is
 * the faster way to answer "make this text bigger" — the most common
 * typography request there is.
 */
export function FontSizeField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element {
  const step = (delta: number) => {
    const current = parseFloat(value ?? '') || 16;
    const next = Math.max(1, Math.round(current + delta));
    onChange(`${next}px`);
  };

  return (
    <label className="field">
      <span className="field__label">Rozmiar</span>
      <div className="color-field">
        <button
          type="button"
          className="button button--icon"
          onClick={() => step(-1)}
          aria-label="Zmniejsz rozmiar tekstu"
          title="Zmniejsz o 1px"
        >
          <Icon name="remove" size={15} />
        </button>
        <input
          className="input"
          type="text"
          // The wrapping <label> holds the two steppers as well, so the implicit
          // label gives the input no usable name — a screen reader would read it
          // as "− Rozmiar +". Naming it explicitly keeps it addressable.
          aria-label="Rozmiar tekstu"
          value={value ?? ''}
          placeholder="16px"
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => {
            const normalized = withPxFallback(event.target.value);
            if (normalized !== event.target.value) onChange(normalized);
          }}
        />
        <button
          type="button"
          className="button button--icon"
          onClick={() => step(1)}
          aria-label="Zwiększ rozmiar tekstu"
          title="Zwiększ o 1px"
        >
          <Icon name="add" size={15} />
        </button>
      </div>
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  options: string[];
}): JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="select" value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option === '' ? '— nie ustawiono —' : option}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * `font-family` as a curated Google Fonts dropdown, with the raw text field
 * kept underneath for anything the list does not cover (a system stack, a
 * font the project already ships, …).
 *
 * Picking a family from the list also links its stylesheet from Google's CDN
 * into the open page's `<head>` (via `ensureHeadLink`, deduped by `href`) —
 * without it the declaration would name a font the page never loads, and
 * every element using it would silently fall back to the generic family.
 */
export function FontPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element {
  const ensureHeadLink = useEditorStore((state) => state.ensureHeadLink);
  const selected = GOOGLE_FONTS.find((font) => fontFamilyValue(font) === value?.trim());

  const pick = (name: string): void => {
    const font = GOOGLE_FONTS.find((candidate) => candidate.name === name);
    if (!font) return;
    for (const hint of GOOGLE_FONTS_PRECONNECT) {
      ensureHeadLink(
        { rel: 'preconnect', href: hint.href, crossorigin: hint.crossorigin },
        'Dodanie preconnect dla Google Fonts',
      );
    }
    ensureHeadLink({ rel: 'stylesheet', href: googleFontHref(font.name) }, `Dodanie czcionki ${font.name}`);
    onChange(fontFamilyValue(font));
  };

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <select className="select" value={selected?.name ?? ''} onChange={(event) => pick(event.target.value)}>
        <option value="">— wybierz z Google Fonts —</option>
        {GOOGLE_FONTS.map((font) => (
          <option key={font.name} value={font.name}>
            {font.name}
          </option>
        ))}
      </select>
      <input
        className="input"
        type="text"
        value={value ?? ''}
        placeholder="system-ui, sans-serif"
        onChange={(event) => onChange(event.target.value)}
        style={{ marginTop: 4 }}
      />
    </div>
  );
}

/**
 * One-click colours, offered next to every primary colour field.
 *
 * The `<input type="color">` swatch opens a picker drawn by the operating
 * system — a GTK dialog on Linux, and one more thing between "I want this
 * white" and a white element. These cover the answers people actually reach
 * for: the page's own neutrals at both ends, a mid grey, and the brand accents
 * the built-in templates already use, so a colour set here matches what the
 * components ship with instead of being a hand-mixed near-miss.
 */
const COLOR_PRESETS: readonly { value: string; label: string }[] = [
  { value: '#ffffff', label: 'Biały' },
  { value: '#f4f6fa', label: 'Bardzo jasny szary' },
  { value: '#e6e8ef', label: 'Jasny szary' },
  { value: '#9aa0b4', label: 'Szary' },
  { value: '#3d3f4d', label: 'Ciemny szary' },
  { value: '#12131a', label: 'Prawie czarny' },
  { value: '#6e56cf', label: 'Fiolet' },
  { value: '#4f8fff', label: 'Niebieski' },
  { value: '#2fa66b', label: 'Zielony' },
  { value: '#e0574a', label: 'Czerwony' },
];

/**
 * A colour field pairs a native picker with a text input, because CSS colours
 * the picker cannot express — `currentColor`, `var(--brand)`, `transparent` —
 * are common in real stylesheets and must remain editable.
 *
 * Under both sits the preset row, which is the fastest path for the common case
 * and the only one that does not depend on the OS colour dialog behaving.
 * "Brak" clears the declaration entirely rather than writing `transparent`:
 * a property the user never set must leave no trace in their stylesheet.
 */
export function ColorField({
  label,
  value,
  onChange,
  presets = true,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  /**
   * Off for colours that are one component of a compound value — the two ends
   * of a gradient, the tint over a background image. Those sit two to a row
   * inside an already-deep section, and a preset strip under each turns a
   * dense group of controls into a wall of squares.
   */
  presets?: boolean;
}): JSX.Element {
  const hex = toHexOrNull(value);
  const current = (value ?? '').trim().toLowerCase();

  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="color-field">
        <input
          className="color-field__swatch"
          type="color"
          aria-label={`${label} — wybierz kolor`}
          value={hex ?? '#000000'}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="input"
          type="text"
          aria-label={`${label} — wartość CSS`}
          value={value ?? ''}
          placeholder="np. #6e56cf lub var(--brand)"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {presets ? (
        <div className="color-presets" role="group" aria-label={`${label} — gotowe kolory`}>
          {COLOR_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={`color-presets__swatch${current === preset.value ? ' color-presets__swatch--active' : ''}`}
              style={{ background: preset.value }}
              title={`${preset.label} (${preset.value})`}
              aria-label={`${label}: ${preset.label}`}
              aria-pressed={current === preset.value}
              onClick={() => onChange(preset.value)}
            />
          ))}
          <button
            type="button"
            className="color-presets__clear"
            title="Usuń tę właściwość ze stylu"
            onClick={() => onChange('')}
          >
            Brak
          </button>
        </div>
      ) : null}
    </div>
  );
}

function toHexOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/iu.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/iu.test(trimmed)) {
    const [, r, g, b] = /^#(.)(.)(.)$/u.exec(trimmed) ?? [];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

const GRADIENT_PATTERN = /^linear-gradient\(\s*(-?\d+(?:\.\d+)?)deg\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/iu;
const URL_PATTERN = /^url\(\s*["']?(.*?)["']?\s*\)$/iu;
/** An image with a flat colour tint on top, e.g. a dark overlay behind hero
 * text — CSS itself has no dedicated "tint" property, so this is the
 * conventional way to fake one: a same-colour-twice gradient layered above
 * the actual picture via the multi-background-image syntax. */
const OVERLAY_PATTERN =
  /^linear-gradient\(\s*(rgba?\([^)]+\))\s*,\s*rgba?\([^)]+\)\s*\)\s*,\s*(url\(.*\))$/iu;
const RGBA_PATTERN = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu;

type BackgroundLayer = 'none' | 'gradient' | 'image';

function backgroundLayerOf(image: string | undefined): BackgroundLayer {
  const trimmed = (image ?? '').trim();
  if (trimmed === '') return 'none';
  if (OVERLAY_PATTERN.test(trimmed)) return 'image';
  if (GRADIENT_PATTERN.test(trimmed)) return 'gradient';
  return 'image';
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = toHexOrNull(hex) ?? '#000000';
  const value = parseInt(normalized.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Background editing shared by an element's own style and a reusable class:
 * a solid colour (bottom layer) plus an optional gradient or picked image (top
 * layer) — the same two-layer model CSS itself uses, so switching between them
 * never has to guess what to throw away.
 *
 * Image paths are resolved the same way a dropped asset becomes an `<img src>`
 * elsewhere in the app: relative to the open page's own location. Real-world
 * projects overwhelmingly keep the stylesheet next to the page (or the CSS
 * engine writes into an already-existing sheet at that location), so this
 * matches what ends up on disk without the panel having to predict which
 * stylesheet the declaration will land in.
 */
export function BackgroundSection({
  declarations,
  set,
}: {
  declarations: Declarations;
  set: (property: string, value: string) => void;
}): JSX.Element {
  const assets = useEditorStore((state) => state.assets);
  const page = useEditorStore((state) => state.document);
  const imageAssets = assets.filter((asset) => isImageAsset(asset.relPath));

  // The layer picker needs its own memory: choosing "Obraz" before an image is
  // picked writes no declaration at all (nothing to write yet), so the layer
  // *computed from the declarations* would immediately fall back to "Brak" and
  // the image controls would vanish the instant they appeared. This override
  // wins over the computed value until the user picks a different tab or an
  // ancestor remounts the section (selection change — see the `key` props at
  // the call sites), so the empty "Obraz" panel stays put and is actually
  // usable.
  const [layerOverride, setLayerOverride] = useState<BackgroundLayer | null>(null);

  const bgImage = declarations['background-image'];
  const computedLayer = backgroundLayerOf(bgImage);
  const layer = layerOverride ?? computedLayer;

  const gradientMatch = GRADIENT_PATTERN.exec((bgImage ?? '').trim());
  const gradientAngle = gradientMatch?.[1] ?? '135';
  const gradientStart = gradientMatch?.[2] ?? '#6e56cf';
  const gradientEnd = gradientMatch?.[3] ?? '#4f8fff';

  const overlayMatch = OVERLAY_PATTERN.exec((bgImage ?? '').trim());
  const imagePortion = overlayMatch ? overlayMatch[2]! : (bgImage ?? '').trim();
  const urlMatch = URL_PATTERN.exec(imagePortion);
  const imageHref = urlMatch?.[1] ?? '';
  const overlayRgba = overlayMatch ? RGBA_PATTERN.exec(overlayMatch[1]!) : null;
  const overlayColor = overlayRgba
    ? rgbToHex(Number(overlayRgba[1]), Number(overlayRgba[2]), Number(overlayRgba[3]))
    : '#000000';
  const overlayOpacity = overlayRgba?.[4] !== undefined ? Math.round(Number(overlayRgba[4]) * 100) : 50;
  const overlayEnabled = overlayMatch !== null;

  const setGradient = (angle: string, start: string, end: string): void => {
    setLayerOverride('gradient');
    set('background-image', `linear-gradient(${angle.trim() === '' ? '135' : angle}deg, ${start}, ${end})`);
  };

  const setImageValue = (href: string, overlay: { color: string; opacity: number } | null): void => {
    if (href.trim() === '') {
      set('background-image', '');
      return;
    }
    const urlPart = `url(${href})`;
    if (!overlay) {
      set('background-image', urlPart);
      return;
    }
    const [r, g, b] = hexToRgb(overlay.color);
    const alpha = Math.max(0, Math.min(100, overlay.opacity)) / 100;
    const rgba = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    set('background-image', `linear-gradient(${rgba}, ${rgba}), ${urlPart}`);
  };

  const setLayer = (next: BackgroundLayer): void => {
    setLayerOverride(next);
    if (next === 'none') {
      set('background-image', '');
      set('background-size', '');
      set('background-position', '');
      set('background-repeat', '');
      set('background-attachment', '');
      return;
    }
    if (next === 'gradient') {
      setGradient(gradientAngle, gradientStart, gradientEnd);
      return;
    }
    // Switching to "Obraz" from a real gradient leaves stale CSS behind
    // otherwise — the canvas would keep showing the old gradient until the
    // user happened to pick an image, which reads as "the button did nothing".
    if (computedLayer === 'gradient') set('background-image', '');
  };

  return (
    <>
      <ColorField
        label="Kolor tła"
        value={declarations['background-color']}
        onChange={(v) => set('background-color', v)}
      />

      <div className="field">
        <span className="field__label">Warstwa tła</span>
        <div className="props__row props__row--three">
          <button
            type="button"
            className={`button${layer === 'none' ? ' button--active' : ''}`}
            onClick={() => setLayer('none')}
          >
            Brak
          </button>
          <button
            type="button"
            className={`button${layer === 'gradient' ? ' button--active' : ''}`}
            onClick={() => setLayer('gradient')}
          >
            Gradient
          </button>
          <button
            type="button"
            className={`button${layer === 'image' ? ' button--active' : ''}`}
            onClick={() => setLayer('image')}
          >
            Obraz
          </button>
        </div>
      </div>

      <BackgroundPreview declarations={declarations} />

      {layer === 'gradient' ? (
        <>
          <div className="props__row">
            <ColorField
              label="Kolor 1"
              value={gradientStart}
              onChange={(v) => setGradient(gradientAngle, v, gradientEnd)}
              presets={false}
            />
            <ColorField
              label="Kolor 2"
              value={gradientEnd}
              onChange={(v) => setGradient(gradientAngle, gradientStart, v)}
              presets={false}
            />
          </div>
          <label className="field">
            <span className="field__label">Kąt: {gradientAngle}°</span>
            <input
              className="range"
              type="range"
              min={0}
              max={360}
              step={1}
              value={Number(gradientAngle) || 0}
              onChange={(event) => setGradient(event.target.value, gradientStart, gradientEnd)}
            />
          </label>
          <SelectField
            label="Przewijanie tła"
            value={declarations['background-attachment']}
            onChange={(v) => set('background-attachment', v)}
            options={['', 'scroll', 'fixed', 'local']}
          />
        </>
      ) : null}

      {layer === 'image' ? (
        <>
          {imageAssets.length > 0 ? (
            <div className="field">
              <span className="field__label">Obraz z zasobów</span>
              <div className="bg-asset-picker">
                {imageAssets.map((asset) => {
                  const href = page ? relativeHref(page.relPath, asset.relPath) : asset.relPath;
                  return (
                    <button
                      key={asset.relPath}
                      type="button"
                      className={`bg-asset-picker__item${href === imageHref ? ' bg-asset-picker__item--active' : ''}`}
                      title={asset.name}
                      aria-label={`Ustaw tło: ${asset.name}`}
                      onClick={() =>
                        setImageValue(
                          href,
                          overlayEnabled ? { color: overlayColor, opacity: overlayOpacity } : null,
                        )
                      }
                    >
                      <img src={toAssetUrl(asset.relPath)} alt="" loading="lazy" />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="dialog__hint" style={{ margin: 0 }}>
              Brak obrazów w zasobach — dodaj je w panelu „Zasoby”.
            </p>
          )}
          <Field
            label="Adres obrazu (ścieżka lub URL)"
            value={imageHref}
            onChange={(v) =>
              setImageValue(v, overlayEnabled ? { color: overlayColor, opacity: overlayOpacity } : null)
            }
            placeholder="assets/tlo.jpg lub https://…"
          />
          <SelectField
            label="Dopasowanie"
            value={declarations['background-size']}
            onChange={(v) => set('background-size', v)}
            options={['', 'cover', 'contain', 'auto']}
          />
          <SelectField
            label="Pozycja"
            value={declarations['background-position']}
            onChange={(v) => set('background-position', v)}
            options={[
              '',
              'center',
              'top',
              'bottom',
              'left',
              'right',
              'top left',
              'top right',
              'bottom left',
              'bottom right',
            ]}
          />
          <SelectField
            label="Powtarzanie"
            value={declarations['background-repeat']}
            onChange={(v) => set('background-repeat', v)}
            options={['', 'no-repeat', 'repeat', 'repeat-x', 'repeat-y']}
          />
          <SelectField
            label="Przewijanie tła"
            value={declarations['background-attachment']}
            onChange={(v) => set('background-attachment', v)}
            options={['', 'scroll', 'fixed', 'local']}
          />

          <label className="field field--inline">
            <input
              type="checkbox"
              checked={overlayEnabled}
              onChange={(event) => {
                if (event.target.checked)
                  setImageValue(imageHref, { color: overlayColor, opacity: overlayOpacity });
                else setImageValue(imageHref, null);
              }}
            />
            <span className="field__label" style={{ margin: 0 }}>
              Przyciemnij obraz kolorem (nakładka)
            </span>
          </label>
          {overlayEnabled ? (
            <>
              <ColorField
                label="Kolor nakładki"
                value={overlayColor}
                onChange={(v) => setImageValue(imageHref, { color: v, opacity: overlayOpacity })}
                presets={false}
              />
              <label className="field">
                <span className="field__label">Krycie nakładki: {overlayOpacity}%</span>
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={overlayOpacity}
                  onChange={(event) =>
                    setImageValue(imageHref, { color: overlayColor, opacity: Number(event.target.value) })
                  }
                />
              </label>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** A live swatch of the composed background — the panel edits several
 * properties that only make sense together (colour under image, size with
 * position, …), so a small always-visible preview answers "what does this
 * actually look like" without round-tripping through the canvas. */
function BackgroundPreview({ declarations }: { declarations: Declarations }): JSX.Element {
  return (
    <div
      className="bg-preview"
      style={{
        backgroundColor: declarations['background-color'] || undefined,
        backgroundImage: declarations['background-image'] || undefined,
        backgroundSize: declarations['background-size'] || undefined,
        backgroundPosition: declarations['background-position'] || undefined,
        backgroundRepeat: declarations['background-repeat'] || undefined,
      }}
    />
  );
}

/**
 * Every CSS property the editor exposes, grouped into sections.
 *
 * `set` receives the property and the raw field value; an empty string means
 * "remove this declaration" — the panel never writes an explicit default, so a
 * property the user did not set leaves no trace in their stylesheet.
 */
export function DeclarationEditor({
  declarations,
  set,
  showTypography = true,
  defaultOpen = true,
}: {
  declarations: Declarations;
  set: (property: string, value: string) => void;
  /**
   * Typography has nothing to act on for an `<img>`, an `<svg>` icon or a
   * checkbox — a control that visibly does nothing is worse than no control.
   * Always on for a reusable class, which may well be applied to text later.
   */
  showTypography?: boolean;
  defaultOpen?: boolean;
}): JSX.Element {
  return (
    <>
      <Section title="Pozycja i rozmiar" defaultOpen={defaultOpen}>
        <div className="props__row">
          <Field
            label="Szerokość"
            value={declarations.width}
            onChange={(v) => set('width', v)}
            placeholder="auto"
            autoPx
          />
          <Field
            label="Wysokość"
            value={declarations.height}
            onChange={(v) => set('height', v)}
            placeholder="auto"
            autoPx
          />
        </div>
        <div className="props__row">
          <Field
            label="Min. szer."
            value={declarations['min-width']}
            onChange={(v) => set('min-width', v)}
            autoPx
          />
          <Field
            label="Maks. szer."
            value={declarations['max-width']}
            onChange={(v) => set('max-width', v)}
            autoPx
          />
        </div>
        <SelectField
          label="Wyświetlanie"
          value={declarations.display}
          onChange={(v) => set('display', v)}
          options={['', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none']}
        />
        {declarations.display === 'flex' || declarations.display === 'inline-flex' ? (
          <>
            <SelectField
              label="Kierunek"
              value={declarations['flex-direction']}
              onChange={(v) => set('flex-direction', v)}
              options={['', 'row', 'row-reverse', 'column', 'column-reverse']}
            />
            <div className="props__row">
              <SelectField
                label="Justify"
                value={declarations['justify-content']}
                onChange={(v) => set('justify-content', v)}
                options={['', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around']}
              />
              <SelectField
                label="Align"
                value={declarations['align-items']}
                onChange={(v) => set('align-items', v)}
                options={['', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline']}
              />
            </div>
            <Field
              label="Odstęp (gap)"
              value={declarations.gap}
              onChange={(v) => set('gap', v)}
              placeholder="16px"
              autoPx
            />
          </>
        ) : null}
        <SelectField
          label="Pozycjonowanie"
          value={declarations.position}
          onChange={(v) => set('position', v)}
          options={['', 'static', 'relative', 'absolute', 'fixed', 'sticky']}
        />
        {/* `relative` belongs here too: dragging an element on the canvas
            offsets it relatively (so the layout around it holds), and those
            offsets have to be typeable to the pixel like any other. */}
        {declarations.position === 'absolute' ||
        declarations.position === 'fixed' ||
        declarations.position === 'relative' ? (
          <div className="props__row">
            <Field
              label={declarations.position === 'relative' ? 'Przesunięcie w poziomie' : 'Lewo (left)'}
              value={declarations.left}
              onChange={(v) => set('left', v)}
              autoPx
            />
            <Field
              label={declarations.position === 'relative' ? 'Przesunięcie w pionie' : 'Góra (top)'}
              value={declarations.top}
              onChange={(v) => set('top', v)}
              autoPx
            />
          </div>
        ) : null}
      </Section>

      {/* Open by default alongside "Pozycja i rozmiar": colour and background
          are the controls people reach for first, and leaving them collapsed
          made background editing look like it did not exist. */}
      <Section title="Wygląd" defaultOpen={defaultOpen}>
        <ColorField label="Kolor tekstu" value={declarations.color} onChange={(v) => set('color', v)} />
        <BackgroundSection declarations={declarations} set={set} />
        <Field
          label="Obramowanie"
          value={declarations.border}
          onChange={(v) => set('border', v)}
          placeholder="1px solid #ddd"
        />
        {/*
         * The border's colour on its own, because for some elements it is the
         * only colour there is. A horizontal rule drawn the conventional way —
         * `border: none; border-top: 1px solid …` — has a content box 0 px tall,
         * so "Kolor tła" above paints nothing and the line's colour was
         * reachable only by retyping the whole `border` shorthand by hand. This
         * writes `border-color`, which lands after the shorthand in the rule and
         * therefore wins, so a line already in the page can be recoloured with
         * one click like anything else.
         */}
        <ColorField
          label="Kolor obramowania"
          value={declarations['border-color']}
          onChange={(v) => set('border-color', v)}
        />
        <Field
          label="Zaokrąglenie"
          value={declarations['border-radius']}
          onChange={(v) => set('border-radius', v)}
          placeholder="8px"
          autoPx
        />
        <Field
          label="Cień"
          value={declarations['box-shadow']}
          onChange={(v) => set('box-shadow', v)}
          placeholder="0 2px 8px rgba(0,0,0,.15)"
        />
        <Field
          label="Przezroczystość"
          value={declarations.opacity}
          onChange={(v) => set('opacity', v)}
          placeholder="1"
        />
      </Section>

      {showTypography ? (
        <Section title="Typografia">
          <FontPicker
            label="Krój pisma"
            value={declarations['font-family']}
            onChange={(v) => set('font-family', v)}
          />
          <div className="props__row">
            <FontSizeField value={declarations['font-size']} onChange={(v) => set('font-size', v)} />
            <SelectField
              label="Grubość"
              value={declarations['font-weight']}
              onChange={(v) => set('font-weight', v)}
              options={['', '300', '400', '500', '600', '700', '800']}
            />
          </div>
          <div className="props__row">
            <Field
              label="Interlinia"
              value={declarations['line-height']}
              onChange={(v) => set('line-height', v)}
              placeholder="1.5"
            />
            <Field
              label="Odstęp liter"
              value={declarations['letter-spacing']}
              onChange={(v) => set('letter-spacing', v)}
              autoPx
            />
          </div>
          <SelectField
            label="Wyrównanie"
            value={declarations['text-align']}
            onChange={(v) => set('text-align', v)}
            options={['', 'left', 'center', 'right', 'justify']}
          />
          <SelectField
            label="Dekoracja"
            value={declarations['text-decoration']}
            onChange={(v) => set('text-decoration', v)}
            options={['', 'none', 'underline', 'line-through']}
          />
        </Section>
      ) : null}

      <Section title="Odstępy">
        <Field
          label="Margines (skrót)"
          value={declarations.margin}
          onChange={(v) => set('margin', v)}
          placeholder="0 auto"
        />
        <div className="props__row props__row--four">
          <Field
            label="Góra"
            value={declarations['margin-top']}
            onChange={(v) => set('margin-top', v)}
            autoPx
          />
          <Field
            label="Prawo"
            value={declarations['margin-right']}
            onChange={(v) => set('margin-right', v)}
            autoPx
          />
          <Field
            label="Dół"
            value={declarations['margin-bottom']}
            onChange={(v) => set('margin-bottom', v)}
            autoPx
          />
          <Field
            label="Lewo"
            value={declarations['margin-left']}
            onChange={(v) => set('margin-left', v)}
            autoPx
          />
        </div>
        <Field
          label="Wypełnienie (skrót)"
          value={declarations.padding}
          onChange={(v) => set('padding', v)}
          placeholder="24px"
        />
        <div className="props__row props__row--four">
          <Field
            label="Góra"
            value={declarations['padding-top']}
            onChange={(v) => set('padding-top', v)}
            autoPx
          />
          <Field
            label="Prawo"
            value={declarations['padding-right']}
            onChange={(v) => set('padding-right', v)}
            autoPx
          />
          <Field
            label="Dół"
            value={declarations['padding-bottom']}
            onChange={(v) => set('padding-bottom', v)}
            autoPx
          />
          <Field
            label="Lewo"
            value={declarations['padding-left']}
            onChange={(v) => set('padding-left', v)}
            autoPx
          />
        </div>
      </Section>
    </>
  );
}
