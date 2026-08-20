import { create } from 'zustand';
import type {
  AssetRef,
  Breakpoint,
  FileChangeEvent,
  ProjectInfo,
  ProjectSnapshot,
  ScriptSource,
  SourceOrigin,
} from '@shared/project.js';
import { DEFAULT_BREAKPOINTS, selectorForState, type FileWrite, type StyleState } from '@shared/project.js';
import type { DocNode, ElementNode, NodeId, PageDocument } from '@shared/document.js';
import {
  findElement,
  findFirstTag,
  findParent,
  findPath,
  getAttr,
  getBody,
  getClassList,
  isElement,
  textContent,
  walk,
} from '@shared/document.js';
import { dirname, extname, joinRelative, relativeHref, sanitizeFileName, stem } from '@shared/paths.js';
import { fail, ok, type IpcResult } from '@shared/result.js';
import { PLACEHOLDER_ASSET_PATH, PLACEHOLDER_SVG } from '@shared/project.js';
import { parseHtml, type MissingReference } from '@/engine/htmlParser.js';
import { generateHtml } from '@/engine/htmlGenerator.js';
import { applyPageMeta, EMPTY_PAGE_META, readPageMeta, type PageMeta } from '@/engine/headMeta.js';
import {
  findSharedSections,
  isValidSectionName,
  markAsShared,
  replaceSharedSection,
  sharedSectionFor,
  unmarkShared,
} from '@/engine/sharedSections.js';
import {
  appendMissingRules,
  applyDeclarations,
  chooseSelectorTarget,
  chooseStyleTarget,
  countClasses,
  definesSelector,
  diffDeclarations,
  ensureRule,
  listClassNames,
  listStyleClasses,
  parseDeclarationBlock,
  parseStyleSheets,
  planSelector,
  renameSelector,
  readDeclarations,
  removeSelectorRules,
  renameClassInSelectors,
  stringifyStyleSheet,
  type Declarations,
  type DeclarationPatch,
  type StyleClassInfo,
  type StyleSheetModel,
  type StyleTarget,
} from '@/engine/cssGenerator.js';
import {
  applySnippets,
  collectWrites,
  embeddedScriptKey,
  ensureScript,
  ensureStyleSheet,
  findScriptTarget,
  reconcileNodeIds,
} from '@/engine/domSync.js';
import { parseManagedScript, type ManagedScript, type ManagedSnippet } from '@/engine/jsGenerator.js';
import {
  buildElementScriptSnippet,
  defaultParamsFor,
  ELEMENT_SCRIPT_PRESETS,
  elementScriptSnippetId,
  findPreset,
  parseElementScriptSnippet,
  type ElementScriptBinding,
} from '@/engine/elementScripts.js';
import {
  ClassNameAllocator,
  createRuntimeNodeId,
  isValidCssIdentifier,
  slugify,
} from '@/engine/idAllocator.js';
import type { TemplateScript } from '@/lib/elementFactory.js';
import type { TextAction, TextActionContext, TextRange } from '@/engine/richTextEditor.js';
import { useHistoryStore, type HistorySnapshot } from './historyStore.js';
import { logger } from '@/lib/logger.js';

/**
 * The editor's single source of truth *in memory* — which is itself derived
 * from, and continuously written back to, the files on disk.
 *
 * The save pipeline is deliberately one-way and debounced:
 *
 *   mutate tree/CSS  →  mark dirty  →  (150 ms)  →  collectWrites  →  IPC write
 *
 * and the reverse direction (`applyExternalChange`) re-parses from the file and
 * reconciles node ids, so an edit made in VS Code lands in the editor without
 * resetting the user's selection.
 */

const SAVE_DEBOUNCE_MS = 180;

export type EditorStatus = 'empty' | 'loading' | 'ready' | 'error';

/**
 * One markup change small enough to apply to the live canvas iframe.
 *
 * Every op has to be *equivalent* to what a full `srcDoc` rebuild would have
 * produced for the same edit — that equivalence is the whole contract, and it
 * is why the set is closed: replacing an element's text and writing one
 * attribute are the only two things the editor does often enough to matter and
 * can express on a DOM node without knowing anything about its surroundings.
 */
export type CanvasPatchOp =
  | { kind: 'text'; id: NodeId; value: string }
  | { kind: 'attribute'; id: NodeId; name: string; value: string | null };

export interface CanvasPatch {
  /** Monotonic, so the canvas can tell a new patch from a re-render. */
  seq: number;
  ops: CanvasPatchOp[];
}

/**
 * What dropping a palette entry or a component actually inserts: the subtree,
 * the CSS its classes need, and any behaviour it ships with (see
 * `TemplateScript` in elementFactory.ts — today only the footer's self-updating
 * year uses it).
 */
export interface TemplatePayload {
  node: ElementNode;
  css?: string;
  scripts?: TemplateScript[];
}

/** A stylesheet of the open page, described for the "Style" panel. */
export interface StyleSheetInfo {
  id: string;
  /** What to show the user: the file path, the CDN href, or "styles in the HTML". */
  label: string;
  relPath: string | null;
  origin: SourceOrigin;
  /** Id of the `<link>`/`<style>` element, so the panel can detach it. */
  hostNodeId: NodeId | null;
  writable: boolean;
  /** A CDN/absolute URL: it renders, but Litho must never touch it. */
  remote: boolean;
  /** How many class names this sheet defines — what the class picker gains. */
  classCount: number;
  /** True for the sheet new rules are written into (the last writable one). */
  isTarget: boolean;
}

/** A named style as the styles panel shows it. */
export interface StyleClassUsage extends StyleClassInfo {
  /** How many elements of the open page carry this class. */
  usage: number;
}

/** Where generated JavaScript for the open page lands. */
export interface ScriptTargetInfo {
  /**
   * `external` — an existing `.js` file of the page; `embedded` — a `<script>`
   * block written inside the HTML; `new` — the page has no script Litho may
   * write to, so one would be created.
   */
  kind: 'external' | 'embedded' | 'new';
  /** Path to show the user; the page's own path when the script is inline. */
  label: string;
}

/** What the properties panel knows about scripting on one element. */
export interface ElementScriptState {
  /** The attached function, when the page carries one this panel can read. */
  binding: ElementScriptBinding | null;
  /**
   * The element has a generated snippet whose configuration could not be read
   * back — hand-edited, or written by a newer version of the app. Applying a
   * function from the panel would replace it, so the panel says so first.
   */
  unrecognized: boolean;
  /** Inline handlers already on the element (`onclick`, `onmouseover`, …). */
  inlineHandlers: string[];
}

interface EditorState {
  status: EditorStatus;
  error: string | null;

  project: ProjectInfo | null;
  /** Raw file contents as last read from or written to disk. */
  files: Record<string, string>;
  assets: AssetRef[];

  pageRelPath: string | null;
  document: PageDocument | null;
  styleModels: StyleSheetModel[];
  scriptSources: ScriptSource[];
  /**
   * Managed-script state, keyed by relative path — only for scripts an edit has
   * actually touched. Untouched script files are deliberately absent so a save
   * can never rewrite (and reformat) JavaScript the user wrote.
   */
  scripts: Map<string, ManagedScript>;
  classAllocator: ClassNameAllocator | null;
  /** Files created by an edit that are not on disk yet. */
  createdFiles: Map<string, string>;
  notices: string[];
  /** Broken local CSS/JS references of the open page, with repair candidates. */
  missingRefs: MissingReference[];

  selection: NodeId[];
  hovered: NodeId | null;

  /**
   * Elements the user has explicitly dismissed from the "poza układem"
   * warning — a false positive (an intentionally fixed header, a badge
   * absolutely placed inside a relatively positioned parent) shouldn't keep
   * nagging every time it's selected. Scoped to the open page, not saved to
   * disk or undo history: it's a UI dismissal, not a document edit.
   */
  ignoredOutOfLayout: NodeId[];

  /** Detached subtrees held for paste; never touches the OS clipboard. */
  clipboard: ElementNode[];

  breakpoints: Breakpoint[];
  breakpointId: string;
  /**
   * The element state style edits are written for — the pseudo-class axis that
   * runs alongside the breakpoint axis. See `StyleState` in shared/project.ts.
   */
  styleState: StyleState;

  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  /** Paths actually written by the most recent save (unchanged files skipped). */
  lastWrittenPaths: string[];
  saveError: string | null;

  /**
   * Bumped on every change to the document or stylesheets. The tree is mutated
   * in place (which keeps history snapshots cheap), so the `document` reference
   * does not change on an edit — this counter is what tells the canvas and the
   * panels to re-render. It is the single "the model changed" signal.
   */
  revision: number;
  /**
   * Bumped only when the DOM tree or an element's attributes change — never on
   * a pure CSS declaration edit. The canvas keys its iframe's `srcDoc` off this
   * instead of `revision`, so typing in the properties panel patches the live
   * stylesheet in place rather than reloading the whole page (which used to
   * flash the selection outline away on every keystroke).
   */
  structureRevision: number;
  /**
   * Small markup edits the canvas can apply straight to the already-loaded
   * iframe, instead of rebuilding `srcDoc` and reloading the page.
   *
   * This is the markup counterpart of the CSS hot-patch above, and it exists
   * for the same reason. Changing one element's text or one attribute *is*
   * structurally a change to the tree, so it used to bump `structureRevision`
   * — which reloads the whole document. On a page with web fonts and remote
   * images that reload is a white flash plus a second or two of re-layout, and
   * it happened on **every keystroke** in the properties panel: the reported
   * "the editor freezes, goes white and refreshes, I can't edit anything for a
   * few seconds".
   *
   * An op describes a change that is expressible on a live DOM node, so
   * applying it to the iframe leaves it showing exactly what a rebuilt
   * `srcDoc` would have. Anything that moves nodes around (insert, delete,
   * group, undo) is *not* expressible this way and still goes through
   * `structureRevision`, which is why this stays a small, closed set of ops.
   */
  canvasPatch: CanvasPatch | null;

  /* actions */
  loadSnapshot(snapshot: ProjectSnapshot, openRelPath?: string): void;
  /** Flushes any pending save of the current page, then parses and shows `relPath`. */
  openPage(relPath: string): Promise<void>;
  closeProject(): void;
  setAssets(assets: AssetRef[]): void;
  /** Replaces the project metadata (page list) after an external re-scan. */
  setProjectInfo(info: ProjectInfo): void;

  select(ids: NodeId[]): void;
  toggleSelection(id: NodeId): void;
  setHovered(id: NodeId | null): void;

  setBreakpoint(id: string): void;
  setStyleState(state: StyleState): void;
  currentBreakpoint(): Breakpoint;
  /** Edits a breakpoint's max-width / canvas width (persists per session). */
  updateBreakpoint(
    id: string,
    patch: Partial<Pick<Breakpoint, 'maxWidth' | 'canvasWidth' | 'label' | 'fluid'>>,
  ): void;

  /**
   * Every element the page has taken *out of its layout* — `position: absolute`
   * or `fixed` declared at the base breakpoint, which is what free placement
   * writes.
   *
   * This is the single most common way a page that looks finished on Desktop
   * arrives broken on Telefon: the element is pinned to a pixel measured
   * against a 1440 px canvas, so on a 390 px one it lands off-screen or on top
   * of something else. The editor used to say nothing about that at all.
   *
   * Excludes anything dismissed via `ignoreOutOfLayout` — not every fixed or
   * absolute element is actually broken (a sticky header, a badge placed
   * inside a relatively positioned parent), and a warning that can't be told
   * "you're wrong about this one" just gets tuned out.
   */
  outOfLayoutIds(): NodeId[];
  /**
   * Puts an element back into the normal flow at the active breakpoint by
   * dropping the declarations that took it out. The exact inverse of the ⌖
   * button in `TransformControls`.
   */
  returnToLayout(id: NodeId): void;

  /** Whether `id` has been dismissed from the "poza układem" warning. */
  isOutOfLayoutIgnored(id: NodeId): boolean;
  /** Dismisses `id` from the warning — it stops counting and stops appearing in the list. */
  ignoreOutOfLayout(id: NodeId): void;
  /** Un-dismisses `id`, so the warning shows for it again if it still qualifies. */
  unignoreOutOfLayout(id: NodeId): void;

  /** Declared styles for the selected element at the active breakpoint. */
  declarationsFor(id: NodeId): Declarations;
  /** Every class name defined across the page's stylesheets, for the class picker. */
  availableClassNames(): string[];

  /* ---------------------------------------------------------------- */
  /* Reusable styles (named CSS classes)                                */
  /* ---------------------------------------------------------------- */

