import { parse, type DefaultTreeAdapterMap } from 'parse5';
import type {
  Attribute,
  CommentNode,
  DocNode,
  DoctypeInfo,
  ElementNode,
  PageDocument,
  TextNode,
} from '@shared/document.js';
import { getAttr, textContent, walk } from '@shared/document.js';
import type { NodeId } from '@shared/document.js';
import type { ScriptSource, StyleSource } from '@shared/project.js';
import { basename, extname, resolveHref, stem } from '@shared/paths.js';
import { NodeAllocator } from './idAllocator.js';

/**
 * HTML → document model.
 *
 * This is the module the "open any folder" requirement rests on. It makes no
 * assumptions whatsoever about how the page is organised:
 *
 *  - `<style>` blocks, one external stylesheet, five external stylesheets, or
 *    any mixture, all become `StyleSource` entries in document order;
 *  - the same holds for `<script>`, inline or external, classic or module;
 *  - comments, unknown tags, malformed nesting, absent `<html>`/`<body>`,
 *    inconsistent indentation and unused classes are all preserved or
 *    normalised by the HTML5 parsing algorithm rather than rejected.
 *
 * parse5 implements the actual WHATWG algorithm, so whatever a browser would
 * make of the file is what the editor sees. No custom regex parsing anywhere.
 */

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5ParentNode = DefaultTreeAdapterMap['parentNode'];

export interface ParsedPage {
  document: PageDocument;
  styles: StyleSource[];
  scripts: ScriptSource[];
  /** Diagnostics worth surfacing in the console panel, never fatal. */
  notices: ParseNotice[];
  /** Local CSS/JS references whose file does not exist, with repair options. */
  missingRefs: MissingReference[];
}

export interface ParseNotice {
  level: 'info' | 'warn';
  message: string;
}

/**
 * A `<link>`/`<script>` that points at a project-local file which is not there.
 *
 * The page was probably moved, or the reference was written against a different
 * folder layout. The editor cannot know which file was meant, so it collects
 * plausible candidates and lets the user pick — the chosen path is then written
 * back into the HTML.
 */
export interface MissingReference {
  kind: 'css' | 'js';
  /** The href/src exactly as written in the HTML. */
  href: string;
  /** Id of the `<link>`/`<script>` element carrying the reference. */
  hostNodeId: NodeId;
  /** Project-relative path the reference resolves to (which does not exist). */
  resolvedTarget: string;
  /** Existing project files that plausibly are the intended target, best first. */
  candidates: string[];
}

export interface ParseOptions {
  /** Contents of every text file in the project, keyed by relative path. */
  files?: Record<string, string>;
  /** Overrides id generation; used by `domSync` to keep ids stable. */
  allocator?: NodeAllocator;
}

export function parseHtml(relPath: string, source: string, options: ParseOptions = {}): ParsedPage {
  const allocator = options.allocator ?? new NodeAllocator();
  const files = options.files ?? {};
  const notices: ParseNotice[] = [];

  const parsed = parse(source, { sourceCodeLocationInfo: false });

  const doctype = extractDoctype(parsed);
  const htmlElement = parsed.childNodes.find(
    (node): node is P5Element => isElementNode(node) && node.tagName === 'html',
  );

  if (!htmlElement) {
    // parse5 always synthesises <html>; reaching here means the input was not a
    // string of markup at all. Produce an empty but valid page rather than throw.
    notices.push({
      level: 'warn',
      message: `Plik ${relPath} nie zawiera struktury HTML — utworzono pustą stronę.`,
    });
    return {
      document: {
        relPath,
        doctype,
        root: emptyHtml(allocator),
        lineEnding: detectLineEnding(source),
        indent: detectIndent(source),
      },
      styles: [],
      scripts: [],
      notices,
      missingRefs: [],
    };
  }

  const root = convertElement(htmlElement, allocator);
  const document: PageDocument = {
    relPath,
    doctype,
    root,
    lineEnding: detectLineEnding(source),
    indent: detectIndent(source),
  };

  const { styles, scripts, missingRefs } = collectSources(document, files, notices);
  return { document, styles, scripts, notices, missingRefs };
}

