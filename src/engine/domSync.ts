import type { DocNode, ElementNode, NodeId, PageDocument } from '@shared/document.js';
import { findFirstTag, getAttr, walk } from '@shared/document.js';
import type { FileWrite, ScriptSource, StyleSource } from '@shared/project.js';
import { relativeHref, dirname, joinRelative, resolveHref } from '@shared/paths.js';
import { createRuntimeNodeId } from './idAllocator.js';
import { generateHtml } from './htmlGenerator.js';
import { emptyStyleSheetContent, stringifyStyleSheet, type StyleSheetModel } from './cssGenerator.js';
import {
  parseManagedScript,
  renderManagedScript,
  type ManagedScript,
  type ManagedSnippet,
} from './jsGenerator.js';

/**
 * Two-way synchronisation between the in-memory model and the files on disk.
 *
 * Model → files (`collectWrites`) is the easy direction. Files → model is the
 * interesting one: when the watcher reports that someone edited `index.html` in
 * VS Code, the page is re-parsed from scratch, which would hand every node a
 * fresh id and drop the user's selection, expanded layers and undo references.
 * `reconcileNodeIds` maps the new tree back onto the old ids wherever the two
 * still describe the same element, so an external edit feels like a refresh
 * rather than a reset.
 */

/* ------------------------------------------------------------------ */
/* Files -> model: keeping node ids stable across a re-parse            */
/* ------------------------------------------------------------------ */

/**
 * Rewrites ids in `next` to reuse ids from `previous` for nodes that match.
 *
 * Matching is structural and deliberately conservative: same tag, and either
 * the same `id`/`class` signature or the same position among siblings. A node
 * that cannot be matched confidently keeps its fresh id, which is always safe -
 * the worst outcome is that the selection is lost for that one element.
 *
 * Mutates `next` in place and returns it.
 */
export function reconcileNodeIds(previous: ElementNode, next: ElementNode): ElementNode {
  matchElement(previous, next);
  return next;
}

function matchElement(previous: ElementNode, next: ElementNode): void {
  if (previous.tag !== next.tag) return;
  next.id = previous.id;

  const previousElements = previous.children.filter(isElementNode);
  const nextElements = next.children.filter(isElementNode);

  const usedPrevious = new Set<number>();
  const resolved = new Set<number>();

  // Pass 1: match on a stable signature (id, else the exact class list). This
  // survives reordering, which positional matching alone cannot.
  nextElements.forEach((candidate, candidateIndex) => {
    const signature = signatureOf(candidate);
    if (signature === null) return;
    const index = previousElements.findIndex(
      (entry, position) => !usedPrevious.has(position) && signatureOf(entry) === signature,
    );
    if (index === -1) return;
    usedPrevious.add(index);
    resolved.add(candidateIndex);
    const matched = previousElements[index];
    if (matched) matchElement(matched, candidate);
  });

  // Pass 2: positional matching for the rest, requiring an identical tag so a
  // wrong guess cannot transplant an id onto an unrelated element.
  let cursor = 0;
  nextElements.forEach((candidate, candidateIndex) => {
    if (resolved.has(candidateIndex)) return;
    while (cursor < previousElements.length && usedPrevious.has(cursor)) cursor += 1;
    const matched = previousElements[cursor];
    if (!matched) return;
    if (matched.tag !== candidate.tag) return;
    usedPrevious.add(cursor);
    cursor += 1;
    matchElement(matched, candidate);
  });
}

function signatureOf(element: ElementNode): string | null {
  const id = getAttr(element, 'id');
  if (id) return `${element.tag}#${id}`;
  const className = getAttr(element, 'class');
  if (className) return `${element.tag}.${className.trim().replace(/\s+/gu, ' ')}`;
  return null;
}

function isElementNode(node: DocNode): node is ElementNode {
  return node.kind === 'element';
}

/* ------------------------------------------------------------------ */
/* Ensuring a page has somewhere to put generated code                  */
/* ------------------------------------------------------------------ */

export interface EnsureStyleSheetResult {
  /** Relative path of the stylesheet to write into. */
  relPath: string;
  /** True when the file and its `<link>` had to be created. */
  created: boolean;
  /** Initial content for a newly created file. */
  initialContent: string | null;
}

/**
 * Guarantees the page has a stylesheet Litho may write to.
 *
 * Order of preference: an existing writable external sheet, then an existing
 * writable `<style>` block, and only if neither exists a new `style.css` next
 * to the page with a `<link>` appended to `<head>`. A page that already keeps
 * its CSS inline therefore *stays* inline - the editor adapts to the project's
 * conventions rather than imposing its own.
 */