  /**
   * The page's named styles: every class its stylesheets define, with what each
   * declares at the active breakpoint and how many elements use it.
   */
  styleClasses(): StyleClassUsage[];
  /** Declarations of `.name` at the active breakpoint. */
  classDeclarations(name: string): Declarations;
  /**
   * Creates an empty `.name` rule, so the style exists under the user's own
   * name before any property is set on it. The name is slugified into a valid
   * CSS identifier; the slug is returned.
   */
  createStyleClass(name: string): IpcResult<string>;
  /** Writes a declaration patch to `.name` at the active breakpoint. */
  setClassStyle(name: string, patch: DeclarationPatch, options?: { label?: string; mergeKey?: string }): void;
  /**
   * Replaces the declarations of `.name` at the active breakpoint with the CSS
   * the user typed in the raw-edit box. Returns an error result when the text is
   * not a parseable declaration block, so the panel can keep it on screen.
   */
  setClassCss(name: string, cssText: string): IpcResult<void>;
  /**
   * Marks the element's block as shared across subpages, or removes that mark.
   *
   * A shared block is delimited by plain HTML comments, and from the next save
   * onwards it is copied into every other subpage carrying the same marker —
   * so a menu entry added once appears on all of them. See
   * `src/engine/sharedSections.ts`.
   */
  shareSection(id: NodeId, name: string): IpcResult<string>;
  unshareSection(name: string): void;
  /** Name of the shared section the node sits in, or null. */
  sharedSectionOf(id: NodeId): string | null;

  /**
   * The page's own `<head>` metadata — title, description, language, social
   * image, favicon. See `src/engine/headMeta.ts` for why each one matters.
   */
  pageMeta(): PageMeta;
  setPageMeta(patch: Partial<PageMeta>, options?: { label?: string; mergeKey?: string }): void;

  /** Renames the class in every rule *and* on every element that carries it. */
  renameStyleClass(from: string, to: string): IpcResult<string>;
  /**
   * Turns an element's private, generated `#id` hook into a named, reusable
   * class — carrying every rule that hung off it, at every breakpoint and in
   * every pseudo-state.
   *
   * Styling an element that has no class of its own makes the editor invent an
   * `id` to hang the rules on. That is correct but private: after an hour the
   * stylesheet is a list of one-off `#naglowek-3 { … }` blocks that no human
   * would choose to maintain, which undercuts the product's central promise
   * that the files stay yours. This is the escape hatch — one action turns the
   * throwaway hook into `.karta-oferty`, reusable from the Styles panel.
   */
  promoteToStyleClass(id: NodeId, name: string): IpcResult<string>;
  /** Drops the `.name` rules and strips the class from every element. */
  deleteStyleClass(name: string): void;
  /** Adds or removes a class on every currently selected element. */
  setClassOnSelection(name: string, present: boolean): void;

  /** Every stylesheet the open page pulls in, in cascade order. */
  pageStyleSheets(): StyleSheetInfo[];
  /** Project CSS files the open page does not reference yet. */
  unlinkedStyleSheets(): string[];
  /**
   * Copies an uploaded `.css` into the project folder and links it to the open
   * page. Resolves once the page has been re-parsed, so by then the sheet is
   * rendering on the canvas and its class names are in the class picker.
   */
  importStyleSheet(fileName: string, css: string): Promise<IpcResult<string>>;
  /** Adds a `<link rel="stylesheet">` for a CSS file already in the project. */
  attachStyleSheet(relPath: string): Promise<IpcResult<string>>;
  /** Removes the `<link>` carrying a stylesheet; the file itself stays on disk. */
  detachStyleSheet(hostNodeId: NodeId): Promise<IpcResult<void>>;
  /**
   * Adds a `<link>` to `<head>` pointing at an external resource (a Google
   * Fonts / Material Symbols stylesheet, a `preconnect` hint, …), deduped by
   * `href` so picking the same font or icon set twice is a no-op. Returns
   * `true` when a new `<link>` was added, `false` when one with that `href`
   * was already there.
   */
  ensureHeadLink(attrs: Record<string, string>, label?: string): boolean;

  /**
   * Where generated JavaScript would go for the open page — the script the page
   * already has, or the file that would be created. Read-only: asking does not
   * create anything.
   */
  scriptTarget(): ScriptTargetInfo | null;
  /** What is already attached to an element, read back from the page's own JS. */
  elementScriptState(id: NodeId): ElementScriptState;
  /** Generates (or regenerates) the element's script, allocating an `id` if needed. */
  setElementScript(id: NodeId, binding: ElementScriptBinding): void;
  removeElementScript(id: NodeId): void;

  setStyle(id: NodeId, patch: DeclarationPatch, options?: { label?: string; mergeKey?: string }): void;
  setAttribute(id: NodeId, name: string, value: string | null, label?: string): void;
  /**
   * Points an existing `<img>` at a different file — the properties-panel
   * picker, and dropping a photo straight onto a gallery tile.
   *
   * `src` and the intrinsic `width`/`height` have to move together: the old
   * dimensions describe the old picture, so leaving them behind squashes the new
   * one into the previous aspect ratio. Writing them as three separate
   * `setAttribute` calls would also split the swap across three history
   * entries, making Ctrl+Z undo it in pieces.
   */
  setImageSource(id: NodeId, src: string, width: number | null, height: number | null): void;
  setTextContent(id: NodeId, text: string): void;

  insertElement(node: ElementNode, target: { parentId: NodeId; index: number }, label?: string): void;
  /**
   * Inserts a palette/component template: the element itself plus the CSS rules
   * it relies on (only those the project does not already define) and the
   * placeholder image, when the template references one that is not on disk.
   */
  insertTemplate(
    template: TemplatePayload,
    target: { parentId: NodeId; index: number },
    label?: string,
  ): void;
  /**
   * Places a palette/component/asset element *freely* at a pixel position: it
   * is added to the container and given `position: absolute` with the supplied
   * `left`/`top`, all in one undo step. The element gets a unique `id` so its
   * position lands on a per-element selector — never on the shared template
   * class other instances reuse — and the container is given a positioning
   * context when it lacks one, so the element anchors where it was dropped.
   */
  placeFreeElement(
    template: TemplatePayload,
    target: { parentId: NodeId; left: number; top: number; parentPositioned: boolean },
    label?: string,
  ): void;
  /**
   * Moves an *existing* normal-flow element by a visual offset: gives it
   * `position: relative` with the supplied `left`/`top`, measured from where the
   * layout already puts it.
   *
   * Relative — not absolute — is what makes dragging feel safe. A relatively
   * offset box still occupies its original slot in the flow, so moving a heading
   * leaves the paragraph under it exactly where it was; taking the box *out* of
   * flow (`position: absolute`) collapses everything below it upwards, which is
   * the "I moved the title and the description ran away" problem. Deliberately
   * dropping out of flow is still available, but as its own explicit action (the
   * ⌖ button in `TransformControls`), not as a side effect of dragging.
   *
   * The element gets a unique selector so the offset never leaks onto a shared
   * class, and no ancestor is touched at all: relative offsets need no
   * positioning context. Once offset, later moves are plain `left`/`top` edits
   * via `setStyle`.
   */
  moveNodeFree(id: NodeId, target: { left: number; top: number }, label?: string): void;
  /**
   * Keeps a free-layout container tall enough for its out-of-flow children.
   *
   * `position: absolute`/`relative`-offset children never contribute to their
   * parent's auto height — that's the whole point of taking them out of flow —
   * so a free element dropped or dragged near the bottom of the page would
   * otherwise hang past the visible/scrollable page edge. Called by the canvas
   * after every measurement pass with the tallest bottom edge among a
   * container's free children; write a `min-height` floor that grows to fit
   * them and shrinks back (or is removed entirely) once none remain.
   *
   * Not an undoable step on its own — it is a derived consequence of whatever
   * add/move/remove action triggered the remeasure, and undoing that action
   * naturally triggers a re-sync that puts this back where it belongs.
   */
  syncFreeLayoutHeight(containerId: NodeId, minHeightPx: number | null): void;
  /** Rewrites a broken `<link>`/`<script>` reference to the chosen project file. */
  fixReference(hostNodeId: NodeId, targetRelPath: string): Promise<void>;
  removeNodes(ids: NodeId[]): void;
  duplicateNodes(ids: NodeId[]): void;
  moveNode(id: NodeId, target: { parentId: NodeId; index: number }): void;

  /** Wraps the selected elements in a new `<div>` (group). */
  groupNodes(ids: NodeId[]): void;
  /** Replaces a wrapper element with its children (ungroup). */
  ungroupNode(id: NodeId): void;

  /** Copies the selected subtrees into the internal clipboard. */
  copyNodes(ids: NodeId[]): void;
  cutNodes(ids: NodeId[]): void;
  /** Pastes clipboard content into the selected container, or after the selection. */
  pasteNodes(): void;
  canPaste(): boolean;

  applyTextAction<P>(id: NodeId, action: TextAction<P>, range: TextRange, params: P): void;

  undo(): void;
  redo(): void;

