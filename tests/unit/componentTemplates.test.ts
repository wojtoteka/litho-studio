import postcss from 'postcss';
import type { AtRule, Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import type { StyleSource } from '@shared/project.js';
import type { DocNode, ElementNode } from '@shared/document.js';
import { COMPONENT_TEMPLATES, getComponentTemplate } from '@/lib/elementFactory.js';
import { appendMissingRules, parseStyleSheet, stringifyStyleSheet } from '@/engine/cssGenerator.js';

/**
 * The component library writes into the *project's own* stylesheet, shared with
 * everything else on the page. That makes two properties load-bearing, and they
 * are what these tests protect:
 *
 *  - a block only ever styles its own classes, so dropping a cennik cannot
 *    restyle a heading that was already on the page, and
 *  - its CSS survives the trip through `appendMissingRules`, which merges plain
 *    rules and `@media` blocks and silently drops anything else.
 */

const SECTION_IDS = ['pricing', 'faq', 'testimonials', 'stats', 'youtube'];
const ORIGINAL_IDS = ['navbar', 'hero', 'contact-form', 'product-card', 'gallery', 'footer'];

function walk(node: DocNode, visit: (element: ElementNode) => void): void {
  if (node.kind !== 'element') return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function classesOf(root: ElementNode): Set<string> {
  const found = new Set<string>();
  walk(root, (element) => {
    const value = element.attrs.find((attr) => attr.name === 'class')?.value ?? '';
    for (const name of value.split(/\s+/u)) if (name) found.add(name);
  });
  return found;
}

/** Every class the snippet's selectors mention. */
function styledClasses(css: string): Set<string> {
  const found = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    for (const match of rule.selector.matchAll(/\.([A-Za-z0-9_-]+)/gu)) found.add(match[1]!);
  });
  return found;
}

function emptySheet(css = ''): ReturnType<typeof parseStyleSheet> {
  const source: StyleSource = {
    id: 'sheet-1',
    origin: 'external',
    relPath: 'style.css',
    href: 'style.css',
    hostNodeId: null,
    media: null,
    css,
    writable: true,
    order: 1,
  };
  return parseStyleSheet(source);
}

