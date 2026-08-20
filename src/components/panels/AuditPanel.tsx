import { useMemo } from 'react';
import { useEditorStore } from '@/state/editorStore.js';
import { auditPage, type AuditFinding } from '@/engine/pageAudit.js';
import { Icon } from '../Icon.js';

/**
 * "Sprawdź stronę" — the checklist a developer runs before publishing, for
 * someone who does not know it exists.
 *
 * Everything listed here is invisible on the canvas by definition: the page
 * looks finished, and is broken for a screen reader, a search engine or anyone
 * who clicks a link. Each row is clickable and selects the element it is about,
 * so the distance from "something is wrong" to "I am editing the thing that is
 * wrong" is one click.
 *
 * The empty state matters as much as the findings: a check that never says
 * "this is fine" gives no reason to trust it when it does complain.
 */
export function AuditPanel(): JSX.Element {
  const document = useEditorStore((state) => state.document);
  const project = useEditorStore((state) => state.project);
  const files = useEditorStore((state) => state.files);
  const select = useEditorStore((state) => state.select);
  const revision = useEditorStore((state) => state.revision);
  const structureRevision = useEditorStore((state) => state.structureRevision);

  const findings = useMemo(() => {
    if (!document) return [];
    return auditPage({
      document,
      pages: project?.pages.map((page) => page.relPath) ?? [],
      files: Object.keys(files),
    });
    // The tree mutates in place, so the revisions — not the object identity —
    // are what say "re-check". See the same pattern in Canvas.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document, project, files, revision, structureRevision]);

  if (!document) {
    return (
      <div className="props__empty">
        <Icon name="help" size={30} />
        Otwórz stronę, aby ją sprawdzić.
      </div>
    );
  }

  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.length - errors;

  return (
    <div className="panel__body">
      <div className="audit__summary">
        {findings.length === 0 ? (
          <p className="audit__clear">
            <Icon name="check_circle" size={18} />
            Nie znaleziono problemów. Strona jest gotowa do opublikowania.
          </p>
        ) : (
          <p className="audit__counts">
            {errors > 0 ? (
              <span className="audit__count audit__count--error">
                <Icon name="error" size={15} />
                {errors} do poprawy
              </span>
            ) : null}
            {warnings > 0 ? (
              <span className="audit__count audit__count--warning">
                <Icon name="warning" size={15} />
                {warnings} do sprawdzenia
              </span>
            ) : null}
          </p>
        )}
      </div>

      {findings.map((finding, index) => (
        <AuditRow
          key={`${finding.rule}:${finding.nodeId ?? index}`}
          finding={finding}
          onSelect={() => finding.nodeId && select([finding.nodeId])}
        />
      ))}
    </div>
  );
}

function AuditRow({ finding, onSelect }: { finding: AuditFinding; onSelect: () => void }): JSX.Element {
  const selectable = finding.nodeId !== null;
  const Row = selectable ? 'button' : 'div';

  return (
    <Row
      {...(selectable ? { type: 'button' as const, onClick: onSelect } : {})}
      className={`audit__item audit__item--${finding.severity}${selectable ? ' audit__item--clickable' : ''}`}
      title={selectable ? 'Kliknij, aby zaznaczyć ten element na stronie' : undefined}
    >
      <Icon name={finding.severity === 'error' ? 'error' : 'warning'} size={15} />
      <span className="audit__text">
        <span className="audit__message">{finding.message}</span>
        <span className="audit__hint">{finding.hint}</span>
      </span>
    </Row>
  );
}
