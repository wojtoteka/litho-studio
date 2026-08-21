import { create } from 'zustand';
import { AI_TOOLS, type AiToolId, type AiToolStatus } from '@shared/aiTools.js';
import { logger } from '@/lib/logger.js';

/**
 * State of the AI tool installer.
 *
 * A store rather than component state, for one reason that matters: an
 * `npm install -g` runs for tens of seconds, and the user is free to close the
 * dialog while it does. The install itself lives in the main process and carries
 * on regardless - so if the progress lived in the dialog, reopening it would show
 * "Zainstaluj" next to a tool that was in the middle of installing, and the
 * output would be gone. Holding it here means the dialog is a view onto work in
 * progress rather than the owner of it.
 *
 * The bridge subscription is likewise module-level and permanent: a listener that
 * came and went with the dialog would drop exactly the chunks that arrived while
 * it was shut.
 */

type ToolMap<T> = Partial<Record<AiToolId, T>>;

interface AiToolsState {
  /** `null` until asked. False on any platform but Windows - see `AI_TOOLS_PLATFORM`. */
  supported: boolean | null;
  /** `null` until the first detection completes. */
  statuses: ToolMap<AiToolStatus> | null;
  detecting: boolean;
  installing: ToolMap<true>;
  /** Accumulated stdout/stderr per tool, for the output pane. */
  output: ToolMap<string>;
  /** Last failure per tool, cleared when a new install starts. */
  errors: ToolMap<string>;
  /** Whose output the pane is showing. */
  activeTool: AiToolId | null;

  /** Asks whether the platform supports the installer, then detects. Safe to call repeatedly. */
  initialise(): Promise<void>;
  refresh(): Promise<void>;
  install(id: AiToolId): Promise<void>;
  cancel(id: AiToolId): Promise<void>;
  select(id: AiToolId): void;
}

export const useAiToolsStore = create<AiToolsState>((set, get) => ({
  supported: null,
  statuses: null,
  detecting: false,
  installing: {},
  output: {},
  errors: {},
  activeTool: null,

  initialise: async () => {
    ensureSubscribed();
    if (get().supported === null) {
      const result = await window.litho.aiTools.supported();
      set({ supported: result.ok ? result.value : false });
    }
    if (get().supported === true && get().statuses === null) await get().refresh();
  },

  refresh: async () => {
    if (get().detecting) return;
    set({ detecting: true });
    const result = await window.litho.aiTools.detect();
    if (!result.ok) {
      set({ detecting: false });
      logger.warn(`Nie udało się sprawdzić narzędzi AI: ${result.message}`);
      return;
    }
    const statuses: ToolMap<AiToolStatus> = {};
    for (const status of result.value) statuses[status.id] = status;
    set({ statuses, detecting: false });
  },

  install: async (id) => {
    if (get().installing[id]) return;
    // Optimistically mark it running and clear the previous attempt's noise, so
    // the row reacts on the click rather than after the IPC round trip.
    set((state) => ({
      installing: { ...state.installing, [id]: true },
      errors: { ...state.errors, [id]: undefined },
      output: { ...state.output, [id]: '' },
      activeTool: id,
    }));

    const result = await window.litho.aiTools.install(id);
    if (result.ok) return;

    // Refused before anything started - no `done` event will arrive, so the
    // optimistic flag has to be taken back here.
    set((state) => ({
      installing: { ...state.installing, [id]: undefined },
      errors: { ...state.errors, [id]: result.message },
    }));
    logger.warn(`Instalacja ${id} nie wystartowała: ${result.message}`);
  },

  cancel: async (id) => {
    const result = await window.litho.aiTools.cancel(id);
    if (!result.ok) logger.warn(`Nie udało się przerwać instalacji: ${result.message}`);
  },

  select: (id) => set({ activeTool: id }),
}));

/* ------------------------------------------------------------------ */

let subscribed = false;

/**
 * Attaches the two bridge listeners exactly once.
 *
 * Not done at module load: this module is imported by the dialog, which is
 * itself only reachable on Windows, but importing a module must not be what
 * decides whether IPC listeners exist. Called from `initialise`, which is the
 * point at which the feature is genuinely in use.
 */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;

  window.litho.onAiToolOutput(({ id, chunk }) => {
    useAiToolsStore.setState((state) => ({
      output: { ...state.output, [id]: (state.output[id] ?? '') + chunk },
    }));
  });

  window.litho.onAiToolDone(({ id, ok, message }) => {
    useAiToolsStore.setState((state) => ({
      installing: { ...state.installing, [id]: undefined },
      errors: { ...state.errors, [id]: ok ? undefined : (message ?? 'Instalacja nie powiodła się.') },
    }));

    const name = AI_TOOLS.find((tool) => tool.id === id)?.name ?? id;
    if (ok) logger.info(`Zainstalowano ${name}`);
    else logger.warn(`Instalacja ${name} nie powiodła się: ${message ?? 'nieznany błąd'}`);

    // The whole point of the operation was to change what is on PATH, so the
    // row's status is stale the moment it finishes - successfully or not.
    void useAiToolsStore.getState().refresh();
  });
}
