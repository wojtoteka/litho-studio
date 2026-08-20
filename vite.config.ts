import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Renderer build. The renderer is a plain sandboxed web app: it has no Node
 * access and talks to the main process exclusively through `window.litho`
 * (see electron/preload.ts).
 */
export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome128',
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
