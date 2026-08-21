import { useUiStore } from '@/state/uiStore.js';
import { logger } from '@/lib/logger.js';
import { Icon } from './Icon.js';

/**
 * "A newer Litho exists" - one strip across the top of the window.
 *
 * The app is installed from a static download page (AppImage, .deb, and the
 * Windows builds), so there is nothing to auto-update *into*: the useful thing
 * the program can do is notice, say so once, and open the page. Everything
 * after that is the user's own browser and package manager, which is where
 * installing software on Linux belongs anyway.
 *
 * The quiet half of the notice: `UpdateDialog` says it once at launch, and what
 * survives "Później" is this strip - same version numbers, same one click to
 * the page, but out of the way.
 *
 * Rendered for both the start screen and the editor - an update matters just as
 * much before a project is open as after - and dismissible with one click. The
 * dismissal lives in the ui store and is deliberately not persisted: the check
 * is supposed to run on every launch, so "Ukryj" means "not now", never "never
 * again".
 *
 * Nothing is drawn while the check is running, when it failed (offline), or
 * when the running build is already current. A banner that appeared and then
 * retracted itself would be worse than no banner.
 */
export function UpdateBanner(): JSX.Element | null {
  const update = useUiStore((state) => state.update);
  const dismissed = useUiStore((state) => state.updateDismissed);
  const dismiss = useUiStore((state) => state.dismissUpdate);

  if (dismissed || !update?.updateAvailable || !update.latest) return null;

  const download = (): void => {
    void window.litho.update.openDownloadPage().then((result) => {
      if (!result.ok) logger.warn(`Nie udało się otworzyć strony pobierania: ${result.message}`);
    });
  };

  return (
    <div className="update-banner" role="status" aria-label="Dostępna aktualizacja">
      <span className="update-banner__text">
        <Icon name="cloud_done" size={16} />
        <span>
          Dostępna jest nowa wersja Litho Studio: <strong>{update.latest}</strong> (masz {update.current}).
        </span>
      </span>
      <span className="update-banner__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={download}
          title="Otwiera stronę z plikami do pobrania w Twojej przeglądarce - Litho niczego nie pobiera samo"
        >
          <Icon name="open_in_new" size={15} />
          Pobierz
        </button>
        <button type="button" className="button button--ghost" onClick={dismiss}>
          Ukryj
        </button>
      </span>
    </div>
  );
}
