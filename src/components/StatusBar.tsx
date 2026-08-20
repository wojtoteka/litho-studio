import { useEditorStore } from '@/state/editorStore.js';
import { classifyElement, ELEMENT_KIND_LABELS, findElement } from '@shared/document.js';
import { Icon } from './Icon.js';

/**
 * The bar along the bottom of the shell.
 *
 * It answers the three questions the rest of the chrome deliberately does not:
 * *which folder on disk am I actually editing*, *what exactly is selected right
 * now*, and *how big is this project*. All three were previously only
 * derivable — the project's path appeared once in the "open recent" list and
 * then never again, and a multi-element selection was visible only as several
 * outlines on the canvas, with no count.
 *
 * Nothing here is interactive. A status bar that can be clicked becomes a
 * second toolbar the eye has to police; this one is a readout, and it stays out
 * of the tab order entirely.
 */
export function StatusBar(): JSX.Element | null {
  const project = useEditorStore((state) => state.project);
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);

  if (!project) return null;

  return (
    <footer className="statusbar">
      <span className="statusbar__item statusbar__item--path" title={project.rootPath}>
        <Icon name="folder" size={14} />
        <strong>{project.name}</strong>
        <span className="statusbar__dim">{project.rootPath}</span>
      </span>

      <span className="statusbar__spacer" />

      <span className="statusbar__item" title="Zaznaczenie">
        <Icon name="select_all" size={14} />
        {describeSelection(document, selection)}
      </span>

      <span className="statusbar__divider" />

      <span className="statusbar__item" title="Liczba podstron w projekcie">
        <Icon name="description" size={14} />
        {project.pages.length} {pluralPages(project.pages.length)}
      </span>

      <span className="statusbar__divider" />

      <span className="statusbar__item statusbar__dim" title="Wersja aplikacji">
        v{window.litho.appVersion}
      </span>
    </footer>
  );
}

/**
 * One element gets named — its kind and tag, the same wording the canvas label
 * and the properties breadcrumb use — because at that point the user is asking
 * "what am I about to change". Several get counted instead: eleven names would
 * not fit and would not help.
 */
function describeSelection(
  document: ReturnType<typeof useEditorStore.getState>['document'],
  selection: readonly string[],
): string {
  if (selection.length === 0) return 'nic nie zaznaczono';
  if (selection.length > 1) return `${selection.length} ${pluralElements(selection.length)}`;

  const element = document ? findElement(document.root, selection[0]!) : null;
  if (!element) return '1 element';
  return `${ELEMENT_KIND_LABELS[classifyElement(element)]} · ${element.tag}`;
}

/* Polish counts three ways, and "2 stron" reads as broken to a native speaker. */
function pluralPages(count: number): string {
  return count === 1 ? 'podstrona' : isFewForm(count) ? 'podstrony' : 'podstron';
}

function pluralElements(count: number): string {
  return isFewForm(count) ? 'elementy' : 'elementów';
}

/** The "2–4" ending, which also applies to 22–24, 32–34 … but never to 12–14. */
function isFewForm(count: number): boolean {
  const last = count % 10;
  const lastTwo = count % 100;
  return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14);
}
