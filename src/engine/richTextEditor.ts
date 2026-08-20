import type { DocNode, ElementNode, TextNode } from '@shared/document.js';
import { INLINE_ELEMENTS, isElement } from '@shared/document.js';
import { buildDynamicYearSnippet, type ManagedSnippet } from './jsGenerator.js';
import { createRuntimeNodeId } from './idAllocator.js';

/**
 * Partial rich-text editing.
 *
 * The user selects a *fragment* inside a text element and transforms just that
 * fragment, leaving the rest of the element untouched. `© wojtoteka.ovh
 * 2024–2026` with `wojtoteka.ovh` selected becomes
 * `© <a href="…">wojtoteka.ovh</a> 2024–2026` — one new inline element, no
 * other change to the paragraph.
 *
 * Everything is built on two primitives:
 *
 *  - **plain-text offsets.** An element's inline children flatten to one string;
 *    a selection is a `[start, end)` range over it. That is the same coordinate
 *    space the DOM `Selection` API gives us from the canvas, so no translation
 *    layer is needed.
 *  - **`spliceRange`.** Splits the child list at those offsets, preserving any
 *    inline markup outside the range, and hands the caller the three parts.
 *
 * Actions are registered in `TEXT_ACTIONS` rather than hard-coded into the UI,
 * so adding "replace with a variable", "replace with a counter" or "replace with
 * a translated string" later means writing one object here and nothing else.
 */

export interface TextRange {
  /** Inclusive start offset in the element's plain text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/* ------------------------------------------------------------------ */
/* Plain-text projection                                                */
/* ------------------------------------------------------------------ */

/** Flattens an element's inline children into the string the user sees. */
export function getPlainText(element: ElementNode): string {
  let out = '';
  const visit = (nodes: DocNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'text') out += node.value;
      else if (node.kind === 'element') visit(node.children);
    }
  };
  visit(element.children);
  return out;
}

export interface SplitResult {
  before: DocNode[];
  selected: DocNode[];
  after: DocNode[];
}

/**
 * Splits an element's children at a plain-text range.
 *
 * Text nodes straddling a boundary are split; inline elements fully inside the
 * range move into `selected` intact, and one that straddles a boundary is
 * recursively split so its markup survives on both sides.
 */
