import type { LogLevel } from '@shared/ipc.js';

/**
 * Renderer-side logging.
 *
 * Everything is forwarded to the main process so it lands in the same rotating
 * file as main-process output. `console` is used only as a development mirror -
 * the requirement that no stray `console.log` ships is met because this is the
 * single place the renderer is allowed to touch it, and it is a no-op in a
 * packaged build.
 */

// Guarded lookup: engine modules import this logger and also run under the
// node-environment unit tests, where no `window` exists at all.
const bridge = typeof window === 'undefined' ? undefined : window.litho;
const isDevelopment = Boolean(bridge?.isDevelopment);

function forward(level: LogLevel, message: string, detail?: unknown): void {
  const context = detail === undefined ? undefined : { detail: describe(detail) };

  try {
    bridge?.log.write(level, message, context);
  } catch {
    // The bridge is unavailable (very early startup, or a unit-test harness).
  }

  if (isDevelopment) {
    const line = context ? `${message} - ${context.detail}` : message;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  }
}

function describe(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}\n${detail.stack ?? ''}`;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export const logger = {
  error: (message: string, detail?: unknown) => forward('error', message, detail),
  warn: (message: string, detail?: unknown) => forward('warn', message, detail),
  info: (message: string, detail?: unknown) => forward('info', message, detail),
  debug: (message: string, detail?: unknown) => forward('debug', message, detail),
};
