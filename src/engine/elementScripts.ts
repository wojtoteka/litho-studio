import type { ManagedSnippet } from './jsGenerator.js';

/**
 * Dynamic behaviour attached to a single element ("Skrypt / Funkcja dynamiczna"
 * in the properties panel).
 *
 * Everything here produces ordinary, dependency-free ES5 that lands in the
 * managed region of the page's own script (see `jsGenerator.ts`), so the result
 * is a normal website: opening `script.js` in VS Code shows readable code, and
 * deleting Litho from the equation changes nothing about how the page behaves.
 *
 * The binding has to survive a round trip through the file — the user closes
 * the project, re-opens it, and the panel must still show "Aktualna data,
 * format: długi". Two mechanisms do that, and both live in the generated text
 * rather than in any Litho-side database:
 *
 *  1. a machine-readable `litho-config` comment carrying the preset id and its
 *     parameters, and
 *  2. for the free-form preset, the user's own code between two marker
 *     comments, so editing that code in a text editor round-trips back into
 *     the panel instead of being overwritten by a stale copy in the config.
 *
 * Snippets are keyed by the element's `id` attribute, because that is what the
 * generated `getElementById` call uses — the code and the binding cannot drift
 * apart. Renaming the id detaches the binding (the snippet's own
 * `if (!element) return;` keeps the page working); re-applying from the panel
 * writes a fresh one.
 */

/* ------------------------------------------------------------------ */
/* Parameter descriptors                                                */
/* ------------------------------------------------------------------ */

export type ScriptParamType = 'text' | 'number' | 'datetime-local' | 'select' | 'code';

export interface ScriptParam {
  name: string;
  label: string;
  type: ScriptParamType;
  default: string;
  placeholder?: string;
  hint?: string;
  /** Only for `type: 'select'`. */
  options?: Array<{ value: string; label: string }>;
}

/**
 * What the script would put on screen *right now*, computed in the renderer so
 * the panel can show it without the code ever running.
 *
 * The canvas iframe is sandboxed without `allow-scripts` (it must never run
 * the page's own JavaScript), which means a script's effect can never appear
 * live on the canvas. `setElementScript` (editorStore.ts) writes this value
 * into the element's static text on apply, so the canvas at least shows a
 * real result instead of the pre-existing placeholder — but that write is a
 * one-time snapshot, not a live binding, so this preview is still what the
 * panel shows on every keystroke in between.
 */
export interface ScriptPreview {
  /** The text the element would show. */
  text: string;
  /** Caveat when the real result depends on runtime the editor cannot supply. */
  note?: string;
}

export interface ElementScriptPreset {
  id: string;
  label: string;
  /** One line, emitted as a comment above the generated code. */
  description: string;
  /** Shown under the picker so the user knows what they are choosing. */
  hint: string;
  params: ScriptParam[];
  /**
   * Body of the generated function. `element` is already declared and
   * guaranteed non-null; the body may `return` early.
   */
  build(params: Record<string, string>, elementId: string): string;
  /**
   * The current output for a live in-panel preview, or `null` when it cannot be
   * shown honestly (arbitrary user code). `elementText` is the element's present
   * text, which some effects (typewriter) animate rather than replace.
   */
  preview(params: Record<string, string>, elementText: string): ScriptPreview | null;
}

export interface ElementScriptBinding {
  presetId: string;
  params: Record<string, string>;
}

export const CUSTOM_PRESET_ID = 'wlasny-kod';

/** Marker comments delimiting user-written code inside the generated wrapper. */
const USER_CODE_START = '// --- twój kod ---';
const USER_CODE_END = '// --- koniec twojego kodu ---';

/* ------------------------------------------------------------------ */
/* Presets                                                              */
/* ------------------------------------------------------------------ */