export function spliceRange(element: ElementNode, range: TextRange): SplitResult {
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(range.start, range.end);

  const before: DocNode[] = [];
  const selected: DocNode[] = [];
  const after: DocNode[] = [];

  let offset = 0;

  const place = (node: DocNode, bucket: DocNode[]): void => {
    bucket.push(node);
  };

  const visit = (
    nodes: DocNode[],
    into: { before: DocNode[]; selected: DocNode[]; after: DocNode[] },
  ): void => {
    for (const node of nodes) {
      if (node.kind === 'comment') {
        // Comments carry no text; they follow the position they sit at.
        place(node, offset < start ? into.before : offset < end ? into.selected : into.after);
        continue;
      }

      if (node.kind === 'text') {
        const nodeStart = offset;
        const nodeEnd = offset + node.value.length;
        offset = nodeEnd;

        const beforePart = node.value.slice(0, clamp(start - nodeStart, 0, node.value.length));
        const selectedPart = node.value.slice(
          clamp(start - nodeStart, 0, node.value.length),
          clamp(end - nodeStart, 0, node.value.length),
        );
        const afterPart = node.value.slice(clamp(end - nodeStart, 0, node.value.length));

        if (beforePart !== '') place(makeText(beforePart), into.before);
        if (selectedPart !== '') place(makeText(selectedPart), into.selected);
        if (afterPart !== '') place(makeText(afterPart), into.after);
        continue;
      }

      const length = getPlainText(node).length;
      const nodeStart = offset;
      const nodeEnd = offset + length;

      // Entirely outside or entirely inside the range: move the node as-is.
      if (nodeEnd <= start) {
        offset = nodeEnd;
        place(node, into.before);
        continue;
      }
      if (nodeStart >= end) {
        offset = nodeEnd;
        place(node, into.after);
        continue;
      }
      if (nodeStart >= start && nodeEnd <= end) {
        offset = nodeEnd;
        place(node, into.selected);
        continue;
      }

      // Straddles a boundary: split the element, duplicating its wrapper.
      const inner = { before: [] as DocNode[], selected: [] as DocNode[], after: [] as DocNode[] };
      visit(node.children, inner);
      if (inner.before.length > 0) place(cloneWithChildren(node, inner.before), into.before);
      if (inner.selected.length > 0) place(cloneWithChildren(node, inner.selected), into.selected);
      if (inner.after.length > 0) place(cloneWithChildren(node, inner.after), into.after);
    }
  };

  visit(element.children, { before, selected, after });
  return { before, selected, after };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function makeText(value: string): TextNode {
  return { kind: 'text', id: createRuntimeNodeId(), value };
}

function cloneWithChildren(element: ElementNode, children: DocNode[]): ElementNode {
  return {
    kind: 'element',
    id: createRuntimeNodeId(),
    tag: element.tag,
    attrs: element.attrs.map((attr) => ({ ...attr })),
    namespace: element.namespace,
    children,
  };
}

/** True when an element's content can be edited as rich text. */
export function isRichTextHost(element: ElementNode): boolean {
  if (element.namespace !== 'html') return false;
  return element.children.every((child) => child.kind !== 'element' || INLINE_ELEMENTS.has(child.tag));
}

/* ------------------------------------------------------------------ */
/* Action framework                                                     */
/* ------------------------------------------------------------------ */

export interface TextActionContext {
  element: ElementNode;
  range: TextRange;
  /** The plain text covered by `range`. */
  selectedText: string;
  /** Allocates a document-unique `id` attribute value. */
  allocateDocumentId(base: string): string;
}

export interface TextActionResult {
  /** Replacement children for the element. */
  children: DocNode[];
  /** Snippets to add to or update in the managed region of the script file. */
  scriptSnippets: ManagedSnippet[];
  /** Snippet ids to remove (used when an action supersedes an earlier one). */
  removedSnippetIds: string[];
  /** Label shown in the undo history. */
  description: string;
}

export interface TextAction<Params> {
  id: string;
  /** Label shown in the context menu. */
  label: string;
  /** One-line explanation shown under the label. */
  hint: string;
  /**
   * Whether the action makes sense for this selection. The context menu hides
   * actions that return false, so the menu never offers a no-op.
   */
  isAvailable(context: TextActionContext): boolean;
  /** Produces default parameters to pre-fill the action's form. */
  defaultParams(context: TextActionContext): Params;
  apply(context: TextActionContext, params: Params): TextActionResult;
}

/* ------------------------------------------------------------------ */
/* Built-in action: convert selection to a link                         */
/* ------------------------------------------------------------------ */

export interface LinkParams {
  href: string;
  /** `_blank` opens in a new tab; empty string means same tab. */
  target: '' | '_blank';
  /** Extra `rel` tokens; `noopener noreferrer` is added automatically. */
  rel: string;
}

export const convertToLinkAction: TextAction<LinkParams> = {
  id: 'convert-to-link',
  label: 'Zamień na link',
  hint: 'Owija zaznaczony fragment w element <a> z podanym adresem.',

  isAvailable(context) {
    if (context.selectedText.trim() === '') return false;
    // Refuse when the selection already sits inside a link — the user should
    // edit that link instead of nesting anchors, which is invalid HTML.
    return !selectionIsInsideTag(context, 'a');
  },

  defaultParams(context) {
    return { href: guessHref(context.selectedText), target: '', rel: '' };
  },

  apply(context, params) {
    const { before, selected, after } = spliceRange(context.element, context.range);
    const attrs = [{ name: 'href', value: params.href.trim() }];

    if (params.target === '_blank') {
      attrs.push({ name: 'target', value: '_blank' });
      // `noopener` is a security requirement for `target="_blank"`, not a style
      // choice: without it the opened page can navigate this one via `opener`.
      const relTokens = new Set(['noopener', 'noreferrer', ...params.rel.split(/\s+/u).filter(Boolean)]);
      attrs.push({ name: 'rel', value: [...relTokens].join(' ') });
    } else if (params.rel.trim() !== '') {
      attrs.push({ name: 'rel', value: params.rel.trim() });
    }

    const anchor: ElementNode = {
      kind: 'element',
      id: createRuntimeNodeId(),
      tag: 'a',
      attrs,
      namespace: 'html',
      children: selected.length > 0 ? selected : [makeText(context.selectedText)],
    };

    return {
      children: [...before, anchor, ...after],
      scriptSnippets: [],
      removedSnippetIds: [],
      description: `Zamień „${truncate(context.selectedText)}" na link`,
    };
  },
};

/* ------------------------------------------------------------------ */
/* Built-in action: convert selection to a dynamic current-year script   */
/* ------------------------------------------------------------------ */

export interface DynamicYearParams {
  /** Start of the range, or `null` to render only the current year. */
  startYear: number | null;
  separator: string;
  /** `id` written on the generated `<span>`. */
  elementId: string;
}

export const dynamicYearAction: TextAction<DynamicYearParams> = {
  id: 'dynamic-year',
  label: 'Zamień na dynamiczny skrypt (aktualny rok)',
  hint: 'Wstawia <span> aktualizowany przez script.js — rok nigdy się nie zdezaktualizuje.',

  isAvailable(context) {
    return context.selectedText.trim() !== '';
  },

  defaultParams(context) {
    const parsed = parseYearSelection(context.selectedText);
    return {
      startYear: parsed.startYear,
      separator: parsed.separator,
      elementId: context.allocateDocumentId(suggestYearId(context.element)),
    };
  },

  apply(context, params) {
    const { before, after } = spliceRange(context.element, context.range);

    const span: ElementNode = {
      kind: 'element',
      id: createRuntimeNodeId(),
      tag: 'span',
      attrs: [{ name: 'id', value: params.elementId }],
      namespace: 'html',
      // A sensible value is rendered server-side-free: if JavaScript is
      // disabled the page still shows a year rather than an empty gap.
      children: [makeText(fallbackYearText(params))],
    };

    return {
      children: [...before, span, ...after],
      scriptSnippets: [
        buildDynamicYearSnippet({
          elementId: params.elementId,
          startYear: params.startYear,
          separator: params.separator,
        }),
      ],
      removedSnippetIds: [],
      description:
        params.startYear === null
          ? 'Zamień na dynamiczny rok'
          : `Zamień na dynamiczny zakres lat od ${params.startYear}`,
    };
  },
};

/** Text rendered into the HTML as a no-JavaScript fallback. */
function fallbackYearText(params: DynamicYearParams): string {
  const currentYear = new Date().getFullYear();
  if (params.startYear === null || params.startYear >= currentYear) return String(currentYear);
  return `${params.startYear}${params.separator}${currentYear}`;
}

/**
 * Works out whether the selection describes a *range* of years or a single one.
 *
 * Handles the shapes users actually type: `2024–2026`, `2024-2026`,
 * `2024-aktualna data`, `2024–obecnie`, and a bare `2026`.
 */
export function parseYearSelection(text: string): { startYear: number | null; separator: string } {
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/gu)].map((match) => Number(match[0]));
  const separator = detectSeparator(text);

  if (years.length === 0) return { startYear: null, separator };

  const first = years[0] ?? null;
  if (years.length >= 2) {
    const sorted = [...years].sort((a, b) => a - b);
    return { startYear: sorted[0] ?? first, separator };
  }

  // One year plus other words ("2024–obecnie") is a range whose end is dynamic;
  // a bare year on its own is just the current year.
  const withoutYear = text.replace(/\b(19|20)\d{2}\b/u, '').trim();
  const hasTrailingContent = withoutYear.replace(/^[\s–—-]+/u, '').trim() !== '';
  const hasSeparatorOnly = /[–—-]/u.test(withoutYear);

  if (hasTrailingContent || hasSeparatorOnly) return { startYear: first, separator };
  return { startYear: null, separator };
}