  applyExternalChange(event: FileChangeEvent): void;
  flushSave(): Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive failed saves; caps the automatic retry so a genuinely broken
 * disk (read-only, unplugged drive) does not get hammered forever. */
let saveFailureStreak = 0;
const MAX_SAVE_RETRIES = 3;
const SAVE_RETRY_DELAY_MS = 700;

export const useEditorStore = create<EditorState>((set, get) => ({
  status: 'empty',
  error: null,

  project: null,
  files: {},
  assets: [],

  pageRelPath: null,
  document: null,
  styleModels: [],
  scriptSources: [],
  scripts: new Map(),
  classAllocator: null,
  createdFiles: new Map(),
  notices: [],
  missingRefs: [],

  selection: [],
  hovered: null,
  ignoredOutOfLayout: [],
  clipboard: [],

  breakpoints: DEFAULT_BREAKPOINTS,
  breakpointId: 'base',
  styleState: 'normal',

  dirty: false,
  saving: false,
  lastSavedAt: null,
  lastWrittenPaths: [],
  saveError: null,
  revision: 0,
  structureRevision: 0,
  canvasPatch: null,

  /* ---------------------------------------------------------------- */

  loadSnapshot: (snapshot, openRelPath) => {
    // Any save still pending belongs to the previous project; its IPC session
    // is gone, so the timer is dropped rather than fired against the new one.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;

    useHistoryStore.getState().clear();
    set({
      status: 'loading',
      error: null,
      project: snapshot.project,
      files: snapshot.files,
      assets: snapshot.assets,
      selection: [],
      hovered: null,
      ignoredOutOfLayout: [],
      dirty: false,
      saveError: null,
      createdFiles: new Map(),
    });

    const requested = openRelPath
      ? snapshot.project.pages.find((page) => page.relPath === openRelPath)
      : undefined;
    const entry =
      requested ?? snapshot.project.pages.find((page) => page.isEntry) ?? snapshot.project.pages[0];
    if (!entry) {
      set({ status: 'error', error: 'Projekt nie zawiera żadnej strony HTML.' });
      return;
    }
    void get().openPage(entry.relPath);
  },

  openPage: async (relPath) => {
    // A debounced save may still hold edits of the page being left; they must
    // land on disk before the model is replaced, or they would be lost.
    await get().flushSave();

    const { files } = get();
    const source = files[relPath];
    if (source === undefined) {
      set({ status: 'error', error: `Nie znaleziono pliku ${relPath}.` });
      return;
    }

    try {
      const parsed = parseHtml(relPath, source, { files });
      const styleModels = parseStyleSheets(parsed.styles);

      set({
        status: 'ready',
        error: null,
        pageRelPath: relPath,
        document: parsed.document,
        styleModels,
        scriptSources: parsed.scripts,
        scripts: new Map(),
        classAllocator: new ClassNameAllocator([parsed.document.root]),
        notices: parsed.notices.map((notice) => notice.message),
        missingRefs: parsed.missingRefs,
        selection: [],
        hovered: null,
        ignoredOutOfLayout: [],
        createdFiles: new Map(),
        // A pseudo-state is only meaningful for the element that was selected
        // when it was picked; carrying it into a fresh page would leave the
        // panel silently writing `:hover` rules for whatever is clicked next.
        styleState: 'normal',
      });
      useHistoryStore.getState().clear();
      logger.info(`Otwarto stronę ${relPath}`);
    } catch (error) {
      logger.error(`Nie udało się otworzyć ${relPath}`, error);
      set({ status: 'error', error: `Nie udało się przetworzyć pliku ${relPath}.` });
    }
  },

  closeProject: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    useHistoryStore.getState().clear();
    set({
      status: 'empty',
      error: null,
      project: null,
      files: {},
      assets: [],
      pageRelPath: null,
      document: null,
      styleModels: [],
      scriptSources: [],
      scripts: new Map(),
      classAllocator: null,
      createdFiles: new Map(),
      notices: [],
      missingRefs: [],
      selection: [],
      hovered: null,
      ignoredOutOfLayout: [],
      clipboard: [],
      dirty: false,
      styleState: 'normal',
    });
  },

  setAssets: (assets) => set({ assets }),

  setProjectInfo: (info) => {
    if (!get().project) return;
    set({ project: info });
  },

  /* ---------------------------------------------------------------- */

  select: (ids) => set({ selection: [...new Set(ids)] }),

  toggleSelection: (id) =>
    set((state) => ({
      selection: state.selection.includes(id)
        ? state.selection.filter((entry) => entry !== id)
        : [...state.selection, id],
    })),

  setHovered: (id) => set({ hovered: id }),

  setBreakpoint: (id) => set({ breakpointId: id }),
  setStyleState: (styleState) => set({ styleState }),

  currentBreakpoint: () => {
    const { breakpoints, breakpointId } = get();
    return breakpoints.find((breakpoint) => breakpoint.id === breakpointId) ?? breakpoints[0]!;
  },

  updateBreakpoint: (id, patch) => {
    set((state) => ({
      breakpoints: state.breakpoints.map((breakpoint) =>
        breakpoint.id === id
          ? {
              ...breakpoint,
              // The base breakpoint emits no media query, so its width is fixed at null.
              maxWidth: breakpoint.id === 'base' ? null : (patch.maxWidth ?? breakpoint.maxWidth),
              canvasWidth: clampWidth(patch.canvasWidth ?? breakpoint.canvasWidth),
              // Only the base breakpoint may be fluid: a device breakpoint whose
              // width did not apply would defeat the point of having it.
              fluid: breakpoint.id === 'base' ? (patch.fluid ?? breakpoint.fluid) : false,
              label: patch.label ?? breakpoint.label,
            }
          : breakpoint,
      ),
    }));
  },

  /* ---------------------------------------------------------------- */

  declarationsFor: (id) => {
    const { document, styleModels } = get();
    if (!document) return {};
    const element = findElement(document.root, id);
    if (!element) return {};
    const selector = existingSelectorFor(element);
    if (!selector) return {};
    return readDeclarations(
      styleModels,
      selectorForState(selector, get().styleState),
      get().currentBreakpoint(),
    );
  },

  outOfLayoutIds: () => {
    const { document, styleModels } = get();
    if (!document) return [];
    const body = getBody(document);
    if (!body) return [];

    // Read at the *base* breakpoint on purpose: that is where free placement
    // writes, and an element pinned there is pinned at every narrower one
    // unless it has been explicitly overridden.
    const base = baseBreakpointOf(get());
    const ids: NodeId[] = [];
    for (const node of walk(body)) {
      if (!isElement(node)) continue;
      const selector = existingSelectorFor(node);
      if (!selector) continue;
      const position = readDeclarations(styleModels, selector, base).position;
      if (position === 'absolute' || position === 'fixed') ids.push(node.id);
    }
    const ignored = get().ignoredOutOfLayout;
    return ignored.length === 0 ? ids : ids.filter((id) => !ignored.includes(id));
  },

  returnToLayout: (id) => {
    get().setStyle(
      id,
      { position: null, left: null, top: null, right: null, bottom: null },
      { label: 'Powrót do układu' },
    );
  },

  isOutOfLayoutIgnored: (id) => get().ignoredOutOfLayout.includes(id),

  ignoreOutOfLayout: (id) => {
    set((state) =>
      state.ignoredOutOfLayout.includes(id)
        ? state
        : { ignoredOutOfLayout: [...state.ignoredOutOfLayout, id] },
    );
  },

  unignoreOutOfLayout: (id) => {
    set((state) => ({ ignoredOutOfLayout: state.ignoredOutOfLayout.filter((entry) => entry !== id) }));
  },

  availableClassNames: () => listClassNames(get().styleModels),

  /* ---------------------------------------------------------------- */
  /* Reusable styles (named CSS classes)                                */
  /* ---------------------------------------------------------------- */

  styleClasses: () => {
    const state = get();
    const counts = state.document
      ? countClasses(getBody(state.document) ?? state.document.root)
      : new Map<string, number>();
    return listStyleClasses(state.styleModels, state.currentBreakpoint()).map((info) => ({
      ...info,
      usage: counts.get(info.name) ?? 0,
    }));
  },

  classDeclarations: (name) => {
    const slug = name.trim();
    if (!isValidCssIdentifier(slug)) return {};
    return readDeclarations(get().styleModels, `.${slug}`, get().currentBreakpoint());
  },

  createStyleClass: (name) => {
    const state = get();
    if (!state.document) return fail('NOT_A_PROJECT', 'Najpierw otwórz stronę, dla której tworzysz styl.');

    const slug = slugify(name, '');
    if (slug === '' || !isValidCssIdentifier(slug)) {
      return fail(
        'INVALID_ARGUMENT',
        'Nazwa stylu musi zaczynać się od litery i może zawierać litery, cyfry i myślniki.',
      );
    }
    if (listClassNames(state.styleModels).includes(slug)) {
      return fail('ALREADY_EXISTS', `Styl .${slug} już istnieje w tym projekcie.`);
    }

    const before = snapshot(state);
    const ensured = ensureWritableTarget(state);
    if (!ensured) {
      return fail('IO_ERROR', 'Ta strona nie ma arkusza stylów, do którego Litho może pisać.');
    }

    // A named style is a *base* style — the rule is created outside every media
    // query, and breakpoint-specific overrides are added later by editing it
    // with another breakpoint active.
    ensureRule(ensured.target.model, `.${slug}`, baseBreakpointOf(state));

    // Reserving the name stops a generated element hook from later claiming it
    // and silently sharing a rule with the user's style.
    state.classAllocator?.reserve(slug);

    set({
      styleModels: ensured.styleModels,
      createdFiles: ensured.createdFiles,
      dirty: true,
    });
    commit(get, before, `Nowy styl .${slug}`, null, ensured.created ? 'structure' : 'style');
    scheduleSave(get);
    logger.info(`Utworzono styl .${slug}`);
    return ok(slug);
  },

  setClassStyle: (name, patch, options) => {
    const state = get();
    const slug = name.trim();
    if (!state.document || !isValidCssIdentifier(slug)) return;

    const before = snapshot(state);
    const ensured = ensureWritableTarget(state, `.${slug}`);
    if (!ensured) {
      logger.warn('Brak arkusza stylów, w którym można zapisać zmianę.');
      return;
    }

    const breakpoint = state.currentBreakpoint();
    applyDeclarations(ensured.target.model, `.${slug}`, breakpoint, patch, {
      // The base rule carries the style's identity: emptying it must not delete
      // the name the user gave it. A breakpoint override has no name of its own,
      // so an emptied one is just debris and is pruned as usual.
      keepEmptyRule: breakpoint.maxWidth === null,
    });

    set({
      styleModels: ensured.styleModels,
      createdFiles: ensured.createdFiles,
      dirty: true,
    });
    commit(
      get,
      before,
      options?.label ?? `Styl .${slug}`,
      options?.mergeKey ?? `class-style:${slug}`,
      ensured.created ? 'structure' : 'style',
    );
    scheduleSave(get);
  },

  setClassCss: (name, cssText) => {
    const state = get();
    const slug = name.trim();
    if (!state.document || !isValidCssIdentifier(slug)) return fail('INVALID_ARGUMENT', 'Nieznany styl.');

    const next = parseDeclarationBlock(cssText);
    if (next === null) {
      return fail(
        'INVALID_ARGUMENT',
        'To nie jest poprawny blok reguł CSS (dozwolone tylko właściwości: wartość).',
      );
    }

    const breakpoint = state.currentBreakpoint();
    const current = readDeclarations(state.styleModels, `.${slug}`, breakpoint);
    const patch = diffDeclarations(current, next);
    if (Object.keys(patch).length === 0) return ok(undefined);

    // Reuse the same write path as the field-by-field editor — same target
    // selection, same keep-empty rule, same single undo step.
    get().setClassStyle(slug, patch, {
      label: `Edycja CSS .${slug}`,
      mergeKey: `class-css:${slug}:${breakpoint.id}`,
    });
    return ok(undefined);
  },

  shareSection: (id, name) => {
    const state = get();
    const { document } = state;
    if (!document) return fail('NOT_A_PROJECT', 'Nie otwarto żadnej strony.');

    const slug = slugify(name, '');
    if (!isValidSectionName(slug)) {
      return fail(
        'INVALID_ARGUMENT',
        'Nazwa wspólnej sekcji musi zaczynać się od litery i może zawierać litery, cyfry i myślniki.',
      );
    }
    if (sharedSectionFor(document, id)) {
      return fail('ALREADY_EXISTS', 'Ten element już należy do wspólnej sekcji.');
    }
    if (findSharedSections(document).some((section) => section.name === slug)) {
      return fail('ALREADY_EXISTS', `Wspólna sekcja „${slug}" już istnieje na tej stronie.`);
    }

    const before = snapshot(state);
    if (!markAsShared(document, id, slug)) {
      return fail('INVALID_ARGUMENT', 'Tego elementu nie da się oznaczyć jako wspólnego.');
    }

    set({ dirty: true });
    commit(get, before, `Wspólna sekcja: ${slug}`, null, 'structure');
    scheduleSave(get);
    return ok(slug);
  },

  unshareSection: (name) => {
    const state = get();
    const { document } = state;
    if (!document) return;

    const before = snapshot(state);
    if (!unmarkShared(document, name)) return;

    set({ dirty: true });
    commit(get, before, `Koniec współdzielenia: ${name}`, null, 'structure');
    scheduleSave(get);
  },

  sharedSectionOf: (id) => {
    const { document } = get();
    if (!document) return null;
    return sharedSectionFor(document, id)?.name ?? null;
  },

  pageMeta: () => {
    const { document } = get();
    return document ? readPageMeta(document.root) : EMPTY_PAGE_META;
  },

  setPageMeta: (patch, options) => {
    const state = get();
    const { document } = state;
    if (!document) return;

    const before = snapshot(state);
    if (!applyPageMeta(document.root, patch)) return;

    set({ dirty: true });
    // Structural: `<head>` gained or lost elements, so the canvas has to
    // rebuild rather than just re-apply CSS.
    commit(get, before, options?.label ?? 'Zmiana danych strony', options?.mergeKey ?? null, 'structure');
    scheduleSave(get);
  },

  promoteToStyleClass: (id, name) => {
    const state = get();
    const { document } = state;
    if (!document) return fail('NOT_A_PROJECT', 'Nie otwarto żadnej strony.');

    const element = findElement(document.root, id);
    if (!element) return fail('INVALID_ARGUMENT', 'Nie znaleziono elementu.');

    const hookId = getAttr(element, 'id');
    if (!hookId || !isValidCssIdentifier(hookId)) {
      return fail('INVALID_ARGUMENT', 'Ten element nie ma stylów zapisanych pod własnym identyfikatorem.');
    }

    const slug = slugify(name, '');
    if (slug === '' || !isValidCssIdentifier(slug)) {
      return fail(
        'INVALID_ARGUMENT',
        'Nazwa stylu musi zaczynać się od litery i może zawierać litery, cyfry i myślniki.',
      );
    }
    if (listClassNames(state.styleModels).includes(slug)) {
      return fail('ALREADY_EXISTS', `Styl .${slug} już istnieje w tym projekcie.`);
    }

    const before = snapshot(state);

    // `renameSelector` carries pseudo-state variants (`#hook:hover`) with it,
    // and walks media blocks too, so every breakpoint's override moves across
    // in the same pass.
    let cssChanged = false;
    for (const model of state.styleModels) {
      const had = definesSelector(model, `#${hookId}`);
      renameSelector(model, `#${hookId}`, `.${slug}`);
      cssChanged = cssChanged || had;
    }
    if (!cssChanged) {
      return fail('INVALID_ARGUMENT', 'Ten element nie ma jeszcze własnych stylów do zapisania.');
    }

    // The rules now say `.slug`, so the element has to carry that class. The
    // generated id goes: it existed only to hang those rules on, and leaving it
    // behind would be a second, now-meaningless hook in the user's markup.
    const classes = getClassList(element);
    setAttributeOn(element, 'class', [...classes, slug].join(' '));
    setAttributeOn(element, 'id', null);

    state.classAllocator?.reserve(slug);
    set({ dirty: true });
    commit(get, before, `Zapisanie stylu .${slug}`, null, 'structure');
    scheduleSave(get);
    return ok(slug);
  },

  renameStyleClass: (from, to) => {
    const state = get();
    const { document } = state;
    if (!document) return fail('NOT_A_PROJECT', 'Nie otwarto żadnej strony.');

    const source = from.trim();
    const slug = slugify(to, '');
    if (!isValidCssIdentifier(source)) return fail('INVALID_ARGUMENT', 'Nieznany styl.');
    if (slug === '' || !isValidCssIdentifier(slug)) {
      return fail(
        'INVALID_ARGUMENT',
        'Nazwa stylu musi zaczynać się od litery i może zawierać litery, cyfry i myślniki.',
      );
    }
    if (slug === source) return ok(slug);
    if (listClassNames(state.styleModels).includes(slug)) {
      return fail('ALREADY_EXISTS', `Styl .${slug} już istnieje w tym projekcie.`);
    }

    const before = snapshot(state);

    let cssChanged = false;
    for (const model of state.styleModels) {
      cssChanged = renameClassInSelectors(model, source, slug) || cssChanged;
    }

    // Renaming only the rule would leave every element pointing at a class that
    // no longer exists — the style would silently stop applying.
    let markupChanged = false;
    for (const node of walk(document.root)) {
      if (!isElement(node)) continue;
      const classes = getClassList(node);
      if (!classes.includes(source)) continue;
      setAttributeOn(node, 'class', classes.map((entry) => (entry === source ? slug : entry)).join(' '));
      markupChanged = true;
    }

    if (!cssChanged && !markupChanged) return ok(slug);

    state.classAllocator?.reserve(slug);
    set({ dirty: true });
    commit(get, before, `Zmiana nazwy stylu na .${slug}`, null, markupChanged ? 'structure' : 'style');
    scheduleSave(get);
    return ok(slug);
  },

  deleteStyleClass: (name) => {
    const state = get();
    const { document } = state;
    const slug = name.trim();
    if (!document || !isValidCssIdentifier(slug)) return;

    const before = snapshot(state);

    let cssChanged = false;
    for (const model of state.styleModels) {
      cssChanged = removeSelectorRules(model, `.${slug}`) || cssChanged;
    }

    let markupChanged = false;
    for (const node of walk(document.root)) {
      if (!isElement(node)) continue;
      const classes = getClassList(node);
      if (!classes.includes(slug)) continue;
      const rest = classes.filter((entry) => entry !== slug);
      setAttributeOn(node, 'class', rest.length > 0 ? rest.join(' ') : null);
      markupChanged = true;
    }

    if (!cssChanged && !markupChanged) return;

    set({ dirty: true });
    commit(get, before, `Usunięcie stylu .${slug}`, null, markupChanged ? 'structure' : 'style');
    scheduleSave(get);
  },

  setClassOnSelection: (name, present) => {
    const state = get();
    const { document } = state;
    const slug = name.trim();
    if (!document || !isValidCssIdentifier(slug) || state.selection.length === 0) return;

    const before = snapshot(state);
    let changed = false;

    for (const id of state.selection) {
      const element = findElement(document.root, id);
      if (!element) continue;
      const classes = getClassList(element);
      if (present === classes.includes(slug)) continue;
      const next = present ? [...classes, slug] : classes.filter((entry) => entry !== slug);
      setAttributeOn(element, 'class', next.length > 0 ? next.join(' ') : null);
      changed = true;
    }

    if (!changed) return;
    set({ dirty: true });
    commit(get, before, present ? `Przypisanie stylu .${slug}` : `Usunięcie stylu .${slug} z elementu`, null);
    scheduleSave(get);
  },

  /* ---------------------------------------------------------------- */
  /* Stylesheets                                                       */
  /* ---------------------------------------------------------------- */

  pageStyleSheets: () => {
    const state = get();
    const target = chooseStyleTarget(state.styleModels);
    return state.styleModels.map((model) => {
      const source = model.source;
      const remote = source.origin === 'external' && source.relPath === null;
      return {
        id: source.id,
        label: remote ? (source.href ?? 'zdalny arkusz') : (source.relPath ?? 'style zapisane w pliku HTML'),
        relPath: source.relPath,
        origin: source.origin,
        hostNodeId: source.hostNodeId,
        writable: source.writable && model.parseError === null,
        remote,
        classCount: listClassNames([model]).length,
        isTarget: target?.model === model,
      };
    });
  },

  unlinkedStyleSheets: () => {
    const state = get();
    const linked = new Set(
      state.styleModels
        .map((model) => model.source.relPath)
        .filter((relPath): relPath is string => relPath !== null),
    );
    return Object.keys(state.files)
      .filter((relPath) => extname(relPath) === '.css' && !linked.has(relPath))
      .sort();
  },

  importStyleSheet: async (fileName, css) => {
    const state = get();
    if (!state.document || !state.pageRelPath) {
      return fail('NOT_A_PROJECT', 'Najpierw otwórz stronę, do której chcesz dodać style.');
    }
    if (extname(fileName) !== '.css') {
      return fail('UNSUPPORTED_TYPE', `To nie jest plik CSS: ${fileName}`);
    }
    if (css.trim() === '') {
      return fail('INVALID_ARGUMENT', `Plik ${fileName} jest pusty.`);
    }

    // The file is copied into the project rather than referenced where it sits:
    // the folder has to stay uploadable to any host exactly as-is.
    const relPath = uniqueStylePath(state, fileName);
    const createdFiles = new Map(state.createdFiles);
    createdFiles.set(relPath, css);
    set({ createdFiles });

    return get().attachStyleSheet(relPath);
  },

  attachStyleSheet: async (relPath) => {
    const { document } = get();
    if (!document) return fail('NOT_A_PROJECT', 'Nie otwarto żadnej strony.');

    if (get().styleModels.some((model) => model.source.relPath === relPath)) {
      return fail('ALREADY_EXISTS', `Ta strona już korzysta z pliku ${relPath}.`);
    }

    const before = snapshot(get());
    // Appended last on purpose: the cascade gives the final sheet the last word,
    // which is both what "apply these styles to my page" means and what makes
    // subsequent edits from the properties panel (which go to the last writable
    // sheet) able to override it.
    const link: ElementNode = {
      kind: 'element',
      id: createRuntimeNodeId(),
      tag: 'link',
      attrs: [
        { name: 'rel', value: 'stylesheet' },
        { name: 'href', value: relativeHref(document.relPath, relPath) },
      ],
      namespace: 'html',
      children: [],
    };
    const head = findFirstTag(document.root, 'head');
    if (head) head.children.push(link);
    else document.root.children.unshift(link);

    set({ dirty: true });
    commit(get, before, 'Dodanie arkusza stylów', null);

    // Write the CSS file and the updated HTML, then re-parse the page: only
    // then does the new sheet take part in the cascade, reach the canvas and
    // contribute its class names to the picker.
    await get().flushSave();
    const saveError = get().saveError;
    if (saveError) return fail('IO_ERROR', saveError);

    const pageRelPath = get().pageRelPath;
    if (pageRelPath) await get().openPage(pageRelPath);
    return ok(relPath);
  },

  detachStyleSheet: async (hostNodeId) => {
    const { document } = get();
    if (!document) return fail('NOT_A_PROJECT', 'Nie otwarto żadnej strony.');
    const parent = findParent(document.root, hostNodeId);
    if (!parent) return fail('NOT_FOUND', 'Nie znaleziono odwołania do tego arkusza.');

    const before = snapshot(get());
    parent.children = parent.children.filter((child) => child.id !== hostNodeId);
    set({ dirty: true });
    commit(get, before, 'Odłączenie arkusza stylów', null);

    await get().flushSave();
    const saveError = get().saveError;
    if (saveError) return fail('IO_ERROR', saveError);

    const pageRelPath = get().pageRelPath;
    if (pageRelPath) await get().openPage(pageRelPath);
    return ok(undefined);
  },

  ensureHeadLink: (attrs, label) => {
    const { document } = get();
    if (!document) return false;
    const href = attrs.href;
    const head = findFirstTag(document.root, 'head');
    const alreadyThere = (head?.children ?? []).some(
      (child) => isElement(child) && child.tag === 'link' && getAttr(child, 'href') === href,
    );
    if (alreadyThere) return false;

    const before = snapshot(get());
    const link: ElementNode = {
      kind: 'element',
      id: createRuntimeNodeId(),
      tag: 'link',
      attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })),
      namespace: 'html',
      children: [],
    };
    if (head) head.children.push(link);
    else document.root.children.unshift(link);

