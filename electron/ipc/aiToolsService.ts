import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  AI_TOOLS,
  AI_TOOLS_PLATFORM,
  parseVersion,
  type AiToolId,
  type AiToolSpec,
  type AiToolStatus,
} from '@shared/aiTools.js';
import { log } from '../logger.js';

/**
 * The AI tool installer's main-process half: find out what is already on the
 * machine, and run one vendor-documented install command at a time.
 *
 * Design constraints worth stating, because they are what keep a feature that
 * runs `npm install -g` from being a liability:
 *
 *  - **The renderer cannot name a command.** It sends an `AiToolId` and nothing
 *    else. Everything executable is looked up in the static catalogue
 *    (`shared/aiTools.ts`), so no string that crossed the IPC bridge is ever
 *    interpolated into a shell. An unknown id is refused, not guessed at.
 *  - **Windows only**, enforced here and not merely hidden in the UI — see the
 *    rationale on `AI_TOOLS_PLATFORM`. A renderer that asked anyway gets
 *    `UNSUPPORTED_PLATFORM` back.
 *  - **One process per tool**, tracked so it can be cancelled and so a second
 *    click cannot start a duplicate install racing the first over the same npm
 *    prefix.
 *  - **Nothing is inherited from a shell profile.** `-NoProfile` and
 *    `-NonInteractive` mean the install cannot stop halfway waiting for a prompt
 *    nobody can see, and cannot pick up a profile that redefines `npm`.
 */

/** How long a `--version` probe may take before it is treated as "present, version unknown". */
const VERSION_PROBE_TIMEOUT_MS = 5000;

/** Cap on retained output per install, so a pathological log cannot grow without bound. */
const MAX_OUTPUT_CHARS = 512 * 1024;

export interface AiToolsCallbacks {
  onOutput(id: AiToolId, chunk: string): void;
  onDone(id: AiToolId, ok: boolean, exitCode: number, message?: string): void;
}

export class AiToolsService {
  private readonly running = new Map<AiToolId, ChildProcess>();
  private readonly emitted = new Map<AiToolId, number>();

  constructor(private readonly callbacks: AiToolsCallbacks) {}

  static get supported(): boolean {
    return process.platform === AI_TOOLS_PLATFORM;
  }

  /**
   * Status of every catalogued tool, probed in parallel.
   *
   * Never rejects and never reports "not found" as an error: a tool that is not
   * installed is the normal case this dialog exists for, so it is data.
   */
  async detect(): Promise<AiToolStatus[]> {
    return Promise.all(AI_TOOLS.map((tool) => this.detectOne(tool)));
  }

  private async detectOne(tool: AiToolSpec): Promise<AiToolStatus> {
    const resolved = await which(tool.binary);
    if (!resolved) return { id: tool.id, installed: false, version: null, path: null };
    return { id: tool.id, installed: true, version: await probeVersion(tool.binary), path: resolved };
  }

  isRunning(id: AiToolId): boolean {
    return this.running.has(id);
  }

  /**
   * Starts an install and returns as soon as the process is spawned — the result
   * arrives later through `onDone`, with `onOutput` streaming in between. A
   * request that cannot even start (wrong platform, unknown tool, no bash for a
   * script installer, already running) fails synchronously with a sentence the
   * dialog shows as-is.
   */
  async start(id: AiToolId): Promise<{ ok: true } | { ok: false; message: string; unsupported?: true }> {
    if (!AiToolsService.supported) {
      return {
        ok: false,
        unsupported: true,
        message: 'Auto-Installer narzędzi AI działa tylko w wersji dla Windows.',
      };
    }

    const tool = AI_TOOLS.find((candidate) => candidate.id === id);
    if (!tool) return { ok: false, message: 'Nieznane narzędzie.' };
    if (this.running.has(id)) return { ok: false, message: `${tool.name}: instalacja już trwa.` };

    const command = await resolveCommand(tool);
    if (!command.ok) return { ok: false, message: command.message };

    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        windowsHide: true,
        // No `shell: true`: `file` is one of two fixed executables and the
        // arguments are built here from the catalogue, so there is nothing for a
        // shell to re-parse — and one less layer that could re-interpret them.
        shell: false,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error(`[ai-tools] nie udało się uruchomić instalacji ${id}: ${detail}`);
      return { ok: false, message: `Nie udało się uruchomić instalatora: ${detail}` };
    }

