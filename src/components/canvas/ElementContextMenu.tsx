import { useEffect, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { findElement } from '@shared/document.js';
import { useClampedMenuPosition } from '@/lib/useClampedMenuPosition.js';
import { Icon, type IconName } from '../Icon.js';

/**
 * Right-click menu for a selected element on the canvas.
 *
 * `TextActionMenu` already owns the right-click gesture when the user has a
 * partial *text* selection inside an element (bold/link/dynamic-year style
 * transforms); this menu owns the other, far more common case - right-
 * clicking an element itself to delete/duplicate/copy/paste/group it,
 * without hunting for the equivalent toolbar buttons or keyboard shortcuts.
 */
export function ElementContextMenu({
  x,
  y,
  nodeId,
  onClose,
}: {
  x: number;
  y: number;
  nodeId: string;
  onClose: () => void;
}): JSX.Element | null {
  const document = useEditorStore((state) => state.document);
  const removeNodes = useEditorStore((state) => state.removeNodes);
  const duplicateNodes = useEditorStore((state) => state.duplicateNodes);
  const copyNodes = useEditorStore((state) => state.copyNodes);
  const cutNodes = useEditorStore((state) => state.cutNodes);
  const pasteNodes = useEditorStore((state) => state.pasteNodes);
  const canPaste = useEditorStore((state) => state.canPaste());
  const groupNodes = useEditorStore((state) => state.groupNodes);
  const ungroupNode = useEditorStore((state) => state.ungroupNode);
  const selection = useEditorStore((state) => state.selection);
  const shareSection = useEditorStore((state) => state.shareSection);
  const unshareSection = useEditorStore((state) => state.unshareSection);
  const sharedSectionOf = useEditorStore((state) => state.sharedSectionOf);
  const { ref, style } = useClampedMenuPosition({ x, y });
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    const onDismiss = (event: MouseEvent | KeyboardEvent) => {
      if ('key' in event && event.key !== 'Escape') return;
      onClose();
    };
    window.addEventListener('mousedown', onDismiss);
    window.addEventListener('keydown', onDismiss);
    return () => {
      window.removeEventListener('mousedown', onDismiss);
      window.removeEventListener('keydown', onDismiss);
    };
  }, [onClose]);

  if (!document) return null;
  const element = findElement(document.root, nodeId);
  if (!element) return null;

  const hasElementChildren = element.children.some((child) => child.kind === 'element');
  const sharedName = sharedSectionOf(nodeId);
  // Only whole blocks are worth sharing: a menu, a footer, a call-to-action
  // band. Sharing a single word would copy a fragment between pages, which is
  // never what "the same on every subpage" means.
  const isShareable =
    sharedName !== null || ['header', 'footer', 'nav', 'section', 'aside', 'div'].includes(element.tag);
  // A name the user will usually just accept - the tag already says what the
  // block is for in the overwhelming majority of cases.
  const suggestedName =
    element.tag === 'footer'
      ? 'stopka'
      : element.tag === 'header' || element.tag === 'nav'
        ? 'nav'
        : 'sekcja';
  const canGroup = selection.length > 1 && selection.includes(nodeId);

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  const confirmShare = (): void => {
    const result = shareSection(nodeId, draftName);
    if (!result.ok) {
      setShareError(result.message);
      return;
    }
    onClose();
  };

  if (naming) {
    return (
      <div
        ref={ref}
        className="context-menu context-menu--form"
        style={style}
        role="dialog"
        aria-label="Wspólna sekcja"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="context-menu__title">Wspólna sekcja</p>
        <p className="context-menu__note">
          Ten blok będzie od teraz kopiowany do każdej podstrony, która go zawiera. W plikach zapisze się jako
          zwykły komentarz HTML - strona nadal otwiera się bez żadnych dodatków.
        </p>
        <input
          className="input"
          type="text"
          autoFocus
          value={draftName}
          placeholder={suggestedName}
          onChange={(event) => {
            setDraftName(event.target.value);
            setShareError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              confirmShare();
            }
            if (event.key === 'Escape') setNaming(false);
          }}
        />
        {shareError ? (
          <p className="context-menu__note" role="alert" style={{ color: 'var(--danger)' }}>
            {shareError}
          </p>
        ) : null}
        <div className="context-menu__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={confirmShare}
            disabled={draftName.trim() === ''}
          >
            Udostępnij
          </button>
          <button type="button" className="button" onClick={() => setNaming(false)}>
            Anuluj
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={style}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MenuItem
        icon="library_add"
        label="Duplikuj"
        hint="Ctrl+D"
        onClick={run(() => duplicateNodes([nodeId]))}
      />
      <MenuItem icon="content_copy" label="Kopiuj" hint="Ctrl+C" onClick={run(() => copyNodes([nodeId]))} />
      <MenuItem icon="content_cut" label="Wytnij" hint="Ctrl+X" onClick={run(() => cutNodes([nodeId]))} />
      <MenuItem
        icon="content_paste"
        label="Wklej"
        hint="Ctrl+V"
        disabled={!canPaste}
        onClick={run(() => pasteNodes())}
      />
      {canGroup ? (
        <MenuItem
          icon="select_all"
          label="Grupuj zaznaczone"
          hint="Ctrl+G"
          onClick={run(() => groupNodes(selection))}
        />
      ) : null}
      {hasElementChildren ? (
        <MenuItem
          icon="call_split"
          label="Rozgrupuj"
          hint="zastąp dziećmi"
          onClick={run(() => ungroupNode(nodeId))}
        />
      ) : null}
      {/* Sharing acts on a whole block, so it is offered for containers - a
          header, a footer, a section - and not for the text inside one. */}
      {isShareable ? (
        sharedName ? (
          <MenuItem
            icon="check_circle"
            label={`Wspólna sekcja: ${sharedName}`}
            hint="przestań"
            onClick={run(() => unshareSection(sharedName))}
          />
        ) : (
          <MenuItem
            icon="view_agenda"
            label="Użyj na wszystkich podstronach"
            hint="wspólna sekcja"
            onClick={() => {
              setDraftName(suggestedName);
              setNaming(true);
            }}
          />
        )
      ) : null}
      <MenuItem icon="delete" label="Usuń" hint="Delete" onClick={run(() => removeNodes([nodeId]))} />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="context-menu__item"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
      <span className="context-menu__label">{label}</span>
      <span className="context-menu__hint">{hint}</span>
    </button>
  );
}
