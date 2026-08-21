import { useCallback, useState } from 'react';
import { useEditorStore, isImageAsset, isAudioAsset } from '@/state/editorStore.js';
import { setDragPayload } from '@/lib/dragPayload.js';
import { toAssetUrl } from '@/lib/canvasDocument.js';
import { logger } from '@/lib/logger.js';
import { importCssFiles, isCssFile, StyleSheetsSection } from './StyleSheetsSection.js';
import { Icon } from '../Icon.js';

/**
 * Asset manager.
 *
 * Files dropped here are copied into the project's own `assets/` folder, never
 * merely referenced from wherever they happened to live - the folder has to
 * stay uploadable to any host as-is.
 *
 * Stylesheets are the one kind of drop that does *not* go to `assets/`: a
 * `.css` is not something a page embeds, it is something a page links, so it
 * is handed to `StyleSheetsSection`'s importer, which puts it next to the
 * project's other CSS and wires it into the open page.
 */
export function AssetsPanel(): JSX.Element {
  const assets = useEditorStore((state) => state.assets);
  const project = useEditorStore((state) => state.project);
  const setAssets = useEditorStore((state) => state.setAssets);

  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFiles = useCallback(
    async (files: FileList): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const dropped = Array.from(files);

        // A dropped stylesheet is linked to the page, not copied into assets/.
        const stylesheets = dropped.filter(isCssFile);
        if (stylesheets.length > 0) {
          const problems = await importCssFiles(stylesheets);
          if (problems.length > 0) setError(problems.join(' · '));
        }

        for (const file of dropped.filter((entry) => !isCssFile(entry))) {
          const buffer = new Uint8Array(await file.arrayBuffer());
          const result = await window.litho.assets.importBuffer(file.name, buffer);
          if (!result.ok) {
            setError(result.message);
            logger.warn(`Nie zaimportowano ${file.name}: ${result.message}`);
          }
        }
        const listed = await window.litho.assets.list();
        if (listed.ok) setAssets(listed.value);
      } catch (importError) {
        logger.error('Import zasobów nie powiódł się', importError);
        setError('Nie udało się zaimportować plików.');
      } finally {
        setBusy(false);
      }
    },
    [setAssets],
  );

  const pickFiles = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await window.litho.assets.pickDialog();
    if (result.ok) setAssets(result.value);
    else if (result.code !== 'CANCELLED') setError(result.message);
    setBusy(false);
  }, [setAssets]);

  const remove = useCallback(
    async (relPath: string): Promise<void> => {
      const result = await window.litho.assets.delete(relPath);
      if (result.ok) setAssets(result.value);
      else setError(result.message);
    },
    [setAssets],
  );

  return (
    <div className="panel__body">
      <div
        className={`dropzone${dragActive ? ' dropzone--active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (event.dataTransfer.files.length > 0) void importFiles(event.dataTransfer.files);
        }}
      >
        <Icon name="upload_file" size={22} />
        <span>Przeciągnij tu obrazy, pliki audio lub pliki CSS</span>
        <button type="button" className="button" onClick={() => void pickFiles()} disabled={busy}>
          <Icon name="folder_open" size={15} />
          Wybierz pliki…
        </button>
      </div>

      {error ? (
        <p className="dialog__hint" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}

      {assets.length === 0 ? (
        <p className="dialog__hint">Brak zasobów. Dodane pliki trafiają do folderu assets/ w projekcie.</p>
      ) : (
        <div className="assets">
          {assets.map((asset) => (
            <div
              key={asset.relPath}
              className="asset-card"
              draggable
              onDragStart={(event) =>
                setDragPayload(event, {
                  kind: 'asset',
                  relPath: asset.relPath,
                  width: asset.width,
                  height: asset.height,
                })
              }
              title={`${asset.relPath} · ${formatSize(asset.size)}`}
            >
              {isImageAsset(asset.relPath) && project ? (
                <img className="asset-card__thumb" src={toAssetUrl(asset.relPath)} alt="" loading="lazy" />
              ) : isAudioAsset(asset.relPath) ? (
                <div className="asset-card__thumb asset-card__thumb--audio">
                  <Icon name="music_note" size={26} />
                </div>
              ) : (
                <div className="asset-card__thumb asset-card__thumb--file">
                  <Icon name="draft" size={26} />
                </div>
              )}
              <span className="asset-card__name">{asset.name}</span>
              <button
                type="button"
                className="asset-card__remove"
                onClick={() => void remove(asset.relPath)}
                aria-label={`Usuń ${asset.name}`}
                title={`Usuń ${asset.name}`}
              >
                <Icon name="delete" size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      <h3 className="panel__subheader">
        <Icon name="style" size={14} />
        Style (CSS)
      </h3>
      <StyleSheetsSection />
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