/* ------------------------------------------------------------------ */
/* parse5 -> DocNode                                                    */
/* ------------------------------------------------------------------ */

function convertElement(element: P5Element, allocator: NodeAllocator): ElementNode {
  const node: ElementNode = {
    kind: 'element',
    id: allocator.next(),
    tag: element.tagName.toLowerCase(),
    attrs: element.attrs.map(toAttribute),
    children: [],
    namespace: toNamespace(element.namespaceURI),
  };

  for (const child of element.childNodes) {
    const converted = convertNode(child, allocator);
    if (converted) node.children.push(converted);
  }

  // `<template>` keeps its content in a separate document fragment.
  if (node.tag === 'template' && 'content' in element && element.content) {
    for (const child of (element.content as P5ParentNode).childNodes) {
      const converted = convertNode(child, allocator);
      if (converted) node.children.push(converted);
    }
  }

  return node;
}

function convertNode(node: P5Node, allocator: NodeAllocator): DocNode | null {
  if (isElementNode(node)) return convertElement(node, allocator);

  if (node.nodeName === '#text') {
    const text: TextNode = {
      kind: 'text',
      id: allocator.next(),
      value: (node as DefaultTreeAdapterMap['textNode']).value,
    };
    return text;
  }

  if (node.nodeName === '#comment') {
    const comment: CommentNode = {
      kind: 'comment',
      id: allocator.next(),
      value: (node as DefaultTreeAdapterMap['commentNode']).data,
    };
    return comment;
  }

  // #documentType is handled separately; anything else is not representable.
  return null;
}

function toAttribute(attr: { name: string; value: string; prefix?: string }): Attribute {
  return attr.prefix
    ? { name: attr.name, value: attr.value, prefix: attr.prefix }
    : { name: attr.name, value: attr.value };
}

function toNamespace(uri: string | undefined): ElementNode['namespace'] {
  if (uri === 'http://www.w3.org/2000/svg') return 'svg';
  if (uri === 'http://www.w3.org/1998/Math/MathML') return 'math';
  return 'html';
}

function isElementNode(node: P5Node): node is P5Element {
  return 'tagName' in node && typeof (node as P5Element).tagName === 'string';
}

function extractDoctype(parsed: DefaultTreeAdapterMap['document']): DoctypeInfo | null {
  for (const node of parsed.childNodes) {
    if (node.nodeName === '#documentType') {
      const doctype = node as DefaultTreeAdapterMap['documentType'];
      return { name: doctype.name, publicId: doctype.publicId, systemId: doctype.systemId };
    }
  }
  return null;
}

