import {
  findParent,
  getBody,
  isElement,
  walk,
  type DocNode,
  type ElementNode,
  type NodeId,
  type PageDocument,
} from '@shared/document.js';
import { createRuntimeNodeId } from './idAllocator.js';

/**
 * Sections shared across every subpage - the navigation bar, the footer.
 *
 * A five-page site needs five identical menus, and adding one entry means five
 * edits of which the fourth is always subtly different. This is the fix, and it
 * is built to cost the user's *files* nothing:
 *
 * ```html
 * <!-- litho:shared nav -->
 * <header class="ls-navbar">…</header>
 * <!-- /litho:shared -->
 * ```
 *
 * The markers are ordinary HTML comments. The page still opens in a browser,
 * still opens in VS Code, still has no build step and no runtime - delete the
 * comments by hand and the only thing lost is the syncing. That is deliberate:
 * the product's whole premise is that the output is a plain website, so a
 * feature that required a template language or a project file would cost more
 * than it gave.
 *
 * Everything here is pure and operates on parsed documents, so the rules are
 * unit-testable without a store or the filesystem.
 */

const OPEN_PREFIX = 'litho:shared';
const CLOSE_MARKER = '/litho:shared';

/** A named block found between a matching pair of markers. */
export interface SharedSection {
  name: string;
  /** Index of the opening comment inside its parent's `children`. */
  start: number;
  /** Index of the closing comment inside its parent's `children`. */
  end: number;
  parent: ElementNode;
  /** The nodes between the markers - the shared content itself. */
  nodes: DocNode[];
}

/** A name is a slug so it can live in a comment without quoting rules. */
export function isValidSectionName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/u.test(name);
}

function readOpenName(node: DocNode): string | null {
  if (node.kind !== 'comment') return null;
  const value = node.value.trim();
  if (!value.startsWith(OPEN_PREFIX)) return null;
  const name = value.slice(OPEN_PREFIX.length).trim();
  return isValidSectionName(name) ? name : null;
}

function isCloseMarker(node: DocNode): boolean {
  return node.kind === 'comment' && node.value.trim() === CLOSE_MARKER;
}

/**
 * Every shared block in the document.
 *
 * Unbalanced markers - an opener with no closer, most likely because someone
 * deleted one by hand - are skipped rather than guessed at. Silently adopting
 * the rest of the page as "the shared section" would then overwrite four other
 * pages with it, which is exactly the kind of surprise this feature must never
 * produce.
 */
export function findSharedSections(document: PageDocument): SharedSection[] {
  const found: SharedSection[] = [];
  const root = getBody(document) ?? document.root;

  const visit = (parent: ElementNode): void => {
    for (let index = 0; index < parent.children.length; index++) {
      const child = parent.children[index];
      if (!child) continue;

      const name = readOpenName(child);
      if (name !== null) {
        const end = parent.children.findIndex((node, at) => at > index && isCloseMarker(node));
        if (end !== -1) {
          found.push({
            name,
            start: index,
            end,
            parent,
            nodes: parent.children.slice(index + 1, end),
          });
          index = end;
          continue;
        }
      }
      if (isElement(child)) visit(child);
    }
  };

  visit(root as ElementNode);
  return found;
}

/** The shared section a node belongs to, if any. */
export function sharedSectionFor(document: PageDocument, nodeId: NodeId): SharedSection | null {
  for (const section of findSharedSections(document)) {
    for (const node of section.nodes) {
      for (const inner of walk(node)) {
        if (inner.id === nodeId) return section;
      }
    }
  }
  return null;
}

/**
 * Wraps an element in shared-section markers, in place.
 *
 * Returns false when the element cannot be shared - it has no parent (the
 * `<body>` itself), or it already sits inside a shared block, which would nest
 * one sync inside another and make "which page wins" ambiguous.
 */
export function markAsShared(document: PageDocument, nodeId: NodeId, name: string): boolean {
  if (!isValidSectionName(name)) return false;
  if (sharedSectionFor(document, nodeId)) return false;

  const parent = findParent(document.root, nodeId);
  if (!parent) return false;
  const index = parent.children.findIndex((child) => child.id === nodeId);
  if (index === -1) return false;

  parent.children.splice(index, 0, {
    kind: 'comment',
    id: createRuntimeNodeId(),
    value: ` ${OPEN_PREFIX} ${name} `,
  });
  parent.children.splice(index + 2, 0, {
    kind: 'comment',
    id: createRuntimeNodeId(),
    value: ` ${CLOSE_MARKER} `,
  });
  return true;
}

/** Removes the markers around a section, leaving its content untouched. */
export function unmarkShared(document: PageDocument, name: string): boolean {
  const section = findSharedSections(document).find((entry) => entry.name === name);
  if (!section) return false;
  // Remove the closer first so the opener's index stays valid.
  section.parent.children.splice(section.end, 1);
  section.parent.children.splice(section.start, 1);
  return true;
}

/**
 * Replaces the contents of `name` in `target` with `nodes`.
 *
 * The nodes are deep-cloned with fresh ids: two pages must never share node
 * identity, or selecting an element on one page would resolve to the other's
 * tree. Returns false when the target has no such section, which is how a page
 * opts out simply by not carrying the markers.
 */
export function replaceSharedSection(target: PageDocument, name: string, nodes: DocNode[]): boolean {
  const section = findSharedSections(target).find((entry) => entry.name === name);
  if (!section) return false;

  const replacement = nodes.map(cloneWithNewIds);
  // Same content already? Then nothing changed and the caller can skip a write.
  if (sameShape(section.nodes, replacement)) return false;

  section.parent.children.splice(section.start + 1, section.end - section.start - 1, ...replacement);
  return true;
}

/** Names of every shared section the document declares. */
export function sharedSectionNames(document: PageDocument): string[] {
  return [...new Set(findSharedSections(document).map((section) => section.name))];
}

/* ------------------------------------------------------------------ */

function cloneWithNewIds(node: DocNode): DocNode {
  if (node.kind === 'text') return { kind: 'text', id: createRuntimeNodeId(), value: node.value };
  if (node.kind === 'comment') return { kind: 'comment', id: createRuntimeNodeId(), value: node.value };
  return {
    kind: 'element',
    id: createRuntimeNodeId(),
    tag: node.tag,
    namespace: node.namespace,
    attrs: node.attrs.map((attr) => ({ ...attr })),
    children: node.children.map(cloneWithNewIds),
  };
}

/** Structural comparison that ignores node ids, which are never equal. */
function sameShape(left: DocNode[], right: DocNode[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((node, index) => {
    const other = right[index];
    if (!other || node.kind !== other.kind) return false;
    if (node.kind === 'text' && other.kind === 'text') return node.value === other.value;
    if (node.kind === 'comment' && other.kind === 'comment') return node.value === other.value;
    if (node.kind === 'element' && other.kind === 'element') {
      if (node.tag !== other.tag || node.attrs.length !== other.attrs.length) return false;
      const attrsEqual = node.attrs.every((attr, at) => {
        const otherAttr = other.attrs[at];
        return otherAttr && attr.name === otherAttr.name && attr.value === otherAttr.value;
      });
      return attrsEqual && sameShape(node.children, other.children);
    }
    return false;
  });
}
