import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useUiStore } from '@/state/uiStore.js';
import { isWindows } from '@/lib/platform.js';
import { logger } from '@/lib/logger.js';
import { Icon } from '../Icon.js';

/**
 * Embedded terminal, VS Code-style: a real shell (node-pty in the main
 * process) rooted at the current project's folder, rendered here with
 * xterm.js. Any CLI the user runs in it - `git`, `npm run …`, `claude`,
 * `grok` - can freely rewrite files on disk; the existing project file
 * watcher (`ProjectWatcher`) picks those changes up exactly as it would an
 * edit made in VS Code, and `registerIpc`'s file-change handler now also
 * nudges the live preview to refresh for them (see electron/ipc/index.ts).
 *
 * The panel gates its own mount behind `hasOpenedRef`: nothing here (no pty,
 * no xterm instance) is created until the user opens the terminal for the
 * first time, but once created it stays alive - just visually hidden - while
 * the panel is toggled closed, so a long-running command or an interactive
 * `claude` session survives closing and reopening the panel.
 */
export function TerminalPanel(): JSX.Element | null {
  const visible = useUiStore((state) => state.terminalVisible);
  const toggleTerminal = useUiStore((state) => state.toggleTerminal);
  const hasOpenedRef = useRef(false);
  if (visible) hasOpenedRef.current = true;

  if (!hasOpenedRef.current) return null;
  return <TerminalSession hidden={!visible} onClose={toggleTerminal} />;
}

/**
 * `fit()` divides the container's measured box by the cell size, so a container
 * that is hidden or has not been laid out yet makes it read zero and throw from
 * inside xterm's own dimension maths. There is nothing useful to do about that
 * but wait for a real size - which the panel's ResizeObserver, and the refit on
 * becoming visible, both deliver.
 */
function safeFit(fitAddon: FitAddon): void {
  try {
    fitAddon.fit();
  } catch {
    /* see above - the next observed resize corrects it */
  }
}

/** Used only if the stylesheet somehow has not applied yet; `--font-mono` is the real source. */
const FALLBACK_MONO_STACK = 'Consolas, "Cascadia Code", ui-monospace, monospace';

/**
 * The monospace stack, as a literal font list.
 *
 * xterm cannot be handed `var(--font-mono)`. It does its own text metrics -
 * measuring one character cell and laying the entire grid out on that number -
 * and part of that path builds a canvas `ctx.font` string, where custom
 * properties do not exist and an unparseable value is discarded outright. The
 * font it then measures with is not the font it renders with, which is how a
 * terminal ends up with subtly wrong column widths and text that drifts out of
 * its own cells. On Linux the fallback landed on a metric-compatible default and
 * the damage stayed invisible; on Windows it did not.
 *
 * Resolving the custom property here keeps app.css the single definition of what
 * the app's monospace font *is* - this reads that value rather than restating
 * it, so the two cannot drift apart.
 */
function resolveMonoStack(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  return value === '' ? FALLBACK_MONO_STACK : value;
}

/**
 * xterm's colours, taken from the app's own theme tokens.
 *
 * Only the background used to be set (to transparent, so the panel's surface
 * shows through), which left the *foreground* at xterm's default of near-white.
 * On the dark theme that happened to be right; on the light theme it was white
 * text on a white panel - the terminal was there, running, and unreadable.
 *
 * Reading the tokens rather than restating their values keeps one definition of
 * the palette, and means the terminal follows a future theme edit for free.
 * Selection is derived from the accent with an alpha suffix, guarded on the token
 * actually being a 6-digit hex: xterm parses colours itself and does not accept
 * the space-separated `rgb(… / …)` form the rest of this stylesheet uses.
 */
function resolveXtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === '' ? fallback : value;
  };

  const accent = read('--accent', '#8f7bff');
  const selection = /^#[0-9a-f]{6}$/iu.test(accent) ? `${accent}59` : undefined;

  return {
    // Transparent, so the panel's own surface (and the theme it follows) shows
    // through instead of xterm painting its own black rectangle.
    background: '#00000000',
    foreground: read('--ink-1', '#f2f4fa'),
    cursor: read('--accent', '#8f7bff'),
    cursorAccent: read('--surface-0', '#0a0b10'),
    ...(selection === undefined ? {} : { selectionBackground: selection }),
  };
}

/**
 * A session on a degraded backend still works, but not identically - see
 * `TerminalBackendKind`. Saying so once, up front and in yellow, is the
 * difference between "resizing does nothing" reading as a bug and reading as a
 * documented limit of the platform build.
 */
function writeNotice(term: Terminal, notice: string | undefined): void {
  if (!notice) return;
  term.write(`\x1b[33m${notice}\x1b[0m\r\n\r\n`);
}

