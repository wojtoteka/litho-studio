import type { ElementNode } from '@shared/document.js';
import { getAttr, getClassList, walk } from '@shared/document.js';

/**
 * Identifier allocation.
 *
 * Two very different kinds of identifier exist in this app and conflating them
 * causes subtle bugs, so they live in separate allocators:
 *
 *  - **Node ids** (`NodeAllocator`) are internal, never written to disk, and
 *    exist only so the UI can refer to a node. They are handed out
 *    deterministically per parse (`n1`, `n2`, …) which keeps unit tests
 *    readable and lets `domSync` map an old tree onto a freshly parsed one.
 *
 *  - **Document identifiers** (`ClassNameAllocator`) *are* written to disk: the
 *    class or id used as a styling hook. Those must be stable, readable and
 *    collision-free against names the page already uses, because the user will
 *    read them in VS Code.
 */

export class NodeAllocator {
  private counter = 0;

  constructor(private readonly prefix = 'n') {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}${this.counter}`;
  }

  reset(): void {
    this.counter = 0;
  }
}

/** Global allocator for nodes created after the initial parse. */
const runtimeAllocator = new NodeAllocator('r');

export function createRuntimeNodeId(): string {
  return runtimeAllocator.next();
}

/* ------------------------------------------------------------------ */
/* Document-facing names                                               */
/* ------------------------------------------------------------------ */

/**
 * Generates CSS class names for elements that need a styling hook.
 *
 * The allocator is seeded with every class and id already present in the page —
 * including ones the page never styles — so a generated name can never collide
 * with something the author wrote.
 */
export class ClassNameAllocator {
  private readonly taken = new Set<string>();

  constructor(roots: ElementNode[] = []) {
    for (const root of roots) this.observe(root);
  }

  /** Registers every class and id in a subtree as unavailable. */
  observe(root: ElementNode): void {
    for (const node of walk(root)) {
      if (node.kind !== 'element') continue;
      for (const className of getClassList(node)) this.taken.add(className);
      const id = getAttr(node, 'id');
      if (id) this.taken.add(id);
    }
  }

  reserve(name: string): void {
    this.taken.add(name);
  }

  isTaken(name: string): boolean {
    return this.taken.has(name);
  }

  /**
   * Returns a free name based on `base`, appending `-2`, `-3`, … on collision.
   * The first candidate is the bare base, so a page with one hero section gets
   * `.hero` rather than `.hero-1`.
   */
  allocate(base: string): string {
    const slug = slugify(base);
    if (!this.taken.has(slug)) {
      this.taken.add(slug);
      return slug;
    }
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = `${slug}-${suffix}`;
      if (!this.taken.has(candidate)) {
        this.taken.add(candidate);
        return candidate;
      }
    }
    const fallback = `${slug}-${Date.now().toString(36)}`;
    this.taken.add(fallback);
    return fallback;
  }
}

/**
 * Converts arbitrary text into a valid, readable CSS identifier.
 *
 * CSS identifiers may not start with a digit or a lone hyphen-digit, so those
 * cases are prefixed rather than rejected — the caller always gets a usable
 * name back.
 */
export function slugify(input: string, fallback = 'element'): string {
  const normalised = input
    .normalize('NFKD')
    // Strip combining marks so "Zdjęcie" becomes "zdjecie", not "zdje-cie".
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);

  if (normalised === '') return fallback;
  if (/^\d/u.test(normalised)) return `x-${normalised}`;
  return normalised;
}

/** True when a string can be used verbatim in a CSS selector. */
export function isValidCssIdentifier(value: string): boolean {
  return /^-?[a-zA-Z_][\w-]*$/u.test(value);
}
