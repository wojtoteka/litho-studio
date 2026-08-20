import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/engine/htmlParser.js';
import { generateHtml } from '@/engine/htmlGenerator.js';
import { applyPageMeta, readPageMeta } from '@/engine/headMeta.js';

/**
 * Page metadata is the part of a site nobody sees while building it and
 * everybody sees once it is shared. The contract here is the same as everywhere
 * else in this editor: the change lands in the real HTML, and nothing else in
 * the file moves.
 */

function load(html: string) {
  return parseHtml('index.html', html, { files: { 'index.html': html } }).document;
}

const BARE = `<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <title>Stara nazwa</title>
  </head>
  <body>
    <h1>Cześć</h1>
  </body>
</html>
`;

describe('readPageMeta', () => {
  it('reads what the page already declares', () => {
    const meta = readPageMeta(load(BARE).root);
    expect(meta.title).toBe('Stara nazwa');
    expect(meta.lang).toBe('pl');
    expect(meta.description).toBe('');
    expect(meta.ogImage).toBe('');
    expect(meta.favicon).toBe('');
  });

  it('reads description, Open Graph image and favicon when present', () => {
    const meta = readPageMeta(
      load(`<!doctype html>
<html lang="en">
  <head>
    <meta name="description" content="Krótki opis strony" />
    <meta property="og:image" content="assets/social.png" />
    <link rel="shortcut icon" href="assets/favicon.ico" />
  </head>
  <body></body>
</html>`).root,
    );
    expect(meta.description).toBe('Krótki opis strony');
    expect(meta.ogImage).toBe('assets/social.png');
    expect(meta.favicon).toBe('assets/favicon.ico');
    expect(meta.lang).toBe('en');
  });
});

describe('applyPageMeta', () => {
  it('writes a title, description and language into the real markup', () => {
    const doc = load(BARE);
    expect(applyPageMeta(doc.root, { title: 'Nowa nazwa', description: 'Opis', lang: 'en' })).toBe(true);

    const html = generateHtml(doc);
    expect(html).toContain('<title>Nowa nazwa</title>');
    expect(html).toContain('name="description"');
    expect(html).toContain('content="Opis"');
    expect(html).toContain('lang="en"');
    // The page's own content is untouched.
    expect(html).toContain('<h1>Cześć</h1>');
    expect(html).toContain('charset="utf-8"');
  });

  it('mirrors the title and description into Open Graph', () => {
    const doc = load(BARE);
    applyPageMeta(doc.root, { title: 'Firma', description: 'Co robimy' });
    const html = generateHtml(doc);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
  });

  it('is idempotent — writing the same value twice adds no second tag', () => {
    const doc = load(BARE);
    applyPageMeta(doc.root, { description: 'Ten sam opis' });
    expect(applyPageMeta(doc.root, { description: 'Ten sam opis' })).toBe(false);

    const html = generateHtml(doc);
    expect(html.match(/name="description"/gu)?.length).toBe(1);
  });

  it('removes a tag when its value is cleared, rather than leaving content=""', () => {
    const doc = load(BARE);
    applyPageMeta(doc.root, { description: 'Do usunięcia' });
    expect(generateHtml(doc)).toContain('name="description"');

    expect(applyPageMeta(doc.root, { description: '' })).toBe(true);
    const html = generateHtml(doc);
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain('content=""');
  });

  it('adds and then updates a favicon link in place', () => {
    const doc = load(BARE);
    applyPageMeta(doc.root, { favicon: 'assets/a.png' });
    expect(generateHtml(doc)).toContain('href="assets/a.png"');

    applyPageMeta(doc.root, { favicon: 'assets/b.png' });
    const html = generateHtml(doc);
    expect(html).toContain('href="assets/b.png"');
    expect(html).not.toContain('assets/a.png');
    expect(html.match(/rel="icon"/gu)?.length).toBe(1);
  });

  it('round-trips through the parser', () => {
    const doc = load(BARE);
    applyPageMeta(doc.root, {
      title: 'Tytuł',
      description: 'Opis strony',
      lang: 'de',
      ogImage: 'assets/og.png',
      favicon: 'assets/icon.svg',
    });

    const reparsed = load(generateHtml(doc));
    const meta = readPageMeta(reparsed.root);
    expect(meta).toMatchObject({
      title: 'Tytuł',
      description: 'Opis strony',
      lang: 'de',
      ogImage: 'assets/og.png',
      favicon: 'assets/icon.svg',
    });
  });
});