    set({ dirty: true });
    commit(get, before, label ?? 'Dodanie zasobu do <head>', null);
    scheduleSave(get);
    return true;
  },

  /* ---------------------------------------------------------------- */

  setStyle: (id, patch, options) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const element = findElement(document.root, id);
    if (!element) return;

    const before = snapshot(get());

    // Make sure the page has a stylesheet we may write to, creating one only
    // when the project genuinely has none.
    const ensured = ensureWritableTarget(state);
    if (!ensured) {
      logger.warn('Brak arkusza stylów, w którym można zapisać zmianę.');
      return;
    }
    const { target, styleModels, createdFiles } = ensured;

    const allocator = state.classAllocator ?? new ClassNameAllocator([document.root]);
    const body = getBody(document);
    const plan = planSelector(element, {
      allocator,
      classCounts: countClasses(body ?? document.root),
      label: options?.label ?? describeElement(element),
    });

    // Allocating a brand-new hook mutates the element's attributes, not just
    // the stylesheet: the new CSS rule targets a class/id the canvas copy does
    // not carry yet, so without telling the canvas about it the rule would be
    // correctly specific and invisible anyway. The attribute change is the
    // entire markup difference, though, so it goes out as a patch op — the
    // first style edit on an element that had no selector of its own used to
    // cost a full page reload for two characters of `class`.
    const hookOps: CanvasPatchOp[] = [];

    if (plan.addClass) {
      const existing = getAttr(element, 'class');
      setAttributeOn(element, 'class', existing ? `${existing} ${plan.addClass}` : plan.addClass);
      hookOps.push({ kind: 'attribute', id, name: 'class', value: getAttr(element, 'class') ?? null });
    }
    if (plan.addId) {
      setAttributeOn(element, 'id', plan.addId);
      hookOps.push({ kind: 'attribute', id, name: 'id', value: plan.addId });
    }

    applyDeclarations(
      target.model,
      selectorForState(plan.selector, state.styleState),
      get().currentBreakpoint(),
      patch,
    );

    set({ styleModels, classAllocator: allocator, createdFiles, dirty: true });
    commit(
      get,
      before,
      options?.label ?? 'Zmiana stylu',
      options?.mergeKey ?? `style:${id}`,
      hookOps.length > 0 ? 'structure' : 'style',
      hookOps.length > 0 ? hookOps : null,
    );
    scheduleSave(get);
  },

  setAttribute: (id, name, value, label) => {
    const { document } = get();
    if (!document) return;
    const element = findElement(document.root, id);
    if (!element) return;

    const before = snapshot(get());
    setAttributeOn(element, name, value);
    set({ dirty: true });
    commit(
      get,
      before,
      label ?? `Zmiana atrybutu ${name}`,
      `attr:${id}:${name}`,
      'structure',
      isPatchableAttribute(element, name) ? [{ kind: 'attribute', id, name, value }] : null,
    );
    scheduleSave(get);
  },

  setImageSource: (id, src, width, height) => {
    const { document } = get();
    if (!document) return;
    const element = findElement(document.root, id);
    if (!element) return;

    const before = snapshot(get());
    setAttributeOn(element, 'src', src);
    // Intrinsic dimensions prevent layout shift when they are right and cause it
    // when they are stale, so an image whose size we do not know drops them
    // rather than keeping the previous picture's.
    setAttributeOn(element, 'width', width === null ? null : String(width));
    setAttributeOn(element, 'height', height === null ? null : String(height));
    set({ dirty: true });
    commit(get, before, 'Zmiana obrazu', null, 'structure', [
      { kind: 'attribute', id, name: 'src', value: src },
      { kind: 'attribute', id, name: 'width', value: width === null ? null : String(width) },
      { kind: 'attribute', id, name: 'height', value: height === null ? null : String(height) },
    ]);
    scheduleSave(get);
  },

  setTextContent: (id, text) => {
    const { document } = get();
    if (!document) return;
    const element = findElement(document.root, id);
    if (!element) return;

    const before = snapshot(get());
    element.children = [{ kind: 'text', id: createRuntimeNodeId(), value: text }];
    set({ dirty: true });
    // Setting `textContent` on the live node replaces its children with one
    // text node — exactly the mutation just made to the model — so the canvas
    // can keep the document it has instead of reloading it per keystroke.
    commit(get, before, 'Zmiana tekstu', `text:${id}`, 'structure', [{ kind: 'text', id, value: text }]);
    scheduleSave(get);
  },

  /* ---------------------------------------------------------------- */

  insertElement: (node, target, label) => {
    const { document } = get();
    if (!document) return;
    const parent = findElement(document.root, target.parentId);
    if (!parent) return;

    const before = snapshot(get());
    const index = Math.max(0, Math.min(target.index, parent.children.length));
    parent.children.splice(index, 0, node);

    get().classAllocator?.observe(node);
    set({ dirty: true, selection: [node.id] });
    commit(get, before, label ?? 'Dodanie elementu', null);
    scheduleSave(get);
  },

  insertTemplate: (template, target, label) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const parent = findElement(document.root, target.parentId);
    if (!parent) return;

    const before = snapshot(get());
    const index = Math.max(0, Math.min(target.index, parent.children.length));
    parent.children.splice(index, 0, template.node);
    get().classAllocator?.observe(template.node);

    let styleModels = state.styleModels;
    const createdFiles = new Map(state.createdFiles);

    // The template's classes are worthless without their rules — write the ones
    // the project does not have yet into the same sheet regular edits go to.
    if (template.css) {
      const ensured = ensureStyleSheet(
        document,
        styleModels.map((model) => model.source),
      );
      if (ensured.created && ensured.initialContent !== null) {
        createdFiles.set(ensured.relPath, ensured.initialContent);
        styleModels = parseStyleSheets([
          ...styleModels.map((model) => ({ ...model.source, css: stringifyStyleSheet(model) })),
          {
            id: `style-created-${ensured.relPath}`,
            origin: 'external',
            relPath: ensured.relPath,
            href: ensured.relPath,
            hostNodeId: null,
            media: null,
            css: ensured.initialContent,
            writable: true,
            order: styleModels.length + 1,
          },
        ]);
      }
      const targetSheet = chooseStyleTarget(styleModels);
      if (targetSheet) appendMissingRules(targetSheet.model, styleModels, template.css);
    }

    // Image templates point at the shared placeholder; make sure it exists so
    // the drop never produces a broken image.
    if (referencesPlaceholder(template.node) && !hasPlaceholderAsset(state, createdFiles)) {
      createdFiles.set(PLACEHOLDER_ASSET_PATH, PLACEHOLDER_SVG);
    }

    let scripts = state.scripts;
    if (template.scripts) {
      const attached = attachTemplateScripts(state, document, template.node, template.scripts);
      if (attached) {
        scripts = attached.scripts;
        for (const [path, content] of attached.createdFiles) createdFiles.set(path, content);
      }
    }

    set({ styleModels, createdFiles, scripts, dirty: true, selection: [template.node.id] });
    commit(get, before, label ?? 'Dodanie elementu', null);
    scheduleSave(get);
  },

  placeFreeElement: (template, target, label) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const parent = findElement(document.root, target.parentId);
    if (!parent) return;

    const before = snapshot(get());
    const node = template.node;

    // Append to the container — document order between absolutely-positioned
    // siblings has no visual effect, so the pixel position is the whole story.
    parent.children.push(node);
    get().classAllocator?.observe(node);
    const allocator = state.classAllocator ?? new ClassNameAllocator([document.root]);

    // A unique `id` up front is what keeps the position off the shared template
    // class: `planSelector` prefers an existing valid id, so the positional
    // rule below lands on `#…`, not on `.przycisk` (which every other button of
    // the same kind reuses).
    if (!getAttr(node, 'id')) {
      setAttributeOn(node, 'id', allocateDocumentId(document, suggestDomId(node)));
    }

    // Template CSS + placeholder, exactly as `insertTemplate` handles them.
    let styleModels = state.styleModels;
    const createdFiles = new Map(state.createdFiles);
    const ensured = ensureStyleSheet(
      document,
      styleModels.map((model) => model.source),
    );
    if (ensured.created && ensured.initialContent !== null) {
      createdFiles.set(ensured.relPath, ensured.initialContent);
      styleModels = parseStyleSheets([
        ...styleModels.map((model) => ({ ...model.source, css: stringifyStyleSheet(model) })),
        {
          id: `style-created-${ensured.relPath}`,
          origin: 'external',
          relPath: ensured.relPath,
          href: ensured.relPath,
          hostNodeId: null,
          media: null,
          css: ensured.initialContent,
          writable: true,
          order: styleModels.length + 1,
        },
      ]);
    }
    if (template.css) {
      const targetSheet = chooseStyleTarget(styleModels);
      if (targetSheet) appendMissingRules(targetSheet.model, styleModels, template.css);
    }
    if (referencesPlaceholder(node) && !hasPlaceholderAsset(state, createdFiles)) {
      createdFiles.set(PLACEHOLDER_ASSET_PATH, PLACEHOLDER_SVG);
    }

    const breakpoint = get().currentBreakpoint();

    // Absolute positioning anchors to the nearest *positioned* ancestor — give
    // the container one when it has none, or the element jumps to the page's
    // own top-left corner instead of staying where it was dropped.
    if (!target.parentPositioned) {
      writeSelfDeclarations(
        document,
        styleModels,
        allocator,
        breakpoint,
        parent,
        { position: 'relative' },
        'Kontener',
      );
    }
    writeSelfDeclarations(
      document,
      styleModels,
      allocator,
      breakpoint,
      node,
      { position: 'absolute', left: `${Math.round(target.left)}px`, top: `${Math.round(target.top)}px` },
      label ?? describeElement(node),
    );

    let scripts = state.scripts;
    if (template.scripts) {
      const attached = attachTemplateScripts(state, document, node, template.scripts);
      if (attached) {
        scripts = attached.scripts;
        for (const [path, content] of attached.createdFiles) createdFiles.set(path, content);
      }
    }

    set({ styleModels, classAllocator: allocator, createdFiles, scripts, dirty: true, selection: [node.id] });
    commit(get, before, label ?? 'Dodanie elementu', null);
    scheduleSave(get);
  },

  moveNodeFree: (id, target, label) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const node = findElement(document.root, id);
    if (!node) return;

    const before = snapshot(get());

    // Make sure the page has a stylesheet we may write to — same guarantee
    // `setStyle`/`placeFreeElement` make before touching the cascade.
    const ensured = ensureStyleSheet(
      document,
      state.styleModels.map((model) => model.source),
    );
    let styleModels = state.styleModels;
    const createdFiles = new Map(state.createdFiles);
    if (ensured.created && ensured.initialContent !== null) {
      createdFiles.set(ensured.relPath, ensured.initialContent);
      styleModels = parseStyleSheets([
        ...styleModels.map((model) => ({ ...model.source, css: stringifyStyleSheet(model) })),
        {
          id: `style-created-${ensured.relPath}`,
          origin: 'external',
          relPath: ensured.relPath,
          href: ensured.relPath,
          hostNodeId: null,
          media: null,
          css: ensured.initialContent,
          writable: true,
          order: styleModels.length + 1,
        },
      ]);
    }

    const allocator = state.classAllocator ?? new ClassNameAllocator([document.root]);
    const breakpoint = get().currentBreakpoint();

    // `left`/`top` on a relatively positioned box are offsets from its own
    // normal position, so — unlike absolute placement — there is no containing
    // block to establish and no ancestor to modify. The element keeps its slot
    // in the flow, which is exactly why its siblings do not move.
    const hookOps = writeSelfDeclarations(
      document,
      styleModels,
      allocator,
      breakpoint,
      node,
      { position: 'relative', left: `${Math.round(target.left)}px`, top: `${Math.round(target.top)}px` },
      label ?? 'Swobodne przesunięcie',
    );

    set({ styleModels, classAllocator: allocator, createdFiles, dirty: true });
    // Nothing here needs a reload: the offset itself is a pure CSS write that
    // gets patched into the live iframe's stylesheet, and the selector hook —
    // when one had to be allocated — goes out as an attribute op. A drag
    // therefore never flashes the page. Same reasoning as `setStyle`.
    commit(
      get,
      before,
      label ?? 'Swobodne przesunięcie',
      null,
      hookOps.length > 0 ? 'structure' : 'style',
      hookOps.length > 0 ? hookOps : null,
    );
    scheduleSave(get);
  },

  syncFreeLayoutHeight: (containerId, minHeightPx) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const container = findElement(document.root, containerId);
    if (!container) return;

    const allocator = state.classAllocator ?? new ClassNameAllocator([document.root]);
    const breakpoint = get().currentBreakpoint();
    const value = minHeightPx !== null && minHeightPx > 0 ? `${Math.ceil(minHeightPx)}px` : null;

    const hookOps = writeSelfDeclarations(
      document,
      state.styleModels,
      allocator,
      breakpoint,
      container,
      { 'min-height': value },
      'Dopasowanie wysokości strony',
    );

    set({ styleModels: state.styleModels, classAllocator: allocator, dirty: true });
    // Housekeeping, not a user gesture in its own right — see the interface
    // doc comment. Bumped by hand instead of going through `commit()` so it
    // does not add its own undo step between the action that triggered the
    // remeasure and whatever the user does next. A hook allocated here rides
    // along as a canvas patch for the same reason it does everywhere else:
    // this runs from `measure`, and reloading the page from a measurement pass
    // is how a resize turns into a loop of reloads.
    useEditorStore.setState((current) => ({
      revision: current.revision + 1,
      canvasPatch:
        hookOps.length > 0 ? { seq: (current.canvasPatch?.seq ?? 0) + 1, ops: hookOps } : current.canvasPatch,
    }));
    scheduleSave(get);
  },

  fixReference: async (hostNodeId, targetRelPath) => {
    const { document } = get();
    if (!document) return;
    const host = findElement(document.root, hostNodeId);
    if (!host) return;

    const attribute = host.tag === 'link' ? 'href' : 'src';
    const before = snapshot(get());
    setAttributeOn(host, attribute, relativeHref(document.relPath, targetRelPath));
    set({ dirty: true });
    commit(get, before, 'Naprawa odwołania do pliku', null);

    // Write the corrected HTML, then reload the page model so the repaired
    // stylesheet/script actually participates in rendering and editing.
    await get().flushSave();
    const relPath = get().pageRelPath;
    if (relPath) await get().openPage(relPath);
  },

  removeNodes: (ids) => {
    const { document } = get();
    if (!document || ids.length === 0) return;

    const before = snapshot(get());
    let removed = 0;
    for (const id of ids) {
      const parent = findParent(document.root, id);
      if (!parent) continue;
      const index = parent.children.findIndex((child) => child.id === id);
      if (index === -1) continue;
      parent.children.splice(index, 1);
      removed += 1;
    }
    if (removed === 0) return;

    set({ dirty: true, selection: [] });
    commit(get, before, removed === 1 ? 'Usunięcie elementu' : `Usunięcie ${removed} elementów`, null);
    scheduleSave(get);
  },

  duplicateNodes: (ids) => {
    const { document } = get();
    if (!document || ids.length === 0) return;

    const before = snapshot(get());
    const created: NodeId[] = [];

    for (const id of ids) {
      const parent = findParent(document.root, id);
      const node = findElement(document.root, id);
      if (!parent || !node) continue;
      const index = parent.children.findIndex((child) => child.id === id);
      const copy = cloneNode(node);
      parent.children.splice(index + 1, 0, copy);
      created.push(copy.id);
      get().classAllocator?.observe(copy);
    }
    if (created.length === 0) return;

    set({ dirty: true, selection: created });
    commit(get, before, 'Duplikowanie', null);
    scheduleSave(get);
  },

  moveNode: (id, target) => {
    const { document } = get();
    if (!document) return;
    const node = findElement(document.root, id);
    const parent = findElement(document.root, target.parentId);
    if (!node || !parent) return;

    // Moving a node into its own subtree would detach the tree from the root.
    if (findElement(node, target.parentId)) return;

    const before = snapshot(get());
    const oldParent = findParent(document.root, id);
    if (oldParent) {
      const index = oldParent.children.findIndex((child) => child.id === id);
      if (index !== -1) oldParent.children.splice(index, 1);
    }
    const index = Math.max(0, Math.min(target.index, parent.children.length));
    parent.children.splice(index, 0, node);

    set({ dirty: true });
    commit(get, before, 'Przeniesienie elementu', null);
    scheduleSave(get);
  },

  groupNodes: (ids) => {
    const { document } = get();
    if (!document || ids.length < 2) return;

    // Grouping only makes sense for a set of siblings — wrapping elements from
    // different parents in one <div> would silently move them in the document.
    const parent = commonParent(document.root, ids);
    if (!parent) return;

    const ordered = parent.children.filter((child) => ids.includes(child.id));
    if (ordered.length < 2) return;

    const before = snapshot(get());
    const firstIndex = parent.children.findIndex((child) => child.id === ordered[0]!.id);

    const group: ElementNode = {
      kind: 'element',
      id: createRuntimeNodeId(),
      tag: 'div',
      attrs: [{ name: 'class', value: 'grupa' }],
      namespace: 'html',
      children: ordered,
    };

    parent.children = parent.children.filter((child) => !ids.includes(child.id));
    parent.children.splice(Math.max(0, firstIndex), 0, group);

    get().classAllocator?.observe(group);
    set({ dirty: true, selection: [group.id] });
    commit(get, before, 'Grupowanie', null);
    scheduleSave(get);
  },

  ungroupNode: (id) => {
    const { document } = get();
    if (!document) return;
    const node = findElement(document.root, id);
    const parent = findParent(document.root, id);
    if (!node || !parent || node.children.length === 0) return;

    const before = snapshot(get());
    const index = parent.children.findIndex((child) => child.id === id);
    const moved = node.children.filter((child) => child.kind === 'element');
    parent.children.splice(index, 1, ...node.children);

    set({ dirty: true, selection: moved.map((child) => child.id) });
    commit(get, before, 'Rozgrupowanie', null);
    scheduleSave(get);
  },

  copyNodes: (ids) => {
    const { document } = get();
    if (!document || ids.length === 0) return;
    // Copy in document order so paste preserves the original arrangement.
    const clipboard: ElementNode[] = [];
    for (const node of walk(document.root)) {
      if (node.kind === 'element' && ids.includes(node.id)) clipboard.push(cloneNode(node));
    }
    if (clipboard.length > 0) set({ clipboard });
  },

  cutNodes: (ids) => {
    get().copyNodes(ids);
    get().removeNodes(ids);
  },

  pasteNodes: () => {
    const state = get();
    const { document, clipboard } = state;
    if (!document || clipboard.length === 0) return;

    // Paste into the selected element if it can hold children, otherwise after
    // the selection, otherwise at the end of <body>.
    const body = getBody(document);
    if (!body) return;

    const selectedId = state.selection[0];
    const selected = selectedId ? findElement(document.root, selectedId) : null;

    let parent: ElementNode;
    let index: number;
    if (selected && canHoldChildren(selected)) {
      parent = selected;
      index = selected.children.length;
    } else if (selected) {
      parent = findParent(document.root, selected.id) ?? body;
      index = parent.children.findIndex((child) => child.id === selected.id) + 1;
    } else {
      parent = body;
      index = body.children.length;
    }

    const before = snapshot(get());
    const copies = clipboard.map((node) => cloneNode(node));
    parent.children.splice(index, 0, ...copies);
    for (const copy of copies) get().classAllocator?.observe(copy);

    set({ dirty: true, selection: copies.map((copy) => copy.id) });
    commit(get, before, copies.length === 1 ? 'Wklejenie' : `Wklejenie ${copies.length} elementów`, null);
    scheduleSave(get);
  },

  canPaste: () => get().clipboard.length > 0,

  /* ---------------------------------------------------------------- */

  applyTextAction: (id, action, range, params) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const element = findElement(document.root, id);
    if (!element) return;

    const before = snapshot(get());
    const context: TextActionContext = {
      element,
      range,
      selectedText: plainTextSlice(element, range),
      allocateDocumentId: (base) => allocateDocumentId(document, base),
    };

    const result = action.apply(context, params);
    element.children = result.children;

    let scripts = state.scripts;
    const createdFiles = new Map(state.createdFiles);

    if (result.scriptSnippets.length > 0 || result.removedSnippetIds.length > 0) {
      const ensured = ensureScript(document, state.scriptSources);
      if (ensured.created && ensured.initialContent !== null) {
        createdFiles.set(ensured.relPath, ensured.initialContent);
      }
      const existingSource = ensured.initialContent ?? state.files[ensured.relPath] ?? '';
      scripts = applySnippets(
        scripts,
        ensured.relPath,
        existingSource,
        result.scriptSnippets,
        result.removedSnippetIds,
      );
    }

    set({ scripts, createdFiles, dirty: true });
    commit(get, before, result.description, null);
    scheduleSave(get);
  },

  /* ---------------------------------------------------------------- */
  /* Per-element dynamic scripts                                       */
  /* ---------------------------------------------------------------- */

  scriptTarget: () => {
    const state = get();
    if (!state.document) return null;

    const existing = findScriptTarget(state.scriptSources);
    if (existing) {
      return existing.kind === 'embedded'
        ? { kind: 'embedded', label: state.document.relPath }
        : { kind: 'external', label: existing.relPath };
    }

    // `scriptSources` is only rebuilt when the page is re-parsed, so a file
    // created earlier in this session shows up in the managed map first.
    const planned = joinRelative(dirname(state.document.relPath), 'script.js');
    return { kind: state.scripts.has(planned) ? 'external' : 'new', label: planned };
  },

  elementScriptState: (id) => {
    const empty: ElementScriptState = { binding: null, unrecognized: false, inlineHandlers: [] };
    const state = get();
    if (!state.document) return empty;
    const element = findElement(state.document.root, id);
    if (!element) return empty;

    // Handlers the page's author wrote by hand. They keep working — a generated
    // snippet is a separate listener — but the user should know they are there.
    const inlineHandlers = element.attrs
      .map((attr) => attr.name.toLowerCase())
      .filter((name) => /^on[a-z]+$/u.test(name));

    // The generated code addresses its target with `getElementById`, so the
    // element's `id` attribute *is* the binding key — an element without one
    // cannot have a generated script yet.
    const domId = getAttr(element, 'id');
    if (!domId) return { ...empty, inlineHandlers };

    const snippet = findManagedSnippet(state, elementScriptSnippetId(domId));
    if (!snippet) return { ...empty, inlineHandlers };

    const binding = parseElementScriptSnippet(snippet);
    return { binding, unrecognized: binding === null, inlineHandlers };
  },

  setElementScript: (id, binding) => {
    const state = get();
    const { document } = state;
    if (!document) return;
    const element = findElement(document.root, id);
    if (!element) return;

    const before = snapshot(get());

    let domId = getAttr(element, 'id');
    if (!domId || domId.trim() === '') {
      domId = allocateDocumentId(document, suggestDomId(element));
      setAttributeOn(element, 'id', domId);
    }

    // Where generated JavaScript goes: an existing writable script file, an
    // existing inline `<script>`, or a newly created `script.js` — the page's
    // own convention wins (see `ensureScript`).
    const ensured = ensureScript(document, state.scriptSources);
    const createdFiles = new Map(state.createdFiles);
    if (ensured.created && ensured.initialContent !== null) {
      createdFiles.set(ensured.relPath, ensured.initialContent);
    }
    const existingSource = ensured.initialContent ?? state.files[ensured.relPath] ?? '';

    // Re-applying must replace the snippet, never append a second copy — even
    // when an earlier version of it landed in a different script file.
    const snippetId = elementScriptSnippetId(domId);
    const scripts = applySnippets(
      withoutSnippet(state, snippetId),
      ensured.relPath,
      existingSource,
      [buildElementScriptSnippet(domId, binding)],
      [],
    );

    // The canvas never runs the page's own scripts, so without this the
    // element keeps showing whatever static text it had before — usually a
    // placeholder like "Kliknij dwukrotnie, aby edytować ten tekst." Writing
    // the computed preview into the DOM makes the canvas (and any no-JS
    // visitor) show a sensible value; the real script still overwrites it at
    // runtime. Skipped for presets whose preview can't be shown honestly
    // (custom code) and for elements with nested markup, where flattening to
    // plain text would destroy structure the script never touches.
    const preset = findPreset(binding.presetId) ?? ELEMENT_SCRIPT_PRESETS[0]!;
    const params = { ...defaultParamsFor(preset), ...binding.params };
    const plainText = element.children.every((child) => !isElement(child));
    const preview = plainText ? preset.preview(params, textContent(element).trim()) : null;
    if (preview) {
      element.children = [{ kind: 'text', id: createRuntimeNodeId(), value: preview.text }];
    }

    set({ scripts, createdFiles, dirty: true });
    // Structural: the element may have just gained an `id`, the page may have
    // gained a `<script>` tag, and its static text may have just changed —
    // all have to reach the canvas markup.
    commit(get, before, 'Skrypt elementu', null);
    scheduleSave(get);
  },

  removeElementScript: (id) => {
    const state = get();
    if (!state.document) return;
    const element = findElement(state.document.root, id);
    if (!element) return;
    const domId = getAttr(element, 'id');
    if (!domId) return;

    const scripts = withoutSnippet(state, elementScriptSnippetId(domId));
    if (scripts === state.scripts) return;

    const before = snapshot(get());
    set({ scripts, dirty: true });
    commit(get, before, 'Usunięcie skryptu elementu', null);
    scheduleSave(get);
  },

  /* ---------------------------------------------------------------- */

  undo: () => {
    const snapshotToRestore = useHistoryStore.getState().undo();
    if (snapshotToRestore) restore(set, get, snapshotToRestore);
  },

  redo: () => {
    const snapshotToRestore = useHistoryStore.getState().redo();
    if (snapshotToRestore) restore(set, get, snapshotToRestore);
  },

  /* ---------------------------------------------------------------- */

  applyExternalChange: (event) => {
    const state = get();
    if (!state.project) return;

    if (event.type === 'unlink') {
      const files = { ...state.files };
      delete files[event.relPath];
      set({ files });
      return;
    }
    if (event.content === null) return;

    const files = { ...state.files, [event.relPath]: event.content };
    set({ files });

    // A change to the page currently open, or to any file it depends on, means
    // the model has to be rebuilt from disk.
    const affectsCurrentPage =
      event.relPath === state.pageRelPath ||
      state.styleModels.some((model) => model.source.relPath === event.relPath) ||
      state.scriptSources.some((script) => script.relPath === event.relPath) ||
      // A file the page *asks for* but that did not exist when it was parsed.
      // It is not in `styleModels`/`scriptSources` precisely because it was
      // missing, so without this clause an assistant adding `<link
      // href="nowy.css">` and then writing `nowy.css` would leave the editor
      // showing an unstyled page until the project was reopened.
      state.missingRefs.some((reference) => reference.resolvedTarget === event.relPath);

    if (!affectsCurrentPage || !state.pageRelPath) return;

    /*
     * An external write to a file we have unsaved edits in — the AI assistant,
     * VS Code or a script changing the page while the 180 ms debounce is still
     * counting down.
     *
     * This used to bail out with a warning and nothing else, which was wrong
     * twice over: the editor kept showing the pre-change document until the
     * project was closed and reopened (the reported "AI edits the page and
     * Edycja shows nothing"), and worse, the pending save then wrote our stale
     * copy straight over the change that had just arrived — silently undoing
     * someone else's work on disk.
     *
     * The disk wins instead. The pending save is cancelled before it can run,
     * the file is re-parsed from what actually landed, and the user is told in
     * plain words. Losing an in-flight edit is a real cost, but it is bounded
     * by the debounce — at most the last fraction of a second of typing — while
     * the alternative discards a whole external change and hides the fact.
     */
    if (state.dirty) {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      logger.warn(
        `Plik ${event.relPath} zmieniono poza edytorem — wczytano wersję z dysku. ` +
          'Jeśli w tej sekundzie coś zmieniałeś w Litho, ta zmiana została pominięta.',
      );
    }

    const source = files[state.pageRelPath];
    if (source === undefined) return;

    try {
      const parsed = parseHtml(state.pageRelPath, source, { files });
      if (state.document) reconcileNodeIds(state.document.root, parsed.document.root);

      const styleModels = parseStyleSheets(parsed.styles);
      const validIds = new Set([...walk(parsed.document.root)].map((node) => node.id));
      set({
        document: parsed.document,
        styleModels,
        scriptSources: parsed.scripts,
        scripts: new Map(),
        classAllocator: new ClassNameAllocator([parsed.document.root]),
        notices: parsed.notices.map((notice) => notice.message),
        missingRefs: parsed.missingRefs,
        selection: state.selection.filter((id) => validIds.has(id)),
        hovered: null,
        ignoredOutOfLayout: state.ignoredOutOfLayout.filter((id) => validIds.has(id)),
        // Everything in memory now came straight off the disk, so there is by
        // definition nothing left to write back. Without this the cancelled
        // save would be re-armed by the next flush (window blur, project close)
        // and put the pre-change document back on top of the external edit.
        dirty: false,
        saveError: null,
        revision: state.revision + 1,
        // An external edit is re-parsed from scratch, so treat it as structural
        // regardless of what actually changed on disk.
        structureRevision: state.structureRevision + 1,
      });

      /*
       * The undo stack cannot survive this, so it is dropped deliberately.
       *
       * Every entry holds a *snapshot* of the document and stylesheets as they
       * were before and after an edit this session made. The file has just been
       * rewritten by something else — VS Code, a CLI in the terminal, git — and
       * re-parsed from scratch. Undoing now would not step back one edit: it
       * would overwrite the file with a whole document from before the external
       * change, silently discarding it. Losing the ability to undo is a small
       * cost; silently reverting someone else's work is not, so the stack goes.
       */
      if (useHistoryStore.getState().entries.length > 0) {
        useHistoryStore.getState().clear();
        logger.warn(
          `Plik ${event.relPath} zmieniono poza edytorem — historia cofania (Ctrl+Z) została zresetowana, żeby cofnięcie nie nadpisało tamtych zmian.`,
        );
      }
      logger.info(`Wczytano zmiany z dysku: ${event.relPath}`);
    } catch (error) {
      logger.error(`Nie udało się wczytać zmian z ${event.relPath}`, error);
    }
  },

  flushSave: async () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await performSave(get, set);
  },
}));

