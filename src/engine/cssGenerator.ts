import postcss, { AtRule, Declaration, type Root, Rule, type ChildNode } from 'postcss';
import type { Breakpoint, StyleSource } from '@shared/project.js';
import type { ElementNode } from '@shared/document.js';
import { getAttr, getClassList, isIconFontClass } from '@shared/document.js';
import { type ClassNameAllocator, isValidCssIdentifier, slugify } from './idAllocator.js';
import {
  BACKGROUND_LONGHAND_INITIALS,
  expandBackgroundShorthand,
  expandBackgroundShorthandInRule,
} from './backgroundShorthand.js';

/**
 * CSS reading and writing.
 *
 * Litho never re-serialises a stylesheet from scratch. It parses the file into
 * a PostCSS AST, mutates only the declarations the user actually changed, and
 * stringifies the same AST back. Comments, custom properties, vendor hacks,
 * `@supports`, rule order and formatting the editor does not understand all
 * survive untouched - which is what makes it safe to point this at a stylesheet
 * somebody else wrote.
 *
 * Nothing here reimplements the cascade. Current *effective* values come from
 * `getComputedStyle` in the canvas, which is the real browser answer; this
 * module only deals with what is *declared* for a specific selector.
 */

export interface StyleSheetModel {
  source: StyleSource;
  root: Root;
  /** True once the model has diverged from the text on disk. */
  dirty: boolean;
  /** Set when the file could not be parsed; the sheet is then read-only. */
  parseError: string | null;
}

export type Declarations = Record<string, string>;

/** `null` removes a property; a string sets it. */
export type DeclarationPatch = Record<string, string | null>;

/* ------------------------------------------------------------------ */
/* Parsing                                                              */
/* ------------------------------------------------------------------ */

export function parseStyleSheets(sources: StyleSource[]): StyleSheetModel[] {
  return sources.map(parseStyleSheet);
}