    this.running.set(id, child);
    this.emitted.set(id, 0);
    log.info(`[ai-tools] instalacja ${id}: ${command.file} ${command.args.join(' ')}`);
    this.emit(id, `> ${command.display}\r\n\r\n`);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.emit(id, chunk));
    // npm reports progress and warnings on stderr during a perfectly successful
    // install, so this is interleaved rather than treated as failure output.
    child.stderr?.on('data', (chunk: string) => this.emit(id, chunk));

    child.on('error', (error) => {
      this.running.delete(id);
      log.error(`[ai-tools] instalacja ${id} nie wystartowała: ${error.message}`);
      this.callbacks.onDone(id, false, -1, `Nie udało się uruchomić instalatora: ${error.message}`);
    });

    child.on('close', (code, signal) => {
      this.running.delete(id);
      this.emitted.delete(id);
      // A killed process reports a signal (or a null code): that is a
      // cancellation the user asked for, not a failed install.
      if (signal !== null) {
        log.info(`[ai-tools] instalacja ${id} przerwana (${signal})`);
        this.callbacks.onDone(id, false, -1, 'Instalacja przerwana.');
        return;
      }
      const exitCode = code ?? -1;
      const ok = exitCode === 0;
      log.info(`[ai-tools] instalacja ${id} zakończona kodem ${exitCode}`);
      this.callbacks.onDone(id, ok, exitCode, ok ? undefined : explainExitCode(tool, exitCode));
    });

    return { ok: true };
  }

  cancel(id: AiToolId): void {
    const child = this.running.get(id);
    if (!child) return;
    // The child is a shell that has its own child (`npm`), so on Windows killing
    // only the shell would orphan the install. `taskkill /T` takes the tree.
    killTree(child);
  }

  disposeAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  private emit(id: AiToolId, chunk: string): void {
    const already = this.emitted.get(id) ?? 0;
    if (already >= MAX_OUTPUT_CHARS) return;
    const room = MAX_OUTPUT_CHARS - already;
    const clipped = chunk.length <= room ? chunk : `${chunk.slice(0, room)}\r\n[…wyjście obcięte]\r\n`;
    this.emitted.set(id, already + clipped.length);
    this.callbacks.onOutput(id, clipped);
  }
}

/* ------------------------------------------------------------------ */
/* Command construction                                                */
/* ------------------------------------------------------------------ */

interface ResolvedCommand {
  ok: true;
  file: string;
  args: string[];
  /** Echoed into the output pane as the first line, so the log shows what ran. */
  display: string;
}

async function resolveCommand(tool: AiToolSpec): Promise<ResolvedCommand | { ok: false; message: string }> {
  if (tool.install.kind === 'npm-global') {
    const npm = await which('npm');
    if (!npm) {
      return {
        ok: false,
        message:
          'Nie znaleziono npm. Zainstaluj Node.js (nodejs.org), otwórz aplikację ponownie i spróbuj jeszcze raz.',
      };
    }
    const display = `npm install -g ${tool.install.package}`;
    return {
      ok: true,
      file: powerShellPath(),
      /*
       * `exit $LASTEXITCODE` is load-bearing. `powershell -Command` exits 0 as
       * long as the *script* completed, regardless of what the native command
       * inside it returned — without this line a failed `npm install` would be
       * reported to the user as a success.
       *
       * The console encoding is forced to UTF-8 for the same reason npm's own
       * output is worth reading: on a Polish Windows the default OEM codepage
       * turns every diacritic in an npm warning into mojibake.
       */
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $env:npm_config_color='false'; ${display}; exit $LASTEXITCODE`,
      ],
      display,
    };
  }

  /*
   * The vendor ships a POSIX shell script and no Windows equivalent. Git for
   * Windows puts a perfectly good `bash` on PATH and most machines with a web
   * editor on them have it — but it is not part of Windows, so its absence is a
   * normal outcome that has to be explained rather than crashed on.
   */
  const bash = await which('bash');
  if (!bash) {
    return {
      ok: false,
      message:
        'Ten instalator jest skryptem powłoki i wymaga bash. Zainstaluj Git for Windows (git-scm.com) albo skorzystaj ze strony producenta.',
    };
  }
  const display = `curl ${tool.install.url} -fsS | bash`;
  return { ok: true, file: bash, args: ['-lc', display], display };
}

function powerShellPath(): string {
  // Absolute, not `powershell.exe` on PATH: PATH is user-writable, and this
  // process runs install commands.
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** Turns a non-zero exit into something a user can act on. */
function explainExitCode(tool: AiToolSpec, exitCode: number): string {
  if (tool.install.kind === 'npm-global') {
    return `Instalacja ${tool.name} nie powiodła się (kod ${exitCode}). Najczęstsza przyczyna to brak uprawnień do katalogu globalnego npm — sprawdź wyjście powyżej.`;
  }
  return `Instalator ${tool.name} zakończył się kodem ${exitCode}. Szczegóły są w wyjściu powyżej.`;
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

/**
 * First PATH match for an executable, or `null`.
 *
 * `where.exe` is used rather than walking PATH by hand because it applies
 * PATHEXT the same way the shell does — which is what makes it find `npm.cmd`
 * and `claude.cmd`, the form an npm global install actually leaves behind.
 */
function which(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'where.exe',
      [binary],
      { windowsHide: true, timeout: VERSION_PROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const first = stdout.split(/\r?\n/u).find((line) => line.trim() !== '');
        resolve(first ? first.trim() : null);
      },
    );
  });
}

/**
 * The tool's own reported version, or `null`.
 *
 * Best-effort by design: a CLI that hangs, prints a banner instead of a version,
 * or wants a login is still installed, and the row must say so. `shell: true` is
 * needed for the `.cmd` shims npm leaves on Windows; the argument is a literal
 * from the catalogue, never anything that crossed the IPC bridge.
 */
function probeVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ['--version'],
      { windowsHide: true, timeout: VERSION_PROBE_TIMEOUT_MS, shell: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseVersion(stdout));
      },
    );
  });
}

/**
 * Ends a process *and its descendants* on Windows.
 *
 * `child.kill()` signals only the PowerShell/bash wrapper. The `npm` (or `curl`)
 * underneath it would survive, keep writing to the npm prefix, and finish an
 * install the user had just cancelled.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
    // Already gone between the click and the call — nothing to do, and the
    // `close` handler has already reported the outcome.
    if (error) child.kill();
  });
}
