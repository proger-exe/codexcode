import type {
  AppCommand,
  ChatMessage,
  ChatSessionSummary,
  ChatSessionContext,
  CodexCommandRequest,
  CodexHealth,
  CodexEvent,
  CreateProjectInput,
  DiffApplyResult,
  DiffPreview,
  FileNode,
  LspCompletionList,
  LspDocumentChangeRequest,
  LspDocumentCloseRequest,
  LspDocumentOpenRequest,
  LspDocumentSaveRequest,
  LspEvent,
  LspFormatRequest,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspQueryRequest,
  LspStatus,
  LspStatusRequest,
  LspTextEdit,
  LspWarmupRequest,
  ProjectSettings,
  ProjectSnapshot,
  ProjectWorkspaceState,
  TerminalCreateRequest,
  TerminalEvent,
  TerminalSession,
  WorkspaceEvent,
  WorkspaceSnapshot,
} from "../types";

export const ipcChannels = {
  projectOpen: "project:open",
  projectOpenDialog: "project:open-dialog",
  projectRefresh: "project:refresh",
  projectRecent: "project:recent",
  fileRead: "file:read",
  fileWrite: "file:write",
  fileCreate: "file:create",
  fileDelete: "file:delete",
  fileRename: "file:rename",
  chatSend: "chat:send",
  chatCancel: "chat:cancel",
  chatList: "chat:list",
  chatCreate: "chat:create",
  chatOpen: "chat:open",
  chatSetActive: "chat:set-active",
  diffApply: "diff:apply",
  templateList: "template:list",
  templateGenerate: "template:generate",
  settingsUpdate: "settings:update",
  codexHealth: "codex:health",
  workspaceOpen: "workspace:open",
  workspaceFileOpen: "workspace:file-open",
  workspaceFileClose: "workspace:file-close",
  workspaceActiveSet: "workspace:active-set",
  workspaceDirtySet: "workspace:dirty-set",
  workspaceReconcile: "workspace:reconcile",
  workspaceStateUpdate: "workspace-state:update",
  workspaceEvent: "workspace:event",
  chatContextUpdate: "chat:context-update",
  lspDocumentOpen: "lsp:document-open",
  lspDocumentChange: "lsp:document-change",
  lspDocumentSave: "lsp:document-save",
  lspDocumentClose: "lsp:document-close",
  lspPrewarm: "lsp:prewarm",
  lspCompletion: "lsp:completion",
  lspHover: "lsp:hover",
  lspDefinition: "lsp:definition",
  lspFormatDocument: "lsp:format-document",
  lspRestartServer: "lsp:restart-server",
  lspStopServer: "lsp:stop-server",
  lspStatus: "lsp:status",
  lspEvent: "lsp:event",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalEvent: "terminal:event",
  appCommand: "app:command",
  codexEvent: "codex:event"
} as const;

export type DesktopApi = {
  openProject(path: string): Promise<ProjectSnapshot>;
  openProjectDialog(): Promise<ProjectSnapshot | null>;
  refreshProject(rootPath: string): Promise<FileNode[]>;
  listRecentProjects(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string, type: "file" | "directory"): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;
  sendChat(request: CodexCommandRequest): Promise<{ requestId: string }>;
  cancelChat(requestId: string): Promise<void>;
  listChats(rootPath: string): Promise<ChatSessionSummary[]>;
  createChat(rootPath: string): Promise<ProjectSnapshot["chat"]>;
  openChat(rootPath: string, chatId: string): Promise<ProjectSnapshot["chat"]>;
  setActiveChat(rootPath: string, chatId: string): Promise<ProjectSnapshot["chat"]>;
  updateChatContext(
    rootPath: string,
    chatId: string,
    context: Partial<ChatSessionContext>
  ): Promise<void>;
  getCodexHealth(projectRoot?: string): Promise<CodexHealth>;
  openWorkspace(rootPath: string): Promise<WorkspaceSnapshot>;
  openWorkspaceFile(rootPath: string, filePath: string): Promise<WorkspaceSnapshot>;
  closeWorkspaceFile(rootPath: string, filePath: string): Promise<WorkspaceSnapshot>;
  setWorkspaceActive(rootPath: string, filePath: string | null): Promise<WorkspaceSnapshot>;
  setWorkspaceDirty(rootPath: string, filePath: string, isDirty: boolean): Promise<WorkspaceSnapshot>;
  reconcileWorkspace(rootPath: string): Promise<WorkspaceSnapshot>;
  updateWorkspaceState(rootPath: string, state: Partial<ProjectWorkspaceState>): Promise<ProjectWorkspaceState>;
  lspOpenDocument(request: LspDocumentOpenRequest): Promise<void>;
  lspChangeDocument(request: LspDocumentChangeRequest): Promise<void>;
  lspSaveDocument(request: LspDocumentSaveRequest): Promise<void>;
  lspCloseDocument(request: LspDocumentCloseRequest): Promise<void>;
  lspPrewarm(request: LspWarmupRequest): Promise<void>;
  lspGetCompletion(request: LspQueryRequest): Promise<LspCompletionList>;
  lspGetHover(request: LspQueryRequest): Promise<LspHover | null>;
  lspGetDefinition(request: LspQueryRequest): Promise<Array<LspLocation | LspLocationLink>>;
  lspFormatDocument(request: LspFormatRequest): Promise<LspTextEdit[]>;
  restartLspServer(workspaceRoot: string, languageId: string): Promise<LspStatus>;
  stopLspServer(workspaceRoot: string, languageId: string): Promise<void>;
  getLspStatus(request: LspStatusRequest): Promise<LspStatus>;
  createTerminal(request: TerminalCreateRequest): Promise<TerminalSession>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  killTerminal(terminalId: string): Promise<void>;
  applyDiff(projectRoot: string, diff: DiffPreview): Promise<DiffApplyResult>;
  listTemplates(): Promise<import("../types").ArchitectureTemplate[]>;
  generateProject(input: CreateProjectInput): Promise<ProjectSnapshot>;
  updateSettings(rootPath: string, settings: ProjectSettings): Promise<ProjectSettings>;
  subscribeLspEvents(listener: (event: LspEvent) => void): () => void;
  subscribeCodexEvents(listener: (event: CodexEvent & { requestId: string }) => void): () => void;
  subscribeWorkspaceEvents(listener: (event: WorkspaceEvent) => void): () => void;
  subscribeTerminalEvents(listener: (event: TerminalEvent) => void): () => void;
  subscribeAppCommands(listener: (command: AppCommand) => void): () => void;
};
