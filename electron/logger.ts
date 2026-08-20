import log from 'electron-log/main.js';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { LogEntry, LogLevel } from '@shared/ipc.js';

/**
 * Central logging for both processes.
 *
 * The renderer never touches the filesystem: it forwards entries over IPC and
 * they land in the same rotating file as main-process output, so a bug report
 * contains one coherent timeline.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024;

let ready = false;

export function initLogger(): void {
  if (ready) return;

  log.transports.file.level = 'info';
  log.transports.file.maxSize = MAX_FILE_BYTES;
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  log.transports.console.level = app.isPackaged ? false : 'debug';

  log.transports.file.resolvePathFn = () => path.join(app.getPath('logs'), 'litho-studio.log');

  // Rotate on startup so a crash loop cannot bury the interesting entries.
  log.transports.file.archiveLogFn = (file) => {
    const archived = `${file.path.replace(/\.log$/u, '')}.old.log`;
    void fs.rm(archived, { force: true }).then(() => fs.rename(file.path, archived));
  };

  log.errorHandler.startCatching({
    showDialog: false,
    onError: ({ error, processType }) => {
      log.error(`[uncaught:${processType}]`, error);
    },
  });

  ready = true;
  log.info(
    `Litho Studio ${app.getVersion()} starting (${process.platform}, electron ${process.versions.electron})`,
  );
}

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function writeLog(
  scope: 'main' | 'renderer' | 'canvas',
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  const suffix = context && Object.keys(context).length > 0 ? ` ${safeStringify(context)}` : '';
  const line = `[${scope}] ${message}${suffix}`;
  switch (level) {
    case 'error':
      log.error(line);
      break;
    case 'warn':
      log.warn(line);
      break;
    case 'debug':
      log.debug(line);
      break;
    default:
      log.info(line);
  }
}

export function logPath(): string {
  return log.transports.file.getFile().path;
}

/** Parses the tail of the log file for the in-app console panel. */
export async function tailLog(lines: number): Promise<LogEntry[]> {
  const target = logPath();
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch {
    return [];
  }

  const parsed: LogEntry[] = [];
  const pattern = /^\[([\d-]+ [\d:.]+)\] \[(\w+)\]\s*(?:\[(main|renderer|canvas)\])?\s*(.*)$/u;

  for (const line of raw.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (!match) {
      // Continuation of a multi-line entry (stack traces) — append to previous.
      const previous = parsed[parsed.length - 1];
      if (previous && line.trim() !== '') previous.message += `\n${line}`;
      continue;
    }
    const [, timestamp, rawLevel, scope, message] = match;
    const level = (rawLevel ?? 'info').toLowerCase();
    parsed.push({
      timestamp: Date.parse((timestamp ?? '').replace(' ', 'T')) || Date.now(),
      level: level in LEVEL_ORDER ? (level as LogLevel) : 'info',
      scope: scope === 'renderer' ? 'renderer' : scope === 'canvas' ? 'canvas' : 'main',
      message: message ?? '',
    });
  }

  return parsed.slice(-Math.max(1, Math.min(lines, 2000)));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
}

export { log };
