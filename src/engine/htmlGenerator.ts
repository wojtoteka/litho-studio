import type { DocNode, ElementNode, PageDocument } from '@shared/document.js';
import { INLINE_ELEMENTS, RAW_TEXT_ELEMENTS, VOID_ELEMENTS } from '@shared/document.js';

/**
 * Document model → HTML text.
 *
 * The output has to satisfy two constraints that pull against each other:
 *
 *  1. **It must render identically to what the canvas showed.** Whitespace
 *     between inline elements is significant in HTML — `<b>a</b> <i>b</i>` and
 *     `<b>a</b>\n<i>b</i>` differ visually under some CSS. So any element whose
 *     children contain inline content is emitted *verbatim*, with its original
 *     whitespace intact.
 *
 *  2. **It must look hand-written.** Elements whose children are all blocks get
 *     re-indented with the file's own indentation unit, and whitespace-only
 *     text between them is regenerated.
 *
 * Deciding per element which of the two applies is what keeps reformatting safe
 * on pages the editor did not create.
 */

export interface GenerateOptions {
  /** Indentation unit; defaults to the one detected when the page was parsed. */
  indent?: string;
  lineEnding?: '\n' | '\r\n';
}

export function generateHtml(document: PageDocument, options: GenerateOptions = {}): string {
  const indent = options.indent ?? document.indent;
  const lineEnding = options.lineEnding ?? document.lineEnding;

  const parts: string[] = [];
  if (document.doctype) parts.push(serialiseDoctype(document));
  parts.push(serialiseElement(document.root, { indent, depth: 0 }));

  const body = parts.join('\n');
  const normalised = `${body.replace(/\s+$/u, '')}\n`;
  return lineEnding === '\r\n' ? normalised.replace(/\n/gu, '\r\n') : normalised;
}

function serialiseDoctype(document: PageDocument): string {
  const doctype = document.doctype;
  if (!doctype) return '';
  // Modern pages are `<!doctype html>`; legacy identifiers are preserved as-is.
  if (!doctype.publicId && !doctype.systemId) return `<!doctype ${doctype.name}>`;
  const publicPart = doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : '';
  const systemPart = doctype.systemId ? ` "${doctype.systemId}"` : '';
  return `<!DOCTYPE ${doctype.name}${publicPart}${systemPart}>`;
}

interface Context {
  indent: string;
  depth: number;
}

function pad(context: Context): string {
  return context.indent.repeat(context.depth);
}

function serialiseElement(element: ElementNode, context: Context): string {
  const openTag = `<${element.tag}${serialiseAttributes(element)}>`;

  if (VOID_ELEMENTS.has(element.tag) && element.namespace === 'html') {
    return `${pad(context)}${openTag.replace(/>$/u, ' />')}`;
  }

  // Self-closing foreign content (`<path />`, `<circle />`).
  if (element.namespace !== 'html' && element.children.length === 0) {
    return `${pad(context)}${openTag.replace(/>$/u, ' />')}`;
  }

  const closeTag = `</${element.tag}>`;

  if (RAW_TEXT_ELEMENTS.has(element.tag)) {
    return serialiseRawTextElement(element, context, openTag, closeTag);
  }

  if (element.children.length === 0) {
    return `${pad(context)}${openTag}${closeTag}`;
  }

  if (hasInlineContent(element)) {
    const inner = element.children.map(serialiseInline).join('');
    const singleLine = `${pad(context)}${openTag}${inner}${closeTag}`;
    // Keep short inline content on one line; wrap longer content but never
    // introduce whitespace inside it.
    if (singleLine.length <= 100 || !inner.includes('\n')) return singleLine;
    return singleLine;
  }

  const childContext: Context = { ...context, depth: context.depth + 1 };
  const lines: string[] = [`${pad(context)}${openTag}`];
  for (const child of element.children) {
    const serialised = serialiseBlockChild(child, childContext);
    if (serialised !== null) lines.push(serialised);
  }
  lines.push(`${pad(context)}${closeTag}`);
  return lines.join('\n');
}