const DATE_FORMATS: Record<string, Record<string, string>> = {
  dlugi: { day: 'numeric', month: 'long', year: 'numeric' },
  krotki: { day: '2-digit', month: '2-digit', year: 'numeric' },
  zDniemTygodnia: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  zGodzina: {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
  miesiacRok: { month: 'long', year: 'numeric' },
};

/* The preview helpers below intentionally mirror what each preset's `build`
 * emits as code, so the panel shows exactly what the page will. A unit test
 * runs the generated code against a fake DOM and asserts the two agree, which
 * is what keeps them from drifting apart. */

function computeYear(params: Record<string, string>, now: Date): string {
  const currentYear = now.getFullYear();
  const startYear = Number.parseInt(params.rokStartowy ?? '', 10);
  const core =
    Number.isFinite(startYear) && currentYear > startYear
      ? `${startYear}${params.separator ?? '–'}${currentYear}`
      : String(currentYear);
  return `${params.przedrostek ?? ''}${core}${params.przyrostek ?? ''}`;
}

interface CounterSpec {
  target: number;
  /** Decimal places, taken from how the user wrote the target value. */
  decimals: number;
  duration: number;
  /** Thousands separator, or `''` when the user turned it off. */
  separator: string;
}

/**
 * Reads the counter parameters once, so `build` and `preview` cannot disagree
 * about what "4,9" or a blank duration means.
 */
function counterSpec(params: Record<string, string>): CounterSpec {
  const raw = (params.wartosc ?? '').trim().replace(/\s/gu, '');
  const target = Number.parseFloat(raw.replace(',', '.'));
  const duration = Number.parseInt(params.czas ?? '', 10);
  return {
    target: Number.isFinite(target) ? target : 0,
    decimals: Math.min(/[.,](\d+)$/u.exec(raw)?.[1]?.length ?? 0, 4),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 1600,
    separator: (params.separator ?? 'spacja') === 'brak' ? '' : ' ',
  };
}

/** Mirrors the `render` function the counter preset emits. */
function formatCounterValue(value: number, spec: CounterSpec): string {
  const parts = value.toFixed(spec.decimals).split('.');
  if (spec.separator) parts[0] = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/gu, spec.separator);
  return parts.join(',');
}

function safeFormatDate(locale: string, options: Record<string, string>, now: Date): string {
  try {
    return new Intl.DateTimeFormat(locale || 'pl-PL', options).format(now);
  } catch {
    return new Intl.DateTimeFormat('pl-PL', options).format(now);
  }
}

