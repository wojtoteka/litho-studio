import { ELEMENT_TEMPLATES, type ElementTemplate } from '@/lib/elementFactory.js';
import { setDragPayload } from '@/lib/dragPayload.js';
import { useEditorStore } from '@/state/editorStore.js';
import { resolveInsertionTarget } from '@/lib/insertionTarget.js';
import { Icon } from '../Icon.js';

/**
 * The element palette.
 *
 * Items are draggable onto the canvas and also insertable with a click, which
 * keeps the editor usable without a pointer — dragging is the only interaction
 * in the app that a keyboard cannot reproduce, so every drag source needs a
 * click equivalent.
 */

const GROUP_LABELS: Record<ElementTemplate['group'], string> = {
  basic: 'Podstawowe',
  media: 'Media',
  form: 'Formularz',
};

export function ElementsPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const insertTemplate = useEditorStore((state) => state.insertTemplate);

  const insert = (template: ElementTemplate): void => {
    if (!document) return;
    const target = resolveInsertionTarget(document, selection);
    if (!target) return;
    insertTemplate(
      { node: template.build(), css: template.css, scripts: template.scripts },
      target,
      `Dodanie: ${template.label}`,
    );
  };

  const groups: ElementTemplate['group'][] = ['basic', 'media', 'form'];

  return (
    <div className="panel__body">
      {groups.map((group) => (
        <section key={group} className="palette__group">
          <h3 className="palette__group-title">{GROUP_LABELS[group]}</h3>
          <div className="palette">
            {ELEMENT_TEMPLATES.filter((template) => template.group === group).map((template) => (
              <button
                key={template.id}
                type="button"
                className="palette__item"
                draggable
                onDragStart={(event) => setDragPayload(event, { kind: 'element', templateId: template.id })}
                onClick={() => insert(template)}
                title={`${template.label} — przeciągnij na stronę lub kliknij, aby wstawić`}
              >
                <span className="palette__icon">
                  <Icon name={template.icon} size={17} />
                </span>
                {template.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
