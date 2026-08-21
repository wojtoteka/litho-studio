import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as NodePty from 'node-pty';
import type { TerminalBackendKind, TerminalSession } from '@shared/ipc.js';
import { log } from '../logger.js';

/**
 * Owns every embedded terminal session.
 *
 * node-pty is a native module and can only run in the main process - the
 * renderer stays sandboxed (`sandbox: true`, `nodeIntegration: false`), so it
 * only ever sees `id`-keyed data over IPC, the same shape every other
 * subsystem in this app uses. This is what lets an interactive CLI (a shell
 * prompt, `git commit` dropping into an editor, `claude`'s own prompts) render
 * correctly: the pty allocates a real TTY, so programs see one and behave
 * accordingly instead of falling back to dumb, non-interactive output.
 *
 * …when node-pty is actually loadable. It is not always:
 *
 *   node-pty 1.1 ships prebuilt binaries for win32 and darwin only. On Linux
 *   it expects to be compiled from source at `npm install` time, which cannot
 *   happen when the Linux package is cross-built from Windows (`npmRebuild:
 *   false`, and there is no Linux toolchain on the build host anyway). The
 *   AppImage therefore carries a node-pty with no binary it can load.
 *
 * Rather than shipping a terminal that throws on open, the service degrades:
 * it asks the OS for a pty by another route (`script`, from util-linux, which
 * is present on every mainstream distribution and allocates a genuine TTY), and
 * only if that is missing too does it fall back to plain pipes. `create()`
 * reports which backend it got so the panel can say so instead of silently
 * behaving differently.
 */

type NodePtyModule = typeof NodePty;

