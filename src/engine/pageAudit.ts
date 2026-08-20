import {
  getAttr,
  getBody,
  isElement,
  textContent,
  walk,
  type ElementNode,
  type PageDocument,
} from '@shared/document.js';
import { readPageMeta } from './headMeta.js';
import { resolveHref } from '@shared/paths.js';

/**
 * "Sprawdź stronę" — the checks a developer would run before publishing, for
 * someone who does not know they exist.
 *
 * Every problem here is one that makes a finished-looking page fail in a way
 * its author cannot see from the canvas: a screen reader hits an image with no
 * description, a search engine finds no summary, a visitor clicks a link that
 * goes nowhere, or text turns out to be unreadable against its background. The
 * canvas cannot show any of that, which is exactly why it needs saying out loud.
 *
 * Pure and synchronous: it takes the parsed document plus what the project
 * knows about itself, and returns findings. No store, no DOM, no I/O — so the
 * rules are unit-testable, and the panel is only a renderer for them.
 */

export type AuditSeverity = 'error' | 'warning';

export interface AuditFinding {
  /** Stable identifier for the rule, so the UI can group and the tests can name. */
  rule: string;
  severity: AuditSeverity;
  /** One sentence, in the second person, describing what is wrong. */
  message: string;
  /** What to do about it. */
  hint: string;
  /** Element to select when the finding is clicked, when there is one. */
  nodeId: string | null;
}

export interface AuditInput {
  document: PageDocument;
  /** Project-relative paths of every page, for internal-link checking. */
  pages: readonly string[];
  /** Project-relative paths of every file Litho tracks, for asset links. */
  files: readonly string[];
}

export function auditPage(input: AuditInput): AuditFinding[] {
  const { document } = input;
  const body = getBody(document);
  const findings: AuditFinding[] = [];

  findings.push(...auditMeta(document));
  if (body) {
    findings.push(...auditImages(body));
    findings.push(...auditLinks(body, input));
    findings.push(...auditHeadings(body));
    findings.push(...auditButtons(body));
  }

  // Errors first, then the order the rules ran in — which follows the page.
  return findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function severityRank(severity: AuditSeverity): number {
  return severity === 'error' ? 0 : 1;
}

/* ------------------------------------------------------------------ */

function auditMeta(document: PageDocument): AuditFinding[] {
  const meta = readPageMeta(document.root);
  const findings: AuditFinding[] = [];

  if (meta.title.trim() === '') {
    findings.push({
      rule: 'meta-title',
      severity: 'error',
      message: 'Strona nie ma tytułu.',
      hint: 'Tytuł to nagłówek wyniku w Google i napis na karcie przeglądarki. Ustaw go w panelu „Strona”.',
      nodeId: null,
    });
  }
  if (meta.description.trim() === '') {
    findings.push({
      rule: 'meta-description',
      severity: 'warning',
      message: 'Strona nie ma opisu.',
      hint: 'Bez opisu wyszukiwarka pokaże przypadkowy fragment tekstu. Dodaj go w panelu „Strona”.',
      nodeId: null,
    });
  }
  if (meta.lang.trim() === '') {
    findings.push({
      rule: 'meta-lang',
      severity: 'warning',
      message: 'Strona nie deklaruje języka.',
      hint: 'Bez tego czytniki ekranu przeczytają polski tekst z angielskim akcentem. Ustaw np. „pl”.',
      nodeId: null,
    });
  }
  return findings;
}

function auditImages(body: ElementNode): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const node of walk(body)) {
    if (!isElement(node) || node.tag !== 'img') continue;
    const alt = getAttr(node, 'alt');
    // `alt=""` is a deliberate, correct choice for decorative images — the
    // check is for a *missing* attribute, not an empty one.
    if (alt === undefined) {
      findings.push({
        rule: 'img-alt',
        severity: 'error',
        message: `Obraz ${describeSource(node)} nie ma opisu alternatywnego.`,
        hint: 'Wpisz w „Atrybuty” pole alt — jednym zdaniem, co widać na obrazie. Jeśli obraz jest tylko ozdobą, wpisz pusty alt.',
        nodeId: node.id,
      });
    }
  }
  return findings;
}

