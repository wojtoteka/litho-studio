import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore, ancestorsOf } from '@/state/editorStore.js';
import {
  classifyElement,
  ELEMENT_KIND_LABELS,
  findElement,
  findParent,
  getAttr,
  getBody,
  textContent,
  type ElementNode,
} from '@shared/document.js';
import { NON_VISUAL_ELEMENTS } from '@shared/document.js';
import { Icon } from '../Icon.js';

/** Tags able to hold children - the only valid "drop inside" targets. */
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'form',
  'figure',
  'ul',
  'ol',
  'li',
]);

/**
 * Layer tree.
 *
 * Rows are flattened before rendering so the list is a single flat array -
 * that keeps the DOM shallow for deep pages and makes it straightforward to
 * virtualise: only rows inside the scroll window are mounted, so a page with
 * thousands of elements still scrolls at full speed.
 *
 * Visibility and locking are stored as real attributes (`hidden`, `inert`)
 * rather than editor metadata, so they mean the same thing when the page is
 * opened in a browser - consistent with the "no editor-only state" rule.
 */

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

interface Row {
  node: ElementNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export function LayersPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const select = useEditorStore((state) => state.select);
  const toggleSelection = useEditorStore((state) => state.toggleSelection);
  const setHovered = useEditorStore((state) => state.setHovered);
  const setAttribute = useEditorStore((state) => state.setAttribute);
  const moveNode = useEditorStore((state) => state.moveNode);
  const revision = useEditorStore((state) => state.revision);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [dragOver, setDragOver] = useState<{ id: string; position: 'before' | 'after' | 'inside' } | null>(
    null,
  );
  const dragId = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // A single selected element (from a canvas click, a fresh insert, or an undo)
  // must be visible here without the user hunting for it - expand whichever of
  // its ancestors are currently collapsed.
  const selectedId = selection.length === 1 ? selection[0] : null;
  useEffect(() => {
    if (!document || !selectedId) return;
    const ancestors = ancestorsOf(document, selectedId);
    setCollapsed((current) => {
      let changed = false;
      const next = new Set(current);
      for (const ancestor of ancestors) {
        if (next.delete(ancestor.id)) changed = true;
      }
      return changed ? next : current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, selectedId]);

  const rows = useMemo(() => {
    if (!document) return [];
    const body = getBody(document);
    if (!body) return [];
    return flatten(body, 0, collapsed);
    // `revision` included because the tree mutates in place - see editorStore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, collapsed, revision]);

  // Once the row for the selected element exists (its ancestors were just
  // expanded above), scroll it into view rather than leaving it off-screen.
  useEffect(() => {
    if (!selectedId) return;
    const container = containerRef.current;
    if (!container) return;
    const index = rows.findIndex((row) => row.node.id === selectedId);
    if (index === -1) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    let target: number | null = null;
    if (rowTop < container.scrollTop) target = rowTop;
    else if (rowBottom > container.scrollTop + container.clientHeight)
      target = rowBottom - container.clientHeight;
    if (target === null) return;
    container.scrollTop = target;
    // Native `scroll` events fire asynchronously; setting this directly avoids
    // a one-frame flash where the just-revealed row is still outside `visible`.
    setScrollTop(target);
  }, [selectedId, rows]);

  const toggleExpanded = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Resolves where a dragged layer should land relative to the row under the
   * pointer: inside a container, or before/after any element. The vertical
   * thirds of the row map to before / inside / after, but only container tags
   * offer an "inside" zone.
   */
  const resolveDrop = useCallback(
    (
      targetNode: ElementNode,
      offsetRatio: number,
    ): { id: string; position: 'before' | 'after' | 'inside' } => {
      const isContainer = CONTAINER_TAGS.has(targetNode.tag);
      if (isContainer && offsetRatio > 0.33 && offsetRatio < 0.67) {
        return { id: targetNode.id, position: 'inside' };
      }
      return { id: targetNode.id, position: offsetRatio < 0.5 ? 'before' : 'after' };
    },
    [],
  );

  const performDrop = useCallback((): void => {
    const sourceId = dragId.current;
    const target = dragOver;
    dragId.current = null;
    setDragOver(null);
    if (!sourceId || !target || sourceId === target.id) return;

    const state = useEditorStore.getState();
    const root = state.document?.root;
    if (!root) return;

    // Never drop a node into its own subtree - that would detach the tree.
    const source = findElement(root, sourceId);
    if (!source || findElement(source, target.id)) return;

    if (target.position === 'inside') {
      const container = findElement(root, target.id);
      if (!container) return;
      moveNode(sourceId, { parentId: container.id, index: container.children.length });
      return;
    }

    const parent = findParent(root, target.id);
    if (!parent) return;
    const targetIndex = parent.children.findIndex((child) => child.id === target.id);
    if (targetIndex === -1) return;
    const insertAt = target.position === 'before' ? targetIndex : targetIndex + 1;
    moveNode(sourceId, { parentId: parent.id, index: insertAt });
  }, [dragOver, moveNode]);

  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastVisible = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(firstVisible, lastVisible);

  if (!document) {
    return (
      <div className="props__empty">
        <Icon name="layers" size={30} />
        Otwórz stronę, aby zobaczyć jej strukturę.
      </div>
    );
  }

  return (
    <div
      className="panel__body"
      role="tree"
      aria-label="Warstwy strony"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={(node) => {
        containerRef.current = node;
        if (node) setViewportHeight(node.clientHeight);
      }}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        {visible.map((row, index) => {
          const absoluteIndex = firstVisible + index;
          const isSelected = selection.includes(row.node.id);
          const hidden = getAttr(row.node, 'hidden') !== undefined;
          const locked = getAttr(row.node, 'inert') !== undefined;

          const dropHint = dragOver?.id === row.node.id ? dragOver.position : null;

          return (
            <div
              key={row.node.id}
              className={`layer${dropHint === 'inside' ? ' layer--drop-inside' : ''}`}
              role="treeitem"
              aria-selected={isSelected}
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              tabIndex={isSelected ? 0 : -1}
              draggable
              style={{
                position: 'absolute',
                top: absoluteIndex * ROW_HEIGHT,
                left: 0,
                right: 0,
                paddingLeft: 4 + row.depth * 12,
                boxShadow:
                  dropHint === 'before'
                    ? 'inset 0 2px 0 var(--accent)'
                    : dropHint === 'after'
                      ? 'inset 0 -2px 0 var(--accent)'
                      : undefined,
              }}
              onDragStart={(event) => {
                dragId.current = row.node.id;
                event.dataTransfer.effectAllowed = 'move';
                // Some browsers require data to be set for the drag to start.
                event.dataTransfer.setData('text/plain', row.node.id);
              }}
              onDragOver={(event) => {
                if (!dragId.current || dragId.current === row.node.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const bounds = event.currentTarget.getBoundingClientRect();
                const ratio = (event.clientY - bounds.top) / bounds.height;
                setDragOver(resolveDrop(row.node, ratio));
              }}
              onDrop={(event) => {
                event.preventDefault();
                performDrop();
              }}
              onDragEnd={() => {
                dragId.current = null;
                setDragOver(null);
              }}
              onMouseEnter={() => setHovered(row.node.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={(event) => {
                if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelection(row.node.id);
                else select([row.node.id]);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select([row.node.id]);
                }
              }}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  className="layer__twisty"
                  aria-label={row.expanded ? 'Zwiń' : 'Rozwiń'}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(row.node.id);
                  }}
                >
                  <Icon name={row.expanded ? 'expand_more' : 'chevron_right'} size={15} />
                </button>
              ) : (
                <span className="layer__twisty" aria-hidden="true" />
              )}

              <span className="layer__name">{describeLayer(row.node)}</span>
              <span className="layer__tag">{row.node.tag}</span>

              <button
                type="button"
                className={`layer__action${locked ? ' layer__action--on' : ''}`}
                aria-label={locked ? 'Odblokuj element' : 'Zablokuj element'}
                aria-pressed={locked}
                onClick={(event) => {
                  event.stopPropagation();
                  setAttribute(
                    row.node.id,
                    'inert',
                    locked ? null : '',
                    locked ? 'Odblokowanie' : 'Zablokowanie',
                  );
                }}
                title={locked ? 'Odblokuj element' : 'Zablokuj element'}
              >
                <Icon name={locked ? 'lock' : 'lock_open'} size={15} />
              </button>

              <button
                type="button"
                className={`layer__action${hidden ? ' layer__action--on' : ''}`}
                aria-label={hidden ? 'Pokaż element' : 'Ukryj element'}
                aria-pressed={hidden}
                onClick={(event) => {
                  event.stopPropagation();
                  setAttribute(row.node.id, 'hidden', hidden ? null : '', hidden ? 'Pokazanie' : 'Ukrycie');
                }}
                title={hidden ? 'Pokaż element' : 'Ukryj element'}
              >
                <Icon name={hidden ? 'visibility_off' : 'visibility'} size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function flatten(node: ElementNode, depth: number, collapsed: Set<string>): Row[] {
  const children = node.children.filter(
    (child): child is ElementNode => child.kind === 'element' && !NON_VISUAL_ELEMENTS.has(child.tag),
  );
  const expanded = !collapsed.has(node.id);
  const row: Row = { node, depth, hasChildren: children.length > 0, expanded };

  if (!expanded || children.length === 0) return [row];
  return [row, ...children.flatMap((child) => flatten(child, depth + 1, collapsed))];
}

/**
 * A layer's name: the author's own `id` or class if there is one, otherwise the
 * element's text, otherwise its kind. Users recognise their own names faster
 * than any label the editor could invent.
 */
function describeLayer(node: ElementNode): string {
  const id = getAttr(node, 'id');
  if (id) return `#${id}`;

  const className = (getAttr(node, 'class') ?? '').split(/\s+/u).filter(Boolean)[0];
  if (className) return `.${className}`;

  const text = textContent(node).replace(/\s+/gu, ' ').trim();
  if (text !== '') return text.length > 28 ? `${text.slice(0, 27)}…` : text;

  return ELEMENT_KIND_LABELS[classifyElement(node)];
}
