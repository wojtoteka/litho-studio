import {
  findFirstTag,
  getAttr,
  isElement,
  textContent,
  type DocNode,
  type ElementNode,
} from '@shared/document.js';
import { createRuntimeNodeId } from './idAllocator.js';

/**
 * Reading and writing the page's `<head>` metadata.
 *
 * Everything a page needs in order to look right *away from the page itself* —
 * in a search result, in a shared link, on a browser tab — lives here, and none
 * of it was reachable from the UI: the only way to set a description or an
 * Open Graph image was to open the HTML in a text editor, which is the exact
 * thing the product exists to avoid.
 *
 * Pure functions over the document tree, so the rules are unit-testable without
 * a store, a renderer or a file on disk. Every write is idempotent: setting the
 * same description twice produces one `<meta>` tag, and clearing a value
 * removes its tag rather than leaving `content=""` behind — an empty
 * `description` is worse than none, because search engines treat it as a
 * deliberate empty summary.
 */

export interface PageMeta {
  /** `<title>` — the browser tab and the search-result headline. */
  title: string;
  /** `<meta name="description">` — the grey text under that headline. */
  description: string;
  /** `<html lang>` — screen readers and translation tools both read it. */
  lang: string;
  /** `og:image` — the picture shown when the link is pasted into a chat. */
  ogImage: string;
  /** `<link rel="icon">`. */
  favicon: string;
}

export const EMPTY_PAGE_META: PageMeta = {
  title: '',
  description: '',
  lang: '',
  ogImage: '',
  favicon: '',
};

/**
 * Recommended lengths, used for the counters in the panel.
 *
 * These are not validation: a longer title still works, it just gets truncated
 * with an ellipsis in Google's results, which is worth knowing *while* writing
 * rather than after publishing.
 */
export const TITLE_RANGE = { min: 30, max: 60 } as const;
export const DESCRIPTION_RANGE = { min: 70, max: 160 } as const;

export function readPageMeta(root: ElementNode): PageMeta {
  const head = findFirstTag(root, 'head');
  const html = root.tag === 'html' ? root : findFirstTag(root, 'html');

  return {
    title: head ? (textContent(findFirstTag(head, 'title') ?? emptyElement()) ?? '').trim() : '',
    description: readMetaContent(head, 'name', 'description'),
    lang: html ? (getAttr(html, 'lang') ?? '') : '',
    ogImage: readMetaContent(head, 'property', 'og:image'),
    favicon: readIconHref(head),
  };
}

/**
 * Applies a partial update, mutating the tree in place (the same convention the
 * rest of the editor's document mutations use — see `editorStore`). Returns
 * true when anything actually changed, so the caller can skip a no-op commit.
 */
export function applyPageMeta(root: ElementNode, patch: Partial<PageMeta>): boolean {
  const head = ensureHead(root);
  let changed = false;

  if (patch.title !== undefined) changed = setTitle(head, patch.title) || changed;
  if (patch.description !== undefined) {
    changed = setMetaContent(head, 'name', 'description', patch.description) || changed;
    // Open Graph falls back to the plain description when it has none of its
    // own, so keeping them in step is what makes a shared link look right
    // without asking the user to fill the same box twice.
    changed = setMetaContent(head, 'property', 'og:description', patch.description) || changed;
  }
  if (patch.title !== undefined) {
    changed = setMetaContent(head, 'property', 'og:title', patch.title) || changed;
  }
  if (patch.lang !== undefined) changed = setLang(root, patch.lang) || changed;
  if (patch.ogImage !== undefined) {
    changed = setMetaContent(head, 'property', 'og:image', patch.ogImage) || changed;
  }
  if (patch.favicon !== undefined) changed = setIconHref(head, patch.favicon) || changed;

  return changed;
}

/* ------------------------------------------------------------------ */

function emptyElement(): ElementNode {
  return { kind: 'element', id: '', tag: 'title', namespace: 'html', attrs: [], children: [] };
}