function emptyHtml(allocator: NodeAllocator): ElementNode {
  return {
    kind: 'element',
    id: allocator.next(),
    tag: 'html',
    attrs: [],
    namespace: 'html',
    children: [
      { kind: 'element', id: allocator.next(), tag: 'head', attrs: [], namespace: 'html', children: [] },
      { kind: 'element', id: allocator.next(), tag: 'body', attrs: [], namespace: 'html', children: [] },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Style and script discovery                                          */
/* ------------------------------------------------------------------ */

/**
 * Walks the page in document order and records every stylesheet and script,
 * wherever it happens to live. Order matters: it is the cascade order, and the
 * generator writes into the *last writable* source so generated rules win over
 * the page's existing ones without `!important`.
 */
function collectSources(
  document: PageDocument,
  files: Record<string, string>,
  notices: ParseNotice[],
): { styles: StyleSource[]; scripts: ScriptSource[]; missingRefs: MissingReference[] } {
  const styles: StyleSource[] = [];
  const scripts: ScriptSource[] = [];
  const missingRefs: MissingReference[] = [];
  let order = 0;

  for (const node of walk(document.root)) {
    if (node.kind !== 'element') continue;

    if (node.tag === 'link') {
      const rel = (getAttr(node, 'rel') ?? '').toLowerCase();
      if (!rel.split(/\s+/u).includes('stylesheet')) continue;

      const href = getAttr(node, 'href') ?? '';
      const target = resolveHref(document.relPath, href);
      order += 1;

      if (target === null) {
        // A CDN or absolute URL: it still participates in the cascade visually,
        // but Litho must never try to edit it.
        styles.push({
          id: `style-ext-${order}`,
          origin: 'external',
          relPath: null,
          href,
          hostNodeId: node.id,
          media: getAttr(node, 'media') ?? null,
          css: '',
          writable: false,
          order,
        });
        continue;
      }

      const found = lookupFile(files, target);
      if (found === undefined) {
        notices.push({
          level: 'warn',
          message: `Arkusz stylów "${href}" jest podlinkowany, ale nie znaleziono pliku ${target}.`,
        });
        missingRefs.push({
          kind: 'css',
          href,
          hostNodeId: node.id,
          resolvedTarget: target,
          candidates: findReferenceCandidates(files, target, 'css'),
        });
      }

      styles.push({
        id: `style-ext-${order}`,
        origin: 'external',
        relPath: found?.actualPath ?? target,
        href,
        hostNodeId: node.id,
        media: getAttr(node, 'media') ?? null,
        css: found?.content ?? '',
        writable: found !== undefined && !looksMinified(found.content),
        order,
      });
      continue;
    }

    if (node.tag === 'style') {
      order += 1;
      const css = textContent(node);
      styles.push({
        id: `style-inline-${order}`,
        origin: 'embedded',
        relPath: null,
        href: null,
        hostNodeId: node.id,
        media: getAttr(node, 'media') ?? null,
        css,
        writable: !looksMinified(css),
        order,
      });
      continue;
    }

    if (node.tag === 'script') {
      const type = (getAttr(node, 'type') ?? '').toLowerCase();
      // Skip data blocks: `application/json`, `text/template`, importmaps.
      const isJavaScript =
        type === '' || type === 'module' || /^(text|application)\/(java|ecma)script$/u.test(type);
      if (!isJavaScript) continue;

      order += 1;
      const src = getAttr(node, 'src');

      if (src !== undefined) {
        const target = resolveHref(document.relPath, src);
        const found = target === null ? undefined : lookupFile(files, target);
        scripts.push({
          id: `script-ext-${order}`,
          origin: 'external',
          relPath: found?.actualPath ?? target,
          src,
          hostNodeId: node.id,
          code: found?.content ?? '',
          writable: found !== undefined && !looksMinified(found.content),
          order,
          isModule: type === 'module',
        });
        if (target !== null && found === undefined) {
          notices.push({
            level: 'warn',
            message: `Skrypt "${src}" jest podlinkowany, ale nie znaleziono pliku ${target}.`,
          });
          missingRefs.push({
            kind: 'js',
            href: src,
            hostNodeId: node.id,
            resolvedTarget: target,
            candidates: findReferenceCandidates(files, target, 'js'),
          });
        }
        continue;
      }

      const code = textContent(node);
      scripts.push({
        id: `script-inline-${order}`,
        origin: 'embedded',
        relPath: null,
        src: null,
        hostNodeId: node.id,
        code,
        writable: !looksMinified(code),
        order,
        isModule: type === 'module',
      });
    }
  }

  return { styles, scripts, missingRefs };
}

/**
 * Looks a resolved reference up in the project's files, falling back to a
 * case-insensitive match.
 *
 * Windows and macOS filesystems are case-insensitive, so an href written as
 * `Style.css` against a file saved as `style.css` opens and behaves correctly
 * for the person who wrote it — flagging that as a *missing* reference (which
 * `findReferenceCandidates` would then have to rank back to the very same
 * file) is a false positive, not a real repair the user needs to make.
 * `actualPath` — the key exactly as it exists in `files` — is what gets used
 * for reads and writes; the href in the HTML is left untouched.
 */
function lookupFile(
  files: Record<string, string>,
  target: string,
): { content: string; actualPath: string } | undefined {
  const exact = files[target];
  if (exact !== undefined) return { content: exact, actualPath: target };

  const lower = target.toLowerCase();
  for (const key of Object.keys(files)) {
    if (key.toLowerCase() === lower) return { content: files[key]!, actualPath: key };
  }
  return undefined;
}

const CANDIDATE_EXTENSIONS: Record<MissingReference['kind'], readonly string[]> = {
  css: ['.css'],
  js: ['.js', '.mjs'],
};

const MAX_CANDIDATES = 8;

/**
 * Ranks the project's files as repair candidates for a broken reference:
 * exact file name match first (the page was moved), then same stem (the file
 * was renamed slightly), then any other file of the right type. The list is
 * what the UI offers the user to choose from — never applied automatically.
 */
export function findReferenceCandidates(
  files: Record<string, string>,
  resolvedTarget: string,
  kind: MissingReference['kind'],
): string[] {
  const extensions = CANDIDATE_EXTENSIONS[kind];
  const wantedName = basename(resolvedTarget).toLowerCase();
  const wantedStem = stem(resolvedTarget).toLowerCase();

  const sameName: string[] = [];
  const sameStem: string[] = [];
  const sameType: string[] = [];

  for (const relPath of Object.keys(files).sort()) {
    if (!extensions.includes(extname(relPath))) continue;
    if (relPath === resolvedTarget) continue;
    if (basename(relPath).toLowerCase() === wantedName) sameName.push(relPath);
    else if (stem(relPath).toLowerCase() === wantedStem) sameStem.push(relPath);
    else sameType.push(relPath);
  }

  return [...sameName, ...sameStem, ...sameType].slice(0, MAX_CANDIDATES);
}

/**
 * Heuristic for machine-generated bundles Litho should leave alone.
 *
 * Rewriting a minified vendor file would destroy it, so the bar is deliberately
 * conservative: only flag sources that are both large and essentially
 * single-line. A hand-written file with long lines still passes.
 */
export function looksMinified(source: string): boolean {
  if (source.length < 4000) return false;
  const lines = source.split('\n');
  const averageLineLength = source.length / Math.max(1, lines.length);
  return averageLineLength > 400;
}

/* ------------------------------------------------------------------ */
/* Source-style detection                                              */
/* ------------------------------------------------------------------ */

/** Preserves the file's existing line endings so diffs stay clean on Windows. */
export function detectLineEnding(source: string): '\n' | '\r\n' {
  const firstNewline = source.indexOf('\n');
  if (firstNewline <= 0) return '\n';
  return source[firstNewline - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Infers the file's indentation unit. Falls back to two spaces, which is what
 * the generator emits for a file that has no indentation to learn from.
 */
export function detectIndent(source: string): string {
  const lines = source.split('\n').slice(0, 500);
  let tabs = 0;
  const spaceWidths: number[] = [];

  for (const line of lines) {
    const match = /^([\t ]+)\S/u.exec(line);
    if (!match?.[1]) continue;
    const indent = match[1];
    if (indent.includes('\t')) {
      tabs += 1;
      continue;
    }
    spaceWidths.push(indent.length);
  }

  if (tabs > spaceWidths.length) return '\t';
  if (spaceWidths.length === 0) return '  ';

  // The smallest non-zero indent step is the unit.
  const smallest = spaceWidths.reduce((min, width) => (width > 0 && width < min ? width : min), Infinity);
  if (!Number.isFinite(smallest)) return '  ';
  return ' '.repeat(Math.min(8, Math.max(1, smallest)));
}