interface TerminalBackend {
  readonly kind: TerminalBackendKind;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface ShellCommand {
  file: string;
  args: string[];
}

/*
 * `__filename`, not `import.meta.url`: this file is TypeScript with ESM syntax,
 * but scripts/build-electron.mjs emits the main process as CommonJS (`.cjs`),
 * where `import.meta` is compiled away to nothing. `createRequire(undefined)`
 * then throws at module load - i.e. the app would fail to start, not merely
 * lose the terminal. `__filename` is the CJS-native equivalent and is what the
 * bundle actually runs with.
 */
const requireFromMain = createRequire(__filename);

/** `undefined` = not attempted yet, `null` = attempted and unavailable. */
let ptyModule: NodePtyModule | null | undefined;

function loadNodePty(): NodePtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = requireFromMain('node-pty') as NodePtyModule;
  } catch (error) {
    ptyModule = null;
    log.warn(
      `[terminal] node-pty is not loadable (${error instanceof Error ? error.message : String(error)}) - falling back to a pty-less backend`,
    );
  }
  return ptyModule;
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalBackend>();

  constructor(
    private readonly onData: (payload: { id: string; data: string }) => void,
    private readonly onExit: (payload: { id: string; exitCode: number }) => void,
  ) {}

  create(cwd: string, cols: number, rows: number): TerminalSession {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeCols = clampSize(cols, 80);
    const safeRows = clampSize(rows, 24);
    const shell = defaultShell();

    const emitData = (data: string): void => this.onData({ id, data });
    const emitExit = (exitCode: number): void => {
      this.sessions.delete(id);
      this.onExit({ id, exitCode });
    };

    const backend = createBackend(shell, cwd, safeCols, safeRows, emitData, emitExit);
    this.sessions.set(id, backend);
    log.info(`[terminal] opened session ${id} in ${cwd} (backend: ${backend.kind}, shell: ${shell.file})`);

    const notice = backendNotice(backend.kind);
    return notice ? { id, cwd, backend: backend.kind, notice } : { id, cwd, backend: backend.kind };
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(clampSize(cols, 80), clampSize(rows, 24));
  }

  kill(id: string): void {
    const backend = this.sessions.get(id);
    if (!backend) return;
    this.sessions.delete(id);
    backend.kill();
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

function clampSize(value: number, fallback: number): number {
  const truncated = Math.trunc(value);
  return Number.isFinite(truncated) && truncated >= 2 ? truncated : fallback;
}

/* ------------------------------------------------------------------ */
/* Backends                                                            */
/* ------------------------------------------------------------------ */

/**
 * Escape hatch, read from the environment: `LITHO_TERMINAL_BACKEND=script`
 * (or `pipe`) skips the preferred backends and takes the named one.
 *
 * It exists for two reasons. It is the only way to exercise the fallbacks on a
 * host where node-pty *does* load, which is every machine this app is developed
 * on; and it gives a user whose distribution ships a node-pty that loads but
 * misbehaves a way out that does not involve rebuilding the app.
 */
function forcedBackend(): TerminalBackendKind | null {
  const requested = process.env.LITHO_TERMINAL_BACKEND?.trim().toLowerCase();
  return requested === 'pty' || requested === 'script' || requested === 'pipe' ? requested : null;
}

function createBackend(
  shell: ShellCommand,
  cwd: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalBackend {
  const forced = forcedBackend();
  if (forced === 'pipe') return createPipeBackend(shell, cwd, cols, rows, onData, onExit);

  const scriptOverride = forced === 'script' ? findScriptBinary() : null;
  if (scriptOverride) return createScriptBackend(scriptOverride, shell, cwd, cols, rows, onData, onExit);
  if (forced === 'script') {
    log.warn(
      '[terminal] LITHO_TERMINAL_BACKEND=script, but no `script` binary was found - ignoring the override',
    );
  }

  const pty = loadNodePty();
  if (pty) {
    try {
      return createPtyBackend(pty, shell, cwd, cols, rows, onData, onExit);
    } catch (error) {
      // A loadable module that still refuses to spawn (a stale binary, a
      // missing conpty helper) is no better than a missing one - degrade
      // rather than surface an unusable terminal.
      log.warn(
        `[terminal] node-pty failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const scriptBinary = findScriptBinary();
  if (scriptBinary) {
    return createScriptBackend(scriptBinary, shell, cwd, cols, rows, onData, onExit);
  }

  return createPipeBackend(shell, cwd, cols, rows, onData, onExit);
}

function createPtyBackend(
  pty: NodePtyModule,
  shell: ShellCommand,
  cwd: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalBackend {
  const proc = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  proc.onData(onData);
  proc.onExit(({ exitCode }) => onExit(exitCode));

  return {
    kind: 'pty',
    write: (data) => proc.write(data),
    resize: (nextCols, nextRows) => {
      try {
        proc.resize(nextCols, nextRows);
      } catch {
        // The pty can be in the middle of exiting; a losing race here is harmless.
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * `script` (util-linux) exists to record a session, but the way it does that is
 * exactly what is needed here: it allocates a pty, runs the command on the far
 * side of it and relays both directions through its own stdio. Programs on the
 * far side see a real TTY, so an interactive shell, `git`'s pager and a
 * full-screen CLI all behave normally.
 *
 * The one thing it cannot do is follow a later resize: the window size is set
 * once, from inside the pty, by the `stty` prefixed to the command. There is no
 * channel to push a new size down afterwards (that would need the `TIOCSWINSZ`
 * ioctl - precisely the native call node-pty exists to provide), so `resize()`
 * is a no-op here and the panel warns about it.
 */
function createScriptBackend(
  scriptBinary: string,
  shell: ShellCommand,
  cwd: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalBackend {
  const inner = [shell.file, ...shell.args].map(shellQuote).join(' ');
  const command = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${inner}`;

  const child = spawn(scriptBinary, ['-q', '-e', '-c', command, '/dev/null'], {
    cwd,
    env: terminalEnv(cols, rows, 'xterm-256color'),
    // Own process group, so `kill()` can take the whole session down - killing
    // `script` alone would orphan the shell it started behind the pty.
    detached: true,
  }) as ChildProcessWithoutNullStreams;

  return wrapChildProcess('script', child, onData, onExit);
}

/** Last resort: no TTY at all. Line-based CLIs work; full-screen ones will not. */
function createPipeBackend(
  shell: ShellCommand,
  cwd: string,
  cols: number,
  rows: number,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalBackend {
  // `-i` (force an interactive shell despite stdin not being a tty) is a POSIX
  // shell flag. PowerShell reads it as an abbreviation of an unrelated parameter
  // and cmd.exe rejects it outright, so on Windows the flag that was meant to
  // rescue this backend is what would kill it.
  const args = process.platform === 'win32' ? shell.args : [...shell.args, '-i'];
  const child = spawn(shell.file, args, {
    cwd,
    env: terminalEnv(cols, rows, 'dumb'),
    // Process groups are a POSIX notion; `detached` on Windows means "own
    // console window", which is the opposite of what an embedded terminal wants.
    detached: process.platform !== 'win32',
  }) as ChildProcessWithoutNullStreams;

  return wrapChildProcess('pipe', child, onData, onExit);
}

function wrapChildProcess(
  kind: Exclude<TerminalBackendKind, 'pty'>,
  child: ChildProcessWithoutNullStreams,
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): TerminalBackend {
  let finished = false;
  const finish = (exitCode: number): void => {
    if (finished) return;
    finished = true;
    onExit(exitCode);
  };

  // xterm.js expects CRLF; a pty gives it for free, a pipe does not.
  const relay = (chunk: Buffer): void =>
    onData(kind === 'pipe' ? toCrlf(chunk.toString()) : chunk.toString());
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);

  child.on('error', (error) => {
    onData(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
    finish(1);
  });
  child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0)));

  return {
    kind,
    write: (data) => {
      try {
        child.stdin.write(data);
      } catch {
        // The shell is gone; the exit event has already been (or is about to be) delivered.
      }
    },
    resize: () => {
      /* see createScriptBackend - there is no ioctl to push a new size through */
    },
    kill: () => {
      try {
        if (child.pid === undefined) {
          child.kill();
        } else if (process.platform === 'win32') {
          // No process groups here, and killing the shell alone would orphan
          // whatever it launched. `taskkill /T` walks the tree instead.
          execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
            /* already gone, or refused - the exit event reports the outcome either way */
          });
        } else {
          // Negative pid = the whole process group, which is why `detached` is set.
          process.kill(-child.pid, 'SIGHUP');
        }
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

function toCrlf(data: string): string {
  return data.replace(/\r?\n/gu, '\r\n');
}

function terminalEnv(cols: number, rows: number, term: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.TERM = term;
  env.COLUMNS = String(cols);
  env.LINES = String(rows);
  return env;
}

/* ------------------------------------------------------------------ */
/* Environment probing                                                 */
/* ------------------------------------------------------------------ */

function findScriptBinary(): string | null {
  for (const candidate of ['/usr/bin/script', '/bin/script']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The shell to run, per platform.
 *
 * This used to be POSIX-only - a list of `/bin/*` candidates ending in a
 * `/bin/sh` fallback - with no Windows branch at all. The consequence was not a
 * degraded terminal on Windows but a dead one, and it misreported its own cause:
 * `defaultShell()` handed back `/bin/sh`, node-pty (which loads and spawns
 * perfectly well on Windows) threw `ENOENT` trying to start it, `createBackend`
 * read that as "node-pty is unusable" and degraded, `findScriptBinary()` then
 * found no util-linux `script` either, and the pipe backend tried the same
 * missing `/bin/sh` one more time. The user saw a yellow warning blaming a
 * missing node-pty, a red `spawn /bin/sh ENOENT`, and an immediately dead
 * terminal - three symptoms, one absent branch.
 */
export function defaultShell(): ShellCommand {
  return process.platform === 'win32' ? windowsShell() : posixShell();
}

function posixShell(): ShellCommand {
  // `$SHELL` is the user's choice and comes first, but it is not guaranteed to
  // be set (or to still exist) inside an AppImage started from a file manager,
  // so a probed list of the usual suspects backs it up.
  const candidates = [process.env.SHELL, '/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh'];
  for (const candidate of candidates) {
    if (candidate && candidate.startsWith('/') && existsSync(candidate))
      return { file: candidate, args: ['-l'] };
  }
  return { file: '/bin/sh', args: ['-l'] };
}

/**
 * PowerShell 7 if it is installed, then the Windows PowerShell every install
 * carries, then cmd.
 *
 * That order matches what a developer on Windows expects from an editor's
 * terminal, and it is also the order of decreasing capability. `%COMSPEC%` is
 * consulted only as the cmd fallback rather than first: it is essentially always
 * cmd.exe, so honouring it early would mean nobody ever got a PowerShell prompt.
 *
 * Absolute paths, not bare names on PATH - PATH is user-writable and this spawns
 * a shell. `-NoLogo` suppresses the copyright banner that would otherwise be the
 * first thing in a fresh panel; there is deliberately no `-NoProfile`, because
 * this is the user's interactive shell and their profile (aliases, `oh-my-posh`,
 * PATH additions) is part of it.
 */
function windowsShell(): ShellCommand {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';

  const powerShellSeven = `${programFiles}\\PowerShell\\7\\pwsh.exe`;
  if (existsSync(powerShellSeven)) return { file: powerShellSeven, args: ['-NoLogo'] };

  const windowsPowerShell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (existsSync(windowsPowerShell)) return { file: windowsPowerShell, args: ['-NoLogo'] };

  const comSpec = process.env.ComSpec;
  if (comSpec && existsSync(comSpec)) return { file: comSpec, args: [] };
  return { file: `${systemRoot}\\System32\\cmd.exe`, args: [] };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function backendNotice(kind: TerminalBackendKind): string | undefined {
  if (kind === 'pty') return undefined;
  if (kind === 'script') {
    return 'Terminal działa w trybie zastępczym (script): moduł node-pty nie jest dostępny w tej wersji. Programy interaktywne działają, ale zmiana rozmiaru okna nie jest przekazywana do powłoki.';
  }
  /*
   * Two different facts, and the notice has to pick the true one. `script` is a
   * util-linux program that does not exist on Windows and never could, so
   * blaming its absence there described the platform rather than the problem -
   * and put it next to a claim about node-pty that was itself wrong (node-pty
   * loads fine on Windows; what had failed was the shell it was asked to start).
   */
  return process.platform === 'win32'
    ? 'Terminal działa w trybie potokowym (bez TTY): nie udało się uruchomić node-pty. Proste polecenia działają, programy pełnoekranowe mogą nie działać poprawnie - przyczyna jest w panelu logów.'
    : 'Terminal działa w trybie potokowym (bez TTY): brak node-pty i polecenia „script”. Proste polecenia działają, programy pełnoekranowe mogą nie działać poprawnie.';
}
