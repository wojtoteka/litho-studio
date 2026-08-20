import { describe, expect, it } from 'vitest';
import {
  AI_TOOLS,
  AI_TOOLS_PLATFORM,
  describeInstallCommand,
  findAiTool,
  parseVersion,
} from '../../shared/aiTools.js';

/**
 * The AI tool catalogue is the single place that decides what the installer
 * runs, and the dialog shows the user that same entry as the command it is about
 * to execute. Two properties therefore matter more than anything else here:
 *
 *  - the command the user *reads* is the command that gets *run* — they are
 *    derived from one field, and these tests pin that they cannot drift;
 *  - an id arriving over the IPC bridge only ever resolves to a catalogue entry,
 *    because `validateToolId` in electron/ipc/index.ts rejects anything
 *    `findAiTool` does not recognise. That is the boundary that keeps a renderer
 *    from naming its own command.
 */
describe('AI tool catalogue', () => {
  it('offers the four tools the installer is documented to install', () => {
    expect(AI_TOOLS.map((tool) => tool.id)).toEqual([
      'claude-code',
      'copilot-cli',
      'grok-cli',
      'cursor-agent',
    ]);
  });

  it('is Windows-only', () => {
    expect(AI_TOOLS_PLATFORM).toBe('win32');
  });

  it('gives every tool a unique id and a unique binary to look for', () => {
    const ids = AI_TOOLS.map((tool) => tool.id);
    const binaries = AI_TOOLS.map((tool) => tool.binary);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(binaries).size).toBe(binaries.length);
  });

  it('describes every install as the command that will actually run', () => {
    expect(describeInstallCommand(findAiTool('claude-code')!)).toBe(
      'npm install -g @anthropic-ai/claude-code',
    );
    expect(describeInstallCommand(findAiTool('copilot-cli')!)).toBe('npm install -g @github/copilot');
    expect(describeInstallCommand(findAiTool('grok-cli')!)).toBe('npm install -g @xai-official/grok');
    expect(describeInstallCommand(findAiTool('cursor-agent')!)).toBe(
      'curl https://cursor.com/install -fsS | bash',
    );
  });

  it('resolves only known ids — anything else is refused before it reaches a shell', () => {
    expect(findAiTool('claude-code')?.name).toBe('Claude Code');
    expect(findAiTool('nope')).toBeUndefined();
    expect(findAiTool('')).toBeUndefined();
    // The shapes an attempt at injection would take, all of which must miss.
    expect(findAiTool('claude-code; rm -rf /')).toBeUndefined();
    expect(findAiTool('__proto__')).toBeUndefined();
    expect(findAiTool('constructor')).toBeUndefined();
  });

  it('never carries a shell metacharacter in a binary name', () => {
    // `probeVersion` runs these with `shell: true`, which is safe only because
    // they are literals from this file and contain nothing a shell would act on.
    for (const tool of AI_TOOLS) {
      expect(tool.binary).toMatch(/^[a-z][a-z0-9-]*$/u);
    }
  });

  it('points every tool at an https homepage', () => {
    for (const tool of AI_TOOLS) {
      expect(tool.homepage.startsWith('https://')).toBe(true);
    }
  });
});

describe('parseVersion', () => {
  it('reads a bare version', () => {
    expect(parseVersion('1.2.3')).toBe('1.2.3');
    expect(parseVersion('1.2.3\n')).toBe('1.2.3');
  });

  it('reads a version out of a longer line', () => {
    expect(parseVersion('@anthropic-ai/claude-code/1.0.44 win32-x64 node-v22.16.0')).toBe('1.0.44');
    expect(parseVersion('grok version 0.9.1')).toBe('0.9.1');
    expect(parseVersion('v2.10.0')).toBe('2.10.0');
  });

  it('accepts a two-segment version', () => {
    expect(parseVersion('1.4')).toBe('1.4');
  });

  it('keeps a prerelease or build suffix', () => {
    expect(parseVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4');
    expect(parseVersion('2.0.0+build17')).toBe('2.0.0+build17');
  });

  it('skips a banner and finds the version on a later line', () => {
    expect(parseVersion('Cursor Agent\nCopyright (c) Anysphere\ncursor-agent 0.3.7')).toBe('0.3.7');
  });

  it('orders 1.0.10 correctly — it is read as one token, not truncated to 1.0.1', () => {
    expect(parseVersion('1.0.10')).toBe('1.0.10');
  });

  it('returns null when there is no version to find', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('command not found')).toBeNull();
    // A lone integer is not a version; treating it as one would show "installed
    // 64" next to a tool that printed an architecture and nothing else.
    expect(parseVersion('x64')).toBeNull();
  });
});
