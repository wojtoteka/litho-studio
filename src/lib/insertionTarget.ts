import type { NodeId, PageDocument } from '@shared/document.js';
import { findElement, findParent, getBody } from '@shared/document.js';
import { canHoldChildren } from '@/state/editorStore.js';

/**
 * Where a palette click should insert.
 *
 * Into the selected element when it is a container; otherwise right after the
 * selection inside its parent - inserting a `<section>` *into* an `<h2>` would
 * produce markup the HTML parser silently restructures on the next reload,
 * which reads as elements teleporting. No selection appends to `<body>`.
 */
export function resolveInsertionTarget(
  document: PageDocument,
  selection: NodeId[],
): { parentId: NodeId; index: number } | null {
  const body = getBody(document);
  if (!body) return null;

  const selectedId = selection[0];
  if (selectedId) {
    const selected = findElement(document.root, selectedId);
    if (selected && canHoldChildren(selected)) {
      return { parentId: selected.id, index: selected.children.length };
    }
    if (selected) {
      const parent = findParent(document.root, selected.id);
      if (parent && canHoldChildren(parent)) {
        const index = parent.children.findIndex((child) => child.id === selected.id);
        return { parentId: parent.id, index: index === -1 ? parent.children.length : index + 1 };
      }
    }
  }

  return { parentId: body.id, index: body.children.length };
}
