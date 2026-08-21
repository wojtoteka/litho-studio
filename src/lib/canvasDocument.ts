import type { DocNode, ElementNode, PageDocument } from '@shared/document.js';
import { getAttr, isElement, NON_VISUAL_ELEMENTS } from '@shared/document.js';
import { generateHtml } from '@/engine/htmlGenerator.js';
import type { StyleSheetModel } from '@/engine/cssGenerator.js';
import { canvasCss } from '@/engine/canvasCss.js';
import { revealHookSelectorList } from '@/engine/revealHooks.js';
import { dirname, resolveHref, toPosix } from '@shared/paths.js';

/**
 * Builds the document rendered inside the canvas iframe.
 *
 * The canvas shows the *real* page - same markup, same CSS, so what the user
 * sees is what a browser will show. The deliberate differences:
 *
 *  1. **`data-litho-id` on every element.** Added to this copy only, never to
 *     the file on disk, so the overlay can map a DOM node back to a tree node
 *     without the project ever gaining editor-specific attributes.
 *  2. **Scripts are removed.** The page's own JavaScript would fight the editor
 *     (routers, scroll hijacking, animations that move elements out from under
 *     the pointer). The live preview pane is where scripts do run.
 *  3. **A `<base>` element.** The iframe's document has the app's own URL, so
 *     without it every relative `src`/`href` in the project would fail to load.
 *  4. **`<iframe>`s become a placeholder box.** Third-party embeds (maps, video
 *     players, …) can't load in the canvas - the editor's CSP blocks all
 *     framing (`frame-src 'none'`) as part of its offline-by-default network
 *     policy - so a live embed would just sit blank. The placeholder carries
 *     the real node's `id`/`class` (so it's sized and selected exactly like
 *     the element it stands in for) and swaps back to the genuine `<iframe>`
 *     in Preview and in the saved/exported HTML.
 *  5. **Animations are held at their end state.** Editing on top of moving
 *     content is the problem; see `MOTIONLESS_CANVAS_CSS`. The page's own
 *     motion is untouched and plays in the live preview.
 *
 * Stylesheet handling splits by origin: project-local `<link>`s are dropped and
 * their CSS re-injected from the in-memory models (which include unsaved
 * edits), while remote `<link>`s (CDN frameworks, web fonts) are kept so the
 * page renders with them exactly as a browser would.
 *
 * The iframe is same-origin (`srcdoc`), which lets the canvas read layout
 * directly from `contentDocument` instead of round-tripping through
 * `postMessage`.
 */

export const CANVAS_ID_ATTRIBUTE = 'data-litho-id';
export const CANVAS_EMPTY_ATTRIBUTE = 'data-litho-empty';
export const CANVAS_IFRAME_PLACEHOLDER_ATTRIBUTE = 'data-litho-iframe-placeholder';
/** Id of the `<style>` carrying the project's CSS, so a pure style edit can
 * patch its content in place instead of forcing a full iframe reload. */
export const CANVAS_CSS_ELEMENT_ID = 'litho-canvas-css';
/**
 * Id of the `<style>` that shows the selected element as it looks in the
 * pseudo-state the properties panel is currently editing - see
 * `buildStatePreviewCss`.
 */
export const CANVAS_STATE_PREVIEW_ELEMENT_ID = 'litho-canvas-state-preview';

export interface CanvasDocumentOptions {
  document: PageDocument;
  styleModels: StyleSheetModel[];
  /** Contents of the state-preview stylesheet; see `buildStatePreviewCss`. */
  statePreviewCss?: string;
}

export function buildCanvasDocument(options: CanvasDocumentOptions): string {
  const annotated = annotateTree(options.document.root, options.document.relPath);
  const page: PageDocument = { ...options.document, root: annotated };

  const html = generateHtml(page);
  const css = canvasCss(options.styleModels);
  const baseHref = toAssetBaseUrl(options.document.relPath);

  const head = [
    `<base href="${escapeAttributeValue(baseHref)}">`,
    `<style id="${CANVAS_CSS_ELEMENT_ID}">${css}</style>`,
    `<style>${EDITOR_OVERLAY_CSS}</style>`,
    // Last, so it outranks everything above it at equal specificity. Empty
    // unless a non-normal state is being edited; it is here even then so a
    // structural reload does not drop the preview until the next keystroke.
    `<style id="${CANVAS_STATE_PREVIEW_ELEMENT_ID}">${options.statePreviewCss ?? ''}</style>`,
  ].join('\n');

  return injectIntoHead(html, head);
}

