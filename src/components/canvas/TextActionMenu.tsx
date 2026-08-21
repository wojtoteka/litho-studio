import { useCallback, useEffect, useState, type RefObject } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { CANVAS_ID_ATTRIBUTE } from '@/lib/canvasDocument.js';
import { useClampedMenuPosition } from '@/lib/useClampedMenuPosition.js';
import { findElement } from '@shared/document.js';
import {
  availableTextActions,
  type TextAction,
  type TextActionContext,
  type TextRange,
} from '@/engine/richTextEditor.js';
import { TextActionDialog } from './TextActionDialog.js';

/**
 * The context menu behind partial rich-text editing.
 *
 * Selecting part of a text element and right-clicking offers the transformations
 * that apply to *that* selection - the menu is built from the action registry in
 * `richTextEditor.ts`, so a new action appears here without this file changing.
 *
 * The delicate part is turning the DOM selection inside the iframe into the
 * plain-text offsets the engine works in: `domOffsetToPlainText` walks the
 * host element's text nodes in document order and accumulates lengths, which is
 * exactly the projection `getPlainText` produces.
 *
 * `frameEpoch` matters: every edit rebuilds the iframe's document, and the old
 * document takes its listeners with it. The epoch bumps on every load, forcing
 * this effect to re-attach - without it the menu works exactly once.
 */
export function TextActionMenu({
  frameRef,
  frameEpoch,
}: {
  frameRef: RefObject<HTMLIFrameElement>;
  frameEpoch: number;
}): JSX.Element | null {
  const document = useEditorStore((state) => state.document);
  const applyTextAction = useEditorStore((state) => state.applyTextAction);
  const zoom = useUiStore((state) => state.zoom);

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    range: TextRange;
    selectedText: string;
  } | null>(null);

  const [pending, setPending] = useState<{
    action: TextAction<unknown>;
    context: TextActionContext;
    nodeId: string;
    range: TextRange;
  } | null>(null);

  const close = useCallback(() => setMenu(null), []);
  const { ref: menuRef, style: menuStyle } = useClampedMenuPosition({ x: menu?.x ?? 0, y: menu?.y ?? 0 });

  useEffect(() => {
    const frame = frameRef.current;
    const frameDocument = frame?.contentDocument;
    if (!frameDocument || !document) return undefined;

    const onContextMenu = (event: MouseEvent) => {
      const selection = frameDocument.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setMenu(null);
        return;
      }

      const domRange = selection.getRangeAt(0);
      const host = findHost(domRange.commonAncestorContainer);
      if (!host) {
        setMenu(null);
        return;
      }

      const nodeId = host.getAttribute(CANVAS_ID_ATTRIBUTE);
      if (!nodeId) return;

      const start = domOffsetToPlainText(host, domRange.startContainer, domRange.startOffset);
      const end = domOffsetToPlainText(host, domRange.endContainer, domRange.endOffset);
      if (start === null || end === null || start === end) {
        setMenu(null);
        return;
      }

      event.preventDefault();

      // The iframe's coordinates are relative to its own (unscaled) viewport;
      // the stage renders it through `scale(zoom)`, so the offset must be
      // scaled before being added to the frame's on-screen position.
      const frameRect = frame.getBoundingClientRect();
      setMenu({
        x: frameRect.left + event.clientX * zoom,
        y: frameRect.top + event.clientY * zoom,
        nodeId,
        range: { start: Math.min(start, end), end: Math.max(start, end) },
        selectedText: selection.toString(),
      });
    };

    frameDocument.addEventListener('contextmenu', onContextMenu);
    return () => frameDocument.removeEventListener('contextmenu', onContextMenu);
  }, [document, frameRef, frameEpoch, zoom]);

  useEffect(() => {
    if (!menu) return undefined;
    const onDismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      close();
    };
    window.addEventListener('mousedown', onDismiss);
    window.addEventListener('keydown', onDismiss);
    return () => {
      window.removeEventListener('mousedown', onDismiss);
      window.removeEventListener('keydown', onDismiss);
    };
  }, [menu, close]);

  if (!document) return null;

  const contextFor = (nodeId: string, range: TextRange, selectedText: string): TextActionContext | null => {
    const element = findElement(document.root, nodeId);
    if (!element) return null;
    return {
      element,
      range,
      selectedText,
      allocateDocumentId: (base) => base,
    };
  };

  return (
    <>
      {menu
        ? (() => {
            const context = contextFor(menu.nodeId, menu.range, menu.selectedText);
            if (!context) return null;
            const actions = availableTextActions(context);
            if (actions.length === 0) return null;

            return (
              <div
                ref={menuRef}
                className="context-menu"
                style={menuStyle}
                role="menu"
                onMouseDown={(event) => event.stopPropagation()}
              >
                {actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    className="context-menu__item"
                    onClick={() => {
                      setPending({
                        action: action as TextAction<unknown>,
                        context,
                        nodeId: menu.nodeId,
                        range: menu.range,
                      });
                      close();
                    }}
                  >
                    <span className="context-menu__label">{action.label}</span>
                    <span className="context-menu__hint">{action.hint}</span>
                  </button>
                ))}
              </div>
            );
          })()
        : null}

      {pending ? (
        <TextActionDialog
          action={pending.action}
          context={pending.context}
          onCancel={() => setPending(null)}
          onConfirm={(params) => {
            applyTextAction(pending.nodeId, pending.action, pending.range, params);
            setPending(null);
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */

function findHost(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest(`[${CANVAS_ID_ATTRIBUTE}]`) ?? null;
}

/**
 * Converts a DOM position inside `host` into an offset in `host`'s plain text.
 *
 * Returns `null` when the position is not inside the host at all, which happens
 * if the user's selection spans two elements - the caller then declines to show
 * a menu rather than transforming the wrong range.
 */
export function domOffsetToPlainText(host: Element, container: Node, offset: number): number | null {
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let total = 0;

  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    if (textNode === container) return total + offset;
    total += textNode.data.length;
  }

  // The position may reference an element node (e.g. selection ending just
  // after a child); fall back to counting text up to that element.
  if (container.nodeType === Node.ELEMENT_NODE && host.contains(container)) {
    const element = container as Element;
    const child = element.childNodes[offset] ?? null;
    if (child === null) return total;
    const inner = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let count = 0;
    while (inner.nextNode()) {
      const textNode = inner.currentNode as Text;
      if (child.contains(textNode) || child === textNode) return count;
      count += textNode.data.length;
    }
    return count;
  }

  return null;
}
