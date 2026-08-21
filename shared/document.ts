/**
 * The document model.
 *
 * Litho Studio has no project format: this tree is a faithful, lossless-enough
 * mirror of the HTML file on disk. Anything the parser cannot classify is still
 * represented (comments, unknown tags, foreign SVG content, raw <script> bodies)
 * so that regenerating the file never silently drops hand-written markup.
 *
 * Element *semantics* (heading vs. button vs. container) are derived on demand
 * by `classifyElement` rather than stored on the node. That is what makes the
 * editor agnostic to who wrote the page - there is no marker attribute a page
 * must carry to be editable.
 */

export type NodeId = string;

export interface Attribute {
  name: string;
  value: string;
  /** Preserved for foreign content (`xlink:href`, `xml:lang`). */
  prefix?: string;
}

export interface ElementNode {
  kind: 'element';
  id: NodeId;
  /** Lowercased tag name, e.g. `div`, `h1`, `svg`. */
  tag: string;
  /** Ordered attribute list - order and duplicates from the source are kept. */
  attrs: Attribute[];
  children: DocNode[];
  /** `html` for normal content, `svg` / `math` for foreign content. */
  namespace: 'html' | 'svg' | 'math';
}

export interface TextNode {
  kind: 'text';
  id: NodeId;
  value: string;
}

export interface CommentNode {
  kind: 'comment';
  id: NodeId;
  value: string;
}

export type DocNode = ElementNode | TextNode | CommentNode;

export interface DoctypeInfo {
  name: string;
  publicId: string;
  systemId: string;
}

/**
 * A parsed HTML page. `root` is always the `<html>` element: parse5 inserts
 * `html`/`head`/`body` when a source file omits them, which normalises fragment
 * pages (very common in AI-generated output) into something editable.
 */
export interface PageDocument {
  /** Project-relative POSIX path, e.g. `index.html` or `pages/about.html`. */
  relPath: string;
  doctype: DoctypeInfo | null;
  root: ElementNode;
  /** Line ending detected in the source file; reused when writing back. */
  lineEnding: '\n' | '\r\n';
  /** Indentation detected in the source file; reused when writing back. */
  indent: string;
}

/* ------------------------------------------------------------------ */
/* Void elements and raw-text elements                                  */
/* ------------------------------------------------------------------ */

/** Elements that never have a closing tag. */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Elements whose text children must be emitted verbatim (no entity escaping).
 * Escaping inside these would corrupt CSS/JS - `a && b` must not become `a &amp;&amp; b`.
 */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'noscript',
]);

/** Elements that render inline and may therefore appear inside rich text. */
export const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

/** Elements that must not be shown as editable layers on the canvas. */
export const NON_VISUAL_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'link',
  'meta',
  'title',
  'base',
  'head',
  'template',
]);

/* ------------------------------------------------------------------ */
/* Semantic classification                                              */
/* ------------------------------------------------------------------ */

export type ElementKind =
  | 'heading'
  | 'text'
  | 'image'
  | 'button'
  | 'link'
  | 'container'
  | 'video'
  | 'audio'
  | 'form'
  | 'input'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'submit'
  | 'icon'
  | 'list'
  | 'listItem'
  | 'table'
  | 'svg'
  | 'unknown';

const TEXT_TAGS = new Set([
  'p',
  'span',
  'blockquote',
  'figcaption',
  'label',
  'em',
  'strong',
  'small',
  'pre',
  'code',
]);
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'figure',
  'body',
  'fieldset',
  'picture',
]);

export function getAttr(node: ElementNode, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const attr of node.attrs) {
    if (attr.name.toLowerCase() === lower) return attr.value;
  }
  return undefined;
}

export function hasAttr(node: ElementNode, name: string): boolean {
  return getAttr(node, name) !== undefined;
}

export function getClassList(node: ElementNode): string[] {
  const value = getAttr(node, 'class');
  if (!value) return [];
  return value.split(/\s+/u).filter(Boolean);
}

/**
 * Classes that come from an icon *font library* - Material Symbols, the older
 * Material Icons, or a font uploaded through the icons panel (`ikona-…`).
 *
 * Two things follow from a class being shared by every icon in the page rather
 * than owned by one element: its box is drawn by a glyph, so its size is
 * `font-size` and not `width`/`height`; and it must never be adopted as one
 * element's personal styling hook, or resizing a single icon would silently
 * rewrite the rule the whole library uses.
 */
const ICON_FONT_CLASS = /^(material-symbols|material-icons|ikona)(-|$)/u;

