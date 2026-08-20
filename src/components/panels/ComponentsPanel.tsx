import { COMPONENT_TEMPLATES, type ComponentTemplate } from '@/lib/elementFactory.js';
import { setDragPayload } from '@/lib/dragPayload.js';
import { useEditorStore } from '@/state/editorStore.js';
import { resolveInsertionTarget } from '@/lib/insertionTarget.js';
import { Icon } from '../Icon.js';

/**
 * Component library.
 *
 * These are compositions of ordinary elements, not a component system: dropping
 * a navbar inserts a `<header>` with links, and the user can immediately delete
 * a link or restyle the whole thing. Nothing in the output hints that it came
 * from a library, which is a direct consequence of the "the project is just a
 * website" rule.
 */
export function ComponentsPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const insertTemplate = useEditorStore((state) => state.insertTemplate);

  const insert = (template: ComponentTemplate): void => {
    if (!document) return;
    const target = resolveInsertionTarget(document, selection);
    if (!target) return;
    insertTemplate(
      { node: template.build(), css: template.css, scripts: template.scripts },
      target,
      `Dodanie: ${template.name}`,
    );
  };

  return (
    <div className="panel__body">
      {COMPONENT_TEMPLATES.map((template) => (
        <button
          key={template.id}
          type="button"
          className="component-card"
          draggable
          onDragStart={(event) => setDragPayload(event, { kind: 'component', templateId: template.id })}
          onClick={() => insert(template)}
        >
          <span className="component-card__icon">
            <Icon name={template.icon} size={18} />
          </span>
          <span className="component-card__text">
            <span className="component-card__name">{template.name}</span>
            <span className="component-card__hint">{template.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
