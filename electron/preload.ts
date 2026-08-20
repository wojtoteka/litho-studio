import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppTheme,
  type LithoApi,
  type LogEntry,
  type LogLevel,
  type MenuCommand,
  type PreviewBounds,
  type TerminalDataPayload,
  type TerminalExitPayload,
} from '@shared/ipc.js';
import type { AiToolDonePayload, AiToolId, AiToolOutputPayload } from '@shared/aiTools.js';
import type { FileChangeEvent, FileWrite } from '@shared/project.js';

/**
 * The security boundary.
 *
 * The renderer runs with `contextIsolation: true` and `nodeIntegration: false`,
 * so this file is the *only* code with access to both worlds. It deliberately
 * exposes a fixed, hand-written API rather than a generic `invoke(channel, …)`
 * passthrough: a compromised renderer can then only call the operations listed
 * here, and only with arguments the main process re-validates anyway.
 *
 * Nothing here trusts its own inputs either — argument shapes are checked again
 * on the main side, because the preload runs in the renderer's process.
 */

/**
 * The main process passes the version through `additionalArguments` because a
 * sandboxed preload has no access to `app.getVersion()`.
 */
function readArgument(flag: string, fallback: string): string {
  const prefix = `--${flag}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => {
    try {
      listener(payload);
    } catch (error) {
      // A throwing listener must not break the IPC pipe for everyone else.
      ipcRenderer.send(IPC.logWrite, 'error', `Listener for ${channel} threw: ${String(error)}`);
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: LithoApi = {
  platform: process.platform,
  appVersion: readArgument('litho-app-version', '0.0.0'),
  // `os.homedir()` is not reachable from a sandboxed preload; the environment is.
  homeDir: process.env.HOME ?? process.env.USERPROFILE ?? '',
  isDevelopment: process.env.NODE_ENV === 'development',
  testHooksEnabled: process.argv.includes('--litho-test-hooks'),

  project: {
    openDialog: () => ipcRenderer.invoke(IPC.projectOpenDialog),
    openFileDialog: () => ipcRenderer.invoke(IPC.projectOpenFileDialog),
    open: (rootPath: string, filePath?: string) => ipcRenderer.invoke(IPC.projectOpen, rootPath, filePath),
    create: (parentPath: string, name: string) => ipcRenderer.invoke(IPC.projectCreate, parentPath, name),
    chooseParentDialog: () => ipcRenderer.invoke(IPC.projectChooseParent),
    close: () => ipcRenderer.invoke(IPC.projectClose),
    recent: () => ipcRenderer.invoke(IPC.projectRecent),
    forgetRecent: (rootPath: string) => ipcRenderer.invoke(IPC.projectForgetRecent, rootPath),
    refresh: () => ipcRenderer.invoke(IPC.projectRefresh),
    createPage: (relPath: string, title: string) => ipcRenderer.invoke(IPC.projectCreatePage, relPath, title),
    deletePage: (relPath: string) => ipcRenderer.invoke(IPC.projectDeletePage, relPath),
  },

  files: {
    read: (relPath: string) => ipcRenderer.invoke(IPC.filesRead, relPath),
    write: (writes: FileWrite[]) => ipcRenderer.invoke(IPC.filesWrite, writes),
    exists: (relPath: string) => ipcRenderer.invoke(IPC.filesExists, relPath),
    reveal: (relPath: string) => ipcRenderer.invoke(IPC.filesReveal, relPath),
    openExternally: (relPath: string) => ipcRenderer.invoke(IPC.filesOpenExternally, relPath),
  },

  assets: {
    list: () => ipcRenderer.invoke(IPC.assetsList),
    import: (sourcePaths: string[]) => ipcRenderer.invoke(IPC.assetsImport, sourcePaths),
    importBuffer: (name: string, data: Uint8Array) => ipcRenderer.invoke(IPC.assetsImportBuffer, name, data),
    delete: (relPath: string) => ipcRenderer.invoke(IPC.assetsDelete, relPath),
    pickDialog: () => ipcRenderer.invoke(IPC.assetsPickDialog),
  },

  preview: {
    show: (relPath: string, bounds: PreviewBounds) => ipcRenderer.invoke(IPC.previewShow, relPath, bounds),
    hide: () => ipcRenderer.invoke(IPC.previewHide),
    setBounds: (bounds: PreviewBounds) => ipcRenderer.invoke(IPC.previewSetBounds, bounds),
    setZoom: (factor: number) => ipcRenderer.invoke(IPC.previewSetZoom, factor),
    reload: () => ipcRenderer.invoke(IPC.previewReload),
    hotReloadCss: () => ipcRenderer.invoke(IPC.previewHotReloadCss),
    openInBrowser: (relPath: string) => ipcRenderer.invoke(IPC.previewOpenInBrowser, relPath),
  },

  window: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
    setTheme: (theme: AppTheme) => ipcRenderer.invoke(IPC.windowSetTheme, theme),
  },

  log: {
    write: (level: LogLevel, message: string, context?: Record<string, unknown>) => {
      ipcRenderer.send(IPC.logWrite, level, message, context);
    },
    path: () => ipcRenderer.invoke(IPC.logPath),
    tail: (lines: number) => ipcRenderer.invoke(IPC.logTail, lines),
    reveal: () => ipcRenderer.invoke(IPC.logReveal),
  },

  terminal: {
    create: (cols: number, rows: number) => ipcRenderer.invoke(IPC.terminalCreate, cols, rows),
    write: (id: string, data: string) => {
      ipcRenderer.send(IPC.terminalWrite, id, data);
    },
    resize: (id: string, cols: number, rows: number) => {
      ipcRenderer.send(IPC.terminalResize, id, cols, rows);
    },
    kill: (id: string) => {
      ipcRenderer.send(IPC.terminalKill, id);
    },
  },

  aiTools: {
    supported: () => ipcRenderer.invoke(IPC.aiToolsSupported),
    detect: () => ipcRenderer.invoke(IPC.aiToolsDetect),
    install: (id: AiToolId) => ipcRenderer.invoke(IPC.aiToolsInstall, id),
    cancel: (id: AiToolId) => ipcRenderer.invoke(IPC.aiToolsCancel, id),
    openHomepage: (id: AiToolId) => ipcRenderer.invoke(IPC.aiToolsOpenHomepage, id),
  },

  runNativeCommand: (command: MenuCommand) => ipcRenderer.invoke(IPC.menuRunNative, command),

  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    openDownloadPage: () => ipcRenderer.invoke(IPC.updateOpenDownloadPage),
  },

  onFileChange: (listener: (event: FileChangeEvent) => void) =>
    subscribe<FileChangeEvent>(IPC.eventFileChange, listener),
  onProjectClosed: (listener: () => void) => subscribe<void>(IPC.eventProjectClosed, listener),
  onMenuCommand: (listener: (command: MenuCommand) => void) =>
    subscribe<MenuCommand>(IPC.eventMenuCommand, listener),
  onWindowStateChange: (listener: (state: { maximized: boolean; focused: boolean }) => void) =>
    subscribe<{ maximized: boolean; focused: boolean }>(IPC.eventWindowState, listener),
  onLogEntry: (listener: (entry: LogEntry) => void) => subscribe<LogEntry>(IPC.eventLogEntry, listener),
  onTerminalData: (listener: (payload: TerminalDataPayload) => void) =>
    subscribe<TerminalDataPayload>(IPC.eventTerminalData, listener),
  onTerminalExit: (listener: (payload: TerminalExitPayload) => void) =>
    subscribe<TerminalExitPayload>(IPC.eventTerminalExit, listener),
  onAiToolOutput: (listener: (payload: AiToolOutputPayload) => void) =>
    subscribe<AiToolOutputPayload>(IPC.eventAiToolOutput, listener),
  onAiToolDone: (listener: (payload: AiToolDonePayload) => void) =>
    subscribe<AiToolDonePayload>(IPC.eventAiToolDone, listener),
  onFlushRequest: (listener: () => void) => subscribe<void>(IPC.eventFlushRequest, listener),
  flushDone: () => {
    ipcRenderer.send(IPC.appFlushDone);
  },
};

contextBridge.exposeInMainWorld('litho', api);