export function ensureStyleSheet(document: PageDocument, styles: StyleSource[]): EnsureStyleSheetResult {
  const writableExternal = [...styles]
    .reverse()
    .find((style) => style.writable && style.origin === 'external' && style.relPath);
  if (writableExternal?.relPath) {
    return { relPath: writableExternal.relPath, created: false, initialContent: null };
  }

  const writableEmbedded = [...styles]
    .reverse()
    .find((style) => style.writable && style.origin === 'embedded');
  if (writableEmbedded) {
    // Embedded sheets are addressed by their source id, not a path.
    return { relPath: document.relPath, created: false, initialContent: null };
  }

  const target = joinRelative(dirname(document.relPath), 'style.css');
  const head = findFirstTag(document.root, 'head');
  const link: ElementNode = {
    kind: 'element',
    id: createRuntimeNodeId(),
    tag: 'link',
    attrs: [
      { name: 'rel', value: 'stylesheet' },
      { name: 'href', value: relativeHref(document.relPath, target) },
    ],
    namespace: 'html',
    children: [],
  };
  if (head) head.children.push(link);
  else document.root.children.unshift(link);

  return { relPath: target, created: true, initialContent: emptyStyleSheetContent() };
}

export interface EnsureScriptResult {
  /**
   * Key identifying where generated snippets go: a project-relative path for a
   * real file, or an `embeddedScriptKey()` synthetic key for an inline
   * `<script>` block. `collectWrites` and `editorStore` both switch on
   * `parseEmbeddedScriptKey()` rather than assuming this is always a path.
   */
  relPath: string;
  created: boolean;
  /**
   * Seed content for `relPath` when it is not already tracked: the starter
   * content for a newly created file, or the current text of an inline
   * `<script>` block reused from the page. `null` means "look the existing
   * content up from disk" (an untouched external file).
   */
  initialContent: string | null;
}

const EMBEDDED_SCRIPT_PREFIX = 'embedded-script:';

/** Synthetic `scripts` map key for an inline `<script>` element. */
export function embeddedScriptKey(hostNodeId: NodeId): string {
  return `${EMBEDDED_SCRIPT_PREFIX}${hostNodeId}`;
}

/** Extracts the host node id back out of an `embeddedScriptKey()`, if it is one. */
export function parseEmbeddedScriptKey(key: string): NodeId | null {
  return key.startsWith(EMBEDDED_SCRIPT_PREFIX) ? key.slice(EMBEDDED_SCRIPT_PREFIX.length) : null;
}

export interface ScriptTarget {
  /** Same key as `EnsureScriptResult.relPath`: a file path or an embedded key. */
  relPath: string;
  /** Whether that key points at a real file or at a `<script>` block in the page. */
  kind: 'external' | 'embedded';
  initialContent: string | null;
}

/**
 * The script the page *already has* that generated code should go into, or
 * `null` when it has none.
 *
 * Deliberately pure - it never touches the document - so the UI can ask "where
 * would this land?" without an edit happening as a side effect of asking.
 */
export function findScriptTarget(scripts: ScriptSource[]): ScriptTarget | null {
  const writableExternal = [...scripts]
    .reverse()
    .find((script) => script.writable && script.origin === 'external' && script.relPath);
  if (writableExternal?.relPath) {
    return { relPath: writableExternal.relPath, kind: 'external', initialContent: null };
  }

  const writableEmbedded = [...scripts]
    .reverse()
    .find((script) => script.writable && script.origin === 'embedded' && script.hostNodeId);
  if (writableEmbedded?.hostNodeId) {
    return {
      relPath: embeddedScriptKey(writableEmbedded.hostNodeId),
      kind: 'embedded',
      initialContent: writableEmbedded.code,
    };
  }

  return null;
}

/**
 * Same contract as `ensureStyleSheet`, for the place that receives generated
 * JavaScript.
 *
 * Order of preference mirrors `ensureStyleSheet` (see `findScriptTarget`): an
 * existing writable external script, then an existing writable inline
 * `<script>` block, and only if neither exists a new `script.js` next to the
 * page with a `<script src>` appended to `<body>` (`defer` omitted - placing it
 * last is the classic, dependency-free way to guarantee the DOM exists when the
 * snippet runs). A page that already keeps its JavaScript inline therefore
 * *stays* inline.
 */
