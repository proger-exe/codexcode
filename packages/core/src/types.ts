export type CodexStatus =
  | "ready"
  | "thinking"
  | "editing"
  | "waiting_approval"
  | "error"
  | "offline";

export type CodexHealthState =
  | "ready"
  | "missing"
  | "not_logged_in"
  | "auth_error"
  | "runtime_error";

export type CodexHealth = {
  state: CodexHealthState;
  summary: string;
  details?: string;
  version?: string;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type CodexChatMode = "agent" | "plan";

export type ProjectInfo = {
  rootPath: string;
  name: string;
  isGitRepo: boolean;
  hasAgentsMd: boolean;
  codexAvailable: boolean;
  codexHealth: CodexHealth;
  openedAt: string;
};

export type ProjectSettings = {
  codexCommand: string;
  defaultModel: string;
  approvalMode: "suggest" | "manual";
  autoOpenCitations: boolean;
  autoSave: boolean;
  ignoredPaths: string[];
  defaultAgentTemplate: string;
  lsp: LspSettings;
};

export type LspSettings = {
  enabled: boolean;
  defaultServers: Record<string, string>;
  diagnostics: {
    enabled: boolean;
  };
  completion: {
    enabled: boolean;
    debounceMs: number;
  };
  formatting: {
    enabled: boolean;
  };
  debug: boolean;
  traceMessages: boolean;
  maxFileSizeBytes: number;
};

export type ChatSessionContext = {
  draft: string;
  mode: CodexChatMode;
};

export type ChatSessionCodexState = {
  id: string | null;
  state: "none" | "active" | "broken";
  createdAt?: string;
  lastUsedAt?: string;
  lastBootstrappedAt?: string;
};

export type ChatSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectChatIndex = {
  activeSessionId: string;
  sessions: ChatSessionSummary[];
};

export type ProjectWorkspaceState = {
  openPaths: string[];
  activePath: string | null;
};

export type FileNode = {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: FileNode[];
};

export type WorkspaceNode = FileNode;

export type WorkspaceOpenEditor = {
  path: string;
  title: string;
  isDirty: boolean;
  isMissing?: boolean;
  hasExternalConflict?: boolean;
};

export type WorkspaceSelection = {
  activePath: string | null;
};

export type WorkspaceFileChange = {
  kind: "added" | "changed" | "removed" | "renamed";
  path: string;
  nodeType: "file" | "directory";
  previousPath?: string;
};

export type WorkspaceSnapshot = {
  rootPath: string;
  tree: WorkspaceNode[];
  openEditors: WorkspaceOpenEditor[];
  selection: WorkspaceSelection;
};

export type WorkspaceEvent =
  | {
      kind: "snapshot";
      snapshot: WorkspaceSnapshot;
    }
  | {
      kind: "changed";
      snapshot: WorkspaceSnapshot;
      changes: WorkspaceFileChange[];
    };

export type EditorSelection = {
  filePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
};

export type ChatAttachment =
  | { kind: "file"; filePath: string }
  | { kind: "selection"; selection: EditorSelection }
  | { kind: "diff"; diffId: string }
  | { kind: "terminal"; output: string };

export type FileCitation = {
  id: string;
  label: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
};

export type DiffLine = {
  kind: "context" | "add" | "remove";
  value: string;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffPreview = {
  id: string;
  filePath: string;
  baseHash: string;
  rawDiff: string;
  hunks: DiffHunk[];
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  attachedFiles?: string[];
  selectedRange?: {
    filePath: string;
    startLine: number;
    endLine: number;
  };
  diffs?: DiffPreview[];
  citations?: FileCitation[];
  error?: string;
};

export type ChatSession = {
  id: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  context: ChatSessionContext;
  codexSession: ChatSessionCodexState;
  messages: ChatMessage[];
};

export type ProjectChatSnapshot = {
  activeSessionId: string;
  session: ChatSession;
  sessions: ChatSessionSummary[];
};

export type ProjectSnapshot = {
  project: ProjectInfo;
  settings: ProjectSettings;
  tree: FileNode[];
  chat: ProjectChatSnapshot;
  workspaceState: ProjectWorkspaceState;
};

export type ArchitectureTemplateVariable = {
  key: string;
  label: string;
  defaultValue: string;
  required: boolean;
};

export type ArchitectureTemplate = {
  id: string;
  name: string;
  description: string;
  languages: string[];
  files: Array<{ path: string; content: string }>;
  directories: string[];
  agentsTemplate: string;
  variables: ArchitectureTemplateVariable[];
  commands: {
    install?: string;
    dev?: string;
    test?: string;
    lint?: string;
    build?: string;
  };
};

export type CreateProjectInput = {
  destinationPath: string;
  templateId: string;
  variables: Record<string, string>;
  initializeGit: boolean;
};

export type DiffApplyResult = {
  applied: boolean;
  filePath: string;
  snapshotPath?: string;
  reason?: string;
};

export type CodexCommandRequest = {
  projectRoot: string;
  chatId: string;
  prompt: string;
  mode: CodexChatMode;
  selection?: EditorSelection;
  attachedFiles?: string[];
  model?: string;
};

export type CodexEvent =
  | { kind: "status"; status: CodexStatus; message?: string }
  | { kind: "token"; chunk: string }
  | {
      kind: "message";
      message: ChatMessage;
    }
  | { kind: "citation"; citation: FileCitation }
  | { kind: "diff"; diff: DiffPreview }
  | { kind: "approval_request"; command: string; reason?: string }
  | { kind: "command_output"; output: string }
  | { kind: "error"; message: string; details?: string }
  | { kind: "completed"; exitCode: number };

export type CodexRunState = {
  requestId: string;
  status: CodexStatus;
};

export type LspStatusState = "disabled" | "starting" | "ready" | "error" | "restarting" | "stopped";

export type LspCapabilitySummary = {
  completion: boolean;
  hover: boolean;
  definition: boolean;
  formatting: boolean;
  diagnostics: boolean;
  references?: boolean;
  rename?: boolean;
  codeAction?: boolean;
  documentSymbol?: boolean;
  workspaceSymbol?: boolean;
  semanticTokens?: boolean;
};

export type LspStatus = {
  languageId: string;
  server: string;
  status: LspStatusState;
  pid?: number;
  workspaceRoot: string;
  capabilities: LspCapabilitySummary;
  detail?: string;
};

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
  originSelectionRange?: LspRange;
};

export type LspTextEdit = {
  range?: LspRange;
  newText: string;
};

export type LspDiagnostic = {
  uri: string;
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: Array<{
    location: LspLocation;
    message: string;
  }>;
};

export type LspMarkupContent =
  | string
  | {
      kind: "markdown" | "plaintext";
      value: string;
    };

export type LspHover = {
  contents: LspMarkupContent | LspMarkupContent[];
  range?: LspRange;
};

export type LspCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: LspMarkupContent | LspMarkupContent[];
  insertText?: string;
  insertTextFormat?: 1 | 2;
  sortText?: string;
  filterText?: string;
  textEdit?: LspTextEdit;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  deprecated?: boolean;
  preselect?: boolean;
};

