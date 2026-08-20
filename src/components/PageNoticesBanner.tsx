import { useEffect, useState } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { Icon } from './Icon.js';

/**
 * Parser warnings for the open page, shown where they cannot be missed.
 *
 * These already existed, but only inside the console panel — which is collapsed
 * by default, so a page that opened with problems looked identical to one that
 * opened cleanly. "It just didn't work and said nothing" is the worst failure
 * an editor can have, so anything the parser flagged is stated up front. The
 * console panel keeps the full history; this is the part the user must see.
 */
export function PageNoticesBanner(): JSX.Element | null {
  const notices = useEditorStore((state) => state.notices);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);

  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
  }, [pageRelPath, notices]);

  if (dismissed || notices.length === 0) return null;

  return (
    <div className="page-notices" role="status" aria-label="Ostrzeżenia dotyczące strony">
      {notices.map((notice, index) => (
        <div key={`${notice}-${index}`} className="page-notices__item">
          <span className="page-notices__text">
            <Icon name="warning" size={16} />
            {notice}
          </span>
        </div>
      ))}
      <div className="page-notices__item">
        <span className="page-notices__text">
          Strona jest edytowalna mimo tych ostrzeżeń — pełne szczegóły są w panelu Logi.
        </span>
        <button type="button" className="button button--ghost" onClick={() => setDismissed(true)}>
          Ukryj
        </button>
      </div>
    </div>
  );
}