export function ensureScript(document: PageDocument, scripts: ScriptSource[]): EnsureScriptResult {
  const existing = findScriptTarget(scripts);
  if (existing) {
    return { relPath: existing.relPath, created: false, initialContent: existing.initialContent };
  }

  const target = joinRelative(dirname(document.relPath), 'script.js');

  // A `<script src>` this function appended earlier in the session is in the
  // *document* but not yet in `scripts` - that list is only rebuilt when the
  // page is re-parsed from disk. Without this check a second generated snippet
  // would append a second identical `<script>` tag to the page. (The stylesheet
  // side has no equivalent hole: `setStyle` folds the sheet it just created
  // back into `styleModels` straight away.)
  const alreadyLinked = findScriptElementFor(document, target);
  if (alreadyLinked) return { relPath: target, created: false, initialContent: null };

  const body = findFirstTag(document.root, 'body');
  const scriptTag: ElementNode = {
    kind: 'element',
    id: createRuntimeNodeId(),
    tag: 'script',
    attrs: [{ name: 'src', value: relativeHref(document.relPath, target) }],
    namespace: 'html',
    children: [],
  };
  if (body) body.children.push(scriptTag);
  else document.root.children.push(scriptTag);

  return { relPath: target, created: true, initialContent: '' };
}

/** The page's own `<script src>` pointing at a project-relative path, if any. */
function findScriptElementFor(document: PageDocument, targetRelPath: string): ElementNode | null {
  for (const node of walk(document.root)) {
    if (node.kind !== 'element' || node.tag !== 'script') continue;
    const src = getAttr(node, 'src');
    if (src === undefined) continue;
    if (resolveHref(document.relPath, src) === targetRelPath) return node;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Model -> files                                                       */
/* ------------------------------------------------------------------ */

export interface SerialiseInput {
  document: PageDocument;
  styleModels: StyleSheetModel[];
  /** Managed-script state keyed by the script's relative path. */
  scripts: Map<string, ManagedScript>;
  /** Files created during this edit that do not exist on disk yet. */
  createdFiles?: Map<string, string>;
}

/**
 * Produces the complete set of file writes for the current model state.
 *
 * Embedded `<style>` and `<script>` content is written back into the HTML by
 * updating the host element's text child, so a project that keeps everything in
 * one file continues to do so - there is exactly one write, of `index.html`.
 */
export function collectWrites(input: SerialiseInput): FileWrite[] {
  const writes: FileWrite[] = [];
  const { document, styleModels } = input;

  // Embedded stylesheets live inside the HTML: push their text back into the
  // owning <style> element before the document is serialised.
  for (const model of styleModels) {
    if (!model.dirty) continue;
    if (model.source.origin === 'embedded' && model.source.hostNodeId) {
      const host = findById(document.root, model.source.hostNodeId);
      if (host && host.kind === 'element') {
        host.children = [
          { kind: 'text', id: createRuntimeNodeId(), value: `\n${stringifyStyleSheet(model).trim()}\n` },
        ];
      }
      continue;
    }
    if (model.source.relPath) {
      writes.push({ relPath: model.source.relPath, content: stringifyStyleSheet(model) });
    }
  }

  for (const [relPath, script] of input.scripts) {
    const embeddedHostId = parseEmbeddedScriptKey(relPath);
    if (embeddedHostId !== null) {
      const host = findById(document.root, embeddedHostId);
      if (host && host.kind === 'element') {
        host.children = [
          { kind: 'text', id: createRuntimeNodeId(), value: `\n${renderManagedScript(script).trim()}\n` },
        ];
      }
      continue;
    }
    writes.push({ relPath, content: renderManagedScript(script) });
  }

  for (const [relPath, content] of input.createdFiles ?? []) {
    if (!writes.some((write) => write.relPath === relPath)) {
      writes.push({ relPath, content });
    }
  }

  writes.push({ relPath: document.relPath, content: generateHtml(document) });

  // Deduplicate, keeping the last write for a path - the HTML write above must
  // win over a stale entry from `createdFiles`.
  const byPath = new Map<string, FileWrite>();
  for (const write of writes) byPath.set(write.relPath, write);
  return [...byPath.values()];
}

export function findById(root: DocNode, id: NodeId): DocNode | null {
  for (const node of walk(root)) {
    if (node.id === id) return node;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Script snippet plumbing                                              */
/* ------------------------------------------------------------------ */

/**
 * Applies a text action's script side effects to the managed-script map,
 * loading the file's existing content on first touch so user code is preserved.
 */
export function applySnippets(
  scripts: Map<string, ManagedScript>,
  relPath: string,
  existingSource: string,
  added: ManagedSnippet[],
  removedIds: string[],
): Map<string, ManagedScript> {
  const next = new Map(scripts);
  const current = next.get(relPath) ?? parseManagedScript(existingSource);

  let snippets = current.snippets.filter((snippet) => !removedIds.includes(snippet.id));
  for (const snippet of added) {
    const index = snippets.findIndex((entry) => entry.id === snippet.id);
    if (index === -1) snippets = [...snippets, snippet];
    else snippets = snippets.map((entry, position) => (position === index ? snippet : entry));
  }

  next.set(relPath, { ...current, snippets });
  return next;
}