function serialiseBlockChild(child: DocNode, context: Context): string | null {
  if (child.kind === 'text') {
    // Only whitespace-only text reaches here (see `hasInlineContent`), and the
    // indentation regenerates it.
    return null;
  }
  if (child.kind === 'comment') return `${pad(context)}<!--${child.value}-->`;
  return serialiseElement(child, context);
}

/**
 * `<script>`/`<style>` bodies are emitted verbatim — escaping them would change
 * the code — but re-indented as a block so the surrounding HTML stays readable.
 */
function serialiseRawTextElement(
  element: ElementNode,
  context: Context,
  openTag: string,
  closeTag: string,
): string {
  const raw = element.children.map((child) => (child.kind === 'text' ? child.value : '')).join('');

  if (raw.trim() === '') return `${pad(context)}${openTag}${closeTag}`;

  const innerIndent = context.indent.repeat(context.depth + 1);
  const reindented = reindentBlock(raw, innerIndent);
  return `${pad(context)}${openTag}\n${reindented}\n${pad(context)}${closeTag}`;
}

/**
 * Re-indents a block of code: the smallest existing indentation becomes the
 * target indentation and every other line shifts by the same amount, so the
 * code's own relative structure survives untouched.
 */
function reindentBlock(raw: string, targetIndent: string): string {
  const lines = raw.replace(/^\n+|\s+$/gu, '').split('\n');
  let common = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = /^[\t ]*/u.exec(line);
    common = Math.min(common, match ? match[0].length : 0);
  }
  if (!Number.isFinite(common)) common = 0;

  return lines.map((line) => (line.trim() === '' ? '' : `${targetIndent}${line.slice(common)}`)).join('\n');
}

/**
 * True when the element's children must be treated as a single inline run.
 *
 * Any non-whitespace text, or any inline element, makes reformatting unsafe.
 */
function hasInlineContent(element: ElementNode): boolean {
  if (element.tag === 'pre' || element.tag === 'textarea') return true;

  for (const child of element.children) {
    if (child.kind === 'text' && child.value.trim() !== '') return true;
    if (child.kind === 'element' && INLINE_ELEMENTS.has(child.tag)) return true;
  }
  return false;
}

/** Serialises a node without adding any whitespace of its own. */
function serialiseInline(node: DocNode): string {
  if (node.kind === 'text') return escapeText(node.value);
  if (node.kind === 'comment') return `<!--${node.value}-->`;

  const openTag = `<${node.tag}${serialiseAttributes(node)}>`;
  if (VOID_ELEMENTS.has(node.tag) && node.namespace === 'html') {
    return openTag.replace(/>$/u, ' />');
  }
  if (RAW_TEXT_ELEMENTS.has(node.tag)) {
    const raw = node.children.map((child) => (child.kind === 'text' ? child.value : '')).join('');
    return `${openTag}${raw}</${node.tag}>`;
  }
  return `${openTag}${node.children.map(serialiseInline).join('')}</${node.tag}>`;
}

function serialiseAttributes(element: ElementNode): string {
  if (element.attrs.length === 0) return '';
  return element.attrs
    .map((attr) => {
      const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      // Boolean attributes stay bare, the way an author would write them.
      if (attr.value === '' && isBooleanAttribute(name)) return ` ${name}`;
      return ` ${name}="${escapeAttribute(attr.value)}"`;
    })
    .join('');
}

const BOOLEAN_ATTRIBUTES = new Set([
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'default',
  'defer',
  'disabled',
  'hidden',
  'ismap',
  'loop',
  'multiple',
  'muted',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
]);

function isBooleanAttribute(name: string): boolean {
  return BOOLEAN_ATTRIBUTES.has(name.toLowerCase());
}

/**
 * Escapes text content. `>` is escaped too: it is not strictly required, but it
 * removes any chance of a stray sequence being re-parsed as markup.
 */
export function escapeText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * Escapes an attribute value for double-quoted output. Non-breaking spaces
 * become entities so they stay visible to anyone reading the file.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/\u00a0/gu, '&nbsp;');
}