/**
 * Shows the selected element the way it will look in a pseudo-state.
 *
 * Picking "Najechanie" in the properties panel writes `.przycisk:hover { … }`,
 * which is correct CSS and completely invisible while editing: the pointer is
 * over the properties panel, not over the element, so the rule never applies
 * and the whole Stan section looked like a control that did nothing. Two of the
 * four states are worse than that - `:focus` and `:active` cannot be reached by
 * hovering at all, because clicking in the canvas selects an element rather than
 * focusing it.
 *
 * So the declarations are re-emitted, unchanged, onto the one selected element
 * for as long as that state is being edited. The selector is the element's
 * canvas id written twice (`[data-litho-id="n7"][data-litho-id="n7"]`), which is
 * a legitimate way to reach specificity 0-2-0 without `!important`: it beats the
 * page's own class rules, ties with `.foo:hover`, and - being last in the
 * document - wins that tie. `!important` would have been simpler and wrong, as
 * it would also override the user's own `!important` declarations and so show
 * them a state their page will never actually render.
 *
 * Canvas-only, like every other override in this module: nothing here reaches
 * the file on disk or the live preview.
 */
export function buildStatePreviewCss(nodeId: string, declarations: Record<string, string>): string {
  const entries = Object.entries(declarations).filter(
    ([, value]) => typeof value === 'string' && value.trim() !== '',
  );
  if (entries.length === 0) return '';

  const selector = `[${CANVAS_ID_ATTRIBUTE}="${escapeAttributeValue(nodeId)}"]`;
  const body = entries.map(([property, value]) => `  ${property}: ${value};`).join('\n');
  return `${selector}${selector} {\n${body}\n}\n`;
}

/* ------------------------------------------------------------------ */

/** Container tags that get the empty-drop-target outline when they have no content. */
const EMPTY_MARKABLE_TAGS = new Set([
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
]);

/**
 * Clones the tree, stamping each element with its node id and dropping content
 * that must not execute or is invisible anyway.
 */
function annotateTree(root: ElementNode, pageRelPath: string): ElementNode {
  const visit = (node: DocNode): DocNode | null => {
    if (node.kind === 'text') return node;
    if (node.kind === 'comment') return null;

    // Scripts never run on the canvas; `<style>` is dropped because the CSS is
    // re-injected from the models, which include unsaved edits.
    if (node.tag === 'script' || node.tag === 'style' || node.tag === 'noscript') return null;

    if (node.tag === 'iframe') return buildIframePlaceholder(node);

    if (node.tag === 'link') {
      const rel = (getAttr(node, 'rel') ?? '').toLowerCase();
      const isStylesheet = rel.split(/\s+/u).includes('stylesheet');
      const href = getAttr(node, 'href') ?? '';
      // Project-local stylesheets are re-injected from the models; remote ones
      // (CDN, web fonts) must stay so the page renders as a browser would.
      if (isStylesheet && resolveHref(pageRelPath, href) !== null) return null;
      return { ...node, attrs: node.attrs.map((attr) => ({ ...attr })), children: [] };
    }

    const children = node.children.map(visit).filter((child): child is DocNode => child !== null);
    const attrs = [
      ...node.attrs.filter(isInertOnCanvas).map(neutralizeAttribute),
      { name: CANVAS_ID_ATTRIBUTE, value: node.id },
    ];

    // Empty containers get a visible dashed outline (and a minimum height) so
    // there is something to aim a drop at.
    if (EMPTY_MARKABLE_TAGS.has(node.tag) && !hasRenderableContent(children)) {
      attrs.push({ name: CANVAS_EMPTY_ATTRIBUTE, value: 'true' });
    }

    return { ...node, attrs, children };
  };

  return visit(root) as ElementNode;
}

/**
 * Drops inline event handlers from the canvas copy.
 *
 * `<script>` elements are already removed above, but `onclick="…"` and friends
 * are script too, and they survived into the `srcdoc` document. They could
 * never actually run - the frame is sandboxed without `allow-scripts` - but
 * Chromium logs "Blocked script execution in 'about:srcdoc'…" once per attempt,
 * which filled the console with warnings about a defence working correctly and
 * buried real diagnostics underneath them. Removing them makes the canvas copy
 * mean what the module comment already claims: no page script, of any kind.
 *
 * The user's file is untouched; this only ever edits the in-memory clone.
 */
function isInertOnCanvas(attr: { name: string }): boolean {
  return !/^on/iu.test(attr.name);
}

/** Same reasoning for `javascript:` URLs, which are handlers wearing a URL. */
function neutralizeAttribute(attr: { name: string; value: string }): { name: string; value: string } {
  const isUrlAttribute = attr.name === 'href' || attr.name === 'src' || attr.name === 'action';
  if (isUrlAttribute && /^\s*javascript:/iu.test(attr.value)) {
    return { name: attr.name, value: '#' };
  }
  return { ...attr };
}

