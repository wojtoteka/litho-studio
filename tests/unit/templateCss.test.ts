import { describe, expect, it } from 'vitest';
import type { StyleSource } from '@shared/project.js';
import { appendMissingRules, parseStyleSheet, stringifyStyleSheet } from '@/engine/cssGenerator.js';

/**
 * Template CSS merging: dropping a palette element brings its stylesheet rules
 * along, but only the ones the project does not already define. Dropping the
 * same template five times must not produce five copies of `.przycisk`, and a
 * hand-written rule with the same class must always win by being left alone.
 */

function makeModel(css: string, overrides: Partial<StyleSource> = {}) {
  return parseStyleSheet({
    id: 'sheet-1',
    origin: 'external',
    relPath: 'style.css',
    href: 'style.css',
    hostNodeId: null,
    media: null,
    css,
    writable: true,
    order: 1,
    ...overrides,
  });
}

const BUTTON_TEMPLATE_CSS = `.przycisk {
  padding: 10px 20px;
  background: #6e56cf;
}

.przycisk:hover {
  background: #5b46b0;
}
`;

describe('appendMissingRules', () => {
  it('appends rules the project does not have and reports the addition', () => {
    const model = makeModel('body { margin: 0; }');
    const added = appendMissingRules(model, [model], BUTTON_TEMPLATE_CSS);

    expect(added).toBe(true);
    expect(model.dirty).toBe(true);
    const output = stringifyStyleSheet(model);
    expect(output).toContain('.przycisk {');
    expect(output).toContain('.przycisk:hover {');
    expect(output).toContain('body { margin: 0; }');
  });

  it('is idempotent - the second drop adds nothing', () => {
    const model = makeModel('body { margin: 0; }');
    appendMissingRules(model, [model], BUTTON_TEMPLATE_CSS);
    const once = stringifyStyleSheet(model);

    const addedAgain = appendMissingRules(model, [model], BUTTON_TEMPLATE_CSS);
    expect(addedAgain).toBe(false);
    expect(stringifyStyleSheet(model)).toBe(once);
  });

  it('leaves a hand-written rule with the same selector untouched', () => {
    const model = makeModel('.przycisk { background: red; }');
    appendMissingRules(model, [model], BUTTON_TEMPLATE_CSS);

    const output = stringifyStyleSheet(model);
    expect(output).toContain('background: red');
    expect(output).not.toContain('#6e56cf');
    // The :hover variant is genuinely absent, so it is added.
    expect(output).toContain('.przycisk:hover');
  });

  it('checks every sheet, not only the target', () => {
    const other = makeModel('.przycisk { background: green; }', { id: 'sheet-0', relPath: 'base.css' });
    const target = makeModel('');
    appendMissingRules(target, [other, target], BUTTON_TEMPLATE_CSS);

    const output = stringifyStyleSheet(target);
    expect(output).not.toContain('#6e56cf'); // defined in the other sheet
    expect(output).toContain('.przycisk:hover'); // still missing everywhere
  });

  it('merges media-query rules into an equivalent existing block', () => {
    const model = makeModel('@media (max-width: 640px) { .a { color: red; } }');
    const added = appendMissingRules(
      model,
      [model],
      '@media (max-width:640px) { .ls-navbar { flex-direction: column; } }',
    );

    expect(added).toBe(true);
    const output = stringifyStyleSheet(model);
    // Only one media block - matched despite the whitespace difference.
    expect(output.match(/@media/gu)).toHaveLength(1);
    expect(output).toContain('.ls-navbar');
  });

  it('does not duplicate a rule that already exists inside the media block', () => {
    const model = makeModel('@media (max-width: 640px) { .ls-hero { padding: 10px; } }');
    const added = appendMissingRules(
      model,
      [model],
      '@media (max-width: 640px) { .ls-hero { padding: 56px 20px; } }',
    );

    expect(added).toBe(false);
    expect(stringifyStyleSheet(model)).toContain('padding: 10px');
    expect(stringifyStyleSheet(model)).not.toContain('56px');
  });

  it('refuses to touch a read-only or broken sheet', () => {
    const readOnly = makeModel('body{}', { writable: false });
    expect(appendMissingRules(readOnly, [readOnly], BUTTON_TEMPLATE_CSS)).toBe(false);

    const broken = parseStyleSheet({
      id: 'bad',
      origin: 'external',
      relPath: 'bad.css',
      href: 'bad.css',
      hostNodeId: null,
      media: null,
      css: '.oops { color: ',
      writable: true,
      order: 1,
    });
    expect(broken.parseError).not.toBeNull();
    expect(appendMissingRules(broken, [broken], BUTTON_TEMPLATE_CSS)).toBe(false);
  });
});
