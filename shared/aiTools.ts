/**
 * The AI tool catalogue — what the installer knows how to fetch, and how.
 *
 * Shared rather than living in the main process, because both sides need it and
 * for different halves: the renderer draws the name, the description and the
 * exact command that is about to run, while the main process turns that same
 * entry into a spawned process. Two lists would drift, and the one thing this
 * dialog must never do is claim it is running one command while running another.
 *
 * ## Why Windows-only
 *
 * These are all global CLI installs — they write outside any project, into a
 * package manager's global prefix or a vendor-chosen directory. On Linux that is
 * the package manager's or the distribution's business, not an editor's: `npm
 * install -g` there lands in a root-owned prefix on a default install, so a
 * button that shells it out would either fail on permissions or quietly want
 * sudo, and neither belongs behind a button in a website editor. Windows has no
 * such split — npm's global prefix is per-user and writable — so the installer
 * is offered there and only there. `AI_TOOLS_PLATFORM` is the single place that
 * decision is written down; `aiToolsService.ts` enforces it and the UI reads it
 * to decide whether the entry point exists at all.
 *
 * The commands themselves are the ones each vendor documents. Nothing here is
 * inferred, and nothing self-updates: if a vendor renames a package, this file is
 * where it gets corrected.
 */

/** The only platform the installer runs on. See the note above. */
export const AI_TOOLS_PLATFORM = 'win32';

export type AiToolId = 'claude-code' | 'copilot-cli' | 'grok-cli' | 'cursor-agent';

/**
 * How a tool gets onto the machine.
 *
 * `npm-global` is the ordinary case. `bash-script` is the vendor's own installer
 * shell script, which needs a POSIX shell — on Windows that means the `bash` that
 * comes with Git for Windows (or WSL). It is not assumed to be there: the service
 * looks for it and, when it is missing, says so and points at the vendor's page
 * instead of failing with a raw "command not found".
 */
export type AiToolInstall =
  | { readonly kind: 'npm-global'; readonly package: string }
  | { readonly kind: 'bash-script'; readonly url: string };

export interface AiToolSpec {
  readonly id: AiToolId;
  /** Product name as its vendor writes it. */
  readonly name: string;
  /** One line, in Polish, on what the tool is for. */
  readonly description: string;
  /**
   * The executable the user types afterwards. Detection looks for exactly this
   * name on PATH, so it is the CLI's real binary name and not a friendly label.
   */
  readonly binary: string;
  readonly install: AiToolInstall;
  /** Vendor page, opened in the user's own browser — never in the app. */
  readonly homepage: string;
}

export const AI_TOOLS: readonly AiToolSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Agent Anthropic w terminalu — czyta i zmienia pliki projektu.',
    binary: 'claude',
    install: { kind: 'npm-global', package: '@anthropic-ai/claude-code' },
    homepage: 'https://docs.anthropic.com/en/docs/claude-code/overview',
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    description: 'Copilot jako polecenie — podpowiada i wykonuje komendy powłoki.',
    binary: 'copilot',
    install: { kind: 'npm-global', package: '@github/copilot' },
    homepage: 'https://github.com/features/copilot',
  },
  {
    id: 'grok-cli',
    name: 'Grok CLI',
    description: 'Klient xAI Grok do pracy z kodem z linii poleceń.',
    binary: 'grok',
    install: { kind: 'npm-global', package: '@xai-official/grok' },
    homepage: 'https://x.ai',
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    description: 'Agent Cursora w terminalu. Instalator wymaga powłoki bash (Git for Windows).',
    binary: 'cursor-agent',
    install: { kind: 'bash-script', url: 'https://cursor.com/install' },
    homepage: 'https://cursor.com',
  },
];

export function findAiTool(id: string): AiToolSpec | undefined {
  return AI_TOOLS.find((tool) => tool.id === id);
}

/**
 * The command as the user should see it, before anything runs.
 *
 * Shown in the dialog next to every tool. An installer that does not say what it
 * is about to execute is asking for trust it has not earned — and this one runs
 * commands that write outside the project, which is exactly the case where the
 * user is entitled to read it first.
 */
export function describeInstallCommand(tool: AiToolSpec): string {
  return tool.install.kind === 'npm-global'
    ? `npm install -g ${tool.install.package}`
    : `curl ${tool.install.url} -fsS | bash`;
}

/**
 * Pulls a version number out of whatever a CLI prints for `--version`.
 *
 * There is no agreement between these four on what that output looks like: some
 * print a bare `1.2.3`, some prefix it with the package name, some with a `v`,
 * and some lead with a banner line and put the version after it. Detection only
 * needs the number, so the first thing in the output that looks like one wins —
 * and anything unrecognisable yields `null`, which the UI shows as "installed,
 * version unknown" rather than as a failure. Lives here beside the catalogue
 * because it is a fact about these tools, and so that it is testable without
 * dragging in the main process.
 */
export function parseVersion(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9a-z.]+)?/iu.exec(output);
  return match ? match[0] : null;
}

/** State of one tool on this machine, as reported by `aiTools.detect()`. */
export interface AiToolStatus {
  readonly id: AiToolId;
  readonly installed: boolean;
  /** Version when the CLI reported one; `null` when it is present but silent. */
  readonly version: string | null;
  /** Absolute path PATH resolved to, shown as the row's tooltip. */
  readonly path: string | null;
}

export interface AiToolOutputPayload {
  readonly id: AiToolId;
  /** Raw stdout/stderr text, in arrival order. Not line-buffered. */
  readonly chunk: string;
}

export interface AiToolDonePayload {
  readonly id: AiToolId;
  readonly ok: boolean;
  readonly exitCode: number;
  /** Set when `ok` is false: a sentence the UI can show as-is. */
  readonly message?: string;
}