function detectSeparator(text: string): string {
  if (text.includes('—')) return '—';
  if (text.includes('–')) return '–';
  if (/\d\s*-\s*/u.test(text)) return '-';
  return '–';
}

function suggestYearId(element: ElementNode): string {
  const tagHint = element.tag === 'footer' ? 'footer' : 'copyright';
  return `${tagHint}-year`;
}

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

/**
 * The registry the context menu renders from. Adding an action here is the only
 * step required to expose a new transformation in the UI.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous params by design
export const TEXT_ACTIONS: ReadonlyArray<TextAction<any>> = [convertToLinkAction, dynamicYearAction];

export function getTextAction(id: string): TextAction<unknown> | null {
  return (TEXT_ACTIONS.find((action) => action.id === id) as TextAction<unknown> | undefined) ?? null;
}

/** Actions applicable to the given selection, in menu order. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see TEXT_ACTIONS
export function availableTextActions(context: TextActionContext): ReadonlyArray<TextAction<any>> {
  return TEXT_ACTIONS.filter((action) => action.isAvailable(context));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** True when the whole selection lies inside an element with the given tag. */
function selectionIsInsideTag(context: TextActionContext, tag: string): boolean {
  let offset = 0;
  let inside = false;

  const visit = (nodes: DocNode[], within: boolean): void => {
    for (const node of nodes) {
      if (node.kind === 'text') {
        const nodeEnd = offset + node.value.length;
        const overlaps = offset < context.range.end && nodeEnd > context.range.start;
        if (overlaps && within) inside = true;
        offset = nodeEnd;
        continue;
      }
      if (isElement(node)) visit(node.children, within || node.tag === tag);
    }
  };

  visit(context.element.children, false);
  return inside;
}

/**
 * Turns a selected fragment into a plausible default URL, so the common case —
 * selecting a domain name — needs no typing.
 */
export function guessHref(selectedText: string): string {
  const trimmed = selectedText.trim();
  if (trimmed === '') return '';
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  if (/^[\w.+-]+@[\w-]+\.[a-z]{2,}$/iu.test(trimmed)) return `mailto:${trimmed}`;
  if (/^(www\.)?[\w-]+(\.[\w-]+)+(\/\S*)?$/u.test(trimmed))
    return `https://${trimmed.replace(/^www\./u, '')}`;
  return '';
}

function truncate(value: string, max = 24): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