export const ELEMENT_SCRIPT_PRESETS: readonly ElementScriptPreset[] = [
  {
    id: 'aktualna-data',
    label: 'Wyświetl aktualną datę',
    description: 'Wstawia dzisiejszą datę w wybranym formacie.',
    hint: 'Tekst elementu zostanie zastąpiony dzisiejszą datą przy każdym otwarciu strony.',
    params: [
      {
        name: 'format',
        label: 'Format',
        type: 'select',
        default: 'dlugi',
        options: [
          { value: 'dlugi', label: 'Długi — 24 lipca 2026' },
          { value: 'krotki', label: 'Krótki — 24.07.2026' },
          { value: 'zDniemTygodnia', label: 'Z dniem tygodnia — piątek, 24 lipca 2026' },
          { value: 'zGodzina', label: 'Z godziną — 24.07.2026, 14:30' },
          { value: 'miesiacRok', label: 'Miesiąc i rok — lipiec 2026' },
        ],
      },
      { name: 'jezyk', label: 'Język (locale)', type: 'text', default: 'pl-PL', placeholder: 'pl-PL' },
      {
        name: 'przedrostek',
        label: 'Tekst przed datą',
        type: 'text',
        default: '',
        placeholder: 'Dzisiaj jest ',
      },
      { name: 'przyrostek', label: 'Tekst po dacie', type: 'text', default: '', placeholder: ' r.' },
    ],
    build: (params) => {
      const options = DATE_FORMATS[params.format ?? 'dlugi'] ?? DATE_FORMATS.dlugi!;
      return [
        `var formatter = new Intl.DateTimeFormat(${str(params.jezyk, 'pl-PL')}, ${JSON.stringify(options)});`,
        `element.textContent = ${wrapText('formatter.format(new Date())', params.przedrostek, params.przyrostek)};`,
      ].join('\n');
    },
    preview: (params) => {
      const options = DATE_FORMATS[params.format ?? 'dlugi'] ?? DATE_FORMATS.dlugi!;
      const date = safeFormatDate(params.jezyk ?? 'pl-PL', options, new Date());
      return { text: `${params.przedrostek ?? ''}${date}${params.przyrostek ?? ''}` };
    },
  },

  {
    id: 'aktualny-rok',
    label: 'Aktualny rok (© 2026)',
    description: 'Wstawia bieżący rok, opcjonalnie jako zakres od roku startowego.',
    hint: 'Typowe zastosowanie: rok w stopce, który sam się aktualizuje 1 stycznia.',
    params: [
      {
        name: 'rokStartowy',
        label: 'Rok startowy (opcjonalnie)',
        type: 'number',
        default: '',
        placeholder: '2020',
        hint: 'Podaj, aby uzyskać zakres „2020–2026”.',
      },
      { name: 'separator', label: 'Separator zakresu', type: 'text', default: '–' },
      { name: 'przedrostek', label: 'Tekst przed rokiem', type: 'text', default: '© ', placeholder: '© ' },
      { name: 'przyrostek', label: 'Tekst po roku', type: 'text', default: '', placeholder: ' Moja Firma' },
    ],
    build: (params) => {
      const startYear = Number.parseInt(params.rokStartowy ?? '', 10);
      const lines = ['var currentYear = new Date().getFullYear();'];
      if (Number.isFinite(startYear)) {
        lines.push(
          `var value = currentYear > ${startYear}`,
          `  ? ${JSON.stringify(`${startYear}${params.separator ?? '–'}`)} + currentYear`,
          '  : String(currentYear);',
        );
      } else {
        lines.push('var value = String(currentYear);');
      }
      lines.push(`element.textContent = ${wrapText('value', params.przedrostek, params.przyrostek)};`);
      return lines.join('\n');
    },
    preview: (params) => ({ text: computeYear(params, new Date()) }),
  },

  {
    id: 'zegar',
    label: 'Zegar (odświeżany co sekundę)',
    description: 'Pokazuje bieżącą godzinę i odświeża ją co sekundę.',
    hint: 'Element musi być pusty albo zawierać tylko tekst — jego treść jest nadpisywana.',
    params: [
      { name: 'jezyk', label: 'Język (locale)', type: 'text', default: 'pl-PL', placeholder: 'pl-PL' },
      {
        name: 'sekundy',
        label: 'Pokaż sekundy',
        type: 'select',
        default: 'tak',
        options: [
          { value: 'tak', label: 'Tak — 14:30:07' },
          { value: 'nie', label: 'Nie — 14:30' },
        ],
      },
    ],
    build: (params) => {
      const options: Record<string, string> = { hour: '2-digit', minute: '2-digit' };
      if ((params.sekundy ?? 'tak') === 'tak') options.second = '2-digit';
      return [
        `var formatter = new Intl.DateTimeFormat(${str(params.jezyk, 'pl-PL')}, ${JSON.stringify(options)});`,
        'function tick() {',
        '  element.textContent = formatter.format(new Date());',
        '}',
        'tick();',
        'setInterval(tick, 1000);',
      ].join('\n');
    },
    preview: (params) => {
      const options: Record<string, string> = { hour: '2-digit', minute: '2-digit' };
      if ((params.sekundy ?? 'tak') === 'tak') options.second = '2-digit';
      return {
        text: safeFormatDate(params.jezyk ?? 'pl-PL', options, new Date()),
        note: 'odświeżany co sekundę',
      };
    },
  },

  {
    id: 'licznik-odliczania',
    label: 'Licznik odliczania',
    description: 'Odlicza czas pozostały do wskazanej daty.',
    hint: 'Po upływie terminu element pokazuje tekst końcowy i licznik się zatrzymuje.',
    params: [
      {
        name: 'termin',
        label: 'Data i godzina',
        type: 'datetime-local',
        default: '',
        hint: 'Czas lokalny przeglądarki odwiedzającego.',
      },
      { name: 'tekstKoncowy', label: 'Tekst po upływie', type: 'text', default: 'Już dziś!' },
      {
        name: 'przedrostek',
        label: 'Tekst przed licznikiem',
        type: 'text',
        default: '',
        placeholder: 'Zostało ',
      },
    ],
    build: (params) => {
      const target = (params.termin ?? '').trim();
      return [
        `var target = new Date(${JSON.stringify(target)}).getTime();`,
        'if (isNaN(target)) return;',
        '',
        'function pad(value) {',
        '  return value < 10 ? "0" + value : String(value);',
        '}',
        '',
        'var timer = null;',
        'function tick() {',
        '  var left = target - Date.now();',
        '  if (left <= 0) {',
        `    element.textContent = ${str(params.tekstKoncowy, 'Już dziś!')};`,
        '    if (timer) clearInterval(timer);',
        '    return;',
        '  }',
        '  var total = Math.floor(left / 1000);',
        '  var days = Math.floor(total / 86400);',
        '  var hours = Math.floor((total % 86400) / 3600);',
        '  var minutes = Math.floor((total % 3600) / 60);',
        '  var text = days + " dni " + pad(hours) + ":" + pad(minutes) + ":" + pad(total % 60);',
        `  element.textContent = ${wrapText('text', params.przedrostek, '')};`,
        '}',
        '',
        'tick();',
        'timer = setInterval(tick, 1000);',
      ].join('\n');
    },
    preview: (params) => {
      const target = new Date((params.termin ?? '').trim()).getTime();
      if (Number.isNaN(target)) {
        return { text: 'Ustaw datę i godzinę', note: 'brak poprawnej daty' };
      }
      const left = target - Date.now();
      if (left <= 0) return { text: params.tekstKoncowy ?? 'Już dziś!' };
      const total = Math.floor(left / 1000);
      const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
      const text = `${Math.floor(total / 86400)} dni ${pad(Math.floor((total % 86400) / 3600))}:${pad(
        Math.floor((total % 3600) / 60),
      )}:${pad(total % 60)}`;
      return { text: `${params.przedrostek ?? ''}${text}`, note: 'odświeżany co sekundę' };
    },
  },

  {
    id: 'imie-z-adresu',
    label: 'Imię z adresu strony (parametr URL)',
    description: 'Personalizuje tekst na podstawie parametru w adresie strony.',
    hint: 'Otwarcie strony jako „…/index.html?imie=Anna” wstawi tu „Anna”. Bez parametru pokaże się wartość zastępcza.',
    params: [
      {
        name: 'parametr',
        label: 'Nazwa parametru w adresie',
        type: 'text',
        default: 'imie',
        placeholder: 'imie',
      },
      { name: 'zastepczo', label: 'Gdy brak parametru', type: 'text', default: 'Gościu' },
      {
        name: 'szablon',
        label: 'Szablon tekstu',
        type: 'text',
        default: 'Cześć, {}!',
        hint: 'Znak {} zostanie zastąpiony wartością z adresu.',
      },
    ],
    build: (params) => {
      return [
        'var query = new URLSearchParams(window.location.search);',
        `var value = query.get(${str(params.parametr, 'imie')});`,
        `if (!value) value = ${str(params.zastepczo, 'Gościu')};`,
        `element.textContent = ${str(params.szablon, 'Cześć, {}!')}.split("{}").join(value);`,
      ].join('\n');
    },
    preview: (params) => {
      // No real query string in the editor, so show the fallback branch — which
      // is exactly what a visitor without the parameter sees.
      const value = params.zastepczo || 'Gościu';
      const text = (params.szablon || 'Cześć, {}!').split('{}').join(value);
      return { text, note: `z adresu ?${params.parametr || 'imie'}=… ; tu pokazano wartość zastępczą` };
    },
  },

  {
    id: 'maszyna-do-pisania',
    label: 'Efekt maszyny do pisania',
    description: 'Wypisuje tekst elementu znak po znaku po wczytaniu strony.',
    hint: 'Animuje tekst, który już jest w elemencie — nic nie trzeba wpisywać w parametrach.',
    params: [
      {
        name: 'tempo',
        label: 'Tempo (ms na znak)',
        type: 'number',
        default: '45',
        placeholder: '45',
      },
    ],
    build: (params) => {
      const speed = Number.parseInt(params.tempo ?? '', 10);
      return [
        'var text = element.textContent;',
        'var index = 0;',
        'element.textContent = "";',
        'var timer = setInterval(function () {',
        '  index += 1;',
        '  element.textContent = text.slice(0, index);',
        '  if (index >= text.length) clearInterval(timer);',
        `}, ${Number.isFinite(speed) && speed > 0 ? speed : 45});`,
      ].join('\n');
    },
    preview: (_params, elementText) => ({
      text: elementText || '(pusty element)',
      note: 'animacja wypisze istniejący tekst znak po znaku',
    }),
  },

  {
    id: 'licznik-liczb',
    label: 'Animowany licznik liczb',
    description: 'Zlicza od zera do podanej wartości, gdy element pojawi się na ekranie.',
    hint: 'Do sekcji statystyk: podepnij pod samą liczbę (np. „100”), bez znaku „+” — treść elementu jest nadpisywana.',
    params: [
      {
        name: 'wartosc',
        label: 'Wartość docelowa',
        type: 'text',
        default: '100',
        placeholder: '1200',
        hint: 'Liczba, do której licznik dojdzie. Ułamek zapisz przecinkiem, np. 4,9.',
      },
      { name: 'czas', label: 'Czas animacji (ms)', type: 'number', default: '1600', placeholder: '1600' },
      {
        name: 'separator',
        label: 'Separator tysięcy',
        type: 'select',
        default: 'spacja',
        options: [
          { value: 'spacja', label: 'Spacja — 12 500' },
          { value: 'brak', label: 'Brak — 12500' },
        ],
      },
      { name: 'przedrostek', label: 'Tekst przed liczbą', type: 'text', default: '', placeholder: 'ponad ' },
      { name: 'przyrostek', label: 'Tekst po liczbie', type: 'text', default: '', placeholder: ' zł' },
    ],
    build: (params) => {
      const spec = counterSpec(params);
      const separatorLine = spec.separator
        ? `  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ${JSON.stringify(spec.separator)});`
        : null;
      return [
        `var target = ${spec.target};`,
        `var duration = ${spec.duration};`,
        '',
        'function render(value) {',
        `  var parts = value.toFixed(${spec.decimals}).split(".");`,
        ...(separatorLine === null ? [] : [separatorLine]),
        `  element.textContent = ${wrapText('parts.join(",")', params.przedrostek, params.przyrostek)};`,
        '}',
        '',
        'render(0);',
        '',
        // Counting up is decoration; someone who asked the system for less motion
        // gets the final number straight away instead.
        'if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {',
        '  render(target);',
        '  return;',
        '}',
        '',
        'var started = false;',
        'function start() {',
        '  if (started) return;',
        '  started = true;',
        '  var startTime = null;',
        '  function frame(now) {',
        '    if (startTime === null) startTime = now;',
        '    var progress = Math.min((now - startTime) / duration, 1);',
        '    if (progress < 1) {',
        '      render(target * (1 - Math.pow(1 - progress, 3)));',
        '      requestAnimationFrame(frame);',
        '    } else {',
        '      render(target);',
        '    }',
        '  }',
        '  requestAnimationFrame(frame);',
        '}',
        '',
        // Counting while the section is still below the fold would be over before
        // anyone saw it, so wait until it is actually on screen.
        'if (typeof IntersectionObserver === "function") {',
        '  var observer = new IntersectionObserver(function (entries) {',
        '    if (entries[0] && entries[0].isIntersecting) {',
        '      observer.disconnect();',
        '      start();',
        '    }',
        '  }, { threshold: 0.35 });',
        '  observer.observe(element);',
        '} else {',
        '  start();',
        '}',
      ].join('\n');
    },
    preview: (params) => {
      const spec = counterSpec(params);
      return {
        text: `${params.przedrostek ?? ''}${formatCounterValue(spec.target, spec)}${params.przyrostek ?? ''}`,
        note: 'animacja od zera, gdy element pojawi się na ekranie',
      };
    },
  },

  {
    id: CUSTOM_PRESET_ID,
    label: 'Własny kod JavaScript',
    description: 'Kod napisany ręcznie, wykonywany na tym elemencie.',
    hint: 'Zmienna `element` wskazuje zaznaczony element. Kod działa po wyrenderowaniu strony i jest zabezpieczony try/catch.',
    params: [
      {
        name: 'kod',
        label: 'Kod JavaScript',
        type: 'code',
        default: 'element.textContent = "Cześć!";',
        hint: 'Dostępne: element, document, window — jak w zwykłym skrypcie strony.',
      },
    ],
    build: (params, elementId) => {
      const body = (params.kod ?? '').replace(/\s+$/u, '');
      return [
        'try {',
        `  ${USER_CODE_START}`,
        indent(body === '' ? '// (pusty skrypt)' : body, 2),
        `  ${USER_CODE_END}`,
        '} catch (error) {',
        `  console.error(${JSON.stringify(`Litho: skrypt elementu #${elementId} zgłosił błąd`)}, error);`,
        '}',
      ].join('\n');
    },
    // Arbitrary user code cannot be evaluated safely in the panel; the live
    // preview honestly says so rather than guessing.
    preview: () => null,
  },
];

