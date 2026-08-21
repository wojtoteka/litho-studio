import type { Attribute, DocNode, ElementNode } from '@shared/document.js';
import { getClassList, isElement, walk } from '@shared/document.js';
import { createRuntimeNodeId } from '@/engine/idAllocator.js';
import type { ElementScriptBinding } from '@/engine/elementScripts.js';
import type { IconName } from './icons.js';

/**
 * Templates for everything the user can drag onto the canvas.
 *
 * Two rules shape these definitions:
 *
 *  - **Semantic HTML, not divs with classes.** A heading is an `<h2>`, a button
 *    is a `<button>`, a form field has a `<label>`. The generated file has to be
 *    a page someone would be happy to hand-edit afterwards.
 *  - **Classes, never inline styles.** Each template carries readable class
 *    names and a matching CSS block, so the styling lands in the project's
 *    stylesheet where the user can find and change it.
 */

/**
 * Dynamic behaviour a template brings with it.
 *
 * Almost no template needs this - a heading is a heading. The footer does: a
 * copyright line whose year is typed in is wrong on the first of January, and
 * every project that has ever shipped one has discovered that the hard way. The
 * binding is applied through the ordinary element-script machinery, so what
 * lands in the project is the same readable `script.js` snippet the properties
 * panel writes, editable and removable from there like any other.
 */
export interface TemplateScript {
  /** Locates the element inside the freshly built subtree that the script drives. */
  find(root: ElementNode): ElementNode | null;
  binding: ElementScriptBinding;
}

export interface ElementTemplate {
  id: string;
  label: string;
  /**
   * Material Symbol shown on the palette card. A name, not a character: the
   * palette used a mix of box-drawing glyphs and emoji, which rendered at
   * different weights, different baselines and different colours depending on
   * the font the OS happened to substitute - and turned into full-colour emoji
   * on Windows for exactly four of them.
   */
  icon: IconName;
  group: 'basic' | 'media' | 'form';
  /** Builds a fresh subtree; called once per drop so ids are unique. */
  build(): ElementNode;
  /** CSS added to the project stylesheet the first time this is used. */
  css?: string;
  /** Element scripts attached on insertion; see `TemplateScript`. */
  scripts?: TemplateScript[];
}