function TerminalSession({ hidden, onClose }: { hidden: boolean; onClose: () => void }): JSX.Element {
  const openAiToolsDialog = useUiStore((state) => state.openAiToolsDialog);
  const theme = useUiStore((state) => state.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [exited, setExited] = useState<number | null>(null);

  /* Create the pty + xterm instance once, on first mount. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let term: Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let onTermData: { dispose(): void } | null = null;
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;

    /*
     * `term.open()` is deferred by one frame, and that delay is load-bearing.
     *
     * Opening a terminal synchronously queues work *inside* xterm: the Viewport
     * constructor schedules its own `setTimeout(() => syncScrollArea())`, which
     * reads `renderService.dimensions`. In development React's StrictMode mounts
     * every effect, tears it down and mounts it again within the same commit -
     * so `dispose()` ran before that timer fired, and the timer then read
     * `dimensions` off a disposed render service. That is the
     * "Cannot read properties of undefined (reading 'dimensions')" crash: not a
     * terminal fault at all, just a disposed object with a timer still pointing
     * at it.
     *
     * A frame's delay means the throwaway StrictMode mount is cleaned up before
     * `open()` is ever reached, so no timer is queued against a terminal that is
     * about to be destroyed. It also guarantees the container has been laid out,
     * which is what `fit()` needs to measure anything at all.
     */
    const openHandle = requestAnimationFrame(() => {
      if (disposed) return;

      term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: resolveMonoStack(),
        theme: resolveXtermTheme(),
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const activeTerm = term;
      offData = window.litho.onTerminalData((payload) => {
        if (payload.id === sessionIdRef.current) activeTerm.write(payload.data);
      });
      offExit = window.litho.onTerminalExit((payload) => {
        if (payload.id !== sessionIdRef.current) return;
        setExited(payload.exitCode);
        activeTerm.write(`\r\n\x1b[90m[proces zakończony, kod ${payload.exitCode}]\x1b[0m\r\n`);
      });

      safeFit(fitAddon);
      void window.litho.terminal.create(activeTerm.cols, activeTerm.rows).then((result) => {
        if (disposed) return;
        if (!result.ok) {
          activeTerm.write(`\r\n\x1b[31mNie udało się uruchomić terminala: ${result.message}\x1b[0m\r\n`);
          return;
        }
        sessionIdRef.current = result.value.id;
        setCwd(result.value.cwd);
        writeNotice(activeTerm, result.value.notice);
      });

      onTermData = activeTerm.onData((data) => {
        if (sessionIdRef.current) window.litho.terminal.write(sessionIdRef.current, data);
      });

      resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        safeFit(fitAddon);
        if (sessionIdRef.current)
          window.litho.terminal.resize(sessionIdRef.current, activeTerm.cols, activeTerm.rows);
      });
      resizeObserver.observe(container);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(openHandle);
      resizeObserver?.disconnect();
      onTermData?.dispose();
      offData?.();
      offExit?.();
      if (sessionIdRef.current) window.litho.terminal.kill(sessionIdRef.current);
      termRef.current = null;
      fitAddonRef.current = null;
      term?.dispose();
    };
    // Intentionally empty: this session is created exactly once per panel lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Follow the app's theme. The tokens `resolveXtermTheme` reads are swapped by
   * `[data-theme]` on <html>, so they resolve to different values after a toggle
   * - but xterm has already copied them into its own colour manager and repaints
   * from that, not from CSS. Handing it the new set is what keeps the terminal
   * from staying dark-on-light (or light-on-dark) until it is next recreated.
   */
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = resolveXtermTheme();
  }, [theme]);

  /* Refit whenever the panel becomes visible again - a hidden xterm cannot
     measure itself, so the fit while closed is stale. */
  useEffect(() => {
    if (hidden) return;
    const id = requestAnimationFrame(() => {
      const fitAddon = fitAddonRef.current;
      if (fitAddon) safeFit(fitAddon);
      containerRef.current?.querySelector('textarea')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [hidden]);

  const restart = (): void => {
    const term = termRef.current;
    if (!term) return;
    if (sessionIdRef.current) window.litho.terminal.kill(sessionIdRef.current);
    sessionIdRef.current = null;
    setExited(null);
    term.clear();
    void window.litho.terminal.create(term.cols, term.rows).then((result) => {
      if (!result.ok) {
        term.write(`\r\n\x1b[31mNie udało się uruchomić terminala: ${result.message}\x1b[0m\r\n`);
        logger.warn(`Nie udało się ponownie uruchomić terminala: ${result.message}`);
        return;
      }
      sessionIdRef.current = result.value.id;
      setCwd(result.value.cwd);
      writeNotice(term, result.value.notice);
    });
  };

  return (
    <section
      className="terminal-panel"
      style={hidden ? { display: 'none' } : undefined}
      aria-label="Terminal"
    >
      <div className="panel__header">
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}
          title={cwd ?? undefined}
        >
          <Icon name="terminal" size={15} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Terminal{cwd ? ` - ${cwd}` : ''}
          </span>
        </span>
        <span style={{ display: 'flex', gap: 4 }}>
          {exited !== null ? (
            <button type="button" className="button button--ghost" onClick={restart}>
              <Icon name="restart_alt" size={15} />
              Uruchom ponownie
            </button>
          ) : null}
          {/* The terminal is where these tools are used, so it is where the
              offer to install them belongs. Windows-only, like the dialog. */}
          {isWindows ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={openAiToolsDialog}
              title="Zainstaluj narzędzia AI (Claude Code, Copilot, Grok, Cursor)"
            >
              <Icon name="bolt" size={15} />
              Narzędzia AI
            </button>
          ) : null}
          <button
            type="button"
            className="button button--ghost button--icon"
            onClick={onClose}
            aria-label="Zamknij terminal"
            title="Zamknij terminal"
          >
            <Icon name="close" size={16} />
          </button>
        </span>
      </div>
      <div className="terminal-panel__body" ref={containerRef} />
    </section>
  );
}
