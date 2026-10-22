import { createRequire } from "node:module";
import type { DesktopApi } from "@codex-code/core";
import { ipcChannels } from "@codex-code/core";

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const api: DesktopApi = {
  openProject: (path) => ipcRenderer.invoke(ipcChannels.projectOpen, path),
  openProjectDialog: () => ipcRenderer.invoke(ipcChannels.projectOpenDialog),
  refreshProject: (rootPath) => ipcRenderer.invoke(ipcChannels.projectRefresh, rootPath),
  listRecentProjects: () => ipcRenderer.invoke(ipcChannels.projectRecent),
  readFile: (path) => ipcRenderer.invoke(ipcChannels.fileRead, path),
  writeFile: (path, content) => ipcRenderer.invoke(ipcChannels.fileWrite, path, content),
  createFile: (path, type) => ipcRenderer.invoke(ipcChannels.fileCreate, path, type),
  deleteFile: (path) => ipcRenderer.invoke(ipcChannels.fileDelete, path),
  renameFile: (oldPath, newPath) => ipcRenderer.invoke(ipcChannels.fileRename, oldPath, newPath),
  sendChat: (request) => ipcRenderer.invoke(ipcChannels.chatSend, request),
  cancelChat: (requestId) => ipcRenderer.invoke(ipcChannels.chatCancel, requestId),
  listChats: (rootPath) => ipcRenderer.invoke(ipcChannels.chatList, rootPath),
  createChat: (rootPath) => ipcRenderer.invoke(ipcChannels.chatCreate, rootPath),
  openChat: (rootPath, chatId) => ipcRenderer.invoke(ipcChannels.chatOpen, rootPath, chatId),
  setActiveChat: (rootPath, chatId) => ipcRenderer.invoke(ipcChannels.chatSetActive, rootPath, chatId),
  updateChatContext: (rootPath, chatId, context) =>
    ipcRenderer.invoke(ipcChannels.chatContextUpdate, rootPath, chatId, context),
  getCodexHealth: (projectRoot) => ipcRenderer.invoke(ipcChannels.codexHealth, projectRoot),
  openWorkspace: (rootPath) => ipcRenderer.invoke(ipcChannels.workspaceOpen, rootPath),
  openWorkspaceFile: (rootPath, filePath) =>
    ipcRenderer.invoke(ipcChannels.workspaceFileOpen, rootPath, filePath),
  closeWorkspaceFile: (rootPath, filePath) =>
    ipcRenderer.invoke(ipcChannels.workspaceFileClose, rootPath, filePath),
  setWorkspaceActive: (rootPath, filePath) =>
    ipcRenderer.invoke(ipcChannels.workspaceActiveSet, rootPath, filePath),
  setWorkspaceDirty: (rootPath, filePath, isDirty) =>
    ipcRenderer.invoke(ipcChannels.workspaceDirtySet, rootPath, filePath, isDirty),
  reconcileWorkspace: (rootPath) => ipcRenderer.invoke(ipcChannels.workspaceReconcile, rootPath),
  updateWorkspaceState: (rootPath, state) =>
    ipcRenderer.invoke(ipcChannels.workspaceStateUpdate, rootPath, state),
  lspOpenDocument: (request) => ipcRenderer.invoke(ipcChannels.lspDocumentOpen, request),
  lspChangeDocument: (request) => ipcRenderer.invoke(ipcChannels.lspDocumentChange, request),
  lspSaveDocument: (request) => ipcRenderer.invoke(ipcChannels.lspDocumentSave, request),
  lspCloseDocument: (request) => ipcRenderer.invoke(ipcChannels.lspDocumentClose, request),
  lspPrewarm: (request) => ipcRenderer.invoke(ipcChannels.lspPrewarm, request),
  lspGetCompletion: (request) => ipcRenderer.invoke(ipcChannels.lspCompletion, request),
  lspGetHover: (request) => ipcRenderer.invoke(ipcChannels.lspHover, request),
  lspGetDefinition: (request) => ipcRenderer.invoke(ipcChannels.lspDefinition, request),
  lspFormatDocument: (request) => ipcRenderer.invoke(ipcChannels.lspFormatDocument, request),
  restartLspServer: (workspaceRoot, languageId) =>
    ipcRenderer.invoke(ipcChannels.lspRestartServer, workspaceRoot, languageId),
  stopLspServer: (workspaceRoot, languageId) =>
    ipcRenderer.invoke(ipcChannels.lspStopServer, workspaceRoot, languageId),
  getLspStatus: (request) => ipcRenderer.invoke(ipcChannels.lspStatus, request),
  createTerminal: (request) => ipcRenderer.invoke(ipcChannels.terminalCreate, request),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke(ipcChannels.terminalWrite, terminalId, data),
  resizeTerminal: (terminalId, cols, rows) =>
    ipcRenderer.invoke(ipcChannels.terminalResize, terminalId, cols, rows),
  killTerminal: (terminalId) => ipcRenderer.invoke(ipcChannels.terminalKill, terminalId),
  applyDiff: (projectRoot, diff) => ipcRenderer.invoke(ipcChannels.diffApply, projectRoot, diff),
  listTemplates: () => ipcRenderer.invoke(ipcChannels.templateList),
  generateProject: (input) => ipcRenderer.invoke(ipcChannels.templateGenerate, input),
  updateSettings: (rootPath, settings) =>
    ipcRenderer.invoke(ipcChannels.settingsUpdate, rootPath, settings),
  subscribeLspEvents: (listener) => {
    const subscription = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof listener>[0]
    ) => listener(payload);

    ipcRenderer.on(ipcChannels.lspEvent, subscription);
    return () => {
      ipcRenderer.removeListener(ipcChannels.lspEvent, subscription);
    };
  },
  subscribeCodexEvents: (listener) => {
    const subscription = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof listener>[0]
    ) => listener(payload);

    ipcRenderer.on(ipcChannels.codexEvent, subscription);
    return () => {
      ipcRenderer.removeListener(ipcChannels.codexEvent, subscription);
    };
  },
  subscribeWorkspaceEvents: (listener) => {
    const subscription = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof listener>[0]
    ) => listener(payload);

    ipcRenderer.on(ipcChannels.workspaceEvent, subscription);
    return () => {
      ipcRenderer.removeListener(ipcChannels.workspaceEvent, subscription);
    };
  },
  subscribeTerminalEvents: (listener) => {
    const subscription = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof listener>[0]
    ) => listener(payload);

    ipcRenderer.on(ipcChannels.terminalEvent, subscription);
    return () => {
      ipcRenderer.removeListener(ipcChannels.terminalEvent, subscription);
    };
  },
  subscribeAppCommands: (listener) => {
    const subscription = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof listener>[0]
    ) => listener(payload);

    ipcRenderer.on(ipcChannels.appCommand, subscription);
    return () => {
      ipcRenderer.removeListener(ipcChannels.appCommand, subscription);
    };
  }
};

contextBridge.exposeInMainWorld("codexCode", api);
