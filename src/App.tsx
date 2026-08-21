import { Suspense, lazy, useEffect } from 'react';
import { useEditorStore } from './state/editorStore.js';
import { useUiStore } from './state/uiStore.js';
import { useCommands, SHORTCUTS } from './lib/useCommands.js';
import { logger } from './lib/logger.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { StartScreen } from './components/StartScreen.js';
import { Toolbar } from './components/Toolbar.js';
import { StatusBar } from './components/StatusBar.js';
import { BreakpointBar } from './components/BreakpointBar.js';
import { Canvas } from './components/canvas/Canvas.js';
import { ElementsPanel } from './components/panels/ElementsPanel.js';
import { ComponentsPanel } from './components/panels/ComponentsPanel.js';
import { StylesPanel } from './components/panels/StylesPanel.js';
import { LayersPanel } from './components/panels/LayersPanel.js';
import { AssetsPanel } from './components/panels/AssetsPanel.js';
import { PropertiesPanel } from './components/panels/PropertiesPanel.js';
import { ConsolePanel } from './components/panels/ConsolePanel.js';
import { PreviewPane } from './components/preview/PreviewPane.js';
import { NewProjectDialog } from './components/NewProjectDialog.js';
import { NewPageDialog } from './components/NewPageDialog.js';
import { AiToolsDialog } from './components/AiToolsDialog.js';
import { MissingRefsBanner } from './components/MissingRefsBanner.js';
import { PageNoticesBanner } from './components/PageNoticesBanner.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { UpdateDialog } from './components/UpdateDialog.js';
import { Icon, type IconName } from './components/Icon.js';
import type { LeftPanel } from './state/uiStore.js';

/*
 * Loaded on demand, not at startup.
 *
 * These are the heaviest things in the app and none of them is needed to open a
 * page and start editing - which is the only thing the first screen has to be
 * fast at. The terminal alone drags in xterm.js (~250 kB); the icon panel
 * carries the full Material Symbols catalogue. Splitting them moves that
 * weight from "every launch" to "the moment you actually ask for it".
 *
 * Everything else stays eagerly imported on purpose: the canvas, the properties
 * panel and the element/component palettes are the app, and code-splitting them
 * would only trade startup time for a stutter on first use.
 */
const IconsPanel = lazy(async () => ({
  default: (await import('./components/panels/IconsPanel.js')).IconsPanel,
}));
const TerminalPanel = lazy(async () => ({
  default: (await import('./components/panels/TerminalPanel.js')).TerminalPanel,
}));
const AuditPanel = lazy(async () => ({
  default: (await import('./components/panels/AuditPanel.js')).AuditPanel,
}));

/** Placeholder while a lazily-loaded panel's chunk arrives - local files, so
 *  this is on screen for a frame or two at most. */
function PanelFallback(): JSX.Element {
  return (
    <p className="dialog__hint" style={{ padding: 'var(--space-5)' }}>
      Wczytywanie…
    </p>
  );
}

/**
 * The left dock's destinations, in the order they appear.
 *
 * Icon *and* label: six tabs in a ~240 px panel cannot show six readable words
 * side by side, and icon-only tabs would make "Style" and "Zasoby" a guessing
 * game the first three times. Stacking a 16 px glyph over a 10 px label fits
 * both and gives the eye something to aim at on the second visit.
 */
const LEFT_PANELS: readonly (readonly [LeftPanel, string, IconName])[] = [
  ['elements', 'Elementy', 'widgets'],
  ['components', 'Komponenty', 'dashboard_customize'],
  ['icons', 'Ikony', 'emoji_symbols'],
  ['styles', 'Style', 'palette'],
  ['layers', 'Warstwy', 'layers'],
  ['assets', 'Zasoby', 'folder'],
  ['audit', 'Sprawdź', 'check_circle'],
] as const;

/**
 * Application shell.
 *
 * Each panel sits behind its own error boundary: a crash in, say, the layer
 * tree must not cost the user access to the canvas or to the console panel that
 * explains what went wrong. The editor writes to real files, so degrading
 * gracefully matters more here than in a typical app.
 */
