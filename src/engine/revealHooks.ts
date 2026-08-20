/**
 * Markers left in the markup by "reveal on scroll" animation libraries.
 *
 * These libraries ship content pre-hidden (`opacity: 0`, `visibility: hidden`,
 * an off-screen `transform`) and rely on JavaScript to add a class once the
 * element scrolls into view. The editor canvas runs no page scripts, so that
 * class never arrives and the content stays invisible — which is why the same
 * page renders fully in the live preview but not in the editor.
 *
 * This single list is the source of truth for both sides of the fix:
 *  - the canvas overlay CSS force-reveals these hooks so editing works
 *    (`revealHookSelectorList`, used in `canvasDocument.ts`);
 *  - the compatibility check flags a page that carries them, and the conversion
 *    strips them from the markup for good (`compatibility.ts`).
 */

/** Class names that put an element into a hidden "waiting to animate in" state. */
export const REVEAL_HOOK_CLASSES: readonly string[] = [
  'wow', // WOW.js
  'reveal',
  'reveal-on-scroll',
  'scroll-reveal',
  'scroll-animate',
  'animate-on-scroll',
  'js-reveal',
  'js-scroll',
  'will-animate',
  'fade-in',
  'fade-up',
  'fade-down',
  'fade-left',
  'fade-right',
  'slide-in',
  'slide-up',
  'appear',
  'inview',
  'in-view',
  'is-inview',
  'aos-init', // AOS, added by its own script
  'animate__animated', // Animate.css
];

/** Attributes that mark an element for a scroll-reveal library. */
export const REVEAL_HOOK_ATTRIBUTES: readonly string[] = [
  'data-aos', // AOS
  'data-sr', // ScrollReveal
  'data-scroll', // Locomotive Scroll
  'data-scroll-reveal',
];

/**
 * Maps a hook back to the library it belongs to, for human-readable copy in the
 * conversion prompt. Best-effort — a page can carry generic hooks with no
 * recognisable library, in which case it contributes nothing here.
 */
export function libraryForHook(hook: string): string | null {
  if (hook === 'data-aos' || hook === 'aos-init') return 'AOS';
  if (hook === 'wow') return 'WOW.js';
  if (hook === 'data-sr') return 'ScrollReveal';
  if (hook === 'data-scroll' || hook === 'data-scroll-reveal') return 'Locomotive Scroll';
  if (hook === 'animate__animated') return 'Animate.css';
  return null;
}

/** CSS selector list matching every reveal hook, for the editor's canvas override. */
export function revealHookSelectorList(): string {
  return [
    ...REVEAL_HOOK_ATTRIBUTES.map((attr) => `[${attr}]`),
    ...REVEAL_HOOK_CLASSES.map((cls) => `.${cls}`),
  ].join(',\n  ');
}
