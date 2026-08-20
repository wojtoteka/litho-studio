import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PageRef } from '@shared/project.js';
import { useFloatingLayer } from '@/lib/useFloatingLayer.js';
import { Icon } from './Icon.js';

/**
 * The page picker in the toolbar.
 *
 * This used to be a bare `<select>`, which cost more than it looked like it
 * did. A native option list can hold exactly one string per row, so the page's
 * title and its file path had to be crushed into `Tytuł — sciezka/pliku.html`;
 * at the control's width the path — the part that actually distinguishes
 * `o-nas.html` from `oferta/o-nas.html` — was the half that got truncated. It
 * also cannot show which page is the entry point, cannot be filtered, and is
 * drawn by the OS, so it ignored the app's theme entirely.
 *
 * The replacement gives each page two lines (title over path), marks the entry
 * page, and filters once a project has enough pages for that to be the faster
 * way to reach one.
 */

/** Above this many pages, hunting a list is slower than typing part of a name. */
const FILTER_THRESHOLD = 8;

export function PageSwitcher({
  pages,
  currentRelPath,
  onPick,
}: {
  pages: PageRef[];
  currentRelPath: string | null;
  onPick: (relPath: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const current = pages.find((page) => page.relPath === currentRelPath) ?? pages[0] ?? null;

  return (
    <div className="page-switcher">
      <button
        ref={buttonRef}
        type="button"
        className="button page-switcher__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={current ? `${current.title} — ${current.relPath}` : 'Wybierz stronę'}
      >
        <Icon name="description" size={15} />
        <span className="page-switcher__current">
          <span className="page-switcher__title">{current?.title ?? 'Wybierz stronę'}</span>
          <span className="page-switcher__path">{current?.relPath ?? ''}</span>
        </span>
        <Icon name="expand_more" size={14} />
      </button>

      {open ? (
        <PageMenu
          anchorRef={buttonRef}
          pages={pages}
          currentRelPath={current?.relPath ?? null}
          onPick={(relPath) => {
            setOpen(false);
            if (relPath !== current?.relPath) onPick(relPath);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function PageMenu({
  anchorRef,
  pages,
  currentRelPath,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  pages: PageRef[];
  currentRelPath: string | null;
  onPick: (relPath: string) => void;
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const showFilter = pages.length > FILTER_THRESHOLD;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return pages;
    return pages.filter(
      (page) => page.title.toLowerCase().includes(needle) || page.relPath.toLowerCase().includes(needle),
    );
  }, [pages, query]);

  /* Anchored under the trigger, matching its width, flipped up if need be. */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const box = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(box.width, menu.offsetWidth);
    const height = menu.offsetHeight;

    const left = Math.max(margin, Math.min(box.left, window.innerWidth - width - margin));
    const below = box.bottom + 6;
    const top = below + height > window.innerHeight - margin ? Math.max(margin, box.top - height - 6) : below;

    setStyle({ left, top, minWidth: box.width, visibility: 'visible' });
  }, [anchorRef, visible.length]);

  // Drops out of the toolbar and over the work area — and the native preview
  // composites above the document, so it has to be told to stand down.
  useFloatingLayer(menuRef);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      if (anchorRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  return (
    <div className="page-switcher__menu" ref={menuRef} style={style} role="listbox" aria-label="Strony">
      {showFilter ? (
        <div className="search-field page-switcher__search">
          <Icon name="search" size={15} />
          <input
            ref={searchRef}
            className="input"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Szukaj strony…"
            aria-label="Szukaj strony"
          />
        </div>
      ) : null}

      <div className="page-switcher__list">
        {visible.map((page) => {
          const active = page.relPath === currentRelPath;
          return (
            <button
              key={page.relPath}
              type="button"
              role="option"
              aria-selected={active}
              className={`page-switcher__option${active ? ' page-switcher__option--active' : ''}`}
              onClick={() => onPick(page.relPath)}
            >
              <Icon name={active ? 'check' : 'description'} size={15} />
              <span className="page-switcher__option-text">
                <span className="page-switcher__title">{page.title}</span>
                <span className="page-switcher__path">{page.relPath}</span>
              </span>
              {/* Which file the site actually opens on is not derivable from the
                  name — plenty of projects have no `index.html` at the root. */}
              {page.isEntry ? <span className="page-switcher__badge">start</span> : null}
            </button>
          );
        })}

        {visible.length === 0 ? (
          <p className="page-switcher__empty">Brak stron pasujących do wyszukiwania.</p>
        ) : null}
      </div>
    </div>
  );
}
