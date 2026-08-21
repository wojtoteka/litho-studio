import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { applyInitialTheme } from './state/uiStore.js';
import { applyPlatformAttribute } from './lib/platform.js';
import { registerTestHooks } from './lib/testHooks.js';
import { logger } from './lib/logger.js';
import './styles/app.css';

applyPlatformAttribute();
applyInitialTheme();
registerTestHooks();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Brak elementu #root - dokument aplikacji jest uszkodzony.');
}

// Anything that escapes React still reaches the log file, so a bug report from
// a user contains the failure even when the UI recovered silently.
window.addEventListener('error', (event) => {
  // Benign layout-settling notification, not an error - logging it as one
  // would bury real failures under noise on every canvas rebuild.
  if (event.message?.includes('ResizeObserver loop')) return;
  logger.error(`Nieobsłużony błąd: ${event.message}`, event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  logger.error('Nieobsłużone odrzucenie obietnicy', event.reason);
});

// Chromium hands the first focusable element a keyboard-style focus ring the
// moment the window is shown, so the start screen's primary button looks
// focused before the user has touched anything. Drop that focus until the first
// real interaction; from then on the ring means what it should and stays.
const dropStartupFocus = (event: FocusEvent): void => {
  if (event.target instanceof HTMLElement) event.target.blur();
};
const releaseStartupFocus = (): void => {
  document.removeEventListener('focusin', dropStartupFocus, true);
  document.removeEventListener('pointerdown', releaseStartupFocus, true);
  document.removeEventListener('keydown', releaseStartupFocus, true);
};
document.addEventListener('focusin', dropStartupFocus, true);
document.addEventListener('pointerdown', releaseStartupFocus, true);
document.addEventListener('keydown', releaseStartupFocus, true);

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
