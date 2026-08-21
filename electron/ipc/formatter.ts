import type * as Prettier from 'prettier';
import { extname } from '@shared/paths.js';
import { log } from '../logger.js';

/**
 * Final formatting pass applied to everything Litho writes.
 *
 * The generators already emit tidy output; Prettier is the safety net that
 * guarantees the files a user opens in VS Code look hand-written. It runs in the
 * main process so the renderer stays free of Node dependencies.
 *
 * Formatting is strictly best-effort: if Prettier throws - which it will for a
 * page containing template syntax it does not understand - the unformatted but
 * *correct* generated source is written instead. Losing pretty-printing is
 * acceptable; refusing to save the user's work is not.
 */

// Type-only import: erased at build time, so Prettier is still loaded lazily.
type PrettierModule = typeof Prettier;

let prettierPromise: Promise<PrettierModule | null> | null = null;
let warnedAboutFailure = false;

async function loadPrettier(): Promise<PrettierModule | null> {
  prettierPromise ??= import('prettier')
    .then((module) => (module.default ?? module) as PrettierModule)
    .catch((error) => {
      log.warn('[formatter] prettier unavailable, writing unformatted output', error);
      return null;
    });
  return prettierPromise;
}

const PARSERS: Record<string, string> = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.js': 'babel',
  '.mjs': 'babel',
  '.json': 'json',
};

export async function formatSource(content: string, relPath: string): Promise<string> {
  const parser = PARSERS[extname(relPath)];
  if (!parser) return content;

  const prettier = await loadPrettier();
  if (!prettier) return content;

  try {
    return await prettier.format(content, {
      parser,
      printWidth: 100,
      singleQuote: false,
      htmlWhitespaceSensitivity: 'css',
      endOfLine: 'lf',
    });
  } catch (error) {
    if (!warnedAboutFailure) {
      warnedAboutFailure = true;
      log.warn(`[formatter] prettier could not format ${relPath}; writing raw output`, error);
    }
    return content;
  }
}