export interface ComponentTemplate {
  id: string;
  name: string;
  hint: string;
  /** Material Symbol shown on the component card; see `ElementTemplate.icon`. */
  icon: IconName;
  build(): ElementNode;
  css: string;
  /** Element scripts attached on insertion; see `TemplateScript`. */
  scripts?: TemplateScript[];
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

export function element(tag: string, attrs: Record<string, string>, children: DocNode[] = []): ElementNode {
  return {
    kind: 'element',
    id: createRuntimeNodeId(),
    tag,
    attrs: Object.entries(attrs).map(([name, value]): Attribute => ({ name, value })),
    namespace: 'html',
    children,
  };
}

export function text(value: string): DocNode {
  return { kind: 'text', id: createRuntimeNodeId(), value };
}

/** Finds a node inside a freshly built template subtree by its own class name. */
export function findByClass(root: ElementNode, className: string): ElementNode | null {
  for (const node of walk(root)) {
    if (isElement(node) && getClassList(node).includes(className)) return node;
  }
  return null;
}

export const AUDIO_CSS = `.audio {\n  width: 100%;\n  max-width: 480px;\n}\n`;

/* ------------------------------------------------------------------ */
/* Basic elements                                                      */
/* ------------------------------------------------------------------ */

export const ELEMENT_TEMPLATES: ElementTemplate[] = [
  {
    id: 'heading',
    label: 'Nagłówek',
    icon: 'title',
    group: 'basic',
    build: () => element('h2', { class: 'naglowek' }, [text('Nagłówek sekcji')]),
    css: `.naglowek {\n  font-size: 32px;\n  line-height: 1.2;\n  margin: 0 0 12px;\n}\n`,
  },
  {
    id: 'text',
    label: 'Tekst',
    icon: 'notes',
    group: 'basic',
    build: () => element('p', { class: 'akapit' }, [text('Kliknij dwukrotnie, aby edytować ten tekst.')]),
    css: `.akapit {\n  margin: 0 0 12px;\n  max-width: 65ch;\n}\n`,
  },
  {
    id: 'button',
    label: 'Przycisk',
    icon: 'smart_button',
    group: 'basic',
    build: () => element('button', { type: 'button', class: 'przycisk' }, [text('Kliknij mnie')]),
    css: `.przycisk {\n  display: inline-flex;\n  align-items: center;\n  padding: 10px 20px;\n  border: none;\n  border-radius: 8px;\n  background: #6e56cf;\n  color: #fff;\n  font-size: 15px;\n  cursor: pointer;\n}\n\n.przycisk:hover {\n  background: #5b46b0;\n}\n`,
  },
  {
    id: 'link',
    label: 'Link',
    icon: 'link',
    group: 'basic',
    build: () => element('a', { href: '#', class: 'odnosnik' }, [text('Link tekstowy')]),
    css: `.odnosnik {\n  color: #4f8fff;\n  text-decoration: underline;\n}\n`,
  },
  {
    id: 'container',
    label: 'Kontener',
    icon: 'crop_square',
    group: 'basic',
    build: () => element('div', { class: 'kontener' }, []),
    css: `.kontener {\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  padding: 24px;\n}\n`,
  },
  {
    id: 'section',
    label: 'Sekcja',
    icon: 'view_agenda',
    group: 'basic',
    build: () => element('section', { class: 'sekcja' }, []),
    css: `.sekcja {\n  padding: 64px 24px;\n}\n`,
  },
  {
    id: 'list',
    label: 'Lista',
    icon: 'format_list_bulleted',
    group: 'basic',
    build: () =>
      element('ul', { class: 'lista' }, [
        element('li', {}, [text('Pierwszy punkt')]),
        element('li', {}, [text('Drugi punkt')]),
        element('li', {}, [text('Trzeci punkt')]),
      ]),
    css: `.lista {\n  margin: 0 0 12px;\n  padding-left: 20px;\n}\n`,
  },
  {
    id: 'spacer',
    label: 'Odstęp',
    icon: 'height',
    group: 'basic',
    build: () => element('div', { class: 'odstep', 'aria-hidden': 'true' }, []),
    css: `.odstep {\n  display: block;\n  width: 100%;\n  height: 48px;\n}\n`,
  },
  {
    id: 'divider',
    label: 'Linia',
    icon: 'horizontal_rule',
    group: 'basic',
    build: () => element('hr', { class: 'linia' }),
    /*
     * A filled 1 px box, not a top border.
     *
     * Drawing the rule as `border-top` is the conventional `<hr>` reset, and it
     * put the line's colour somewhere the properties panel could not reach: an
     * `<hr>` styled that way has a content box 0 px tall, so "Kolor tła" painted
     * a region with no area and the colour picker looked broken. The only
     * control that did anything was the free-text "Obramowanie" field, which
     * meant knowing to type `1px solid #ff0000`. Reported, correctly, as "you
     * can't change the line's colour".
     *
     * As a height plus a background the two obvious controls both work and mean
     * what they say - "Kolor tła" is the line's colour, "Wysokość" is its
     * thickness - and the rendered result is identical to the border version.
     */
    css: `.linia {\n  border: none;\n  height: 1px;\n  background-color: #e6e8ef;\n  margin: 24px 0;\n}\n`,
  },
  {
    id: 'blockquote',
    label: 'Cytat',
    icon: 'format_quote',
    group: 'basic',
    build: () =>
      element('blockquote', { class: 'cytat' }, [
        element('p', {}, [text('Tu wpisz treść cytatu.')]),
        element('footer', { class: 'cytat__autor' }, [text('- Autor cytatu')]),
      ]),
    css: `.cytat {\n  margin: 0 0 12px;\n  padding: 16px 20px;\n  border-left: 4px solid #6e56cf;\n  font-style: italic;\n  color: #3d3f4d;\n}\n\n.cytat__autor {\n  margin-top: 8px;\n  font-size: 14px;\n  font-style: normal;\n  color: #5b5f73;\n}\n`,
  },
  {
    id: 'image',
    label: 'Obraz',
    icon: 'image',
    group: 'media',
    build: () =>
      element('img', {
        src: 'assets/placeholder.svg',
        alt: 'Opis obrazu',
        class: 'obraz',
        loading: 'lazy',
      }),
    css: `.obraz {\n  display: block;\n  max-width: 100%;\n  height: auto;\n}\n`,
  },
  {
    id: 'video',
    label: 'Wideo',
    icon: 'movie',
    group: 'media',
    build: () =>
      element('video', { class: 'wideo', controls: '', preload: 'metadata' }, [
        text(' Twoja przeglądarka nie obsługuje odtwarzania wideo. '),
      ]),
    css: `.wideo {\n  width: 100%;\n  max-width: 720px;\n  border-radius: 8px;\n}\n`,
  },
  {
    id: 'icon',
    label: 'Ikona',
    icon: 'star',
    group: 'media',
    build: () => element('span', { class: 'ikona', 'aria-hidden': 'true' }, [text('★')]),
    css: `.ikona {\n  display: inline-block;\n  font-size: 24px;\n  line-height: 1;\n}\n`,
  },
  {
    id: 'audio',
    label: 'Audio',
    icon: 'music_note',
    group: 'media',
    build: () =>
      element('audio', { class: 'audio', controls: '', preload: 'metadata' }, [
        text(' Twoja przeglądarka nie obsługuje odtwarzania audio. '),
      ]),
    css: AUDIO_CSS,
  },
  {
    id: 'maps',
    label: 'Mapy',
    icon: 'location_on',
    group: 'media',
    build: () =>
      element('iframe', {
        class: 'mapa',
        src: 'https://www.google.com/maps?q=Warszawa&output=embed',
        title: 'Mapa lokalizacji',
        loading: 'lazy',
        referrerpolicy: 'no-referrer-when-downgrade',
        allowfullscreen: '',
      }),
    css: `.mapa {\n  display: block;\n  width: 100%;\n  aspect-ratio: 16 / 9;\n  border: none;\n  border-radius: 8px;\n}\n`,
  },
  {
    id: 'input',
    label: 'Pole tekstowe',
    icon: 'text_fields',
    group: 'form',
    build: () =>
      element('label', { class: 'pole' }, [
        element('span', { class: 'pole__etykieta' }, [text('Imię i nazwisko')]),
        element('input', { type: 'text', name: 'imie', class: 'pole__kontrolka' }),
      ]),
    css: FORM_FIELD_CSS(),
  },
  {
    id: 'textarea',
    label: 'Pole wieloliniowe',
    icon: 'notes',
    group: 'form',
    build: () =>
      element('label', { class: 'pole' }, [
        element('span', { class: 'pole__etykieta' }, [text('Wiadomość')]),
        element('textarea', { name: 'wiadomosc', rows: '4', class: 'pole__kontrolka' }, [text('')]),
      ]),
    css: FORM_FIELD_CSS(),
  },
  {
    id: 'select',
    label: 'Lista wyboru',
    icon: 'arrow_drop_down_circle',
    group: 'form',
    build: () =>
      element('label', { class: 'pole' }, [
        element('span', { class: 'pole__etykieta' }, [text('Wybierz opcję')]),
        element('select', { name: 'opcja', class: 'pole__kontrolka' }, [
          element('option', { value: 'a' }, [text('Opcja A')]),
          element('option', { value: 'b' }, [text('Opcja B')]),
        ]),
      ]),
    css: FORM_FIELD_CSS(),
  },
  {
    id: 'checkbox',
    label: 'Checkbox',
    icon: 'check_box',
    group: 'form',
    build: () =>
      element('label', { class: 'zgoda' }, [
        element('input', { type: 'checkbox', name: 'zgoda', class: 'zgoda__kontrolka' }),
        element('span', {}, [text('Akceptuję regulamin')]),
      ]),
    css: `.zgoda {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  cursor: pointer;\n}\n`,
  },
  {
    id: 'radio',
    label: 'Radio',
    icon: 'radio_button_checked',
    group: 'form',
    build: () =>
      element('label', { class: 'zgoda' }, [
        element('input', { type: 'radio', name: 'wybor', value: 'a', class: 'zgoda__kontrolka' }),
        element('span', {}, [text('Pierwsza opcja')]),
      ]),
    css: `.zgoda {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  cursor: pointer;\n}\n`,
  },
  {
    id: 'switch',
    label: 'Przełącznik',
    icon: 'toggle_on',
    group: 'form',
    build: () =>
      element('label', { class: 'przelacznik' }, [
        element('input', { type: 'checkbox', name: 'przelacznik', class: 'przelacznik__kontrolka' }),
        element('span', { class: 'przelacznik__suwak', 'aria-hidden': 'true' }, []),
        element('span', { class: 'przelacznik__tekst' }, [text('Włącz opcję')]),
      ]),
    css: `.przelacznik {\n  display: inline-flex;\n  align-items: center;\n  gap: 10px;\n  cursor: pointer;\n}\n\n.przelacznik__kontrolka {\n  position: absolute;\n  opacity: 0;\n  width: 1px;\n  height: 1px;\n}\n\n.przelacznik__suwak {\n  position: relative;\n  flex-shrink: 0;\n  width: 40px;\n  height: 22px;\n  background: #d0d3de;\n  border-radius: 999px;\n  transition: background 0.15s ease;\n}\n\n.przelacznik__suwak::before {\n  content: '';\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 18px;\n  height: 18px;\n  background: #fff;\n  border-radius: 50%;\n  transition: transform 0.15s ease;\n}\n\n.przelacznik__kontrolka:checked + .przelacznik__suwak {\n  background: #6e56cf;\n}\n\n.przelacznik__kontrolka:checked + .przelacznik__suwak::before {\n  transform: translateX(18px);\n}\n\n.przelacznik__kontrolka:focus-visible + .przelacznik__suwak {\n  outline: 2px solid #6e56cf;\n  outline-offset: 2px;\n}\n`,
  },
  {
    id: 'file',
    label: 'Pole wyboru pliku',
    icon: 'attach_file',
    group: 'form',
    build: () =>
      element('label', { class: 'pole' }, [
        element('span', { class: 'pole__etykieta' }, [text('Załącz plik')]),
        element('input', { type: 'file', name: 'plik', class: 'pole__kontrolka' }),
      ]),
    css: FORM_FIELD_CSS(),
  },
  {
    id: 'submit',
    label: 'Wyślij',
    icon: 'send',
    group: 'form',
    build: () => element('button', { type: 'submit', class: 'przycisk' }, [text('Wyślij')]),
    css: `.przycisk {\n  display: inline-flex;\n  align-items: center;\n  padding: 10px 20px;\n  border: none;\n  border-radius: 8px;\n  background: #6e56cf;\n  color: #fff;\n  font-size: 15px;\n  cursor: pointer;\n}\n`,
  },
  {
    id: 'form',
    label: 'Formularz',
    icon: 'list_alt',
    group: 'form',
    build: () =>
      element('form', { class: 'formularz', method: 'post', action: '#' }, [
        element('label', { class: 'pole' }, [
          element('span', { class: 'pole__etykieta' }, [text('E-mail')]),
          element('input', { type: 'email', name: 'email', required: '', class: 'pole__kontrolka' }),
        ]),
        element('button', { type: 'submit', class: 'przycisk' }, [text('Wyślij')]),
      ]),
    css: `.formularz {\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  max-width: 420px;\n}\n${FORM_FIELD_CSS()}`,
  },
];

function FORM_FIELD_CSS(): string {
  return `.pole {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n}\n\n.pole__etykieta {\n  font-size: 14px;\n  font-weight: 600;\n}\n\n.pole__kontrolka {\n  padding: 10px 12px;\n  border: 1px solid #d0d3de;\n  border-radius: 6px;\n  font: inherit;\n}\n\n.pole__kontrolka:focus-visible {\n  outline: 2px solid #6e56cf;\n  outline-offset: 1px;\n}\n`;
}

export function getElementTemplate(id: string): ElementTemplate | null {
  return ELEMENT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Component library                                                   */
/* ------------------------------------------------------------------ */

/**
 * Ready-made blocks. Each one is a plain composition of the basic elements -
 * there is no component abstraction in the output, so once dropped the user can
 * take it apart, restyle it or delete half of it like any other markup.
 */
const BASE_COMPONENT_TEMPLATES: ComponentTemplate[] = [
  {
    id: 'navbar',
    name: 'Pasek nawigacji',
    hint: 'Logo + odnośniki, układ flex',
    icon: 'web',
    build: () =>
      element('header', { class: 'ls-navbar' }, [
        element('a', { class: 'ls-navbar__logo', href: '/' }, [text('Moja Strona')]),
        element('nav', { class: 'ls-navbar__nav', 'aria-label': 'Nawigacja główna' }, [
          element('a', { class: 'ls-navbar__link', href: '#o-nas' }, [text('O nas')]),
          element('a', { class: 'ls-navbar__link', href: '#oferta' }, [text('Oferta')]),
          element('a', { class: 'ls-navbar__link', href: '#kontakt' }, [text('Kontakt')]),
        ]),
      ]),
    /*
     * `background-color` is written out even though `#ffffff` is what the bar
     * already looked like against a default page.
     *
     * It declared no background at all, so the bar was white by accident - the
     * page showing through. That made the properties panel tell the truth about
     * a rule that did not exist: "Kolor tła" was blank, the swatch offered black
     * as its starting point, and there was nothing on screen connecting the two
     * to the white strip the user was looking at. Reported, reasonably, as "you
     * can't change the navigation bar's colour from the default white".
     *
     * Stating it changes nothing about how the bar renders and makes the colour
     * an ordinary editable declaration like every other.
     */
    css: `.ls-navbar {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 24px;\n  padding: 16px 32px;\n  background-color: #ffffff;\n  border-bottom: 1px solid #e6e8ef;\n}\n\n.ls-navbar__logo {\n  font-size: 18px;\n  font-weight: 700;\n  text-decoration: none;\n  color: inherit;\n}\n\n.ls-navbar__nav {\n  display: flex;\n  gap: 24px;\n}\n\n.ls-navbar__link {\n  color: inherit;\n  text-decoration: none;\n}\n\n.ls-navbar__link:hover {\n  color: #6e56cf;\n}\n\n@media (max-width: 640px) {\n  .ls-navbar {\n    flex-direction: column;\n    align-items: flex-start;\n    padding: 16px 20px;\n  }\n}\n`,
  },
  {
    id: 'hero',
    name: 'Sekcja hero',
    hint: 'Nagłówek, opis i przycisk CTA',
    icon: 'view_agenda',
    build: () =>
      element('section', { class: 'ls-hero' }, [
        element('h1', { class: 'ls-hero__title' }, [text('Zbuduj stronę, którą pokochasz')]),
        element('p', { class: 'ls-hero__lead' }, [
          text('Krótkie zdanie, które wyjaśnia, co oferujesz i dla kogo to jest.'),
        ]),
        element('a', { class: 'ls-hero__cta', href: '#kontakt' }, [text('Zacznij teraz')]),
      ]),
    css: `.ls-hero {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 20px;\n  padding: 96px 24px;\n  text-align: center;\n}\n\n.ls-hero__title {\n  margin: 0;\n  font-size: 52px;\n  line-height: 1.1;\n  max-width: 16ch;\n}\n\n.ls-hero__lead {\n  margin: 0;\n  max-width: 52ch;\n  font-size: 18px;\n  color: #5b5f73;\n}\n\n.ls-hero__cta {\n  padding: 14px 28px;\n  border-radius: 999px;\n  background: linear-gradient(135deg, #6e56cf, #4f8fff);\n  color: #fff;\n  font-weight: 600;\n  text-decoration: none;\n}\n\n@media (max-width: 640px) {\n  .ls-hero {\n    padding: 56px 20px;\n  }\n\n  .ls-hero__title {\n    font-size: 34px;\n  }\n}\n`,
  },
  {
    id: 'contact-form',
    name: 'Formularz kontaktowy',
    hint: 'Imię, e-mail, wiadomość, zgoda',
    icon: 'contact_mail',
    build: () =>
      element('section', { class: 'ls-contact', id: 'kontakt' }, [
        element('h2', { class: 'ls-contact__title' }, [text('Napisz do nas')]),
        element('form', { class: 'ls-contact__form', method: 'post', action: '#' }, [
          element('label', { class: 'pole' }, [
            element('span', { class: 'pole__etykieta' }, [text('Imię')]),
            element('input', { type: 'text', name: 'imie', required: '', class: 'pole__kontrolka' }),
          ]),
          element('label', { class: 'pole' }, [
            element('span', { class: 'pole__etykieta' }, [text('E-mail')]),
            element('input', { type: 'email', name: 'email', required: '', class: 'pole__kontrolka' }),
          ]),
          element('label', { class: 'pole' }, [
            element('span', { class: 'pole__etykieta' }, [text('Wiadomość')]),
            element('textarea', { name: 'wiadomosc', rows: '5', required: '', class: 'pole__kontrolka' }, [
              text(''),
            ]),
          ]),
          element('button', { type: 'submit', class: 'przycisk' }, [text('Wyślij wiadomość')]),
        ]),
      ]),
    css: `.ls-contact {\n  padding: 64px 24px;\n}\n\n.ls-contact__title {\n  margin: 0 0 24px;\n  font-size: 32px;\n}\n\n.ls-contact__form {\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  max-width: 480px;\n}\n${FORM_FIELD_CSS()}`,
  },
  {
    id: 'product-card',
    name: 'Karta produktu',
    hint: 'Obraz, tytuł, cena, przycisk',
    icon: 'sell',
    build: () =>
      element('article', { class: 'ls-card' }, [
        element('img', { class: 'ls-card__image', src: 'assets/placeholder.svg', alt: '', loading: 'lazy' }),
        element('div', { class: 'ls-card__body' }, [
          element('h3', { class: 'ls-card__title' }, [text('Nazwa produktu')]),
          element('p', { class: 'ls-card__price' }, [text('129,00 zł')]),
          element('button', { type: 'button', class: 'przycisk' }, [text('Dodaj do koszyka')]),
        ]),
      ]),
    css: `.ls-card {\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n  border: 1px solid #e6e8ef;\n  border-radius: 12px;\n  background: #fff;\n}\n\n.ls-card__image {\n  width: 100%;\n  aspect-ratio: 4 / 3;\n  object-fit: cover;\n}\n\n.ls-card__body {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 16px;\n}\n\n.ls-card__title {\n  margin: 0;\n  font-size: 18px;\n}\n\n.ls-card__price {\n  margin: 0;\n  font-weight: 700;\n  color: #6e56cf;\n}\n`,
  },
  {
    id: 'gallery',
    name: 'Galeria',
    hint: 'Siatka obrazów, responsywna',
    icon: 'collections',
    build: () =>
      element(
        'section',
        { class: 'ls-gallery' },
        [1, 2, 3, 4, 5, 6].map(() =>
          element('img', {
            class: 'ls-gallery__item',
            src: 'assets/placeholder.svg',
            alt: '',
            loading: 'lazy',
          }),
        ),
      ),
    css: `.ls-gallery {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));\n  gap: 16px;\n  padding: 48px 24px;\n}\n\n.ls-gallery__item {\n  width: 100%;\n  aspect-ratio: 1 / 1;\n  object-fit: cover;\n  border-radius: 8px;\n}\n`,
  },
  {
    id: 'footer',
    name: 'Stopka',
    hint: 'Prawa autorskie z aktualnym rokiem i odnośniki',
    icon: 'horizontal_rule',
    build: () =>
      element('footer', { class: 'ls-footer' }, [
        // The year is not typed in: it comes from the `aktualny-rok` element
        // script attached below, so the line is still right next January.
        // The static text is the value that script computes today, which is
        // what a visitor with JavaScript off (and the editor canvas, which
        // runs no page scripts) sees.
        element('p', { class: 'ls-footer__copy' }, [text(`© Twoja firma ${new Date().getFullYear()}`)]),
        element('nav', { class: 'ls-footer__nav', 'aria-label': 'Nawigacja w stopce' }, [
          element('a', { class: 'ls-footer__link', href: '#polityka' }, [text('Polityka prywatności')]),
          element('a', { class: 'ls-footer__link', href: '#regulamin' }, [text('Regulamin')]),
        ]),
      ]),
    scripts: [
      {
        find: (root) => findByClass(root, 'ls-footer__copy'),
        binding: {
          presetId: 'aktualny-rok',
          params: { rokStartowy: '', separator: '-', przedrostek: '© Twoja firma ', przyrostek: '' },
        },
      },
    ],
    css: `.ls-footer {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  padding: 32px 24px;\n  border-top: 1px solid #e6e8ef;\n  color: #5b5f73;\n  font-size: 14px;\n}\n\n.ls-footer__nav {\n  display: flex;\n  gap: 20px;\n}\n\n.ls-footer__link {\n  color: inherit;\n}\n\n@media (max-width: 640px) {\n  .ls-footer {\n    flex-direction: column;\n    align-items: flex-start;\n  }\n}\n`,
  },
];

/* ------------------------------------------------------------------ */
/* Component library - page sections                                   */
/* ------------------------------------------------------------------ */

/**
 * The section blocks below follow the same rules as the ones above, plus one
 * more that matters because their CSS is merged into the project's *global*
 * stylesheet:
 *
 *  - **Every selector is scoped to the block's own root class.** No bare tag
 *    selectors (`section`, `h2`, `blockquote`), no resets, no `!important` -
 *    dropping a pricing table can never restyle a heading somewhere else on the
 *    page. Where a block relies on a browser default that a project is likely to
 *    have overridden (`blockquote` margins, `ul` bullets), it zeroes it out on
 *    its own class rather than on the tag.
 *  - **No `@keyframes`.** `appendMissingRules` merges plain rules and `@media`
 *    blocks only, so anything else would be silently dropped on the way to the
 *    stylesheet. Motion here is done with `transition`, which survives the trip.
 *
 * They also work with JavaScript disabled: the FAQ is a native
 * `<details>`/`<summary>` accordion (the `name` attribute makes modern browsers
 * close the other entries), and nothing else needs behaviour at all. The stats
 * numbers are real text; the optional count-up animation is the
 * `licznik-liczb` element script, attached per number from the properties panel.
 */

function pricingPlan(spec: {
  name: string;
  amount: string;
  period: string;
  features: string[];
  cta: string;
  featured?: boolean;
}): ElementNode {
  const children: DocNode[] = [];
  if (spec.featured) {
    children.push(element('p', { class: 'ls-plan__badge' }, [text('Najczęściej wybierany')]));
  }
  children.push(
    element('h3', { class: 'ls-plan__name' }, [text(spec.name)]),
    element('p', { class: 'ls-plan__price' }, [
      element('span', { class: 'ls-plan__amount' }, [text(spec.amount)]),
      element('span', { class: 'ls-plan__period' }, [text(spec.period)]),
    ]),
    element(
      'ul',
      { class: 'ls-plan__features' },
      spec.features.map((feature) => element('li', { class: 'ls-plan__feature' }, [text(feature)])),
    ),
    element('a', { class: 'ls-plan__cta', href: '#kontakt' }, [text(spec.cta)]),
  );
  return element('article', { class: spec.featured ? 'ls-plan ls-plan--featured' : 'ls-plan' }, children);
}

function faqItem(question: string, answer: string, open: boolean): ElementNode {
  const attrs: Record<string, string> = { class: 'ls-faq__item', name: 'faq' };
  if (open) attrs.open = '';
  return element('details', attrs, [
    element('summary', { class: 'ls-faq__question' }, [text(question)]),
    element('div', { class: 'ls-faq__answer' }, [element('p', { class: 'ls-faq__text' }, [text(answer)])]),
  ]);
}

function ratingStars(filled: number): ElementNode {
  return element(
    'div',
    { class: 'ls-testimonial__rating', role: 'img', 'aria-label': `Ocena ${filled} na 5` },
    [1, 2, 3, 4, 5].map((index) =>
      element(
        'span',
        {
          class:
            index <= filled ? 'ls-testimonial__star' : 'ls-testimonial__star ls-testimonial__star--empty',
          'aria-hidden': 'true',
        },
        [text('★')],
      ),
    ),
  );
}

function testimonial(spec: { rating: number; quote: string; name: string; role: string }): ElementNode {
  return element('figure', { class: 'ls-testimonial' }, [
    ratingStars(spec.rating),
    element('blockquote', { class: 'ls-testimonial__quote' }, [
      element('p', { class: 'ls-testimonial__text' }, [text(spec.quote)]),
    ]),
    element('figcaption', { class: 'ls-testimonial__author' }, [
      element('img', {
        class: 'ls-testimonial__avatar',
        src: 'assets/placeholder.svg',
        alt: '',
        loading: 'lazy',
      }),
      element('span', { class: 'ls-testimonial__meta' }, [
        element('span', { class: 'ls-testimonial__name' }, [text(spec.name)]),
        element('span', { class: 'ls-testimonial__role' }, [text(spec.role)]),
      ]),
    ]),
  ]);
}

/**
 * One statistic. `<dl>` wants `<dt>` before `<dd>`, but the number has to read
 * first visually - `flex-direction: column-reverse` on `.ls-stat` gives that
 * without inventing a non-semantic structure or reversing the reading order.
 */
function statistic(value: string, suffix: string, label: string): ElementNode {
  const valueChildren: DocNode[] = [element('span', { class: 'ls-stat__number' }, [text(value)])];
  if (suffix) valueChildren.push(element('span', { class: 'ls-stat__suffix' }, [text(suffix)]));
  return element('div', { class: 'ls-stat' }, [
    element('dt', { class: 'ls-stat__label' }, [text(label)]),
    element('dd', { class: 'ls-stat__value' }, valueChildren),
  ]);
}

const SECTION_COMPONENT_TEMPLATES: ComponentTemplate[] = [
  {
    id: 'pricing',
    name: 'Cennik',
    hint: 'Trzy plany, lista korzyści, CTA',
    icon: 'payments',
    build: () =>
      element('section', { class: 'ls-pricing', id: 'cennik' }, [
        element('div', { class: 'ls-pricing__header' }, [
          element('h2', { class: 'ls-pricing__title' }, [text('Cennik')]),
          element('p', { class: 'ls-pricing__lead' }, [
            text('Wybierz plan dopasowany do skali Twojego projektu. Bez ukrytych opłat.'),
          ]),
        ]),
        element('div', { class: 'ls-pricing__grid' }, [
          pricingPlan({
            name: 'Start',
            amount: '49 zł',
            period: '/ mies.',
            features: ['1 strona internetowa', 'Certyfikat SSL', 'Wsparcie e-mail'],
            cta: 'Wybieram Start',
          }),
          pricingPlan({
            name: 'Profesjonalny',
            amount: '99 zł',
            period: '/ mies.',
            features: [
              'Do 10 podstron',
              'Certyfikat SSL',
              'Kopie zapasowe co 24 h',
              'Wsparcie e-mail i telefon',
            ],
            cta: 'Zamawiam',
            featured: true,
          }),
          pricingPlan({
            name: 'Firmowy',
            amount: '199 zł',
            period: '/ mies.',
            features: ['Bez limitu podstron', 'Sklep internetowy', 'Kopie zapasowe co 24 h', 'Opiekun konta'],
            cta: 'Porozmawiajmy',
          }),
        ]),
      ]),
    css: `.ls-pricing {
  padding: 72px 24px;
}

.ls-pricing__header {
  max-width: 640px;
  margin: 0 auto 40px;
  text-align: center;
}

.ls-pricing__title {
  margin: 0 0 12px;
  font-size: 34px;
  line-height: 1.2;
}

.ls-pricing__lead {
  margin: 0;
  color: #5b5f73;
  font-size: 17px;
  line-height: 1.6;
}

.ls-pricing__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 24px;
  max-width: 1040px;
  margin: 0 auto;
}

.ls-plan {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 32px 28px;
  border: 1px solid #e6e8ef;
  border-radius: 16px;
  background: #fff;
  color: #1f2130;
}

.ls-plan--featured {
  border-color: #6e56cf;
  box-shadow: 0 18px 40px rgba(110, 86, 207, 0.18);
}

.ls-plan__badge {
  align-self: flex-start;
  margin: 0;
  padding: 4px 12px;
  border-radius: 999px;
  background: #6e56cf;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.ls-plan__name {
  margin: 0;
  font-size: 20px;
}

.ls-plan__price {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
}

.ls-plan__amount {
  font-size: 42px;
  font-weight: 700;
  line-height: 1;
}

.ls-plan__period {
  color: #5b5f73;
  font-size: 15px;
}

.ls-plan__features {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ls-plan__feature {
  position: relative;
  padding-left: 26px;
  color: #3d3f4d;
  font-size: 15px;
  line-height: 1.5;
}

.ls-plan__feature::before {
  content: '✓';
  position: absolute;
  top: 0;
  left: 0;
  color: #6e56cf;
  font-weight: 700;
}

.ls-plan__cta {
  margin-top: auto;
  padding: 12px 20px;
  border: 1px solid #6e56cf;
  border-radius: 10px;
  background: #fff;
  color: #6e56cf;
  font-weight: 600;
  text-align: center;
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.ls-plan__cta:hover {
  background: #6e56cf;
  color: #fff;
}

.ls-plan--featured .ls-plan__cta {
  background: #6e56cf;
  color: #fff;
}

.ls-plan--featured .ls-plan__cta:hover {
  background: #5b46b0;
}

@media (max-width: 640px) {
  .ls-pricing {
    padding: 48px 20px;
  }

  .ls-plan {
    padding: 24px 20px;
  }
}
`,
  },

  {
    id: 'faq',
    name: 'Sekcja FAQ',
    hint: 'Rozwijane pytania (details), bez JS',
    icon: 'help',
    build: () =>
      element('section', { class: 'ls-faq', id: 'faq' }, [
        element('div', { class: 'ls-faq__header' }, [
          element('h2', { class: 'ls-faq__title' }, [text('Najczęściej zadawane pytania')]),
          element('p', { class: 'ls-faq__lead' }, [
            text('Nie znalazłeś odpowiedzi? Napisz do nas - odpowiadamy w ciągu jednego dnia roboczego.'),
          ]),
        ]),
        element('div', { class: 'ls-faq__list' }, [
          faqItem(
            'Ile trwa realizacja zamówienia?',
            'Standardowo od 3 do 5 dni roboczych. Termin potwierdzamy zawsze przy przyjęciu zlecenia.',
            true,
          ),
          faqItem(
            'Czy mogę zmienić plan w trakcie trwania umowy?',
            'Tak, plan zmienisz w dowolnym momencie. Różnicę w cenie rozliczamy proporcjonalnie do końca okresu.',
            false,
          ),
          faqItem(
            'Jakie formy płatności akceptujecie?',
            'Przelew tradycyjny, BLIK oraz karty płatnicze. Do każdego zamówienia wystawiamy fakturę VAT.',
            false,
          ),
          faqItem(
            'Czy dane są bezpieczne?',
            'Połączenie jest szyfrowane certyfikatem SSL, a kopie zapasowe wykonujemy codziennie.',
            false,
          ),
        ]),
      ]),
    css: `.ls-faq {
  padding: 72px 24px;
}

.ls-faq__header {
  max-width: 640px;
  margin: 0 auto 32px;
  text-align: center;
}

.ls-faq__title {
  margin: 0 0 12px;
  font-size: 34px;
  line-height: 1.2;
}

.ls-faq__lead {
  margin: 0;
  color: #5b5f73;
  font-size: 17px;
  line-height: 1.6;
}

.ls-faq__list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
  margin: 0 auto;
}

.ls-faq__item {
  overflow: hidden;
  border: 1px solid #e6e8ef;
  border-radius: 12px;
  background: #fff;
}

.ls-faq__item[open] {
  border-color: #6e56cf;
}

.ls-faq__question {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  color: #1f2130;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.4;
  list-style: none;
  cursor: pointer;
}

.ls-faq__question::-webkit-details-marker {
  display: none;
}

.ls-faq__question:focus-visible {
  outline: 2px solid #6e56cf;
  outline-offset: -2px;
}

.ls-faq__question::after {
  content: '+';
  flex-shrink: 0;
  color: #6e56cf;
  font-size: 26px;
  font-weight: 400;
  line-height: 1;
  transition: transform 0.2s ease;
}

.ls-faq__item[open] .ls-faq__question::after {
  transform: rotate(45deg);
}

.ls-faq__answer {
  padding: 0 20px 18px;
}

.ls-faq__text {
  margin: 0;
  color: #5b5f73;
  font-size: 16px;
  line-height: 1.6;
}

@media (max-width: 640px) {
  .ls-faq {
    padding: 48px 20px;
  }

  .ls-faq__question {
    font-size: 16px;
  }
}
`,
  },

  {
    id: 'testimonials',
    name: 'Opinie klientów',
    hint: 'Cytaty, zdjęcie i ocena w gwiazdkach',
    icon: 'format_quote',
    build: () =>
      element('section', { class: 'ls-testimonials', id: 'opinie' }, [
        element('div', { class: 'ls-testimonials__header' }, [
          element('h2', { class: 'ls-testimonials__title' }, [text('Co mówią nasi klienci')]),
          element('p', { class: 'ls-testimonials__lead' }, [
            text('Średnia ocena 4,9 / 5 na podstawie 212 opinii.'),
          ]),
        ]),
        element('div', { class: 'ls-testimonials__grid' }, [
          testimonial({
            rating: 5,
            quote:
              'Strona powstała w tydzień i od razu zaczęła przynosić zapytania. Współpraca bezstresowa, każdy termin dotrzymany.',
            name: 'Anna Kowalska',
            role: 'Właścicielka, Kwiaciarnia Ida',
          }),
          testimonial({
            rating: 5,
            quote:
              'Wreszcie sam wprowadzam zmiany na stronie, bez dzwonienia do informatyka. To oszczędza mi kilka godzin miesięcznie.',
            name: 'Marek Zieliński',
            role: 'Kierownik marketingu, Nordbud',
          }),
          testimonial({
            rating: 4,
            quote:
              'Świetny stosunek ceny do jakości. Wsparcie odpowiada w kilkanaście minut, nawet przy drobiazgach.',
            name: 'Julia Nowak',
            role: 'Founderka, Studio Pracownia',
          }),
        ]),
      ]),
    css: `.ls-testimonials {
  padding: 72px 24px;
  background: #f7f8fb;
}

.ls-testimonials__header {
  max-width: 640px;
  margin: 0 auto 40px;
  text-align: center;
}

.ls-testimonials__title {
  margin: 0 0 12px;
  font-size: 34px;
  line-height: 1.2;
}

.ls-testimonials__lead {
  margin: 0;
  color: #5b5f73;
  font-size: 17px;
  line-height: 1.6;
}

.ls-testimonials__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
  max-width: 1040px;
  margin: 0 auto;
}

.ls-testimonial {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0;
  padding: 28px;
  border: 1px solid #e6e8ef;
  border-radius: 16px;
  background: #fff;
}

.ls-testimonial__rating {
  display: flex;
  gap: 2px;
  font-size: 18px;
  line-height: 1;
}

.ls-testimonial__star {
  color: #f5a524;
}

.ls-testimonial__star--empty {
  color: #d0d3de;
}

.ls-testimonial__quote {
  margin: 0;
  padding: 0;
  border: none;
  color: #3d3f4d;
  font-size: 16px;
  font-style: normal;
  line-height: 1.6;
}

.ls-testimonial__text {
  margin: 0;
}

.ls-testimonial__author {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: auto;
  padding-top: 4px;
}

.ls-testimonial__avatar {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
}

.ls-testimonial__meta {
  display: flex;
  flex-direction: column;
}

.ls-testimonial__name {
  font-size: 15px;
  font-weight: 600;
}

.ls-testimonial__role {
  color: #5b5f73;
  font-size: 13px;
}

@media (max-width: 640px) {
  .ls-testimonials {
    padding: 48px 20px;
  }

  .ls-testimonial {
    padding: 22px;
  }
}
`,
  },

  {
    id: 'stats',
    name: 'Licznik / Statystyki',
    hint: 'Duże liczby z opisem, siatka 4 pól',
    icon: 'bar_chart',
    build: () =>
      element('section', { class: 'ls-stats' }, [
        element('h2', { class: 'ls-stats__title' }, [text('Liczby, które mówią same za siebie')]),
        element('dl', { class: 'ls-stats__grid' }, [
          statistic('100', '+', 'zadowolonych klientów'),
          statistic('5', '', 'lat doświadczenia'),
          // Spaced thousands, the way Polish writes them - and the way the
          // `licznik-liczb` script formats the value it counts up to.
          statistic('1 200', '+', 'zrealizowanych projektów'),
          statistic('24', 'h', 'średni czas odpowiedzi'),
        ]),
      ]),
    css: `.ls-stats {
  padding: 72px 24px;
  background: linear-gradient(135deg, #6e56cf, #4f8fff);
  color: #fff;
}

.ls-stats__title {
  max-width: 680px;
  margin: 0 auto 40px;
  font-size: 34px;
  line-height: 1.2;
  text-align: center;
}

.ls-stats__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 32px 24px;
  max-width: 1040px;
  margin: 0 auto;
}

.ls-stat {
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 6px;
  text-align: center;
}

.ls-stat__value {
  display: flex;
  align-items: baseline;
  margin: 0;
  font-size: 52px;
  font-weight: 700;
  line-height: 1;
}

.ls-stat__number {
  font-variant-numeric: tabular-nums;
}

.ls-stat__suffix {
  font-size: 30px;
}

.ls-stat__label {
  color: rgba(255, 255, 255, 0.82);
  font-size: 15px;
  line-height: 1.4;
}

@media (max-width: 640px) {
  .ls-stats {
    padding: 48px 20px;
  }

  .ls-stat__value {
    font-size: 40px;
  }
}
`,
  },

  {
    id: 'youtube',
    name: 'Wideo YouTube',
    hint: 'Responsywny embed 16:9, bez cookies',
    icon: 'smart_display',
    build: () =>
      element('section', { class: 'ls-video' }, [
        element('h2', { class: 'ls-video__title' }, [text('Zobacz, jak to działa')]),
        element('div', { class: 'ls-video__frame' }, [
          element('iframe', {
            class: 'ls-video__player',
            // youtube-nocookie.com sets no tracking cookie until the visitor
            // presses play, which is what keeps a plain embed defensible under
            // RODO without a consent banner in front of it.
            src: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
            title: 'Odtwarzacz wideo YouTube',
            loading: 'lazy',
            referrerpolicy: 'strict-origin-when-cross-origin',
            allow:
              'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
            allowfullscreen: '',
          }),
        ]),
      ]),
    css: `.ls-video {
  padding: 72px 24px;
}

.ls-video__title {
  max-width: 760px;
  margin: 0 auto 24px;
  font-size: 34px;
  line-height: 1.2;
  text-align: center;
}

.ls-video__frame {
  position: relative;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  max-width: 900px;
  margin: 0 auto;
  border-radius: 16px;
  background: #10121b;
}

.ls-video__player {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
}

@media (max-width: 640px) {
  .ls-video {
    padding: 48px 20px;
  }

  .ls-video__frame {
    border-radius: 12px;
  }
}
`,
  },
];

/** The panel's list, in drop order: the original blocks first, sections after. */
export const COMPONENT_TEMPLATES: ComponentTemplate[] = [
  ...BASE_COMPONENT_TEMPLATES,
  ...SECTION_COMPONENT_TEMPLATES,
];

export function getComponentTemplate(id: string): ComponentTemplate | null {
  return COMPONENT_TEMPLATES.find((template) => template.id === id) ?? null;
}

/** Builds an `<img>` for an asset dropped onto the canvas. */
export function buildImageForAsset(
  relPath: string,
  width: number | null,
  height: number | null,
): ElementNode {
  const attrs: Record<string, string> = {
    src: relPath,
    alt: '',
    class: 'obraz',
    loading: 'lazy',
  };
  if (width !== null && height !== null) {
    // Intrinsic dimensions prevent layout shift - worth writing into the file.
    attrs.width = String(width);
    attrs.height = String(height);
  }
  return element('img', attrs);
}

/** Builds an `<audio>` for an audio asset dropped onto the canvas. */
export function buildAudioForAsset(relPath: string): ElementNode {
  return element('audio', { class: 'audio', controls: '', preload: 'metadata', src: relPath }, [
    text(' Twoja przeglądarka nie obsługuje odtwarzania audio. '),
  ]);
}

/** Visual styles the Material Symbols font ships, one CSS class per style. */
export type MaterialSymbolStyle = 'outlined' | 'rounded' | 'sharp';

export const MATERIAL_SYMBOL_CLASS: Record<MaterialSymbolStyle, string> = {
  outlined: 'material-symbols-outlined',
  rounded: 'material-symbols-rounded',
  sharp: 'material-symbols-sharp',
};

/**
 * One shared rule per style, written once: the font renders its glyphs from
 * the element's *text content* (the icon's ligature name, e.g. `home`), so
 * every inserted icon reuses the same class and never needs its own CSS.
 */
export const MATERIAL_SYMBOLS_CSS = Object.values(MATERIAL_SYMBOL_CLASS)
  .map(
    (className) =>
      `.${className} {\n` +
      `  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;\n` +
      `  font-size: 24px;\n` +
      `  display: inline-block;\n` +
      `  line-height: 1;\n` +
      `  vertical-align: middle;\n` +
      `}\n`,
  )
  .join('\n');

/** Builds a `<span>` rendering one Material Symbols icon (Google Fonts). */
export function buildMaterialSymbolIcon(
  iconName: string,
  style: MaterialSymbolStyle = 'outlined',
): ElementNode {
  return element('span', { class: MATERIAL_SYMBOL_CLASS[style], 'aria-hidden': 'true', translate: 'no' }, [
    text(iconName),
  ]);
}
