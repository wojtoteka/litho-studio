import { useEffect } from 'react';
import { DOWNLOAD_PAGE_URL } from '@shared/ipc.js';
import { useUiStore } from '@/state/uiStore.js';
import { logger } from '@/lib/logger.js';
import { Icon } from './Icon.js';

/**
 * "A newer Litho exists" - said once, at launch, in front of everything else.
 *
 * The banner along the top (`UpdateBanner`) is easy to walk past: it is one
 * strip of chrome among several, and an update that ships a fix the user is
 * currently working around is worth one deliberate look. So the notice starts
 * as a modal - new version, running version, where it comes from - and *only*
 * then falls back to the banner.
 *
 * Two ways out, both leaving the app usable:
 *
 *  - **Pobierz** opens the download page in the user's own browser and closes
 *    the dialog. It deliberately does not download anything: Litho ships as an
 *    AppImage, a .deb and a couple of Windows builds, each installed a
 *    different way, so the file to fetch is the user's choice to make on a page
 *    that lists all of them. The editor stays open behind it.
 *  - **Później** just closes it. Nothing is blocked, nothing is postponed to a
 *    place the user cannot find again - the banner stays behind with the same
 *    button.
 *
 * Escape counts as "Później". Nothing here is ever shown when the check failed
 * (offline) or when the running build is already current - see
 * `updateService.ts`.
 */
export function UpdateDialog(): JSX.Element | null {
  const update = useUiStore((state) => state.update);
  const seen = useUiStore((state) => state.updateNoticeSeen);
  const acknowledge = useUiStore((state) => state.acknowledgeUpdateNotice);

  const visible = !seen && Boolean(update?.updateAvailable) && Boolean(update?.latest);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') acknowledge();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, acknowledge]);

  if (!visible || !update?.latest) return null;

  const download = (): void => {
    acknowledge();
    void window.litho.update.openDownloadPage().then((result) => {
      if (!result.ok) logger.warn(`Nie udało się otworzyć strony pobierania: ${result.message}`);
    });
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={acknowledge}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id="update-dialog-title">
          <Icon name="cloud_done" size={20} />
          Dostępna jest nowa wersja
        </h2>
        <p className="dialog__hint">
          Litho Studio <strong>{update.latest}</strong> jest już do pobrania. Aktualizacja jest ręczna -
          „Pobierz” otwiera stronę z plikami w Twojej przeglądarce, a instalujesz ją tak samo jak poprzednią
          wersję.
        </p>

        <dl className="update-dialog__facts">
          <div className="update-dialog__fact">
            <dt>Nowa wersja</dt>
            <dd>
              <strong>{update.latest}</strong>
            </dd>
          </div>
          <div className="update-dialog__fact">
            <dt>Twoja wersja</dt>
            <dd>{update.current}</dd>
          </div>
          <div className="update-dialog__fact">
            <dt>System</dt>
            <dd>{platformLabel()}</dd>
          </div>
          <div className="update-dialog__fact">
            <dt>Skąd pobrać</dt>
            <dd>
              <code>{DOWNLOAD_PAGE_URL}</code>
            </dd>
          </div>
        </dl>

        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={acknowledge}>
            Później
          </button>
          <button type="button" className="button button--primary" onClick={download} autoFocus>
            <Icon name="open_in_new" size={15} />
            Pobierz
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which build the page will offer. The release API keeps a separate version per
 * platform, so naming the platform here is what makes "1.0.3" unambiguous.
 */
function platformLabel(): string {
  return /win/iu.test(window.navigator.userAgent) ? 'Windows' : 'Linux';
}
