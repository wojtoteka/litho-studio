import { Declaration, type Rule } from 'postcss';

/**
 * The `background` shorthand, expanded into the longhands the editor speaks.
 *
 * The properties panel reads and writes `background-color` and
 * `background-image`. Real stylesheets - including the ones this app's own
 * component templates ship - overwhelmingly write the shorthand instead:
 *
 *     .ls-stats { background: linear-gradient(135deg, #6e56cf, #4f8fff); }
 *
 * Nothing in the panel could see that. The background section showed no colour
 * and layer "Brak", picking a colour appended a `background-color` the
 * shorthand's gradient still covered, and "Brak" removed a `background-image`
 * declaration that was never there - so on a statistics block it was impossible
 * to get a flat colour or a transparent background, which is exactly what was
 * reported. Teaching the reader and the writer about the shorthand fixes both
 * halves at once, for every project, not just for our own templates.
 *
 * The parser is deliberately all-or-nothing: anything it cannot classify with
 * certainty (a `var()` that could be a colour or a position, an unrecognised
 * keyword) makes it return `null`, and the caller leaves the stylesheet exactly
 * as the user wrote it. Guessing here would mean rewriting somebody's CSS into
 * something that renders differently.
 */

/** Every longhand `background` sets, and what it resets to when unmentioned. */
export const BACKGROUND_LONGHAND_INITIALS: Readonly<Record<string, string>> = {
  'background-image': 'none',
  'background-position': '0% 0%',
  'background-size': 'auto',
  'background-repeat': 'repeat',
  'background-attachment': 'scroll',
  'background-origin': 'padding-box',
  'background-clip': 'border-box',
  'background-color': 'transparent',
};

const REPEAT_KEYWORDS = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round']);
const ATTACHMENT_KEYWORDS = new Set(['scroll', 'fixed', 'local']);
const BOX_KEYWORDS = new Set(['border-box', 'padding-box', 'content-box']);
const POSITION_KEYWORDS = new Set(['left', 'right', 'top', 'bottom', 'center']);

