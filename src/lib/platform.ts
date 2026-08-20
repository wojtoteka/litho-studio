/**
 * Which OS the renderer is running on, resolved once.
 *
 * The main process already knows and passes it across the bridge
 * (`LithoApi.platform`, set from `process.platform` in preload.ts), so this is
 * not a guess — except in the one case where the bridge is absent: the renderer
 * opened in a plain browser tab against the Vite dev server, and jsdom under
 * Vitest. Both fall back to sniffing the user agent, which is imprecise but only
 * ever affects cosmetics (see below), never behaviour that matters.
 *
 * Two things depend on this:
 *
 *  - `data-platform` on <html>, which app.css uses to size the UI. Windows
 *    carries the shell's own display scaling underneath CSS, so it needs a
 *    smaller base scale than Linux — see the platform block in app.css.
 *  - the AI tool installer, which is Windows-only. That gate is enforced in the
 *    *main* process (`aiToolsService.ts`); this value only decides whether the
 *    entry point is worth drawing, so a wrong guess in a browser tab hides a
 *    button rather than breaking anything.
 */
export type UiPlatform = 'win32' | 'darwin' | 'linux';

function detect(): UiPlatform {
  // `window.litho` is typed as always present, and in the real app it is. A dev
  // server tab or a test renderer has no preload, so this has to be checked
  // rather than trusted.
  const fromBridge = (window as { litho?: { platform?: string } }).litho?.platform;
  if (fromBridge === 'win32' || fromBridge === 'darwin' || fromBridge === 'linux') return fromBridge;

  const agent = window.navigator.userAgent;
  if (/windows/iu.test(agent)) return 'win32';
  if (/mac os x|macintosh/iu.test(agent)) return 'darwin';
  return 'linux';
}

export const uiPlatform: UiPlatform = detect();

export const isWindows = uiPlatform === 'win32';

/**
 * Stamps the platform onto <html> before React mounts, so the first paint is
 * already at the right scale — doing it in a component would show one frame of
 * Linux-sized chrome on Windows.
 */
export function applyPlatformAttribute(): void {
  document.documentElement.dataset.platform = uiPlatform;
}