/* ------------------------------------------------------------------ */
/* Save pipeline                                                        */
/* ------------------------------------------------------------------ */

function scheduleSave(get: () => EditorState): void {
  // A fresh edit re-arms the automatic retry after earlier failures.
  saveFailureStreak = 0;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void performSave(get, useEditorStore.setState);
  }, SAVE_DEBOUNCE_MS);
}

async function performSave(
  get: () => EditorState,
  set: (partial: Partial<EditorState>) => void,
): Promise<void> {
  const state = get();
  if (!state.document || !state.dirty || state.saving) return;

  set({ saving: true, saveError: null });

  try {
    const writes = collectWrites({
      document: state.document,
      styleModels: state.styleModels,
      scripts: state.scripts,
      createdFiles: state.createdFiles,
    });

    // Shared sections ride along with the save that is already happening, so
    // the header edited here reaches the other subpages in the same write —
    // never as a second, separately-failing round trip.
    const propagated = propagateSharedSections(state);
    writes.push(...propagated.writes);

    const result = await window.litho.files.write(writes);
    if (!result.ok) {
      logger.error(`Zapis nie powiódł się: ${result.message}`, result.detail);
      set({ saving: false, saveError: result.message });
      retrySaveLater(get);
      return;
    }

    // Keep the in-memory file cache in step with what is now on disk, so a
    // later re-parse sees exactly what a browser would load.
    const files = { ...get().files };
    for (const write of writes) files[write.relPath] = write.content;

    saveFailureStreak = 0;
    set({
      saving: false,
      dirty: false,
      lastSavedAt: Date.now(),
      lastWrittenPaths: result.value.written,
      files,
      createdFiles: new Map(),
      saveError: null,
    });

    if (propagated.pages > 0) {
      logger.info(
        propagated.pages === 1
          ? 'Wspólną sekcję zaktualizowano na 1 podstronie.'
          : `Wspólną sekcję zaktualizowano na ${propagated.pages} podstronach.`,
      );
    }
  } catch (error) {
    logger.error('Nieoczekiwany błąd zapisu', error);
    set({ saving: false, saveError: 'Nieoczekiwany błąd zapisu. Szczegóły w panelu logów.' });
    retrySaveLater(get);
  }
}