function readMetaContent(head: ElementNode | null, keyAttr: string, key: string): string {
  const tag = findMeta(head, keyAttr, key);
  return tag ? (getAttr(tag, 'content') ?? '') : '';
}

function findMeta(head: ElementNode | null, keyAttr: string, key: string): ElementNode | null {
  if (!head) return null;
  for (const child of head.children) {
    if (!isElement(child) || child.tag !== 'meta') continue;
    if ((getAttr(child, keyAttr) ?? '').toLowerCase() === key) return child;
  }
  return null;
}

function readIconHref(head: ElementNode | null): string {
  const icon = findIconLink(head);
  return icon ? (getAttr(icon, 'href') ?? '') : '';
}

/** Any `rel` containing the `icon` token — covers `icon`, `shortcut icon`, `apple-touch-icon`. */
function findIconLink(head: ElementNode | null): ElementNode | null {
  if (!head) return null;
  for (const child of head.children) {
    if (!isElement(child) || child.tag !== 'link') continue;
    const rel = (getAttr(child, 'rel') ?? '').toLowerCase().split(/\s+/u);
    if (rel.includes('icon')) return child;
  }
  return null;
}

function ensureHead(root: ElementNode): ElementNode {
  const existing = findFirstTag(root, 'head');
  if (existing) return existing;
  const head = makeElement('head', {});
  root.children.unshift(head);
  return head;
}

function makeElement(tag: string, attrs: Record<string, string>, children: DocNode[] = []): ElementNode {
  return {
    kind: 'element',
    id: createRuntimeNodeId(),
    tag,
    namespace: 'html',
    attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    children,
  };
}

function setAttribute(element: ElementNode, name: string, value: string): boolean {
  const existing = element.attrs.find((attr) => attr.name === name);
  if (existing) {
    if (existing.value === value) return false;
    existing.value = value;
    return true;
  }
  element.attrs.push({ name, value });
  return true;
}

function setTitle(head: ElementNode, value: string): boolean {
  const trimmed = value.trim();
  const existing = findFirstTag(head, 'title');

  if (trimmed === '') {
    if (!existing) return false;
    head.children = head.children.filter((child) => child !== existing);
    return true;
  }

  if (!existing) {
    head.children.push(
      makeElement('title', {}, [{ kind: 'text', id: createRuntimeNodeId(), value: trimmed }]),
    );
    return true;
  }

  if (textContent(existing).trim() === trimmed) return false;
  existing.children = [{ kind: 'text', id: createRuntimeNodeId(), value: trimmed }];
  return true;
}

function setLang(root: ElementNode, value: string): boolean {
  const html = root.tag === 'html' ? root : findFirstTag(root, 'html');
  if (!html) return false;
  const trimmed = value.trim();

  if (trimmed === '') {
    const before = html.attrs.length;
    html.attrs = html.attrs.filter((attr) => attr.name !== 'lang');
    return html.attrs.length !== before;
  }
  return setAttribute(html, 'lang', trimmed);
}

function setMetaContent(head: ElementNode, keyAttr: string, key: string, value: string): boolean {
  const trimmed = value.trim();
  const existing = findMeta(head, keyAttr, key);

  if (trimmed === '') {
    if (!existing) return false;
    head.children = head.children.filter((child) => child !== existing);
    return true;
  }

  if (!existing) {
    head.children.push(makeElement('meta', { [keyAttr]: key, content: trimmed }));
    return true;
  }
  return setAttribute(existing, 'content', trimmed);
}

function setIconHref(head: ElementNode, value: string): boolean {
  const trimmed = value.trim();
  const existing = findIconLink(head);

  if (trimmed === '') {
    if (!existing) return false;
    head.children = head.children.filter((child) => child !== existing);
    return true;
  }

  if (!existing) {
    head.children.push(makeElement('link', { rel: 'icon', href: trimmed }));
    return true;
  }
  return setAttribute(existing, 'href', trimmed);
}