export function isIconFontClass(className: string): boolean {
  return ICON_FONT_CLASS.test(className);
}

/** True when the element renders as a glyph from an icon font. */
export function isIconFontElement(node: ElementNode): boolean {
  return getClassList(node).some(isIconFontClass);
}

/**
 * Maps a raw element onto the editor's palette of element kinds. Purely
 * structural - it never depends on classes the editor itself generated, so a
 * page written by hand classifies exactly like one the editor produced.
 */
export function classifyElement(node: ElementNode): ElementKind {
  if (node.namespace === 'svg') return node.tag === 'svg' ? 'svg' : 'unknown';

  const tag = node.tag;
  if (/^h[1-6]$/u.test(tag)) return 'heading';
  if (tag === 'img') return 'image';
  if (tag === 'button') return 'button';
  if (tag === 'video' || tag === 'iframe') return 'video';
  if (tag === 'audio') return 'audio';
  if (tag === 'form') return 'form';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listItem';
  if (tag === 'table') return 'table';

  if (tag === 'input') {
    const type = (getAttr(node, 'type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button') return 'submit';
    return 'input';
  }

  if (tag === 'a') {
    // A link styled as a button (very common in generated pages) is still a link
    // structurally; the properties panel offers button styling either way.
    return 'link';
  }

  if (tag === 'i' && getClassList(node).some((c) => /^(fa|bi|icon|material)/u.test(c))) {
    return 'icon';
  }

  if (TEXT_TAGS.has(tag)) return 'text';
  if (CONTAINER_TAGS.has(tag)) return 'container';

  return 'unknown';
}

export const ELEMENT_KIND_LABELS: Record<ElementKind, string> = {
  heading: 'Nagłówek',
  text: 'Tekst',
  image: 'Obraz',
  button: 'Przycisk',
  link: 'Link',
  container: 'Kontener',
  video: 'Wideo',
  audio: 'Audio',
  form: 'Formularz',
  input: 'Pole tekstowe',
  textarea: 'Pole wieloliniowe',
  select: 'Lista wyboru',
  checkbox: 'Checkbox',
  radio: 'Radio',
  submit: 'Przycisk wysyłania',
  icon: 'Ikona',
  list: 'Lista',
  listItem: 'Element listy',
  table: 'Tabela',
  svg: 'Grafika SVG',
  unknown: 'Element',
};

/* ------------------------------------------------------------------ */
/* Tree helpers                                                         */
/* ------------------------------------------------------------------ */

export function isElement(node: DocNode): node is ElementNode {
  return node.kind === 'element';
}

export function isText(node: DocNode): node is TextNode {
  return node.kind === 'text';
}

/** Depth-first walk over every node in the subtree, including `node` itself. */
export function* walk(node: DocNode): Generator<DocNode> {
  yield node;
  if (node.kind === 'element') {
    for (const child of node.children) yield* walk(child);
  }
}

export function findNode(root: DocNode, id: NodeId): DocNode | null {
  for (const node of walk(root)) {
    if (node.id === id) return node;
  }
  return null;
}

export function findElement(root: DocNode, id: NodeId): ElementNode | null {
  const node = findNode(root, id);
  return node && node.kind === 'element' ? node : null;
}

/** Returns the chain of ancestors from `root` down to (and excluding) `id`. */
export function findPath(root: DocNode, id: NodeId): ElementNode[] | null {
  if (root.id === id) return [];
  if (root.kind !== 'element') return null;
  for (const child of root.children) {
    const sub = findPath(child, id);
    if (sub) return [root, ...sub];
  }
  return null;
}

export function findParent(root: DocNode, id: NodeId): ElementNode | null {
  const path = findPath(root, id);
  if (!path || path.length === 0) return null;
  return path[path.length - 1] ?? null;
}

export function findFirstTag(root: ElementNode, tag: string): ElementNode | null {
  for (const node of walk(root)) {
    if (node.kind === 'element' && node.tag === tag) return node;
  }
  return null;
}

export function getHead(doc: PageDocument): ElementNode | null {
  return findFirstTag(doc.root, 'head');
}

export function getBody(doc: PageDocument): ElementNode | null {
  return findFirstTag(doc.root, 'body');
}

/** Concatenated text content of a subtree, matching DOM `textContent`. */
export function textContent(node: DocNode): string {
  if (node.kind === 'text') return node.value;
  if (node.kind === 'comment') return '';
  let out = '';
  for (const child of node.children) out += textContent(child);
  return out;
}