export function App(): JSX.Element {
  const status = useEditorStore((state) => state.status);
  const project = useEditorStore((state) => state.project);
  const pageRelPath = useEditorStore((state) => state.pageRelPath);
  const applyExternalChange = useEditorStore((state) => state.applyExternalChange);
  const closeProject = useEditorStore((state) => state.closeProject);
  const setAssets = useEditorStore((state) => state.setAssets);
  const setProjectInfo = useEditorStore((state) => state.setProjectInfo);
  const loadSnapshot = useEditorStore((state) => state.loadSnapshot);

  const leftPanel = useUiStore((state) => state.leftPanel);
  const setLeftPanel = useUiStore((state) => state.setLeftPanel);
  const canvasMode = useUiStore((state) => state.canvasMode);
  const previewVisible = useUiStore((state) => state.previewVisible);
  // "Przeglądanie" already replaces the main work area with the same live
  // preview the toolbar's own "Podgląd" toggle opens as a side panel - showing
  // both at once would be two components fighting over one underlying native
  // view (previewService manages exactly one WebContentsView).
  const showSidePreview = previewVisible && canvasMode !== 'preview';
  const consoleVisible = useUiStore((state) => state.consoleVisible);
  const shortcutsVisible = useUiStore((state) => state.shortcutsVisible);
  const toggleShortcuts = useUiStore((state) => state.toggleShortcuts);
  const newProjectDialogVisible = useUiStore((state) => state.newProjectDialogVisible);
  const closeNewProjectDialog = useUiStore((state) => state.closeNewProjectDialog);
  const newPageDialogVisible = useUiStore((state) => state.newPageDialogVisible);
  const closeNewPageDialog = useUiStore((state) => state.closeNewPageDialog);
  const aiToolsDialogVisible = useUiStore((state) => state.aiToolsDialogVisible);
  const closeAiToolsDialog = useUiStore((state) => state.closeAiToolsDialog);
  const appendLog = useUiStore((state) => state.appendLog);
  const setUpdate = useUiStore((state) => state.setUpdate);

  useCommands();

  /* Bridge subscriptions. */
  useEffect(() => {
    const offFileChange = window.litho.onFileChange((event) => {
      applyExternalChange(event);
      // A non-text file appearing, changing or vanishing means the asset list
      // is stale - deletions included, or removed images would linger in the panel.
      if (event.content === null) {
        void window.litho.assets.list().then((result) => {
          if (result.ok) setAssets(result.value);
        });
      }
      // An HTML file appearing or vanishing changes the page list; re-scan it so
      // the page switcher reflects what is actually in the folder.
      if ((event.type === 'add' || event.type === 'unlink') && /\.html?$/iu.test(event.relPath)) {
        void window.litho.project.refresh().then((result) => {
          if (result.ok) setProjectInfo(result.value);
        });
      }
    });
    const offClosed = window.litho.onProjectClosed(() => closeProject());
    const offLog = window.litho.onLogEntry((entry) => appendLog(entry));

    return () => {
      offFileChange();
      offClosed();
      offLog();
    };
  }, [applyExternalChange, appendLog, closeProject, setAssets, setProjectInfo]);

  /* Never lose the last debounced edit when the window goes away. */
  useEffect(() => {
    const flush = (): void => {
      void useEditorStore.getState().flushSave();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('blur', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('blur', flush);
    };
  }, []);

  useEffect(() => {
    logger.info('Interfejs Litho Studio gotowy');
  }, []);

  /*
   * With no project open there is nothing the live preview may show, so it is
   * told to stand down from here as well as from `PreviewPane`'s own unmount.
   *
   * Belt and braces, deliberately. The preview is a native `WebContentsView`
   * composited above this document, so when it fails to go away it is not
   * merely a stale panel - it is a page drawn over the start screen that no
   * amount of DOM can cover, and the user has to click their way back into a
   * project to be rid of it. Two independent paths to "hidden" is a cheap price
   * for never landing in that state; both are idempotent (see `hide()` in
   * previewService.ts).
   */
  useEffect(() => {
    if (project) return;
    void window.litho.preview.hide();
  }, [project]);

  /*
   * One update check per launch, exactly as asked for: every time the app is
   * opened, provided there is a network to ask over.
   *
   * Fire-and-forget on purpose - nothing in the editor waits on it, and the
   * main process resolves an unreachable server to "nothing newer known"
   * rather than an error, so being offline costs the user no dialog, no toast
   * and no delay. See `updateService.ts`.
   */
  useEffect(() => {
    void window.litho.update.check().then((result) => {
      if (!result.ok) {
        logger.warn(`Nie udało się sprawdzić aktualizacji: ${result.message}`);
        return;
      }
      setUpdate(result.value);
      if (result.value.updateAvailable) {
        logger.info(`Dostępna aktualizacja: ${result.value.latest} (masz ${result.value.current})`);
      }
    });
  }, [setUpdate]);

  const newProjectDialog = newProjectDialogVisible ? (
    <NewProjectDialog
      onCancel={closeNewProjectDialog}
      onCreated={(snapshot) => {
        closeNewProjectDialog();
        loadSnapshot(snapshot);
      }}
    />
  ) : null;

  const newPageDialog = newPageDialogVisible ? (
    <NewPageDialog
      onCancel={closeNewPageDialog}
      onCreated={(snapshot, relPath) => {
        closeNewPageDialog();
        loadSnapshot(snapshot, relPath);
      }}
    />
  ) : null;

  /* Reachable with and without a project open - installing a CLI has nothing to
     do with which page is being edited. */
  const aiToolsDialog = aiToolsDialogVisible ? <AiToolsDialog onClose={closeAiToolsDialog} /> : null;

  if (!project || status === 'empty') {
    return (
      <div className="app-shell">
        <UpdateBanner />
        <UpdateDialog />
        <StartScreen />
        {newProjectDialog}
        {aiToolsDialog}
        {shortcutsVisible ? <ShortcutsDialog onClose={toggleShortcuts} /> : null}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <UpdateBanner />
      <UpdateDialog />
      <div className="app">
        <Toolbar />

        <div className={`app__body${showSidePreview ? ' app__body--with-preview' : ''}`}>
          <aside className="panel" aria-label="Panele narzędziowe">
            <div className="panel__tabs" role="tablist">
              {LEFT_PANELS.map(([id, label, icon]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  className="panel__tab"
                  aria-selected={leftPanel === id}
                  title={label}
                  onClick={() => setLeftPanel(id)}
                >
                  <Icon name={icon} size={17} />
                  <span className="panel__tab-label">{label}</span>
                </button>
              ))}
            </div>

            <ErrorBoundary fallbackTitle="Panel narzędziowy napotkał błąd">
              <Suspense fallback={<PanelFallback />}>
                {leftPanel === 'elements' ? <ElementsPanel /> : null}
                {leftPanel === 'components' ? <ComponentsPanel /> : null}
                {leftPanel === 'icons' ? <IconsPanel /> : null}
                {leftPanel === 'styles' ? <StylesPanel /> : null}
                {leftPanel === 'layers' ? <LayersPanel /> : null}
                {leftPanel === 'assets' ? <AssetsPanel /> : null}
                {leftPanel === 'audit' ? <AuditPanel /> : null}
              </Suspense>
            </ErrorBoundary>
          </aside>

          {/*
           * The bars span the work area *and* the preview beside it, rather than
           * sitting inside the editor column.
           *
           * Everything they carry - the breakpoint, the browse/edit mode, the
           * out-of-layout warning - describes both halves equally, and putting
           * them over only one half also made that half start ~40 px lower than
           * the other: side by side, the editor showed a visibly shorter slice of
           * the same page than the preview did.
           */}
          <div className="app__bars">
            <BreakpointBar />
            <ErrorBoundary fallbackTitle="Pasek naprawy odwołań napotkał błąd">
              <MissingRefsBanner />
            </ErrorBoundary>
            <ErrorBoundary fallbackTitle="Pasek ostrzeżeń napotkał błąd">
              <PageNoticesBanner />
            </ErrorBoundary>
          </div>

          <main className="app__main">
            {/*
             * Only when the preview is beside it, and that is the whole point:
             * the preview pane carries a 36 px toolbar of its own, so without a
             * matching strip here the edited page started 36 px lower than the
             * previewed one and the two halves were visibly out of step. It
             * doubles as the label the editing half never had - with both panes
             * showing the same file, saying which is which is worth the row.
             */}
            {showSidePreview ? (
              <div className="canvas__titlebar">
                <Icon name="edit" size={15} />
                Edycja: {pageRelPath ?? '-'}
              </div>
            ) : null}

            {canvasMode === 'preview' ? (
              // The real page, loaded and navigable exactly as a browser would -
              // internal links move between the project's own pages, external
              // ones open in the user's system browser, and anything pointing
              // outside the project folder is blocked with a visible error
              // (see previewService.ts's `guardNavigation`). This is deliberately
              // *not* the editable canvas with affordances hidden: "Przeglądanie"
              // means what it says.
              <ErrorBoundary fallbackTitle="Podgląd napotkał błąd">
                <PreviewPane />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary fallbackTitle="Obszar edycji napotkał błąd">
                <Canvas />
              </ErrorBoundary>
            )}
          </main>

          {showSidePreview ? (
            <ErrorBoundary fallbackTitle="Podgląd napotkał błąd">
              <PreviewPane />
            </ErrorBoundary>
          ) : null}

          <aside className="panel panel--right" aria-label="Właściwości">
            <div className="panel__header">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Icon name="tune" size={15} />
                Właściwości
              </span>
            </div>
            <ErrorBoundary fallbackTitle="Panel właściwości napotkał błąd">
              <PropertiesPanel />
            </ErrorBoundary>
          </aside>
        </div>

        <ErrorBoundary fallbackTitle="Terminal napotkał błąd">
          <Suspense fallback={null}>
            <TerminalPanel />
          </Suspense>
        </ErrorBoundary>

        {consoleVisible ? (
          <ErrorBoundary fallbackTitle="Panel logów napotkał błąd">
            <ConsolePanel />
          </ErrorBoundary>
        ) : (
          <div />
        )}

        <StatusBar />
      </div>

      {shortcutsVisible ? <ShortcutsDialog onClose={toggleShortcuts} /> : null}
      {newProjectDialog}
      {newPageDialog}
      {aiToolsDialog}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="dialog__title" id="shortcuts-title">
          <Icon name="keyboard" size={20} />
          Skróty klawiszowe
        </h2>
        <p className="dialog__hint">Na macOS zamiast Ctrl używaj Cmd.</p>

        <dl className="shortcuts__list">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} style={{ display: 'contents' }}>
              <dt>{shortcut.description}</dt>
              <dd>{shortcut.keys}</dd>
            </div>
          ))}
        </dl>

        <div className="dialog__actions">
          <button type="button" className="button button--primary" onClick={onClose}>
            Zamknij
          </button>
        </div>
      </div>
    </div>
  );
}