/**
 * Copies every shared section of the open page into the other subpages that
 * carry the same marker, returning the extra writes for the caller to fold into
 * the save it is already performing.
 *
 * Deliberately text-in, text-out: each other page is parsed from the file cache,
 * patched and regenerated, and is never held as a live model. Only one page is
 * ever "open" — keeping four more parsed trees in memory would mean four more
 * things that can drift from disk, and the whole point of this architecture is
 * that the file is the truth.
 *
 * A page that does not carry the marker is left alone, and a page whose block
 * already matches produces no write at all, so this cannot churn files or the
 * watcher.
 */
function propagateSharedSections(state: EditorState): { writes: FileWrite[]; pages: number } {
  const { document, project } = state;
  if (!document || !project) return { writes: [], pages: 0 };

  const sections = findSharedSections(document);
  if (sections.length === 0) return { writes: [], pages: 0 };

  const writes: FileWrite[] = [];
  for (const page of project.pages) {
    if (page.relPath === document.relPath) continue;
    const source = state.files[page.relPath];
    if (source === undefined) continue;

    let target: PageDocument;
    try {
      target = parseHtml(page.relPath, source, { files: state.files }).document;
    } catch (error) {
      logger.warn(`Nie udało się zaktualizować wspólnej sekcji w ${page.relPath}`, error);
      continue;
    }

    let changed = false;
    for (const section of sections) {
      changed = replaceSharedSection(target, section.name, section.nodes) || changed;
    }
    if (changed) writes.push({ relPath: page.relPath, content: generateHtml(target) });
  }

  return { writes, pages: writes.length };
}

