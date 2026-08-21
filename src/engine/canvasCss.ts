import postcss, { type ChildNode, type Container } from 'postcss';
import { combinedCss, type StyleSheetModel } from './cssGenerator.js';

/**
 * CSS as the editing canvas needs it.
 *
 * The canvas runs none of the page's own scripts, which breaks the single most
 * common pattern in modern hand-written pages: content is shipped hidden
 * (`opacity: 0`) and a scroll observer adds a class to reveal it. Without the
 * script the class never arrives and everything below the first screen stays
 * invisible - the page renders fully in the live preview and half-empty in the
 * editor.
 *
 * Guessing library class names (`.wow`, `[data-aos]`, …) does not solve this:
 * real pages roll their own, and - worse - hide through *descendant* selectors
 * where the hidden element carries no marker at all:
 *
 *     .reveal-group > *         { opacity: 0 }   <- the child has no class
 *     .reveal-group.visible > * { opacity: 1 }
 *
 * So the detection here is structural instead of name-based. A rule is treated
 * as a "hidden until revealed" state when some *other* rule in the same
 * stylesheet has an identical selector skeleton plus at least one extra class,
 * and restores visibility. That matches `.reveal`/`.reveal.visible`,
 * `.reveal-group > *`/`.reveal-group.visible > *` and
 * `.timeline .stage`/`.timeline.visible .stage` alike, without knowing a single
 * library name.
 *
 * Overrides are appended rather than edited in, so the user's stylesheet is
 * never rewritten - this affects only what the canvas renders.
 */

/** `opacity: 0`, `0.0`, `0%` - anything that renders the element invisible. */
const HIDDEN_OPACITY = /^(0(\.0+)?|0+%)$/u;

interface SelectorShape {
  /** The selector with every state token removed, so only structure remains. */
  skeleton: string;
  /** The classes and attributes the selector requires, e.g. `.visible`, `[data-shown]`. */
  tokens: Set<string>;
}

/**
 * Splits a selector into its structural skeleton and the set of state tokens it
 * requires. `.reveal-group.visible > *` becomes skeleton `> *` with tokens
 * `{.reveal-group, .visible}` - so it can be compared against `.reveal-group > *`,
 * which has the same skeleton and a strict subset of the tokens.
 *
 * Attributes count as state alongside classes: a page is just as likely to
 * reveal with `[data-shown]` or `[data-state="in"]` as with a second class.
 */
export function analyzeSelector(selector: string): SelectorShape {
  const tokens = new Set<string>();
  const skeleton = selector
    // Attributes first - their values may contain dots (`[href=".x"]`), which
    // would otherwise be mistaken for class tokens.
    .replace(/\[[^\]]*\]/gu, (match) => {
      tokens.add(match.replace(/\s+/gu, ''));
      return '';
    })
    .replace(/\.(-?[_a-zA-Z][\w-]*)/gu, (match) => {
      tokens.add(match);
      return '';
    })
    .replace(/\s+/gu, ' ')
    .trim();
  return { skeleton, tokens };
}

/** True for rules inside `@keyframes`, whose `from`/`to` steps are not selectors. */
function insideKeyframes(node: ChildNode): boolean {
  for (let parent: Container | undefined = node.parent as Container | undefined; parent;) {
    if (parent.type === 'atrule' && /keyframes$/iu.test((parent as unknown as { name: string }).name)) {
      return true;
    }
    parent = parent.parent as Container | undefined;
  }
  return false;
}

/**
 * Returns the extra CSS that forces every "hidden until a script reveals it"
 * rule into its revealed state, or `''` when the stylesheet has no such rule.
 */
export function neutralizeHiddenReveals(css: string): string {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    // A stylesheet Litho cannot parse still has to render; it just misses this
    // enhancement rather than blanking the canvas.
    return '';
  }

  const revealing: SelectorShape[] = [];
  const hiding: Array<{ selector: string; shape: SelectorShape; animated: boolean }> = [];

  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;

    let opacity: string | null = null;
    let visibility: string | null = null;
    let animated = false;

    rule.walkDecls((decl) => {
      const prop = decl.prop.toLowerCase();
      if (prop === 'opacity') opacity = decl.value.trim();
      else if (prop === 'visibility') visibility = decl.value.trim().toLowerCase();
      else if (prop === 'animation' || prop === 'animation-name') animated = true;
    });

    const hidden = (opacity !== null && HIDDEN_OPACITY.test(opacity)) || visibility === 'hidden';
    const shown = (opacity !== null && !HIDDEN_OPACITY.test(opacity)) || visibility === 'visible';

    let selectors: string[];
    try {
      selectors = rule.selectors;
    } catch {
      return;
    }

    for (const selector of selectors) {
      const shape = analyzeSelector(selector);
      if (hidden) hiding.push({ selector, shape, animated });
      else if (shown) revealing.push(shape);
    }
  });

  const targets = new Set<string>();
  for (const entry of hiding) {
    // A rule that hides *and* animates is a CSS entrance animation ending in
    // the visible state (`animation-fill-mode: forwards`). The editor wants
    // that end state immediately - not a fade replaying on every reload, and
    // not a permanently blank element when the OS asks for reduced motion.
    if (entry.animated) {
      targets.add(entry.selector);
      continue;
    }
    const revealedElsewhere = revealing.some(
      (candidate) =>
        candidate.skeleton === entry.shape.skeleton &&
        candidate.tokens.size > entry.shape.tokens.size &&
        [...entry.shape.tokens].every((token) => candidate.tokens.has(token)),
    );
    if (revealedElsewhere) targets.add(entry.selector);
  }

  if (targets.size === 0) return '';

  return `${[...targets].join(',\n')} {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
}
`;
}

/** The page's own CSS plus the canvas-only reveal neutralisation. */
export function canvasCss(models: StyleSheetModel[]): string {
  const css = combinedCss(models);
  const overrides = neutralizeHiddenReveals(css);
  if (overrides === '') return css;
  return `${css}\n\n/* Litho Studio - odsłonięcie treści ukrytej do czasu przewinięcia */\n${overrides}`;
}