const IFRAME_PLACEHOLDER_TEXT = 'Osadzona treść (iframe) - pełny podgląd dostępny w trybie Podgląd';

/**
 * Stands in for a real `<iframe>` in the canvas - see difference 4 in the
 * module doc comment above. Keeps `id`/`class`/`style` so the box picks up
 * whatever sizing the real element's CSS declares, and keeps the original
 * node id on `CANVAS_ID_ATTRIBUTE` so clicking it selects and edits the real
 * `<iframe>`, not this stand-in.
 */
function buildIframePlaceholder(node: ElementNode): ElementNode {
  const carried = node.attrs
    .filter((attr) => attr.name === 'id' || attr.name === 'class' || attr.name === 'style')
    .map((attr) => ({ ...attr }));

  return {
    kind: 'element',
    id: node.id,
    tag: 'div',
    namespace: 'html',
    attrs: [
      ...carried,
      { name: CANVAS_ID_ATTRIBUTE, value: node.id },
      { name: CANVAS_IFRAME_PLACEHOLDER_ATTRIBUTE, value: 'true' },
    ],
    children: [{ kind: 'text', id: `${node.id}:placeholder`, value: IFRAME_PLACEHOLDER_TEXT }],
  };
}

function hasRenderableContent(children: DocNode[]): boolean {
  return children.some((child) => (child.kind === 'text' && child.value.trim() !== '') || isElement(child));
}

/**
 * Re-evaluates the empty-container marker on a *live* canvas node.
 *
 * `annotateTree` decides this once, while building the document. A text edit
 * patched straight into the loaded iframe (see `canvasPatch` in editorStore)
 * skips that pass entirely, so emptying a container would leave it without the
 * dashed drop-target outline and filling one would leave the outline behind.
 * Keeping the rule in this module is what stops the two paths from drifting.
 */
export function syncEmptyMarker(element: Element): void {
  const markable = EMPTY_MARKABLE_TAGS.has(element.tagName.toLowerCase());
  const empty = element.children.length === 0 && (element.textContent ?? '').trim() === '';
  if (markable && empty) element.setAttribute(CANVAS_EMPTY_ATTRIBUTE, 'true');
  else element.removeAttribute(CANVAS_EMPTY_ATTRIBUTE);
}

/** True for elements the canvas should never let the user select. */
export function isSelectableTag(tag: string): boolean {
  return !NON_VISUAL_ELEMENTS.has(tag) && tag !== 'html' && tag !== 'body';
}

/**
 * Node ids of every selectable element *fully* enclosed by `rect` (both in
 * `frameDocument`'s own coordinate space), for the Ctrl-drag marquee select -
 * "draw a box on the desktop" multi-select.
 *
 * Containment rather than mere intersection: a marquee that merely brushes an
 * element's edge is rarely what the user meant to include. An element whose
 * own ancestor is also fully enclosed is dropped - dragging a box around an
 * entire list should select the list, not the list and every one of its
 * items at once.
 */
export function collectEnclosedIds(
  frameDocument: Document,
  rect: { left: number; top: number; right: number; bottom: number },
): string[] {
  const candidates = Array.from(frameDocument.querySelectorAll(`[${CANVAS_ID_ATTRIBUTE}]`));
  const enclosed = candidates.filter((el) => {
    if (!isSelectableTag(el.tagName.toLowerCase())) return false;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    return (
      box.left >= rect.left && box.right <= rect.right && box.top >= rect.top && box.bottom <= rect.bottom
    );
  });

  const enclosedSet = new Set(enclosed);
  const topmost = enclosed.filter((el) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (enclosedSet.has(parent)) return false;
    }
    return true;
  });

  return topmost.map((el) => el.getAttribute(CANVAS_ID_ATTRIBUTE)).filter((id): id is string => id !== null);
}

function injectIntoHead(html: string, injection: string): string {
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    return `${html.slice(0, headClose)}${injection}\n${html.slice(headClose)}`;
  }
  const htmlOpen = html.indexOf('<html');
  if (htmlOpen !== -1) {
    const tagEnd = html.indexOf('>', htmlOpen);
    if (tagEnd !== -1) {
      return `${html.slice(0, tagEnd + 1)}<head>${injection}</head>${html.slice(tagEnd + 1)}`;
    }
  }
  return `<head>${injection}</head>${html}`;
}

/**
 * Converts a page's project-relative path into the `<base href>` a browser
 * would load it from, expressed via the app's own `litho-asset:` scheme
 * rather than `file:`. Every relative `src`/`href` still resolves exactly as
 * a real browser would (against the page's own directory) - but unlike
 * `file:`, this scheme loads correctly regardless of whether the app window
 * itself is `file://` (packaged build) or `http://localhost` (dev server),
 * since Chromium blocks `http:` → `file:` subresource loads outright. See
 * `registerAssetProtocol` in `electron/main.ts`.
 */