const IMAGE_FUNCTION =
  /^(-webkit-|-moz-|-o-)?(url|(repeating-)?(linear|radial|conic)-gradient|image-set|cross-fade|paint|element)\(/iu;
const LENGTH = /^[+-]?(\d+\.?\d*|\.\d+)(px|em|rem|%|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|q)?$/iu;
const COLOR_FUNCTION = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/iu;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/iu;

/**
 * Named colours accepted as such. Not the full CSS list on purpose: an
 * identifier that is *not* here is treated as unparseable, and the whole
 * shorthand is left alone rather than being rewritten around a guess.
 */
const NAMED_COLORS = new Set([
  'transparent',
  'currentcolor',
  'aqua',
  'aquamarine',
  'azure',
  'beige',
  'black',
  'blue',
  'brown',
  'coral',
  'crimson',
  'cyan',
  'fuchsia',
  'gold',
  'gray',
  'green',
  'grey',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lime',
  'linen',
  'magenta',
  'maroon',
  'navy',
  'olive',
  'orange',
  'orchid',
  'pink',
  'plum',
  'purple',
  'red',
  'salmon',
  'silver',
  'snow',
  'tan',
  'teal',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'white',
  'yellow',
]);

/**
 * Splits on a separator only at nesting depth zero, so the commas inside
 * `linear-gradient(…)` and `rgb(…)` never split a value apart.
 */
function splitTopLevel(value: string, separator: ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;

  for (const char of value) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Whitespace-separated tokens of one layer, with `/` emitted as its own token. */
function tokenizeLayer(layer: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;

  const flush = (): void => {
    if (current.trim() !== '') tokens.push(current.trim());
    current = '';
  };

  for (const char of layer) {
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/u.test(char)) {
      flush();
      continue;
    }
    if (depth === 0 && char === '/') {
      flush();
      tokens.push('/');
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

function isImageToken(token: string): boolean {
  return token.toLowerCase() === 'none' || IMAGE_FUNCTION.test(token);
}

function isPositionToken(token: string): boolean {
  const lower = token.toLowerCase();
  return POSITION_KEYWORDS.has(lower) || LENGTH.test(token) || lower.startsWith('calc(');
}

function isSizeToken(token: string): boolean {
  const lower = token.toLowerCase();
  return lower === 'cover' || lower === 'contain' || lower === 'auto' || isPositionToken(token);
}

function isColorToken(token: string): boolean {
  const lower = token.toLowerCase();
  return NAMED_COLORS.has(lower) || HEX_COLOR.test(token) || COLOR_FUNCTION.test(token);
}

interface LayerParts {
  image?: string;
  position?: string;
  size?: string;
  repeat?: string;
  attachment?: string;
  origin?: string;
  clip?: string;
  color?: string;
}

/** Classifies one comma-separated layer, or returns `null` if anything is unclear. */
function parseLayer(layer: string, isFinalLayer: boolean): LayerParts | null {
  const tokens = tokenizeLayer(layer);
  if (tokens.length === 0) return null;

  const parts: LayerParts = {};
  const position: string[] = [];
  const size: string[] = [];
  const repeat: string[] = [];
  const boxes: string[] = [];
  let afterSlash = false;

  for (const token of tokens) {
    if (token === '/') {
      // A size may only follow a position, and only once.
      if (afterSlash || position.length === 0) return null;
      afterSlash = true;
      continue;
    }
    if (afterSlash) {
      // A size is one or two values, and the layer may carry on afterwards
      // (`url(a) center / cover no-repeat`) - so the slash state ends as soon
      // as the size is complete or a token that cannot be one turns up.
      if (size.length < 2 && isSizeToken(token)) {
        size.push(token);
        continue;
      }
      afterSlash = false;
    }
    if (isImageToken(token)) {
      if (parts.image !== undefined) return null;
      parts.image = token;
      continue;
    }
    if (REPEAT_KEYWORDS.has(token.toLowerCase())) {
      repeat.push(token);
      continue;
    }
    if (ATTACHMENT_KEYWORDS.has(token.toLowerCase()) && !isPositionToken(token)) {
      if (parts.attachment !== undefined) return null;
      parts.attachment = token;
      continue;
    }
    if (BOX_KEYWORDS.has(token.toLowerCase())) {
      boxes.push(token);
      continue;
    }
    if (isPositionToken(token)) {
      position.push(token);
      continue;
    }
    // Only the last layer may carry the colour - it sits *behind* every layer,
    // so CSS allows it nowhere else, and a colour found earlier means this is
    // not a value we understand.
    if (isColorToken(token) && isFinalLayer && parts.color === undefined) {
      parts.color = token;
      continue;
    }
    return null;
  }

  if (position.length > 0) parts.position = position.join(' ');
  if (size.length > 0) parts.size = size.join(' ');
  if (repeat.length > 0) parts.repeat = repeat.join(' ');
  if (boxes.length === 1) {
    // One box sets origin *and* clip; two set them in that order.
    parts.origin = boxes[0];
    parts.clip = boxes[0];
  } else if (boxes.length === 2) {
    parts.origin = boxes[0];
    parts.clip = boxes[1];
  } else if (boxes.length > 2) {
    return null;
  }

  return parts;
}

/**
 * Expands a `background` value into its longhands, or returns `null` when the
 * value cannot be classified with certainty.
 *
 * Multi-layer values are supported: each longhand keeps the same comma-separated
 * layer order the shorthand had, which is what `background-image` and friends
 * expect. `!important` on the shorthand is carried onto every longhand.
 */
export function expandBackgroundShorthand(value: string): Record<string, string> | null {
  const important = /!\s*important\s*$/iu.test(value);
  const body = value.replace(/!\s*important\s*$/iu, '').trim();
  if (body === '') return null;

  // Global keywords apply to the whole shorthand and mean something specific
  // per longhand; not worth guessing at, so they are left alone.
  if (/^(inherit|initial|unset|revert|revert-layer)$/iu.test(body)) return null;

  const layers = splitTopLevel(body, ',').map((layer) => layer.trim());
  if (layers.some((layer) => layer === '')) return null;

  const parsed: LayerParts[] = [];
  for (const [index, layer] of layers.entries()) {
    const result = parseLayer(layer, index === layers.length - 1);
    if (!result) return null;
    parsed.push(result);
  }

  const expanded: Record<string, string> = {};
  const collect = (property: string, pick: (parts: LayerParts) => string | undefined): void => {
    if (parsed.every((parts) => pick(parts) === undefined)) return;
    const initial = BACKGROUND_LONGHAND_INITIALS[property]!;
    expanded[property] = parsed.map((parts) => pick(parts) ?? initial).join(', ');
  };

  collect('background-image', (parts) => parts.image);
  collect('background-position', (parts) => parts.position);
  collect('background-size', (parts) => parts.size);
  collect('background-repeat', (parts) => parts.repeat);
  collect('background-attachment', (parts) => parts.attachment);
  collect('background-origin', (parts) => parts.origin);
  collect('background-clip', (parts) => parts.clip);
  // The colour is not per-layer: it belongs to the final layer alone.
  const color = parsed[parsed.length - 1]?.color;
  if (color !== undefined) expanded['background-color'] = color;

  if (Object.keys(expanded).length === 0) return null;

  if (important) {
    for (const property of Object.keys(expanded)) {
      expanded[property] = `${expanded[property]} !important`;
    }
  }
  return expanded;
}

/**
 * Rewrites every `background` shorthand in a rule as longhands, in place.
 *
 * Called before a background longhand is written, so the declaration the panel
 * produces is not silently overruled by a shorthand further up the same rule.
 * Longhands the shorthand did not mention are written out at their initial
 * values *only* when the same rule declares them somewhere else - the shorthand
 * was resetting those, and dropping that reset would change how the page
 * renders.
 *
 * Returns true when anything was rewritten.
 */
export function expandBackgroundShorthandInRule(rule: Rule): boolean {
  const shorthands: Declaration[] = [];
  rule.walkDecls((declaration) => {
    if (declaration.prop.toLowerCase() === 'background') shorthands.push(declaration);
  });
  if (shorthands.length === 0) return false;

  let changed = false;
  for (const shorthand of shorthands) {
    const raw = shorthand.value + (shorthand.important ? ' !important' : '');
    const expanded = expandBackgroundShorthand(raw);
    if (!expanded) continue;

    const longhandsInRule = new Set<string>();
    rule.walkDecls((declaration) => {
      if (declaration === shorthand) return;
      const property = declaration.prop.toLowerCase();
      if (property in BACKGROUND_LONGHAND_INITIALS) longhandsInRule.add(property);
    });

    const replacements: Declaration[] = [];
    for (const [property, initial] of Object.entries(BACKGROUND_LONGHAND_INITIALS)) {
      const value = expanded[property] ?? (longhandsInRule.has(property) ? initial : undefined);
      if (value === undefined) continue;
      const cleanValue = value.replace(/!\s*important\s*$/iu, '').trim();
      replacements.push(
        new Declaration({ prop: property, value: cleanValue, important: shorthand.important }),
      );
    }

    shorthand.replaceWith(...replacements);
    changed = true;
  }
  return changed;
}
