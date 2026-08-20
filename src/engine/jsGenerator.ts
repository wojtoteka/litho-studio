/**
 * JavaScript generation.
 *
 * The hard rule: **Litho never touches code the user wrote.** Everything it
 * generates lives inside one clearly delimited region at the end of the file:
 *
 * ```js
 * // === Litho Studio — kod generowany automatycznie ===
 * …snippets…
 * // === koniec sekcji Litho Studio ===
 * ```
 *
 * Regenerating the file means: take everything before the marker verbatim, take
 * everything after the closing marker verbatim, and rebuild only the middle.
 * Each snippet carries a stable id, so applying the same action twice updates
 * the existing snippet instead of appending a duplicate — which is the specific
 * failure mode the "no duplicated code" requirement is about.
 *
 * The generated code has no dependencies, uses no build step and is written to
 * be read: a user who opens `script.js` in VS Code sees ordinary JavaScript.
 */

export const REGION_START = '// === Litho Studio — kod generowany automatycznie ===';
export const REGION_END = '// === koniec sekcji Litho Studio ===';
const REGION_NOTE =
  '// Nie edytuj tej sekcji ręcznie — Litho Studio nadpisuje ją przy każdej zmianie.\n// Kod powyżej tej sekcji nigdy nie jest modyfikowany.';

export interface ManagedSnippet {
  /** Stable identifier, e.g. `dynamic-year:copyright-year`. */
  id: string;
  /** One-line human description emitted as a comment above the code. */
  title: string;
  code: string;
}

export interface ManagedScript {
  /** User code before the managed region. */
  prefix: string;
  snippets: ManagedSnippet[];
  /** User code after the managed region (rare, but must survive). */
  suffix: string;
}

const SNIPPET_MARKER = /^\s*\/\/ \[litho:([^\]]+)\]\s*(.*)$/u;

/**
 * Splits a script into user code and managed snippets.
 *
 * A file with no managed region yields an empty snippet list and the whole file
 * as `prefix`, which is exactly what should happen for a page whose JavaScript
 * the editor has never touched.
 */
export function parseManagedScript(source: string): ManagedScript {
  const startIndex = source.indexOf(REGION_START);
  if (startIndex === -1) {
    return { prefix: source, snippets: [], suffix: '' };
  }

  const endMarkerIndex = source.indexOf(REGION_END, startIndex);
  const bodyStart = startIndex + REGION_START.length;
  const bodyEnd = endMarkerIndex === -1 ? source.length : endMarkerIndex;

  const prefix = source.slice(0, startIndex);
  const body = source.slice(bodyStart, bodyEnd);
  const suffix = endMarkerIndex === -1 ? '' : source.slice(endMarkerIndex + REGION_END.length);

  return { prefix, snippets: parseSnippets(body), suffix };
}

function parseSnippets(body: string): ManagedSnippet[] {
  const lines = body.split('\n');
  const snippets: ManagedSnippet[] = [];
  let current: { id: string; title: string; lines: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const code = current.lines.join('\n').replace(/^\n+|\s+$/gu, '');
    if (code !== '') snippets.push({ id: current.id, title: current.title, code });
    current = null;
  };

  for (const line of lines) {
    const match = SNIPPET_MARKER.exec(line);
    if (match?.[1]) {
      flush();
      current = { id: match[1].trim(), title: (match[2] ?? '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();

  return snippets;
}

/**
 * Rebuilds a script file from user code plus the managed snippets.
 *
 * When the snippet list is empty the region is dropped entirely, so undoing the
 * last generated action leaves the file exactly as the user had it.
 */
export function renderManagedScript(script: ManagedScript): string {
  const prefix = script.prefix.replace(/\s+$/u, '');
  const suffix = script.suffix.replace(/^\s+/u, '');

  if (script.snippets.length === 0) {
    const joined = [prefix, suffix].filter((part) => part !== '').join('\n\n');
    return joined === '' ? '' : `${joined}\n`;
  }

  const body = script.snippets
    .map((snippet) => {
      const title = snippet.title.trim();
      const header = `// [litho:${snippet.id}]${title === '' ? '' : ` ${title}`}`;
      return `${header}\n${snippet.code.replace(/\s+$/u, '')}`;
    })
    .join('\n\n');

  const region = `${REGION_START}\n${REGION_NOTE}\n\n${body}\n${REGION_END}`;
  const parts = [prefix, region, suffix].filter((part) => part !== '');
  return `${parts.join('\n\n')}\n`;
}

/**
 * Inserts or replaces a snippet by id, preserving the order of the others.
 * Returns a new object; callers treat `ManagedScript` as immutable so history
 * snapshots stay valid.
 */
export function upsertSnippet(script: ManagedScript, snippet: ManagedSnippet): ManagedScript {
  const index = script.snippets.findIndex((entry) => entry.id === snippet.id);
  const snippets = [...script.snippets];
  if (index === -1) snippets.push(snippet);
  else snippets[index] = snippet;
  return { ...script, snippets };
}

/* ------------------------------------------------------------------ */
/* Snippet builders                                                     */
/* ------------------------------------------------------------------ */

export interface DynamicYearOptions {
  /** `id` of the element whose text is replaced at runtime. */
  elementId: string;
  /**
   * Start year for a range such as `2024–2026`. When `null`, only the current
   * year is written, which is the `© 2026` case.
   */
  startYear: number | null;
  /** Separator between start year and current year. Defaults to an en dash. */
  separator?: string;
}

/**
 * Builds the "current year" snippet.
 *
 * Deliberately plain: a `DOMContentLoaded`-independent IIFE that tolerates the
 * element being missing (the user may delete it later without breaking the
 * page), and no template literals, so the output stays readable in any editor.
 */
export function buildDynamicYearSnippet(options: DynamicYearOptions): ManagedSnippet {
  const { elementId, startYear } = options;
  const separator = options.separator ?? '–';

  const assignment =
    startYear === null
      ? '    element.textContent = String(currentYear);'
      : `    element.textContent = currentYear > ${startYear} ? "${startYear}${separator}" + currentYear : String(currentYear);`;

  const description =
    startYear === null ? 'Wstawia bieżący rok.' : `Wstawia zakres lat od ${startYear} do bieżącego roku.`;

  const code = [
    `(function () {`,
    `  // ${description}`,
    `  var element = document.getElementById(${JSON.stringify(elementId)});`,
    `  if (!element) return;`,
    `  var currentYear = new Date().getFullYear();`,
    assignment.replace(/^ {4}/u, '  '),
    `})();`,
  ].join('\n');

  return {
    id: `dynamic-year:${elementId}`,
    title: `aktualny rok w #${elementId}`,
    code,
  };
}