describe('component library', () => {
  it('keeps the original blocks and adds the new sections after them', () => {
    const ids = COMPONENT_TEMPLATES.map((template) => template.id);
    expect(ids.slice(0, ORIGINAL_IDS.length)).toEqual(ORIGINAL_IDS);
    for (const id of SECTION_IDS) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes every template reachable by id, which is what a canvas drop uses', () => {
    for (const template of COMPONENT_TEMPLATES) {
      expect(getComponentTemplate(template.id)).toBe(template);
    }
  });

  it('gives each drop a fresh subtree with unique node ids', () => {
    for (const template of COMPONENT_TEMPLATES) {
      const first = template.build();
      const second = template.build();
      const ids: string[] = [];
      walk(first, (element) => ids.push(element.id));
      walk(second, (element) => ids.push(element.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('new section templates', () => {
  const sections = COMPONENT_TEMPLATES.filter((template) => SECTION_IDS.includes(template.id));

  it('styles only classes, never bare tags — a drop cannot restyle the page', () => {
    for (const template of sections) {
      postcss.parse(template.css).walkRules((rule) => {
        for (const part of rule.selector.split(',')) {
          // Each compound selector in the list has to start at a class, so the
          // rule can never reach markup outside the block.
          expect(part.trim().startsWith('.'), `${template.id}: ${rule.selector}`).toBe(true);
        }
        expect(rule.selector, template.id).not.toContain('!important');
      });
    }
  });

  it('scopes every selector to its own block prefix', () => {
    const prefixes: Record<string, string[]> = {
      pricing: ['ls-pricing', 'ls-plan'],
      faq: ['ls-faq'],
      testimonials: ['ls-testimonials', 'ls-testimonial'],
      stats: ['ls-stats', 'ls-stat'],
      youtube: ['ls-video'],
    };
    for (const template of sections) {
      for (const name of styledClasses(template.css)) {
        expect(
          prefixes[template.id]!.some(
            (prefix) => name === prefix || name.startsWith(`${prefix}__`) || name.startsWith(`${prefix}--`),
          ),
          `${template.id} styles unrelated class .${name}`,
        ).toBe(true);
      }
    }
  });

  it('styles exactly the classes its markup uses — no dead rules, no unstyled nodes', () => {
    for (const template of sections) {
      const used = classesOf(template.build());
      const styled = styledClasses(template.css);
      for (const name of used) {
        expect(styled.has(name), `${template.id}: .${name} is used but never styled`).toBe(true);
      }
      for (const name of styled) {
        expect(used.has(name), `${template.id}: .${name} is styled but never used`).toBe(true);
      }
    }
  });

  it('uses only rules and @media, the two things the merge can carry', () => {
    for (const template of sections) {
      postcss.parse(template.css).each((node) => {
        if (node.type === 'rule') return;
        // @keyframes and friends would be dropped on the way to the stylesheet,
        // leaving an animation that references a name nothing defines.
        expect(node.type, template.id).toBe('atrule');
        expect((node as AtRule).name, template.id).toBe('media');
      });
    }
  });

  it('lands in a stylesheet that already holds every other template, without collisions', () => {
    // The realistic worst case: a page built from the whole library. Nothing may
    // be skipped as "already defined" — that would mean two blocks fighting over
    // one selector.
    const sheet = emptySheet('body { margin: 0; }');
    for (const template of COMPONENT_TEMPLATES) {
      expect(appendMissingRules(sheet, [sheet], template.css), `${template.id} added nothing`).toBe(true);
    }

    const output = stringifyStyleSheet(sheet);
    const selectors: string[] = [];
    postcss.parse(output).walkRules((rule) => {
      const parent = rule.parent;
      const media =
        parent && parent.type === 'atrule' && (parent as AtRule).name === 'media'
          ? (parent as AtRule).params
          : '';
      selectors.push(`${media}|${(rule as Rule).selector}`);
    });
    expect(new Set(selectors).size, 'duplicate selector written to the sheet').toBe(selectors.length);
    expect(output).toContain('.ls-plan__cta');
    expect(output).toContain('.ls-faq__item[open] .ls-faq__question::after');
  });

  it('adds nothing on a second drop of the same block', () => {
    for (const template of sections) {
      const sheet = emptySheet();
      expect(appendMissingRules(sheet, [sheet], template.css)).toBe(true);
      expect(appendMissingRules(sheet, [sheet], template.css), template.id).toBe(false);
    }
  });

  it('builds the FAQ as a native details accordion that works without JavaScript', () => {
    const root = getComponentTemplate('faq')!.build();
    const items: ElementNode[] = [];
    walk(root, (element) => {
      if (element.tag === 'details') items.push(element);
    });

    expect(items).toHaveLength(4);
    for (const item of items) {
      // `name` is what makes modern browsers close the other entries.
      expect(item.attrs.find((attr) => attr.name === 'name')?.value).toBe('faq');
      expect(item.children.some((child) => child.kind === 'element' && child.tag === 'summary')).toBe(true);
    }
    const open = items.filter((item) => item.attrs.some((attr) => attr.name === 'open'));
    expect(open, 'exactly one entry starts open').toHaveLength(1);
  });

  it('embeds YouTube from the no-cookie host, lazily and with fullscreen allowed', () => {
    const root = getComponentTemplate('youtube')!.build();
    let frame: ElementNode | null = null;
    walk(root, (element) => {
      if (element.tag === 'iframe') frame = element;
    });
    expect(frame).not.toBeNull();

    const attrs = Object.fromEntries((frame! as ElementNode).attrs.map((attr) => [attr.name, attr.value]));
    expect(attrs.src).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\//u);
    expect(attrs.loading).toBe('lazy');
    expect(attrs.title).toBeTruthy();
    expect(attrs.allowfullscreen).toBe('');
  });

  it('keeps each statistic number in its own span, so a counter script can target it', () => {
    const root = getComponentTemplate('stats')!.build();
    const numbers: ElementNode[] = [];
    walk(root, (element) => {
      if (element.attrs.some((attr) => attr.name === 'class' && attr.value === 'ls-stat__number')) {
        numbers.push(element);
      }
    });

    expect(numbers).toHaveLength(4);
    for (const number of numbers) {
      // A lone text child: the count-up preset overwrites `textContent`, and the
      // "+" suffix must not be inside what it overwrites.
      expect(number.children).toHaveLength(1);
      expect(number.children[0]!.kind).toBe('text');
    }
  });
});
