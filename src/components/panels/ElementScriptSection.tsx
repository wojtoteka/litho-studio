import { useMemo, useState } from 'react';
import { useEditorStore, type ScriptTargetInfo } from '@/state/editorStore.js';
import { useUiStore } from '@/state/uiStore.js';
import { findElement, textContent, type NodeId } from '@shared/document.js';
import {
  defaultParamsFor,
  ELEMENT_SCRIPT_PRESETS,
  findPreset,
  type ScriptParam,
} from '@/engine/elementScripts.js';
import { Icon } from '../Icon.js';

/**
 * "Skrypt / Funkcja dynamiczna" — the properties-panel section that attaches
 * behaviour to one element.
 *
 * The user picks a ready-made function (current date, countdown, a name taken
 * from the URL) or writes a few lines of JavaScript, and Litho writes real code
 * into the page's own script file. Nothing is stored in a Litho-specific
 * format: the binding shown here is read back out of that generated code, so
 * closing and re-opening the project — or editing the file in VS Code — keeps
 * the panel and the page in agreement.
 *
 * Changes commit on an explicit button rather than per keystroke: every apply
 * rewrites the project's JavaScript file, which is not something to do sixty
 * times while someone types a date into a field.
 */
export function ElementScriptSection({ nodeId }: { nodeId: NodeId }): JSX.Element {
  const elementScriptState = useEditorStore((state) => state.elementScriptState);
  const scriptTarget = useEditorStore((state) => state.scriptTarget);
  const setElementScript = useEditorStore((state) => state.setElementScript);
  const removeElementScript = useEditorStore((state) => state.removeElementScript);
  const revision = useEditorStore((state) => state.revision);

  const status = useMemo(
    () => elementScriptState(nodeId),
    // The tree mutates in place, so `revision` is what signals a change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elementScriptState, nodeId, revision],
  );
  const target = useMemo(
    () => scriptTarget(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scriptTarget, revision],
  );
  const elementText = useMemo(
    () => {
      const doc = useEditorStore.getState().document;
      const element = doc ? findElement(doc.root, nodeId) : null;
      return element ? textContent(element).trim() : '';
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, revision],
  );
  const binding = status.binding;

  const [presetId, setPresetId] = useState(() => binding?.presetId ?? ELEMENT_SCRIPT_PRESETS[0]!.id);
  const [params, setParams] = useState<Record<string, string>>(() => {
    const preset = findPreset(binding?.presetId ?? '') ?? ELEMENT_SCRIPT_PRESETS[0]!;
    return { ...defaultParamsFor(preset), ...(binding?.params ?? {}) };
  });
  const [justApplied, setJustApplied] = useState(false);

  const preset = findPreset(presetId) ?? ELEMENT_SCRIPT_PRESETS[0]!;
  // Live output, recomputed on every keystroke — the only feedback the editor
  // can give, since the canvas iframe runs no scripts (see `ScriptPreview`).
  const preview = useMemo(() => preset.preview(params, elementText), [preset, params, elementText]);

  const choosePreset = (nextId: string): void => {
    const next = findPreset(nextId);
    setPresetId(nextId);
    setJustApplied(false);
    if (!next) return;
    // Switching back to the preset that is actually on the page restores its
    // saved values rather than resetting to the generic defaults.
    const saved = binding !== null && binding.presetId === nextId ? binding.params : {};
    setParams({ ...defaultParamsFor(next), ...saved });
  };

  const apply = (): void => {
    setElementScript(nodeId, { presetId, params });
    setJustApplied(true);
  };

  return (
    <div className="script-section">
      <p className="dialog__hint script-section__status">
        {binding !== null ? (
          <>
            Przypisano: <strong>{findPreset(binding.presetId)?.label ?? binding.presetId}</strong>
          </>
        ) : (
          'Ten element nie ma jeszcze skryptu.'
        )}
      </p>

      {status.unrecognized ? (
        <p className="script-section__warning" role="status">
          <Icon name="warning" size={15} />
          <span>
            Ten element ma już skrypt, którego panel nie potrafi odczytać (prawdopodobnie zmieniony ręcznie w
            pliku). Zastosowanie funkcji poniżej <strong>zastąpi</strong> tamten kod.
          </span>
        </p>
      ) : null}

      {status.inlineHandlers.length > 0 ? (
        <p className="script-section__warning" role="status">
          <Icon name="warning" size={15} />
          <span>
            Element ma własną obsługę zdarzeń w HTML ({status.inlineHandlers.join(', ')}). Skrypt z panelu
            działa niezależnie i jej nie usuwa.
          </span>
        </p>
      ) : null}

      <label className="field">
        <span className="field__label">Gotowa funkcja</span>
        <select className="select" value={presetId} onChange={(event) => choosePreset(event.target.value)}>
          {ELEMENT_SCRIPT_PRESETS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <p className="dialog__hint">{preset.hint}</p>

      {preset.params.map((param) => (
        <ParamField
          key={`${presetId}:${param.name}`}
          param={param}
          value={params[param.name] ?? param.default}
          onChange={(value) => {
            setJustApplied(false);
            setParams((current) => ({ ...current, [param.name]: value }));
          }}
        />
      ))}

      {preview ? (
        <div className="script-preview">
          <span className="script-preview__label">Podgląd wyniku</span>
          <span className="script-preview__value">{preview.text || '—'}</span>
          {preview.note ? <span className="script-preview__note">{preview.note}</span> : null}
        </div>
      ) : (
        <p className="dialog__hint">
          Podglądu nie da się pokazać dla własnego kodu — uruchom stronę w <strong>Podglądzie</strong>, aby
          zobaczyć wynik.
        </p>
      )}

      <div className="script-section__actions">
        <button type="button" className="button button--primary" onClick={apply}>
          <Icon name="bolt" size={15} />
          {binding !== null ? 'Zaktualizuj skrypt' : 'Zastosuj skrypt'}
        </button>
        {binding !== null ? (
          <button type="button" className="button button--ghost" onClick={() => removeElementScript(nodeId)}>
            <Icon name="delete" size={15} />
            Usuń skrypt
          </button>
        ) : null}
      </div>

      {justApplied ? <ApplyConfirmation onOpenPreview={() => setJustApplied(false)} /> : null}

      {target ? (
        <p className="dialog__hint">
          {describeTarget(target)} Kod dopisywany jest w wydzielonej sekcji na końcu — nic, co już tam jest,
          nie zostanie zmienione.
        </p>
      ) : null}

      <p className="dialog__hint">
        Po zapisaniu tekst elementu w obszarze edycji zmieni się na powyższy podgląd — obszar edycji nie
        uruchamia skryptów strony, więc to statyczny zapis, nie żywy efekt. Pełny efekt (animacje,
        odświeżanie) zobaczysz w <strong>Podglądzie</strong> lub po otwarciu strony w przeglądarce. Element
        dostanie własny identyfikator (id).
      </p>
    </div>
  );
}

/**
 * Confirms the save happened and offers the one place the effect is actually
 * visible. Shown briefly, because the effect is silent everywhere in the editor
 * except the live preview — without this, applying a script looks like a no-op.
 */
function ApplyConfirmation({ onOpenPreview }: { onOpenPreview: () => void }): JSX.Element {
  const previewVisible = useUiStore((state) => state.previewVisible);
  const togglePreview = useUiStore((state) => state.togglePreview);

  const open = async (): Promise<void> => {
    // Land the debounced write first so the preview loads the new code, not the
    // page as it was a moment ago.
    await useEditorStore.getState().flushSave();
    if (!previewVisible) togglePreview();
    onOpenPreview();
  };

  return (
    <div className="script-section__applied" role="status">
      <span>
        <Icon name="check_circle" size={16} />
        Zapisano — efekt działa na stronie.
      </span>
      <button type="button" className="button button--ghost" onClick={() => void open()}>
        <Icon name="visibility" size={15} />
        Pokaż w podglądzie
      </button>
    </div>
  );
}

/**
 * Says out loud where the code will land. A page that already has a script
 * keeps it — the editor adapts to the project's layout instead of imposing a
 * `script.js` on every project — and showing which file that is spares the user
 * from hunting for the generated code afterwards.
 */
function describeTarget(target: ScriptTargetInfo): string {
  if (target.kind === 'external') return `Kod trafi do istniejącego pliku strony: ${target.label}.`;
  if (target.kind === 'embedded') return `Strona trzyma JavaScript wewnątrz ${target.label} — kod trafi tam.`;
  return `Strona nie ma jeszcze pliku JavaScript — zostanie utworzony ${target.label}.`;
}

function ParamField({
  param,
  value,
  onChange,
}: {
  param: ScriptParam;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const control =
    param.type === 'select' ? (
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        {(param.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ) : param.type === 'code' ? (
      <textarea
        className="textarea textarea--code"
        rows={6}
        spellCheck={false}
        value={value}
        placeholder={param.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : (
      <input
        className="input"
        type={
          param.type === 'number' ? 'number' : param.type === 'datetime-local' ? 'datetime-local' : 'text'
        }
        value={value}
        placeholder={param.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );

  return (
    <label className="field">
      <span className="field__label">{param.label}</span>
      {control}
      {param.hint ? <span className="field__hint">{param.hint}</span> : null}
    </label>
  );
}