export function findPreset(presetId: string): ElementScriptPreset | null {
  return ELEMENT_SCRIPT_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export function defaultParamsFor(preset: ElementScriptPreset): Record<string, string> {
  const params: Record<string, string> = {};
  for (const param of preset.params) params[param.name] = param.default;
  return params;
}

/* ------------------------------------------------------------------ */
/* Snippet generation                                                   */
/* ------------------------------------------------------------------ */

const SNIPPET_ID_PREFIX = 'element-script:';

/** Managed-snippet id for the script bound to the element with this `id`. */
export function elementScriptSnippetId(domId: string): string {
  return `${SNIPPET_ID_PREFIX}${domId}`;
}

/**
 * Builds the snippet for a binding.
 *
 * The wrapper waits for `DOMContentLoaded` when the document is still parsing,
 * which makes the code correct no matter where the host `<script>` sits — a
 * page that keeps its scripts in `<head>` is just as common as one that puts
 * them last, and the panel must not depend on which one this is.
 */
export function buildElementScriptSnippet(domId: string, binding: ElementScriptBinding): ManagedSnippet {
  const preset = findPreset(binding.presetId) ?? ELEMENT_SCRIPT_PRESETS[0]!;
  const params = { ...defaultParamsFor(preset), ...binding.params };

  // Code parameters round-trip through the marker comments instead, so that
  // editing the generated file by hand is not silently undone by a stale copy
  // sitting in this comment.
  const storedParams: Record<string, string> = {};
  for (const param of preset.params) {
    if (param.type === 'code') continue;
    storedParams[param.name] = params[param.name] ?? '';
  }
  const config = { preset: preset.id, params: storedParams };

  const code = [
    `/* litho-config: ${JSON.stringify(config)} */`,
    '(function () {',
    `  // ${preset.description}`,
    '  function run() {',
    `    var element = document.getElementById(${JSON.stringify(domId)});`,
    '    if (!element) return;',
    indent(preset.build(params, domId), 4),
    '  }',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", run);',
    '  } else {',
    '    run();',
    '  }',
    '})();',
  ].join('\n');

  return { id: elementScriptSnippetId(domId), title: `${preset.label} — #${domId}`, code };
}

/* ------------------------------------------------------------------ */
/* Reading a binding back out of generated code                         */
/* ------------------------------------------------------------------ */

const CONFIG_COMMENT = /\/\*\s*litho-config:\s*([\s\S]*?)\*\//u;

/**
 * Recovers the panel state from a snippet found in the project's JavaScript.
 *
 * Returns `null` for anything that does not carry a readable config — a
 * hand-written snippet, or one produced by a newer version of the app — so the
 * panel can say "nierozpoznany skrypt" rather than silently showing defaults
 * that do not match the code actually on disk.
 */
export function parseElementScriptSnippet(snippet: ManagedSnippet): ElementScriptBinding | null {
  const match = CONFIG_COMMENT.exec(snippet.code);
  if (!match?.[1]) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as { preset?: unknown; params?: unknown };
  if (typeof record.preset !== 'string') return null;
  const preset = findPreset(record.preset);
  if (!preset) return null;

  const params = { ...defaultParamsFor(preset) };
  if (typeof record.params === 'object' && record.params !== null) {
    for (const [key, value] of Object.entries(record.params as Record<string, unknown>)) {
      if (typeof value === 'string') params[key] = value;
    }
  }

  const userCode = extractUserCode(snippet.code);
  if (userCode !== null) {
    const codeParam = preset.params.find((param) => param.type === 'code');
    if (codeParam) params[codeParam.name] = userCode;
  }

  return { presetId: preset.id, params };
}

/** Pulls the user's own code back out from between the marker comments. */
function extractUserCode(code: string): string | null {
  const start = code.indexOf(USER_CODE_START);
  if (start === -1) return null;
  const end = code.indexOf(USER_CODE_END, start);
  if (end === -1) return null;

  const body = code.slice(start + USER_CODE_START.length, end);
  return dedent(body.replace(/^[ \t]*\r?\n/u, '').replace(/\s+$/u, ''));
}

/* ------------------------------------------------------------------ */
/* Small text helpers                                                   */
/* ------------------------------------------------------------------ */

function indent(code: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${pad}${line}`))
    .join('\n');
}

/** Removes the common leading whitespace, so extracted code reads normally. */
function dedent(code: string): string {
  const lines = code.split('\n');
  let smallest = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = /^[ \t]*/u.exec(line);
    smallest = Math.min(smallest, match?.[0]?.length ?? 0);
  }
  if (!Number.isFinite(smallest) || smallest === 0) return code;
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(smallest))).join('\n');
}

/** A JS string literal for a parameter value, falling back when it is blank. */
function str(value: string | undefined, fallback: string): string {
  const resolved = value === undefined || value === '' ? fallback : value;
  return JSON.stringify(resolved);
}

/**
 * Wraps an expression with optional literal prefix/suffix text, skipping the
 * concatenation entirely when there is nothing to add.
 */
function wrapText(expression: string, prefix: string | undefined, suffix: string | undefined): string {
  const parts: string[] = [];
  if (prefix) parts.push(JSON.stringify(prefix));
  parts.push(expression);
  if (suffix) parts.push(JSON.stringify(suffix));
  return parts.join(' + ');
}