export function toAssetBaseUrl(pageRelPath: string): string {
  const pageDirectory = dirname(pageRelPath);
  return toAssetUrl(pageDirectory === '' ? '' : `${pageDirectory}/`);
}

/** Converts a project-relative path into a `litho-asset://project/...` URL. */
export function toAssetUrl(relPath: string): string {
  const encoded = toPosix(relPath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `litho-asset://project/${encoded}`;
}

function escapeAttributeValue(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;');
}

/**
 * The canvas runs no page scripts (see `annotateTree`), which breaks pages
 * built with "reveal on scroll" libraries: they ship content pre-hidden
 * (`opacity: 0`, `visibility: hidden`, an off-screen `transform`) and rely on
 * JavaScript to add a class once the element scrolls into view. With the
 * scripts gone that class never arrives, so everything below the first screen
 * stays invisible in the editor even though it renders perfectly in the live
 * preview - reported as "empty space when scrolling" and "cut-off layout".
 *
 * These overrides force the *revealed* end-state for the well-known animation
 * hooks, so the editor shows the same content the browser eventually would.
 * They are deliberately scoped to those hooks - an `opacity: 0` on a dropdown
 * or modal is meant to stay hidden and carries none of these markers - and
 * live only in the canvas overlay, never in the user's files.
 */
const REVEAL_ON_SCROLL_OVERRIDES = `
  ${revealHookSelectorList()} {
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    animation: none !important;
    transition: none !important;
    filter: none !important;
  }
`;

/**
 * Motion is switched off on the editing canvas - the page keeps every animation
 * it has, and the live preview is where they play.
 *
 * An editor is a workbench, not a showreel. A CSS animation runs again from the
 * top each time the canvas document is (re)built, so a page with entrance
 * animations spent its first second fading and sliding its own content around
 * every time - under a pointer trying to click that content, and under
 * selection outlines measured against boxes that were still moving. Infinite
 * animations (gradient sweeps, pulsing badges, marquees) never stop repainting
 * at all, which is what a page that "keeps refreshing itself" looks like.
 *
 * Rather than `animation: none` - which would strand any element whose visible
 * state *is* the animation's last keyframe - every animation is run out
 * instantly and held at its end (`forwards`), so the canvas shows the frame the
 * page settles on. `!important` author declarations still win over animated
 * values, which is what keeps `REVEAL_ON_SCROLL_OVERRIDES` above authoritative.
 */
const MOTIONLESS_CANVAS_CSS = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    animation-fill-mode: forwards !important;
    animation-play-state: running !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
    scroll-behavior: auto !important;
  }
`;

/**
 * Styling applied only inside the canvas. It suppresses interactions that would
 * make direct manipulation feel wrong - following a link, submitting a form,
 * text selection during a drag - without altering the page's own appearance,
 * force-reveals scroll-animation content the missing scripts would leave hidden
 * (see `REVEAL_ON_SCROLL_OVERRIDES`) and holds every animation at its end state
 * (see `MOTIONLESS_CANVAS_CSS`).
 */
const EDITOR_OVERLAY_CSS = `
  html { cursor: default; }
  /*
   * The editor restores the scroll position itself after the reload that every
   * structural edit performs. Chromium's scroll anchoring would compete with
   * that: it nudges the scroll offset whenever content above the viewport
   * changes and fires its own scroll event doing so, which drifts the
   * remembered position a little further on every single edit.
   */
  html { overflow-anchor: none; }
  a, button, [role="button"] { cursor: default !important; }
  * { -webkit-user-drag: none !important; }
  ::selection { background: rgba(110, 86, 207, 0.35); }
  [data-litho-empty="true"] {
    min-height: 48px;
    outline: 1px dashed rgba(110, 86, 207, 0.5);
    outline-offset: -1px;
  }
  [data-litho-iframe-placeholder="true"] {
    display: flex !important;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    padding: 16px;
    background: repeating-linear-gradient(
      45deg,
      rgba(110, 86, 207, 0.08),
      rgba(110, 86, 207, 0.08) 10px,
      rgba(110, 86, 207, 0.14) 10px,
      rgba(110, 86, 207, 0.14) 20px
    );
    border: 1px dashed rgba(110, 86, 207, 0.5);
    color: #5b5f73;
    font: 13px/1.4 var(--font-ui, system-ui, sans-serif);
    text-align: center;
  }
  ${MOTIONLESS_CANVAS_CSS}
  ${REVEAL_ON_SCROLL_OVERRIDES}
`;
