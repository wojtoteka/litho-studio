import { describe, expect, it } from 'vitest';
import { parseHtml } from '@/engine/htmlParser.js';
import { auditPage, type AuditFinding } from '@/engine/pageAudit.js';

/**
 * The pre-publish checks.
 *
 * Each case is a page that *looks* finished in the canvas and is broken for
 * someone who is not looking at the canvas - a screen-reader user, a search
 * engine, or a visitor who clicks a link. The tests pin the rules that catch
 * them, and just as importantly pin the cases that must stay silent: a check
 * that cries wolf gets ignored, and then the real findings go with it.
 */

function audit(html: string, options: { pages?: string[]; files?: string[] } = {}): AuditFinding[] {
  const parsed = parseHtml('index.html', html, { files: { 'index.html': html } });
  return auditPage({
    document: parsed.document,
    pages: options.pages ?? ['index.html'],
    files: options.files ?? ['index.html'],
  });
}

const rules = (findings: AuditFinding[]): string[] => findings.map((finding) => finding.rule);

const GOOD = `<!doctype html>
<html lang="pl">
  <head>
    <title>Stolarnia Kowalski - meble na wymiar</title>
    <meta name="description" content="Robimy meble na wymiar w Krakowie od 1998 roku." />
  </head>
  <body>
    <h1>Meble na wymiar</h1>
    <h2>Oferta</h2>
    <img src="stol.jpg" alt="Dębowy stół w warsztacie" />
    <a href="kontakt.html">Kontakt</a>
    <a href="https://example.com">Partner</a>
    <a href="#oferta">Zobacz ofertę</a>
    <button>Wyślij</button>
  </body>
</html>
`;

describe('auditPage', () => {
  it('says nothing about a page that is actually fine', () => {
    expect(
      audit(GOOD, { pages: ['index.html', 'kontakt.html'], files: ['index.html', 'kontakt.html'] }),
    ).toEqual([]);
  });

  it('reports a missing title, description and language', () => {
    const findings = audit(`<!doctype html><html><head></head><body><h1>A</h1></body></html>`);
    expect(rules(findings)).toEqual(expect.arrayContaining(['meta-title', 'meta-description', 'meta-lang']));
    expect(findings.find((f) => f.rule === 'meta-title')?.severity).toBe('error');
  });

  it('reports an image with no alt, but not one deliberately marked decorative', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><img src="a.jpg" /><img src="b.jpg" alt="" /></body></html>`,
    );
    expect(rules(findings)).toEqual(['img-alt']);
    expect(findings[0]?.message).toContain('a.jpg');
  });

  it('reports links that go nowhere and links to files that do not exist', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><a href="#">Pusty</a><a href="brak.html">Znikąd</a></body></html>`,
    );
    expect(rules(findings)).toEqual(expect.arrayContaining(['link-empty', 'link-missing']));
    expect(findings.find((f) => f.rule === 'link-missing')?.message).toContain('brak.html');
  });

  it('leaves external links and anchors alone', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><a href="https://example.com/x">Zew</a><a href="mailto:a@b.pl">Mail</a><a href="#sekcja">Kotwica</a></body></html>`,
    );
    expect(findings).toEqual([]);
  });

  it('reports a skipped heading level', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><h3>C</h3></body></html>`,
    );
    expect(rules(findings)).toEqual(['heading-skip']);
    expect(findings[0]?.message).toContain('H1 → H3');
  });

  it('accepts headings that step back up to a previous level', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2></body></html>`,
    );
    expect(findings).toEqual([]);
  });

  it('reports a button with no accessible name, but accepts an aria-label', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><button></button><button aria-label="Zamknij"></button></body></html>`,
    );
    expect(rules(findings)).toEqual(['button-unlabelled']);
  });

  it('puts errors before warnings', () => {
    const findings = audit(
      `<!doctype html><html><head></head><body><h1>A</h1><img src="a.jpg" /></body></html>`,
    );
    const severities = findings.map((finding) => finding.severity);
    expect(severities).toEqual(
      [...severities].sort((a, b) => (a === 'error' ? -1 : 1) - (b === 'error' ? -1 : 1)),
    );
    expect(severities[0]).toBe('error');
  });

  it('points each finding at the element it is about', () => {
    const findings = audit(
      `<!doctype html><html lang="pl"><head><title>T</title><meta name="description" content="D" /></head>
       <body><h1>A</h1><img src="a.jpg" /></body></html>`,
    );
    expect(findings[0]?.nodeId).toBeTruthy();
  });
});
