import { create } from 'zustand';

/**
 * Undo/redo.
 *
 * Implemented as a command stack whose commands carry *mementos* — an immutable
 * snapshot of the affected state before and after the change. Storing closures
 * that recompute an inverse operation is the textbook alternative, but every
 * such inverse is a second implementation of the edit that can drift from the
 * forward one; snapshots cannot drift, and for a document of this size the
 * memory cost is irrelevant (a full page snapshot is tens of kilobytes, and the
 * stack is capped).
 *
 * Consecutive edits of the same kind to the same target are coalesced, so
 * dragging an element produces one undo step rather than sixty.
 */

export interface HistorySnapshot {
  /** Serialised page document. */
  document: string;
  /** Stylesheet text keyed by source id. */
  styles: Record<string, string>;
  /** Managed script state keyed by relative path. */
  scripts: string;
  selection: string[];
}

export interface HistoryEntry {
  /** Shown in the history panel and in the undo tooltip. */
  label: string;
  /**
   * Coalescing key. Two adjacent entries with the same non-null key collapse
   * into one, keeping the *older* `before` and the *newer* `after`.
   */
  mergeKey: string | null;
  before: HistorySnapshot;
  after: HistorySnapshot;
  timestamp: number;
}

const MAX_ENTRIES = 200;
/** Edits closer together than this may coalesce; further apart never do. */
const MERGE_WINDOW_MS = 800;

interface HistoryState {
  entries: HistoryEntry[];
  /** Index of the next entry to redo; entries before it are undone-able. */
  cursor: number;

  canUndo(): boolean;
  canRedo(): boolean;
  undoLabel(): string | null;
  redoLabel(): string | null;

  push(entry: Omit<HistoryEntry, 'timestamp'>): void;
  /** Returns the snapshot to restore, or null when there is nothing to undo. */
  undo(): HistorySnapshot | null;
  redo(): HistorySnapshot | null;
  clear(): void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  cursor: 0,

  canUndo: () => get().cursor > 0,
  canRedo: () => get().cursor < get().entries.length,

  undoLabel: () => {
    const { entries, cursor } = get();
    return cursor > 0 ? (entries[cursor - 1]?.label ?? null) : null;
  },

  redoLabel: () => {
    const { entries, cursor } = get();
    return cursor < entries.length ? (entries[cursor]?.label ?? null) : null;
  },

  push: (entry) => {
    set((state) => {
      // A new edit invalidates everything that was redoable.
      const kept = state.entries.slice(0, state.cursor);
      const previous = kept[kept.length - 1];
      const now = Date.now();

      const canMerge =
        previous !== undefined &&
        entry.mergeKey !== null &&
        previous.mergeKey === entry.mergeKey &&
        now - previous.timestamp < MERGE_WINDOW_MS;

      if (canMerge && previous) {
        const merged: HistoryEntry = {
          ...previous,
          label: entry.label,
          after: entry.after,
          timestamp: now,
        };
        const entries = [...kept.slice(0, -1), merged];
        return { entries, cursor: entries.length };
      }

      const entries = [...kept, { ...entry, timestamp: now }];
      const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
      return { entries: trimmed, cursor: trimmed.length };
    });
  },

  undo: () => {
    const { entries, cursor } = get();
    if (cursor <= 0) return null;
    const entry = entries[cursor - 1];
    if (!entry) return null;
    set({ cursor: cursor - 1 });
    return entry.before;
  },

  redo: () => {
    const { entries, cursor } = get();
    if (cursor >= entries.length) return null;
    const entry = entries[cursor];
    if (!entry) return null;
    set({ cursor: cursor + 1 });
    return entry.after;
  },

  clear: () => set({ entries: [], cursor: 0 }),
}));
