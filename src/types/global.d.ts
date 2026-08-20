import type { LithoApi } from '@shared/ipc.js';
import type { LithoTestHooks } from '@/lib/testHooks.js';

/**
 * The renderer's only channel to the outside world. Declared here so that using
 * anything not on `LithoApi` is a compile error rather than a runtime crash.
 */
declare global {
  interface Window {
    readonly litho: LithoApi;
    /**
     * Present only when the app was launched with `--litho-enable-test-hooks`
     * in an unpackaged build. See `src/lib/testHooks.ts`.
     */
    __lithoTestHooks?: LithoTestHooks;
  }
}

export {};