export type LspCompletionList = {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
};

export type LspDocumentOpenRequest = {
  workspaceRoot: string;
  filePath: string;
  text: string;
};

export type LspDocumentChangeRequest = {
  workspaceRoot: string;
  filePath: string;
  text: string;
  version: number;
};

export type LspDocumentSaveRequest = {
  workspaceRoot: string;
  filePath: string;
  text?: string;
};

export type LspDocumentCloseRequest = {
  workspaceRoot: string;
  filePath: string;
};

export type LspWarmupRequest = {
  workspaceRoot: string;
  filePath: string;
};

export type LspQueryRequest = {
  workspaceRoot: string;
  filePath: string;
  position: LspPosition;
};

export type LspFormatRequest = {
  workspaceRoot: string;
  filePath: string;
  tabSize: number;
  insertSpaces: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
};

export type LspStatusRequest = {
  workspaceRoot: string;
  filePath?: string;
  languageId?: string;
};

export type LspServerConfig = {
  command: string;
  args: string[];
  languages: string[];
  fileExtensions: string[];
  rootPatterns: string[];
};

export type LspConfig = {
  servers: Record<string, LspServerConfig>;
};

export type LspServerDescriptor = LspServerConfig & {
  id: string;
};

export type LspEvent =
  | {
      kind: "status";
      status: LspStatus;
    }
  | {
      kind: "diagnostics";
      workspaceRoot: string;
      filePath: string;
      diagnostics: LspDiagnostic[];
    }
  | {
      kind: "log";
      workspaceRoot: string;
      languageId: string;
      level: "info" | "warn" | "error" | "debug";
      message: string;
    };

export type TerminalCreateRequest = {
  cwd: string;
  cols: number;
  rows: number;
};

export type TerminalSession = {
  id: string;
  cwd: string;
  shell: string;
  pid?: number;
};

export type TerminalEvent =
  | {
      kind: "data";
      terminalId: string;
      data: string;
    }
  | {
      kind: "exit";
      terminalId: string;
      exitCode: number | null;
      signal?: number;
    }
  | {
      kind: "error";
      terminalId: string;
      message: string;
    };

export type AppCommand =
  | "project.openFolder"
  | "file.save"
  | "file.quickOpen"
  | "file.closeActive"
  | "pane.focusExplorer"
  | "pane.focusEditor"
  | "pane.focusChat"
  | "pane.toggleExplorer"
  | "pane.toggleChat"
  | "lsp.restartServer"
  | "lsp.stopServer"
  | "lsp.showStatus"
  | "lsp.goToDefinition"
  | "lsp.formatDocument"
  | "terminal.toggle"
  | "terminal.focus";