export function parseStyleSheet(source: StyleSource): StyleSheetModel {
  try {
    return {
      source,
      root: postcss.parse(source.css, { from: source.relPath ?? undefined }),
      dirty: false,
      parseError: null,
    };
  } catch (error) {
    // A stylesheet with a syntax error still has to be *displayed*; it just
    // cannot be written to. Refusing to open the project would be worse.
    return {
      source: { ...source, writable: false },
      root: postcss.parse(''),
      dirty: false,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function stringifyStyleSheet(model: StyleSheetModel): string {
  return model.root.toString();
}

/** Combined CSS of every source in cascade order, for the canvas iframe. */
export function combinedCss(models: StyleSheetModel[]): string {
  return models
    .map((model) => {
      const media = model.source.media;
      const css = stringifyStyleSheet(model);
      return media && media !== 'all' ? `@media ${media} {\n${css}\n}` : css;
    })
    .join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Choosing where generated rules go                                    */
/* ------------------------------------------------------------------ */

export interface StyleTarget {
  model: StyleSheetModel;
}

/**
 * Picks the stylesheet that new rules are written into.
 *
 * The *last* writable sheet in document order wins, because a rule added there
 * beats identical-specificity rules earlier in the cascade - so the user's edit
 * takes effect without the editor ever resorting to `!important`.
 *
 * Returns `null` when the page has no writable stylesheet at all; the caller
 * then creates one (see `domSync.ensureStyleSheet`).
 */
export function chooseStyleTarget(models: StyleSheetModel[]): StyleTarget | null {
  for (let index = models.length - 1; index >= 0; index -= 1) {
    const model = models[index];
    if (model && model.source.writable && model.parseError === null) return { model };
  }
  return null;
}

/**
 * Like `chooseStyleTarget`, but prefers the writable sheet that *already*
 * defines `selector`.
 *
 * Named styles (`.page-intro`) are edited over and over, and blindly writing
 * every edit into the last sheet would scatter one class across several files -
 * the user would see `.page-intro` in two places with half the properties in
 * each. Editing the rule where it lives keeps the stylesheet readable; when no
 * writable sheet defines it (a brand new class, or one that exists only in a
 * read-only vendor sheet) this falls back to the normal target, where the new
 * rule also wins the cascade.
 */
export function chooseSelectorTarget(models: StyleSheetModel[], selector: string): StyleTarget | null {
  for (let index = models.length - 1; index >= 0; index -= 1) {
    const model = models[index];
    if (!model || !model.source.writable || model.parseError !== null) continue;
    if (definesSelector(model, selector)) return { model };
  }
  return chooseStyleTarget(models);
}

/** True when the sheet has a rule for exactly `selector`, at any breakpoint. */
export function definesSelector(model: StyleSheetModel, selector: string): boolean {
  let found = false;
  model.root.walkRules((rule) => {
    if (found) return;
    if (splitSelectorList(rule.selector).includes(selector)) found = true;
  });
  return found;
}

/* ------------------------------------------------------------------ */
/* Selectors for elements                                               */
/* ------------------------------------------------------------------ */

/**
 * Returns the selector used to style an element, creating a hook if needed.
 *
 * Preference order is chosen so that generated CSS reads like the page's own,
 * while still guaranteeing the edit is visible - a declaration under a
 * selector that loses the cascade to some other rule elsewhere is, from the
 * user's side, indistinguishable from the panel doing nothing:
 *  1. an existing `id` - already unique and already how the author refers to it;
 *  2. an existing class that is unique in the document, so the edit lands on the
 *     hook the author was already using;
 *  3. a newly allocated **id**, not a class. A class fabricated here has no
 *     author convention to preserve - it is purely the editor's own hook -
 *     and a plain single class (specificity 0,1,0) can silently lose to a
 *     pre-existing compound/descendant selector on the same element (e.g. a
 *     template rule like `.card .title`, specificity 0,2,0): the declaration
 *     still gets written, but never wins the cascade, so the panel edit
 *     appears to do nothing. An id (1,0,0) beats that regardless of source
 *     order, which is exactly what a hook that exists *only* to carry this
 *     one element's own overrides should do.
 *
 * The mutation of `classList`/`id` is returned rather than applied, so the
 * caller can fold it into a single undoable command.
 */
export interface SelectorPlan {
  selector: string;
  /** Class to add to the element, when an existing hook could be reused. */
  addClass: string | null;
  /** Id to add to the element, when a brand new hook had to be created. */
  addId: string | null;
}

export function planSelector(
  element: ElementNode,
  options: {
    allocator: ClassNameAllocator;
    /** How many elements in the page carry each class. */
    classCounts: Map<string, number>;
    /** Label used to derive a readable class/id name. */
    label?: string;
  },
): SelectorPlan {
  const id = getAttr(element, 'id');
  if (id && isValidCssIdentifier(id)) {
    return { selector: `#${id}`, addClass: null, addId: null };
  }

  for (const className of getClassList(element)) {
    if (!isValidCssIdentifier(className)) continue;
    // A class from an icon font library belongs to every icon in the page, not
    // to this one element - it is only "unique" while the page happens to hold
    // a single icon. Styling through it would rewrite the library's own rule,
    // and every icon added later would inherit this element's size.
    if (isIconFontClass(className)) continue;
    if ((options.classCounts.get(className) ?? 0) === 1) {
      return { selector: `.${className}`, addClass: null, addId: null };
    }
  }

  const base = slugify(options.label ?? element.tag, element.tag);
  const allocated = options.allocator.allocate(base);
  return { selector: `#${allocated}`, addClass: null, addId: allocated };
}

/**
 * Every class name defined by a `.foo` selector anywhere across the page's
 * stylesheets, sorted and deduplicated.
 *
 * Feeds the properties panel's class picker - the point is to let the user
 * assign a style the page *already defines* rather than retype it, so this
 * has to read every sheet (not just the one new rules would be written into)
 * and every compound/descendant selector, not only bare `.foo` rules.
 */
export function listClassNames(models: StyleSheetModel[]): string[] {
  const names = new Set<string>();
  const classToken = /\.(-?[a-zA-Z_][\w-]*)/gu;

  for (const model of models) {
    model.root.walkRules((rule) => {
      for (const selector of splitSelectorList(rule.selector)) {
        for (const match of selector.matchAll(classToken)) {
          const name = match[1];
          if (name) names.add(name);
        }
      }
    });
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Counts how many elements in a subtree carry each class name. */
export function countClasses(root: ElementNode): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: ElementNode): void => {
    for (const className of getClassList(node)) {
      counts.set(className, (counts.get(className) ?? 0) + 1);
    }
    for (const child of node.children) {
      if (child.kind === 'element') visit(child);
    }
  };
  visit(root);
  return counts;
}

/* ------------------------------------------------------------------ */
/* Reading declarations                                                 */
/* ------------------------------------------------------------------ */

/**
 * Collects the declarations written for an exact selector, across every sheet,
 * in cascade order. Later sources overwrite earlier ones, matching the browser.
 */
export function readDeclarations(
  models: StyleSheetModel[],
  selector: string,
  breakpoint: Breakpoint,
): Declarations {
  const result: Declarations = {};
  for (const model of models) {
    const rule = findRule(model.root, selector, breakpoint);
    if (!rule) continue;
    rule.walkDecls((declaration) => {
      const value = declaration.value + (declaration.important ? ' !important' : '');
      // The panel edits `background-color`/`background-image`, so a rule
      // written with the `background` shorthand - which is most of them -
      // would otherwise read as having no background at all. Expanded here,
      // in cascade order, so a longhand written after the shorthand still
      // wins, exactly as it does in the browser.
      if (declaration.prop.toLowerCase() === 'background') {
        const expanded = expandBackgroundShorthand(value);
        if (expanded) {
          // The shorthand resets every longhand it covers, so whatever an
          // earlier declaration left behind is gone rather than inherited.
          for (const property of Object.keys(BACKGROUND_LONGHAND_INITIALS)) delete result[property];
          Object.assign(result, expanded);
          return;
        }
      }
      result[declaration.prop] = value;
    });
  }
  return result;
}

/**
 * Parses the declarations a user typed into the raw-CSS box.
 *
 * The box shows a whole rule (`.name { … }`), but people edit loosely - they
 * delete the braces, paste just `color: red; margin: 0`, or leave a trailing
 * property with no semicolon. So both a full rule and a bare declaration list
 * are accepted: anything between the first `{` and the last `}` is treated as
 * the body, and if there are no braces the whole text is. Returns `null` only
 * when even that cannot be parsed as CSS, so the caller can keep the user's text
 * on screen and show an error rather than silently dropping it.
 */
export function parseDeclarationBlock(cssText: string): Declarations | null {
  // With a brace the text is treated as the rule the box shows (`.name { … }`);
  // without one it is a bare declaration list, wrapped so PostCSS will parse it.
  const wrapped = cssText.includes('{') ? cssText : `*{${cssText}}`;

  let root: Root;
  try {
    root = postcss.parse(wrapped);
  } catch {
    return null;
  }

  // Only a plain declaration block is allowed: no at-rules (`@media`, …) and no
  // nested selectors. Anything else is not "the style's own declarations", so it
  // is rejected rather than half-applied.
  let ok = true;
  root.walkAtRules(() => {
    ok = false;
  });
  root.walkRules((rule) => {
    rule.each((node) => {
      if (node.type !== 'decl' && node.type !== 'comment') ok = false;
    });
  });
  if (!ok) return null;

  const result: Declarations = {};
  root.walkDecls((declaration) => {
    result[declaration.prop] = declaration.value + (declaration.important ? ' !important' : '');
  });
  return result;
}

/**
 * Turns the difference between the current declarations and an edited set into a
 * patch: every changed/added property is set, every removed one is nulled.
 */
export function diffDeclarations(current: Declarations, next: Declarations): DeclarationPatch {
  const patch: DeclarationPatch = {};
  for (const [property, value] of Object.entries(next)) {
    if (current[property] !== value) patch[property] = value;
  }
  for (const property of Object.keys(current)) {
    if (!(property in next)) patch[property] = null;
  }
  return patch;
}

/* ------------------------------------------------------------------ */
/* Writing declarations                                                 */
/* ------------------------------------------------------------------ */

/**
 * Applies a declaration patch to one selector at one breakpoint.
 *
 * Creates the rule (and the surrounding `@media` block) on demand, updates
 * declarations in place so their position in the rule is preserved, and removes
 * rules that end up empty so the stylesheet does not accumulate debris.
 */
export function applyDeclarations(
  model: StyleSheetModel,
  selector: string,
  breakpoint: Breakpoint,
  patch: DeclarationPatch,
  options: {
    /**
     * Keeps the rule even after its last declaration is removed.
     *
     * Set when the *selector itself* is something the user created and can see
     * by name - a reusable style class. Pruning it would make the style vanish
     * from the styles panel (and from every picker) the moment its last
     * property was cleared, taking the name with it; for an element's own
     * generated hook, where nobody ever refers to the selector by name,
     * pruning is still the right thing.
     */
    keepEmptyRule?: boolean;
  } = {},
): void {
  if (!model.source.writable || model.parseError !== null) return;

  const entries = Object.entries(patch);
  if (entries.length === 0) return;

  const hasAdditions = entries.some(([, value]) => value !== null && value !== '');
  const rule =
    findRule(model.root, selector, breakpoint) ??
    (hasAdditions ? createRule(model.root, selector, breakpoint) : null);
  if (!rule) return;

  // A `background` shorthand in the rule covers every longhand the panel
  // writes, so appending `background-color: transparent` next to
  // `background: linear-gradient(…)` changed nothing on screen - the reported
  // "on the counter block I can't set a transparent background or a single
  // colour". Splitting the shorthand first makes the panel's declaration the
  // one that decides, without touching rules the user is not editing.
  if (entries.some(([property]) => property.toLowerCase() in BACKGROUND_LONGHAND_INITIALS)) {
    if (expandBackgroundShorthandInRule(rule)) model.dirty = true;
  }

  for (const [property, value] of entries) {
    const existing = findDeclaration(rule, property);

    if (value === null || value === '') {
      existing?.remove();
      continue;
    }

    const { cleanValue, important } = splitImportant(value);
    if (existing) {
      existing.value = cleanValue;
      existing.important = important;
    } else {
      rule.append(new Declaration({ prop: property, value: cleanValue, important }));
    }
  }

  if (!options.keepEmptyRule) pruneEmpty(rule);
  model.dirty = true;
}

/* ------------------------------------------------------------------ */
/* Named style classes                                                  */
/* ------------------------------------------------------------------ */

/** One reusable style: a class name and what it declares at a breakpoint. */
export interface StyleClassInfo {
  /** Bare class name, e.g. `page-intro`. */
  name: string;
  /** Declarations of the `.name` rule at the requested breakpoint. */
  declarations: Declarations;
  /**
   * True when a writable sheet defines `.name` on its own. False for a class
   * that only ever appears inside a compound selector (`.card .title`) or that
   * lives in a read-only sheet - the panel can still edit it, but the edit
   * creates a new rule rather than changing the one that is already there.
   */
  ownRule: boolean;
}

/**
 * Every class the page's stylesheets mention, with the declarations of its own
 * `.name` rule - the model behind the styles panel.
 */
export function listStyleClasses(models: StyleSheetModel[], breakpoint: Breakpoint): StyleClassInfo[] {
  return listClassNames(models).map((name) => ({
    name,
    declarations: readDeclarations(models, `.${name}`, breakpoint),
    ownRule: models.some((model) => model.source.writable && definesSelector(model, `.${name}`)),
  }));
}

/**
 * Creates an empty rule for a selector, so a style can exist under a name the
 * user chose *before* they have set any property on it. Returns false when the
 * sheet already has the rule (or cannot be written to).
 */
export function ensureRule(model: StyleSheetModel, selector: string, breakpoint: Breakpoint): boolean {
  if (!model.source.writable || model.parseError !== null) return false;
  if (findRule(model.root, selector, breakpoint)) return false;
  createRule(model.root, selector, breakpoint);
  model.dirty = true;
  return true;
}

/**
 * Removes a selector from the sheet at every breakpoint.
 *
 * A rule that lists several selectors (`.intro, .lead { … }`) loses only the
 * one being removed - the other selectors keep their declarations, which is the
 * only reading of "delete this style" that does not silently restyle unrelated
 * parts of the page.
 */
export function removeSelectorRules(model: StyleSheetModel, selector: string): boolean {
  if (!model.source.writable || model.parseError !== null) return false;

  const doomed: Rule[] = [];
  let changed = false;

  model.root.walkRules((rule) => {
    const selectors = splitSelectorList(rule.selector);
    if (!selectors.includes(selector)) return;
    const rest = selectors.filter((entry) => entry !== selector);
    if (rest.length === 0) doomed.push(rule);
    else rule.selector = rest.join(', ');
    changed = true;
  });

  for (const rule of doomed) {
    const parent = rule.parent;
    rule.remove();
    if (parent instanceof AtRule && (parent.nodes?.length ?? 0) === 0) parent.remove();
  }

  if (changed) model.dirty = true;
  return changed;
}

/**
 * Renames a class everywhere it is used in selectors - including inside
 * compound and descendant selectors (`.card .old`, `.old.active`), which a
 * plain selector rename would miss and leave pointing at a class that no
 * element carries any more.
 */
export function renameClassInSelectors(model: StyleSheetModel, from: string, to: string): boolean {
  if (!model.source.writable || model.parseError !== null || from === to) return false;

  let changed = false;
  model.root.walkRules((rule) => {
    const next = splitSelectorList(rule.selector)
      .map((selector) => replaceClassToken(selector, from, to))
      .join(', ');
    if (next === rule.selector) return;
    rule.selector = next;
    changed = true;
  });

  if (changed) model.dirty = true;
  return changed;
}

/**
 * Replaces `.from` with `.to` in one selector, matching whole class tokens
 * only. Text inside quotes is skipped, so `[data-x=".from"]` is left alone.
 */
function replaceClassToken(selector: string, from: string, to: string): string {
  let out = '';
  let quote: string | null = null;

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!;

    if (quote) {
      out += char;
      if (char === quote && selector[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    // An escaped character is never the start of a class token.
    if (char === '\\') {
      out += char + (selector[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '.' && selector.startsWith(from, index + 1)) {
      const after = selector[index + 1 + from.length];
      if (after === undefined || !/[\w-]/u.test(after)) {
        out += `.${to}`;
        index += from.length;
        continue;
      }
    }
    out += char;
  }

  return out;
}

/**
 * Appends the rules from a template's CSS snippet that the project does not
 * already have.
 *
 * Deduplication is by selector, checked across *every* sheet (not just the
 * target): if the page already styles `.przycisk` - whether because the user
 * dropped this template before or wrote the class by hand - that rule is
 * left alone. Rules inside `@media` blocks are matched within the equivalent
 * block. Returns true when anything was actually added.
 */
export function appendMissingRules(
  target: StyleSheetModel,
  allModels: StyleSheetModel[],
  cssSnippet: string,
): boolean {
  if (!target.source.writable || target.parseError !== null) return false;

  let snippet: Root;
  try {
    snippet = postcss.parse(cssSnippet);
  } catch {
    return false;
  }

  let added = false;

  snippet.each((node) => {
    if (node.type === 'rule') {
      const rule = node as Rule;
      if (anySheetHasRule(allModels, rule.selector, null)) return;
      const clone = rule.clone();
      clone.raws.before = '\n\n';
      target.root.append(clone);
      added = true;
      return;
    }

    if (node.type === 'atrule' && (node as AtRule).name === 'font-face') {
      const atRule = node as AtRule;
      const family = declValue(atRule, 'font-family');
      if (family && anySheetHasFontFace(allModels, family)) return;
      const clone = atRule.clone();
      clone.raws.before = '\n\n';
      target.root.append(clone);
      added = true;
      return;
    }

    if (node.type === 'atrule' && (node as AtRule).name === 'media') {
      const mediaRule = node as AtRule;
      const wanted = normaliseMediaParams(mediaRule.params);
      const missing: Rule[] = [];
      mediaRule.walkRules((inner) => {
        if (inner.parent !== mediaRule) return;
        if (!anySheetHasRule(allModels, inner.selector, wanted)) missing.push(inner);
      });
      if (missing.length === 0) return;

      const block =
        findMediaBlockByParams(target.root, wanted) ?? createRawMediaBlock(target.root, mediaRule.params);
      for (const inner of missing) {
        const clone = inner.clone();
        clone.raws.before = '\n\n  ';
        block.append(clone);
      }
      added = true;
    }
  });

  if (added) target.dirty = true;
  return added;
}

function anySheetHasRule(models: StyleSheetModel[], selector: string, mediaParams: string | null): boolean {
  const wanted = splitSelectorList(selector);
  for (const model of models) {
    let found = false;
    model.root.walkRules((rule) => {
      if (found) return;
      const parent = rule.parent;
      const parentMedia =
        parent && parent.type === 'atrule' && (parent as AtRule).name === 'media'
          ? normaliseMediaParams((parent as AtRule).params)
          : null;
      if (parentMedia !== mediaParams) return;
      const selectors = splitSelectorList(rule.selector);
      if (wanted.some((entry) => selectors.includes(entry))) found = true;
    });
    if (found) return true;
  }
  return false;
}

/** The value of the first declaration named `prop` directly inside an at-rule, quotes stripped. */
function declValue(atRule: AtRule, prop: string): string | null {
  let value: string | null = null;
  atRule.walkDecls(prop, (decl) => {
    if (value === null) value = decl.value.trim().replace(/^["']|["']$/gu, '');
  });
  return value;
}

/** True when some sheet already declares `@font-face` for `fontFamily`. */
function anySheetHasFontFace(models: StyleSheetModel[], fontFamily: string): boolean {
  for (const model of models) {
    let found = false;
    model.root.walkAtRules('font-face', (atRule) => {
      if (found) return;
      if (declValue(atRule, 'font-family') === fontFamily) found = true;
    });
    if (found) return true;
  }
  return false;
}

function findMediaBlockByParams(root: Root, normalisedParams: string): AtRule | null {
  let found: AtRule | null = null;
  root.walkAtRules('media', (atRule) => {
    if (found) return;
    if (atRule.parent === root && normaliseMediaParams(atRule.params) === normalisedParams) found = atRule;
  });
  return found;
}

function createRawMediaBlock(root: Root, params: string): AtRule {
  const media = new AtRule({ name: 'media', params });
  media.raws.before = '\n\n';
  media.raws.between = ' ';
  root.append(media);
  return media;
}

/** Removes every declaration for a selector at a breakpoint. */
export function clearRule(model: StyleSheetModel, selector: string, breakpoint: Breakpoint): void {
  if (!model.source.writable) return;
  const rule = findRule(model.root, selector, breakpoint);
  if (!rule) return;
  const parent = rule.parent;
  rule.remove();
  if (parent instanceof AtRule && parent.nodes?.length === 0) parent.remove();
  model.dirty = true;
}

/**
 * Renames a selector everywhere it appears, including inside media queries.
 * Used when an element's styling hook changes (e.g. the user renames a layer).
 */
export function renameSelector(model: StyleSheetModel, from: string, to: string): void {
  if (!model.source.writable || from === to) return;
  let changed = false;

  /**
   * Rewrites one selector, carrying its pseudo-class suffix along.
   *
   * `#hook` and `#hook:hover` are two rules describing the same element, so
   * renaming one without the other would strip the element's hover styling -
   * which is exactly what would happen now that the properties panel can write
   * pseudo-state rules (see `StyleState`). The suffix must begin at a `:` so
   * that renaming `#a` can never match `#ab`.
   */
  const rewrite = (entry: string): string => {
    if (entry === from) return to;
    if (entry.startsWith(from) && entry.charAt(from.length) === ':') {
      return `${to}${entry.slice(from.length)}`;
    }
    return entry;
  };

  model.root.walkRules((rule) => {
    const selectors = splitSelectorList(rule.selector);
    const next = selectors.map(rewrite);
    if (next.every((entry, index) => entry === selectors[index])) return;
    rule.selector = next.join(', ');
    changed = true;
  });
  if (changed) model.dirty = true;
}

/* ------------------------------------------------------------------ */
/* Rule lookup and creation                                             */
/* ------------------------------------------------------------------ */

function findRule(root: Root, selector: string, breakpoint: Breakpoint): Rule | null {
  const container = breakpoint.maxWidth === null ? root : findMediaBlock(root, breakpoint);
  if (!container) return null;

  let found: Rule | null = null;
  container.each((node) => {
    if (found) return false;
    if (node.type !== 'rule') return undefined;
    const rule = node as Rule;
    if (splitSelectorList(rule.selector).includes(selector)) found = rule;
    return undefined;
  });
  return found;
}

function createRule(root: Root, selector: string, breakpoint: Breakpoint): Rule {
  const rule = new Rule({ selector });

  if (breakpoint.maxWidth === null) {
    // Base rules go before the first media block so the desktop-first cascade
    // stays intact even after many edits.
    const firstMedia = findFirstMedia(root);
    if (firstMedia) root.insertBefore(firstMedia, rule);
    else root.append(rule);
    return rule;
  }

  const media = findMediaBlock(root, breakpoint) ?? createMediaBlock(root, breakpoint);
  media.append(rule);
  return rule;
}

/**
 * Media blocks are matched on their *normalised* parameters, so a rule written
 * by hand as `@media(max-width:640px)` is reused rather than duplicated.
 */
function findMediaBlock(root: Root, breakpoint: Breakpoint): AtRule | null {
  if (breakpoint.maxWidth === null) return null;
  const wanted = normaliseMediaParams(mediaQueryFor(breakpoint));

  let found: AtRule | null = null;
  root.walkAtRules('media', (atRule) => {
    if (found) return;
    if (normaliseMediaParams(atRule.params) === wanted) found = atRule;
  });
  return found;
}

function createMediaBlock(root: Root, breakpoint: Breakpoint): AtRule {
  const media = new AtRule({ name: 'media', params: mediaQueryFor(breakpoint) });
  media.raws.before = '\n\n';
  media.raws.between = ' ';

  // Media blocks are kept sorted widest-first, which is the conventional
  // desktop-first order and keeps narrower overrides last.
  const existing: AtRule[] = [];
  root.walkAtRules('media', (atRule) => {
    if (atRule.parent === root) existing.push(atRule);
  });

  const insertBefore = existing.find((atRule) => {
    const width = extractMaxWidth(atRule.params);
    return width !== null && breakpoint.maxWidth !== null && width < breakpoint.maxWidth;
  });

  if (insertBefore) root.insertBefore(insertBefore, media);
  else root.append(media);

  return media;
}

export function mediaQueryFor(breakpoint: Breakpoint): string {
  if (breakpoint.maxWidth === null) return '';
  return `(max-width: ${breakpoint.maxWidth}px)`;
}

function normaliseMediaParams(params: string): string {
  return params.replace(/\s+/gu, '').toLowerCase();
}

function extractMaxWidth(params: string): number | null {
  const match = /max-width\s*:\s*(\d+(?:\.\d+)?)px/iu.exec(params);
  return match?.[1] ? Number(match[1]) : null;
}

function findFirstMedia(root: Root): ChildNode | null {
  let found: ChildNode | null = null;
  root.each((node) => {
    if (found) return false;
    if (node.type === 'atrule' && (node as AtRule).name === 'media') found = node;
    return undefined;
  });
  return found;
}

function findDeclaration(rule: Rule, property: string): Declaration | null {
  let found: Declaration | null = null;
  rule.walkDecls((declaration) => {
    if (declaration.prop.toLowerCase() === property.toLowerCase()) found = declaration;
  });
  return found;
}

function pruneEmpty(rule: Rule): void {
  if (rule.nodes && rule.nodes.length > 0) return;
  const parent = rule.parent;
  rule.remove();
  if (parent instanceof AtRule && (parent.nodes?.length ?? 0) === 0) parent.remove();
}

/**
 * Splits a selector list on top-level commas only - commas inside `:is(...)`,
 * `:not(...)` or attribute values must not split the selector.
 */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const char of selector) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

function splitImportant(value: string): { cleanValue: string; important: boolean } {
  const match = /^(.*?)\s*!\s*important\s*$/iu.exec(value);
  if (match?.[1] !== undefined) return { cleanValue: match[1].trim(), important: true };
  return { cleanValue: value.trim(), important: false };
}

/* ------------------------------------------------------------------ */
/* Starter stylesheet                                                   */
/* ------------------------------------------------------------------ */

/** Content for a stylesheet Litho has to create because the page had none. */
export function emptyStyleSheetContent(): string {
  return `/* Style tej strony. Litho Studio dopisuje tu reguły dla edytowanych elementów. */\n`;
}