/**
 * A failed save leaves `dirty` set but nothing scheduled — without a retry the
 * user's edits would sit in memory until they happen to edit again. Transient
 * failures (an antivirus briefly locking the file) heal on their own; after a
 * few consecutive failures the error stays visible and the next edit retries.
 */
function retrySaveLater(get: () => EditorState): void {
  saveFailureStreak += 1;
  if (saveFailureStreak > MAX_SAVE_RETRIES) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void performSave(get, useEditorStore.setState);
  }, SAVE_RETRY_DELAY_MS * saveFailureStreak);
}

/* ------------------------------------------------------------------ */
/* History integration                                                  */
/* ------------------------------------------------------------------ */

function snapshot(state: EditorState): HistorySnapshot {
  return {
    document: state.document ? JSON.stringify(state.document) : '',
    styles: Object.fromEntries(
      state.styleModels.map((model) => [model.source.id, stringifyStyleSheet(model)]),
    ),
    scripts: JSON.stringify([...state.scripts.entries()]),
    selection: [...state.selection],
  };
}

function commit(
  get: () => EditorState,
  before: HistorySnapshot,
  label: string,
  mergeKey: string | null,
  kind: 'style' | 'structure' = 'structure',
  /**
   * Markup ops that fully describe this edit on a live DOM node.
   *
   * Passing them is a promise, and the promise is what buys the speed: if the
   * ops really do describe the whole markup change, the canvas can apply them
   * to the document it already has instead of reloading a rebuilt one, so the
   * commit deliberately does *not* count as structural. Pass `null` — the
   * default — whenever the change cannot be expressed that way, and the canvas
   * reloads as before. Getting this wrong shows up immediately as a canvas
   * rendering stale markup, which is why the ops are built next to the model
   * mutation they mirror rather than inferred afterwards.
   */
  patchOps: CanvasPatchOp[] | null = null,
): void {
  useHistoryStore.getState().push({ label, mergeKey, before, after: snapshot(get()) });
  const patched = patchOps !== null && patchOps.length > 0;
  // Every commit follows an in-place mutation, so signal the render layer that
  // the model changed even though the `document` reference did not.
  useEditorStore.setState((state) => ({
    revision: state.revision + 1,
    structureRevision:
      kind === 'structure' && !patched ? state.structureRevision + 1 : state.structureRevision,
    canvasPatch: patched ? { seq: (state.canvasPatch?.seq ?? 0) + 1, ops: patchOps } : state.canvasPatch,
  }));
}

/**
 * Attributes the canvas copy of the page rewrites rather than carrying through
 * verbatim — `annotateTree` in canvasDocument.ts strips inline handlers, drops
 * project-local stylesheet links and swaps `<iframe>`s for a placeholder box.
 * For those, "set this attribute on the live node" is *not* equivalent to a
 * rebuild, so the edit falls back to a full reload instead of quietly leaving
 * the canvas showing something the file does not say.
 */
function isPatchableAttribute(element: ElementNode, name: string): boolean {
  if (/^on/iu.test(name)) return false;
  return !['iframe', 'script', 'style', 'link', 'base', 'meta', 'title', 'head'].includes(element.tag);
}