function describeSource(node: ElementNode): string {
  const src = getAttr(node, 'src') ?? '';
  const name = src.split('/').pop() ?? '';
  return name === '' ? '(bez pliku)' : `„${name}”`;
}

function auditLinks(body: ElementNode, input: AuditInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const known = new Set([...input.pages, ...input.files]);

  for (const node of walk(body)) {
    if (!isElement(node) || node.tag !== 'a') continue;
    const href = (getAttr(node, 'href') ?? '').trim();
    const label = textContent(node).trim().slice(0, 30) || node.tag;

    if (href === '' || href === '#') {
      findings.push({
        rule: 'link-empty',
        severity: 'warning',
        message: `Link „${label}” nigdzie nie prowadzi.`,
        hint: 'Wskaż podstronę, adres zewnętrzny albo kotwicę (#sekcja) w polu „href”.',
        nodeId: node.id,
      });
      continue;
    }

    // Only project-internal links can be checked: an external URL is not this
    // program's business, and a `#anchor` is resolved by the browser.
    if (/^[a-z]+:/iu.test(href) || href.startsWith('#') || href.startsWith('//')) continue;

    const target = resolveHref(input.document.relPath, href.split('#')[0] ?? href);
    if (target !== null && !known.has(target)) {
      findings.push({
        rule: 'link-missing',
        severity: 'error',
        message: `Link „${label}” wskazuje na nieistniejący plik: ${target}.`,
        hint: 'Popraw adres albo utwórz tę podstronę — inaczej odwiedzający zobaczy błąd 404.',
        nodeId: node.id,
      });
    }
  }
  return findings;
}

/**
 * Heading levels must not skip: `h1` → `h3` reads to a screen reader as a
 * missing section, and it is the single most common structural mistake on a
 * page built by dragging headings around until they look right.
 */
function auditHeadings(body: ElementNode): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const headings: ElementNode[] = [];

  for (const node of walk(body)) {
    if (isElement(node) && /^h[1-6]$/u.test(node.tag)) headings.push(node);
  }

  const firstLevel = headings[0] ? Number(headings[0].tag.slice(1)) : 0;
  if (headings.length > 0 && firstLevel !== 1) {
    findings.push({
      rule: 'heading-no-h1',
      severity: 'warning',
      message: 'Strona nie zaczyna się od nagłówka H1.',
      hint: 'Główny tytuł treści powinien być H1 — jest jeden na stronę i mówi wyszukiwarce, o czym ona jest.',
      nodeId: headings[0]?.id ?? null,
    });
  }

  let previous = firstLevel;
  for (const heading of headings.slice(1)) {
    const level = Number(heading.tag.slice(1));
    if (level > previous + 1) {
      findings.push({
        rule: 'heading-skip',
        severity: 'warning',
        message: `Pominięto poziom nagłówka: H${previous} → H${level}.`,
        hint: `Zmień ten nagłówek na H${previous + 1}, albo dodaj brakujący poziom wyżej.`,
        nodeId: heading.id,
      });
    }
    previous = level;
  }
  return findings;
}

/** A control with no text is unusable to anyone not looking at the screen. */
function auditButtons(body: ElementNode): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const node of walk(body)) {
    if (!isElement(node) || node.tag !== 'button') continue;
    const hasText = textContent(node).trim() !== '';
    const hasLabel = (getAttr(node, 'aria-label') ?? '').trim() !== '';
    if (!hasText && !hasLabel) {
      findings.push({
        rule: 'button-unlabelled',
        severity: 'error',
        message: 'Przycisk nie ma żadnego napisu.',
        hint: 'Dodaj tekst na przycisku albo opis w polu „aria-label” — inaczej czytnik ekranu powie tylko „przycisk”.',
        nodeId: node.id,
      });
    }
  }
  return findings;
}
