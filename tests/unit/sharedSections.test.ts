import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/engine/htmlParser.js';
import { generateHtml } from '@/engine/htmlGenerator.js';
import { findElement, getBody, isElement } from '@shared/document.js';
import {
  findSharedSections,
  isValidSectionName,
  markAsShared,
  replaceSharedSection,
  sharedSectionFor,
  sharedSectionNames,
  unmarkShared,
} from '@/engine/sharedSections.js';

/**
 * Shared sections are the one feature here that writes to files the user is not
 * currently looking at, so the rules around *when it refuses* matter as much as
 * the copying itself. The markers are plain HTML comments on purpose — these
 * tests pin that the output stays a plain website.
 */

function load(html: string, relPath = 'index.html') {
  return parseHtml(relPath, html, { files: { [relPath]: html } }).document;
}

const WITH_NAV = `<!doctype html>
<html lang="pl">
  <head><title>A</title></head>
  <body>
    <!-- litho:shared nav -->
    <header class="menu"><a href="/">Start</a></header>
    <!-- /litho:shared -->
    <main><h1>Strona A</h1></main>
  </body>
</html>
`;

const OTHER_PAGE = `<!doctype html>
<html lang="pl">
  <head><title>B</title></head>
  <body>
    <!-- litho:shared nav -->
    <header class="menu"><a href="/">Stara wersja</a></header>
    <!-- /litho:shared -->
    <main><h1>Strona B</h1></main>
  </body>
</html>
`;

describe('isValidSectionName', () => {
  it('accepts slugs and rejects anything that would need quoting', () => {
    expect(isValidSectionName('nav')).toBe(true);
    expect(isValidSectionName('stopka-glowna')).toBe(true);
    expect(isValidSectionName('Nav')).toBe(false);
    expect(isValidSectionName('2nav')).toBe(false);
    expect(isValidSectionName('na v')).toBe(false);
    expect(isValidSectionName('')).toBe(false);
  });
});

describe('findSharedSections', () => {
  it('finds a named block and the nodes between its markers', () => {
    const sections = findSharedSections(load(WITH_NAV));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe('nav');
    const [node] = sections[0]!.nodes.filter(isElement);
    expect(node?.tag).toBe('header');
  });

  it('ignores an opener with no closer rather than swallowing the rest of the page', () => {
    const sections = findSharedSections(
      load(
        `<!doctype html><html><body><!-- litho:shared nav --><header>X</header><main>Y</main></body></html>`,
      ),
    );
    expect(sections).toEqual([]);
  });

  it('ignores a malformed name', () => {
    const sections = findSharedSections(
      load(
        `<!doctype html><html><body><!-- litho:shared Nie Slug --><header>X</header><!-- /litho:shared --></body></html>`,
      ),
    );
    expect(sections).toEqual([]);
  });

  it('lists the names it found', () => {
    expect(sharedSectionNames(load(WITH_NAV))).toEqual(['nav']);
  });
});

describe('markAsShared', () => {
  it('wraps an element in comment markers that survive a round trip', () => {
    const doc = load(`<!doctype html>
<html lang="pl"><head><title>A</title></head>
<body><header class="menu">Menu</header><main>Treść</main></body></html>`);

    const body = getBody(doc)!;
    const header = body.children.filter(isElement).find((node) => node.tag === 'header')!;
    expect(markAsShared(doc, header.id, 'nav')).toBe(true);

    const html = generateHtml(doc);
    expect(html).toContain('<!-- litho:shared nav -->');
    expect(html).toContain('<!-- /litho:shared -->');
    // Still a plain page: the section itself is unchanged.
    expect(html).toContain('<header class="menu">Menu</header>');

    expect(sharedSectionNames(load(html))).toEqual(['nav']);
  });

  it('refuses to nest one shared section inside another', () => {
    const doc = load(WITH_NAV);
    const section = findSharedSections(doc)[0]!;
    const header = section.nodes.filter(isElement)[0]!;
    const link = header.children.filter(isElement)[0]!;
    expect(markAsShared(doc, link.id, 'inny')).toBe(false);
  });

  it('refuses an invalid name', () => {
    const doc = load(`<!doctype html><html><body><header>M</header></body></html>`);
    const header = getBody(doc)!.children.filter(isElement)[0]!;
    expect(markAsShared(doc, header.id, 'Nie Slug')).toBe(false);
  });
});

describe('sharedSectionFor', () => {
  it('finds the section a nested node belongs to, and nothing for one outside', () => {
    const doc = load(WITH_NAV);
    const section = findSharedSections(doc)[0]!;
    const link = section.nodes.filter(isElement)[0]!.children.filter(isElement)[0]!;
    expect(sharedSectionFor(doc, link.id)?.name).toBe('nav');

    const main = getBody(doc)!
      .children.filter(isElement)
      .find((node) => node.tag === 'main')!;
    const heading = main.children.filter(isElement)[0]!;
    expect(sharedSectionFor(doc, heading.id)).toBeNull();
  });
});

describe('replaceSharedSection', () => {
  it('copies the block into another page without touching the rest of it', () => {
    const source = load(WITH_NAV);
    const target = load(OTHER_PAGE, 'b.html');

    const section = findSharedSections(source)[0]!;
    expect(replaceSharedSection(target, 'nav', section.nodes)).toBe(true);

    const html = generateHtml(target);
    expect(html).toContain('Start');
    expect(html).not.toContain('Stara wersja');
    // The target's own content and title are untouched.
    expect(html).toContain('<h1>Strona B</h1>');
    expect(html).toContain('<title>B</title>');
    // And it is still marked, so the next change reaches it too.
    expect(html).toContain('<!-- litho:shared nav -->');
  });

  it('gives the copied nodes fresh ids so two pages never share identity', () => {
    const source = load(WITH_NAV);
    const target = load(OTHER_PAGE, 'b.html');
    const section = findSharedSections(source)[0]!;
    const sourceHeaderId = section.nodes.filter(isElement)[0]!.id;

    replaceSharedSection(target, 'nav', section.nodes);

    const copied = findSharedSections(target)[0]!.nodes.filter(isElement)[0]!;
    expect(copied.id).not.toBe(sourceHeaderId);
    expect(findElement(target.root, sourceHeaderId)).toBeNull();
  });

  it('reports no change when the target already matches, so nothing is rewritten', () => {
    const source = load(WITH_NAV);
    const target = load(WITH_NAV, 'b.html');
    const section = findSharedSections(source)[0]!;
    expect(replaceSharedSection(target, 'nav', section.nodes)).toBe(false);
  });

  it('leaves a page that does not carry the markers alone', () => {
    const source = load(WITH_NAV);
    const target = load(`<!doctype html><html><body><main>Bez menu</main></body></html>`, 'b.html');
    const section = findSharedSections(source)[0]!;
    expect(replaceSharedSection(target, 'nav', section.nodes)).toBe(false);
    expect(generateHtml(target)).toContain('Bez menu');
  });
});

describe('unmarkShared', () => {
  it('removes the markers and keeps the content', () => {
    const doc = load(WITH_NAV);
    expect(unmarkShared(doc, 'nav')).toBe(true);
    const html = generateHtml(doc);
    expect(html).not.toContain('litho:shared');
    expect(html).toContain('<header class="menu">');
  });
});
