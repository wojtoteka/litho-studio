import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUiStore, ZOOM_PRESETS } from '@/state/uiStore.js';
import { useFloatingLayer } from '@/lib/useFloatingLayer.js';
import { Icon } from './Icon.js';

/**
 * The zoom readout in the toolbar, and the menu behind it.
 *
 * The percentage used to be a button that did exactly one thing — snap back to
 * 100 % — which meant every other magnification had to be reached by clicking
 * −/+ repeatedly and watching the number go past the one you wanted. It now
 * behaves the way a zoom readout does in every drawing tool: it *reads* as a
 * value, and clicking it opens the ways of setting that value — type an exact
 * number, or pick a step.
 *
 * "Dopasuj do okna" lives in this menu as well as on its own toolbar button,
 * because "how big is the page" and "make the page fit" are the same question
 * asked twice, and the user who opened this menu is already asking it.
 */
export function ZoomControl(): JSX.Element {
  const zoom = useUiStore((state) => state.zoom);
  const zoomMode = useUiStore((state) => state.zoomMode);
  const setZoom = useUiStore((state) => state.setZoom);
  const fitZoom = useUiStore((state) => state.fitZoom);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const percent = Math.round(zoom * 100);

  return (
    <div className="zoom">
      <button
        ref={buttonRef}
        type="button"
        className="button zoom__value"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Powiększenie — kliknij, aby wpisać własną wartość lub wybrać z listy"
      >
        {percent}%
        <Icon name="expand_more" size={14} />
      </button>

      {open ? (
        <ZoomMenu
          anchorRef={buttonRef}
          percent={percent}
          zoomMode={zoomMode}
          onPick={(value) => {
            setZoom(value);
            setOpen(false);
          }}
          onFit={() => {
            fitZoom();
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ZoomMenu({
  anchorRef,
  percent,
  zoomMode,
  onPick,
  onFit,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement>;
  percent: number;
  zoomMode: 'fit' | 'manual';
  onPick: (zoom: number) => void;
  onFit: () => void;
  onClose: () => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(String(percent));
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  /* Anchored to the button, flipped up if the bar ever sits near the bottom. */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const box = anchor.getBoundingClientRect();
    const margin = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;

    const left = Math.max(margin, Math.min(box.left, window.innerWidth - width - margin));
    const below = box.bottom + 6;
    const top = below + height > window.innerHeight - margin ? Math.max(margin, box.top - height - 6) : below;

    setStyle({ left, top, visibility: 'visible' });
  }, [anchorRef]);

  // The toolbar spans the preview too, so this menu can drop over the native
  // view — which would otherwise composite straight over it.
  useFloatingLayer(menuRef);

  /* Open with the current value selected, so typing replaces it outright. */
  useEffect(() => {
    inputRef.current?.select();
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

  const commitDraft = (): void => {
    // Tolerant of what people actually type: "150", "150%", "1,5x" spacing and
    // a stray comma all mean the same thing. Anything unreadable is ignored
    // rather than snapping the canvas to some arbitrary fallback.
    const parsed = Number.parseFloat(draft.replace(',', '.').replace(/[^\d.]/gu, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      onClose();
      return;
    }
    onPick(parsed / 100);
  };

  return (
    <div className="zoom__menu" ref={menuRef} style={style} role="menu" aria-label="Powiększenie">
      <form
        className="zoom__custom"
        onSubmit={(event) => {
          event.preventDefault();
          commitDraft();
        }}
      >
        <input
          ref={inputRef}
          className="input zoom__input"
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Własne powiększenie w procentach"
        />
        <span className="zoom__unit">%</span>
        <button type="submit" className="button button--primary zoom__apply">
          Ustaw
        </button>
      </form>

      <div className="zoom__presets">
        {ZOOM_PRESETS.map((preset) => {
          const value = Math.round(preset * 100);
          return (
            <button
              key={preset}
              type="button"
              role="menuitem"
              className={`button zoom__preset${zoomMode === 'manual' && value === percent ? ' button--active' : ''}`}
              onClick={() => onPick(preset)}
            >
              {value}%
            </button>
          );
        })}
      </div>

      <button
        type="button"
        role="menuitem"
        className={`button zoom__fit${zoomMode === 'fit' ? ' button--active' : ''}`}
        onClick={onFit}
      >
        <Icon name="fit_screen" size={15} />
        Dopasuj do okna
      </button>
    </div>
  );
}