function restore(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState,
  target: HistorySnapshot,
): void {
  const state = get();
  if (target.document === '') return;

  const document = JSON.parse(target.document) as PageDocument;
  const styleModels = parseStyleSheets(
    state.styleModels.map((model) => ({
      ...model.source,
      css: target.styles[model.source.id] ?? stringifyStyleSheet(model),
    })),
  );
  for (const model of styleModels) model.dirty = true;

  const scripts = new Map(JSON.parse(target.scripts) as Array<[string, ManagedScript]>);
  const validIds = new Set([...walk(document.root)].map((node) => node.id));

  set({
    document,
    styleModels,
    scripts,
    classAllocator: new ClassNameAllocator([document.root]),
    selection: target.selection.filter((id) => validIds.has(id)),
    dirty: true,
    revision: state.revision + 1,
    // Undo/redo can revert structural edits too, and there is no cheap way to
    // tell from a snapshot alone — always force the canvas to reload.
    structureRevision: state.structureRevision + 1,
  });
  scheduleSave(get);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Attaches the element scripts a template ships with, as part of the insertion
 * that is already happening.
 *
 * Deliberately not a call to `setElementScript`: that would push its own
 * history entry, so dropping a footer would take two Ctrl+Z presses to undo and
 * the first one would leave a footer with a dead script binding behind. This
 * does the same work — allocate a DOM id, find the page's script file, add the
 * snippet — and hands the results back for the caller to fold into its single
 * commit.
 *
 * The generated snippet is the ordinary kind: it shows up in the properties
 * panel under "Skrypt / Funkcja dynamiczna" and can be edited or removed there
 * like any other, and it reads as normal JavaScript in the project's own file.
 */
function attachTemplateScripts(
  state: EditorState,
  document: PageDocument,
  node: ElementNode,
  templateScripts: TemplateScript[],
): { scripts: Map<string, ManagedScript>; createdFiles: Map<string, string> } | null {
  const targets = templateScripts
    .map((entry) => ({ element: entry.find(node), binding: entry.binding }))
    .filter(
      (entry): entry is { element: ElementNode; binding: ElementScriptBinding } => entry.element !== null,
    );
  if (targets.length === 0) return null;

  const ensured = ensureScript(document, state.scriptSources);
  const createdFiles = new Map(state.createdFiles);
  if (ensured.created && ensured.initialContent !== null) {
    createdFiles.set(ensured.relPath, ensured.initialContent);
  }
  const existingSource = ensured.initialContent ?? state.files[ensured.relPath] ?? '';

  let scripts = state.scripts;
  for (const { element, binding } of targets) {
    let domId = getAttr(element, 'id');
    if (!domId || domId.trim() === '') {
      domId = allocateDocumentId(document, suggestDomId(element));
      setAttributeOn(element, 'id', domId);
    }
    scripts = applySnippets(
      scripts,
      ensured.relPath,
      existingSource,
      [buildElementScriptSnippet(domId, binding)],
      [],
    );

    // The canvas runs no page script, so without this the element would show
    // whatever the template hard-coded until the page is opened in a browser.
    // Same one-time snapshot `setElementScript` writes, for the same reason.
    const preset = findPreset(binding.presetId);
    const preview = preset?.preview({ ...defaultParamsFor(preset), ...binding.params }, '') ?? null;
    if (preview && element.children.every((child) => !isElement(child))) {
      element.children = [{ kind: 'text', id: createRuntimeNodeId(), value: preview.text }];
    }
  }

  return { scripts, createdFiles };
}

/**
 * Writes a declaration patch to an element's *own* selector — allocating a
 * unique class/id hook first when the element has none the rule could target,
 * exactly like `setStyle` does. Mutates both the given stylesheet models (via
 * `applyDeclarations`) and, when a hook is allocated, the element's attributes.
 * Shared by `placeFreeElement` for the dropped element and its container.
 *
 * Returns the canvas patch ops for the hook it had to allocate — empty when the
 * element already had a usable selector and only the stylesheet changed. Either
 * way the caller can commit without forcing a canvas reload: an empty list is a
 * pure CSS write, and a non-empty one describes the whole markup difference.
 */
function writeSelfDeclarations(
  document: PageDocument,
  styleModels: StyleSheetModel[],
  allocator: ClassNameAllocator,
  breakpoint: Breakpoint,
  element: ElementNode,
  patch: DeclarationPatch,
  label: string,
): CanvasPatchOp[] {
  const target = chooseStyleTarget(styleModels);
  if (!target) return [];
  const body = getBody(document);
  const plan = planSelector(element, {
    allocator,
    classCounts: countClasses(body ?? document.root),
    label,
  });
  const ops: CanvasPatchOp[] = [];
  if (plan.addClass) {
    const existing = getAttr(element, 'class');
    setAttributeOn(element, 'class', existing ? `${existing} ${plan.addClass}` : plan.addClass);
    ops.push({ kind: 'attribute', id: element.id, name: 'class', value: getAttr(element, 'class') ?? null });
  }
  if (plan.addId) {
    setAttributeOn(element, 'id', plan.addId);
    ops.push({ kind: 'attribute', id: element.id, name: 'id', value: plan.addId });
  }
  applyDeclarations(target.model, plan.selector, breakpoint, patch);
  return ops;
}

/** The stylesheet a CSS write lands in, plus what had to be created to get one. */
interface EnsuredStyleTarget {
  target: StyleTarget;
  /** Possibly a new array, when a stylesheet had to be created for the page. */
  styleModels: StyleSheetModel[];
  createdFiles: Map<string, string>;
  /** True when the page got a brand new `<link>` — a structural change. */
  created: boolean;
}

/**
 * Resolves where a CSS write goes, creating a stylesheet for the page only when
 * the project genuinely has none.
 *
 * Nothing is committed here: the caller folds the returned models and files into
 * its own `set` so the whole edit stays one undoable step. Pass `selector` to
 * keep an existing rule's declarations together in the sheet that already has
 * it (see `chooseSelectorTarget`); omit it for a hook that is being created now
 * anyway, which belongs in the last writable sheet.
 */
function ensureWritableTarget(state: EditorState, selector?: string): EnsuredStyleTarget | null {
  const { document } = state;
  if (!document) return null;

  const ensured = ensureStyleSheet(
    document,
    state.styleModels.map((model) => model.source),
  );
  let styleModels = state.styleModels;
  const createdFiles = new Map(state.createdFiles);

  if (ensured.created && ensured.initialContent !== null) {
    createdFiles.set(ensured.relPath, ensured.initialContent);
    styleModels = parseStyleSheets([
      ...styleModels.map((model) => ({ ...model.source, css: stringifyStyleSheet(model) })),
      {
        id: `style-created-${ensured.relPath}`,
        origin: 'external',
        relPath: ensured.relPath,
        href: ensured.relPath,
        hostNodeId: null,
        media: null,
        css: ensured.initialContent,
        writable: true,
        order: styleModels.length + 1,
      },
    ]);
  }

  const target = selector ? chooseSelectorTarget(styleModels, selector) : chooseStyleTarget(styleModels);
  if (!target) return null;

  return { target, styleModels, createdFiles, created: ensured.created };
}

/** The breakpoint that emits no media query — where base rules belong. */
function baseBreakpointOf(state: EditorState): Breakpoint {
  return state.breakpoints.find((breakpoint) => breakpoint.maxWidth === null) ?? state.breakpoints[0]!;
}

function setAttributeOn(element: ElementNode, name: string, value: string | null): void {
  const index = element.attrs.findIndex((attr) => attr.name.toLowerCase() === name.toLowerCase());
  if (value === null) {
    if (index !== -1) element.attrs.splice(index, 1);
    return;
  }
  if (index === -1) element.attrs.push({ name, value });
  else element.attrs[index] = { ...element.attrs[index]!, value };
}

/** The selector an element already has, without allocating a new one. */
function existingSelectorFor(element: ElementNode): string | null {
  const id = getAttr(element, 'id');
  if (id) return `#${id}`;
  const classes = (getAttr(element, 'class') ?? '').split(/\s+/u).filter(Boolean);
  const last = classes[classes.length - 1];
  return last ? `.${last}` : null;
}

function describeElement(element: ElementNode): string {
  const text = [...walk(element)]
    .filter((node) => node.kind === 'text')
    .map((node) => (node.kind === 'text' ? node.value : ''))
    .join(' ')
    .trim()
    .slice(0, 24);
  return text !== '' ? text : element.tag;
}

function cloneNode(node: ElementNode): ElementNode {
  const clone = (input: DocNode): DocNode => {
    if (input.kind === 'text') return { kind: 'text', id: createRuntimeNodeId(), value: input.value };
    if (input.kind === 'comment') return { kind: 'comment', id: createRuntimeNodeId(), value: input.value };
    return {
      kind: 'element',
      id: createRuntimeNodeId(),
      tag: input.tag,
      // A duplicated element must not reuse the original's `id` attribute.
      attrs: input.attrs.filter((attr) => attr.name.toLowerCase() !== 'id').map((attr) => ({ ...attr })),
      namespace: input.namespace,
      children: input.children.map(clone),
    };
  };
  return clone(node) as ElementNode;
}

/** Keeps a breakpoint's canvas width within a sane, editable range. */
function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return 375;
  return Math.max(200, Math.min(3840, Math.round(value)));
}

/** Tags that may hold arbitrary child elements — valid paste/group targets. */
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'form',
  'figure',
  'ul',
  'ol',
  'li',
  'body',
]);

export function canHoldChildren(element: ElementNode): boolean {
  return element.namespace === 'html' && CONTAINER_TAGS.has(element.tag);
}

/** True when any element in the subtree points at the shared placeholder image. */
function referencesPlaceholder(node: ElementNode): boolean {
  for (const entry of walk(node)) {
    if (entry.kind !== 'element') continue;
    const src = getAttr(entry, 'src');
    if (src && src.replace(/^\.\//u, '') === PLACEHOLDER_ASSET_PATH) return true;
  }
  return false;
}

function hasPlaceholderAsset(state: EditorState, createdFiles: Map<string, string>): boolean {
  if (createdFiles.has(PLACEHOLDER_ASSET_PATH)) return true;
  if (state.files[PLACEHOLDER_ASSET_PATH] !== undefined) return true;
  return state.assets.some((asset) => asset.relPath === PLACEHOLDER_ASSET_PATH);
}

/** The single element that is parent to all of `ids`, or null if they differ. */
function commonParent(root: ElementNode, ids: NodeId[]): ElementNode | null {
  let parent: ElementNode | null = null;
  for (const id of ids) {
    const found = findParent(root, id);
    if (!found) return null;
    if (parent === null) parent = found;
    else if (parent.id !== found.id) return null;
  }
  return parent;
}

function plainTextSlice(element: ElementNode, range: TextRange): string {
  let text = '';
  const visit = (nodes: DocNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'text') text += node.value;
      else if (isElement(node)) visit(node.children);
    }
  };
  visit(element.children);
  return text.slice(range.start, range.end);
}

/* ------------------------------------------------------------------ */
/* Stylesheet import helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Picks a free project-relative path for an uploaded stylesheet.
 *
 * The folder is inferred from where the project already keeps its CSS, so an
 * upload into a project organised as `css/…` does not suddenly create a second
 * convention next to it. Collisions get `-1`, `-2`, … rather than overwriting
 * a file the user may still be using.
 */
function uniqueStylePath(state: EditorState, fileName: string): string {
  const base = sanitizeFileName(stem(fileName), 'style');
  const folder = preferredStyleFolder(state);
  const taken = (candidate: string): boolean =>
    state.files[candidate] !== undefined || state.createdFiles.has(candidate);

  for (let index = 0; index < 1000; index += 1) {
    const candidate = joinRelative(folder, index === 0 ? `${base}.css` : `${base}-${index}.css`);
    if (!taken(candidate)) return candidate;
  }
  return joinRelative(folder, `${base}-${Date.now().toString(36)}.css`);
}

/** The folder holding most of the project's CSS today, or `styles/` if it has none. */
function preferredStyleFolder(state: EditorState): string {
  const counts = new Map<string, number>();
  for (const relPath of Object.keys(state.files)) {
    if (extname(relPath) !== '.css') continue;
    const folder = dirname(relPath);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [folder, count] of counts) {
    if (count > bestCount) {
      best = folder;
      bestCount = count;
    }
  }
  // `''` (the project root) is a legitimate answer, so only a genuine absence
  // falls through to the default.
  return best ?? 'styles';
}

/* ------------------------------------------------------------------ */
/* Managed-snippet lookup across the page's scripts                     */
/* ------------------------------------------------------------------ */

/** Key under which a script source is addressed in the `scripts` map. */
function scriptKeyFor(source: ScriptSource): string | null {
  if (source.origin === 'embedded') {
    return source.hostNodeId === null ? null : embeddedScriptKey(source.hostNodeId);
  }
  return source.relPath;
}

/** Current text of a script source, preferring what was last written to disk. */
function scriptTextFor(state: EditorState, source: ScriptSource): string {
  if (source.origin === 'external' && source.relPath) {
    return state.files[source.relPath] ?? source.code;
  }
  return source.code;
}

/**
 * Finds a managed snippet by id anywhere in the page's JavaScript: first in the
 * scripts an edit has already touched, then — parsing on demand — in the ones
 * it has not. That second step is what makes a binding survive closing and
 * re-opening the project: the state lives in the generated file, not in the app.
 */
function findManagedSnippet(state: EditorState, snippetId: string): ManagedSnippet | null {
  for (const script of state.scripts.values()) {
    const found = script.snippets.find((snippet) => snippet.id === snippetId);
    if (found) return found;
  }

  for (const source of state.scriptSources) {
    if (!source.writable) continue;
    const key = scriptKeyFor(source);
    if (key === null || state.scripts.has(key)) continue;
    const text = scriptTextFor(state, source);
    if (!text.includes(`[litho:${snippetId}]`)) continue;
    const found = parseManagedScript(text).snippets.find((snippet) => snippet.id === snippetId);
    if (found) return found;
  }
  return null;
}

/**
 * Returns the managed-script map with a snippet removed from wherever it lives,
 * or the original map when nothing carried it.
 *
 * An untouched script file is pulled into the map *only* when it genuinely
 * contains the snippet — adding it otherwise would make the next save rewrite
 * (and reformat) JavaScript Litho never generated, which is exactly what the
 * lazy `scripts` map exists to prevent.
 */
function withoutSnippet(state: EditorState, snippetId: string): Map<string, ManagedScript> {
  let changed = false;
  const next = new Map(state.scripts);

  for (const [key, script] of state.scripts) {
    if (!script.snippets.some((snippet) => snippet.id === snippetId)) continue;
    next.set(key, {
      ...script,
      snippets: script.snippets.filter((snippet) => snippet.id !== snippetId),
    });
    changed = true;
  }

  for (const source of state.scriptSources) {
    if (!source.writable) continue;
    const key = scriptKeyFor(source);
    if (key === null || next.has(key)) continue;
    const text = scriptTextFor(state, source);
    if (!text.includes(`[litho:${snippetId}]`)) continue;
    const parsed = parseManagedScript(text);
    next.set(key, {
      ...parsed,
      snippets: parsed.snippets.filter((snippet) => snippet.id !== snippetId),
    });
    changed = true;
  }

  return changed ? next : state.scripts;
}

/**
 * The combining marks `normalize('NFD')` splits accents into. Built from an
 * escaped source string rather than written as literal characters, which would
 * be invisible in an editor and easy to break on the next edit.
 */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'gu');

/** Letters `NFD` normalisation leaves alone, which would otherwise be dropped. */
const TRANSLITERATIONS: Record<string, string> = {
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z',
};

/**
 * A readable `id` for an element that has none, derived from its own text —
 * `#cena-promocyjna` rather than `#litho-7`, because this id ends up in the
 * user's HTML and in the generated `getElementById` call, where they will read
 * it back.
 */
function suggestDomId(element: ElementNode): string {
  const slug = describeElement(element)
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/gu, (char) => TRANSLITERATIONS[char] ?? char)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .slice(0, 24)
    .replace(/^-+|-+$/gu, '');

  if (slug === '') return `${element.tag}-dynamiczny`;
  // An id must not start with a digit to stay usable as a CSS selector.
  return /^[0-9]/u.test(slug) ? `el-${slug}` : slug;
}

/** Allocates an `id` attribute value that no element in the page uses yet. */
function allocateDocumentId(document: PageDocument, base: string): string {
  const taken = new Set<string>();
  for (const node of walk(document.root)) {
    if (node.kind !== 'element') continue;
    const id = getAttr(node, 'id');
    if (id) taken.add(id);
  }
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Derived selectors used by the UI                                     */
/* ------------------------------------------------------------------ */

export function ancestorsOf(document: PageDocument | null, id: NodeId): ElementNode[] {
  if (!document) return [];
  return findPath(document.root, id) ?? [];
}

export function isImageAsset(relPath: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'].includes(extname(relPath));
}

export function isAudioAsset(relPath: string): boolean {
  return ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.weba'].includes(extname(relPath));
}
