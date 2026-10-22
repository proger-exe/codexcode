import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type {
  AppCommand,
  ChatMessage,
  CodexChatMode,
  ChatSessionSummary,
  ChatSessionContext,
  CodexHealth,
  CodexStatus,
  DesktopApi,
  FileCitation,
  FileNode,
  LspLocation,
  LspLocationLink,
  ProjectInfo,
  ProjectChatSnapshot,
  ProjectSettings,
  WorkspaceEvent,
  WorkspaceFileChange,
  WorkspaceOpenEditor,
  WorkspaceSnapshot
} from "@codex-code/core";
import { SideChat, TopBar, WorkspaceExplorerPane } from "@codex-code/ui";
import {
  conf as monacoPythonConf,
  language as monacoPythonLanguage
} from "monaco-editor/esm/vs/basic-languages/python/python.js";
import { LspClientAdapter } from "./lsp/LspClientAdapter";
import { TerminalPanel } from "./TerminalPanel";

type HighlightRange = {
  startLine: number;
  endLine: number;
};

type DefinitionTarget = {
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn: number;
};

type EditorDocument = {
  content: string;
  hasExternalConflict: boolean;
  isDirty: boolean;
  isMissing: boolean;
};

type PendingAssistantMessage = {
  content: string;
  createdAt: string;
  id: string;
};

type QuickOpenItem = {
  path: string;
  relativePath: string;
  title: string;
};

const defaultSettings: ProjectSettings = {
  codexCommand: "codex",
  defaultModel: "gpt-5.4",
  approvalMode: "suggest",
  autoOpenCitations: true,
  autoSave: false,
  ignoredPaths: [".git", ".codex-code", "node_modules", ".venv", "dist", "build"],
  defaultAgentTemplate: "python-backend",
  lsp: {
    enabled: true,
    defaultServers: {
      python: "pyright"
    },
    diagnostics: {
      enabled: true
    },
    completion: {
      enabled: true,
      debounceMs: 75
    },
    formatting: {
      enabled: true
    },
    debug: false,
    traceMessages: false,
    maxFileSizeBytes: 1024 * 1024
  }
};

const defaultCodexHealth: CodexHealth = {
  state: "missing",
  summary: "codex-cli has not been checked yet."
};

const defaultChatContext: ChatSessionContext = {
  draft: "",
  mode: "agent"
};

const resolveProjectPath = (projectRoot: string, filePath: string): string =>
  filePath.startsWith("/") ? filePath : `${projectRoot}/${filePath}`;

const fileUriToPath = (uri: string): string => decodeURIComponent(new URL(uri).pathname);

const getRelativePathSegments = (rootPath: string, filePath: string): string[] => {
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFile = filePath.replace(/\\/g, "/");
  const relativePath = normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : normalizedFile;

  return relativePath.split("/").filter(Boolean);
};

const editorLanguageByExtension: Record<string, string> = {
  py: "python",
  pyi: "python",
  js: "javascript",
  jsx: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  cts: "typescript",
  mts: "typescript",
  json: "json",
  md: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell"
};

const resolveEditorLanguage = (filePath: string | null | undefined): string => {
  if (!filePath) {
    return "plaintext";
  }

  const fileName = filePath.split("/").pop() ?? filePath;
  const extension = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : "";

  if (!extension) {
    return "plaintext";
  }

  return editorLanguageByExtension[extension] ?? "plaintext";
};

const patchedPythonLanguage = {
  ...monacoPythonLanguage,
  tokenizer: {
    ...monacoPythonLanguage.tokenizer,
    strings: [
      [/'$/, "string.escape", "@popall"],
      [/(?:[fF][rR]?|[rR][fF])'''/, "string.escape", "@fTripleStringBody"],
      [/(?:[fF][rR]?|[rR][fF])'/, "string.escape", "@fStringBody"],
      [/'/, "string.escape", "@stringBody"],
      [/"$/, "string.escape", "@popall"],
      [/(?:[fF][rR]?|[rR][fF])"""/, "string.escape", "@fTripleDblStringBody"],
      [/(?:[fF][rR]?|[rR][fF])"/, "string.escape", "@fDblStringBody"],
      [/"/, "string.escape", "@dblStringBody"]
    ],
    fTripleStringBody: [
      [/[^\\'\{\}]+/, "string"],
      [/\{[^\}':!=]+/, "identifier", "@fStringDetail"],
      [/\\./, "string"],
      [/'''/, "string.escape", "@popall"],
      [/'/, "string"],
      [/\\$/, "string"]
    ],
    fTripleDblStringBody: [
      [/[^\\"\{\}]+/, "string"],
      [/\{[^\}':!=]+/, "identifier", "@fStringDetail"],
      [/\\./, "string"],
      [/"""/, "string.escape", "@popall"],
      [/"/, "string"],
      [/\\$/, "string"]
    ]
  }
};

const resolveDefinitionTarget = (
  definition: LspLocation | LspLocationLink
): DefinitionTarget => {
  if ("targetUri" in definition) {
    const range = definition.targetSelectionRange ?? definition.targetRange;
    return {
      filePath: fileUriToPath(definition.targetUri),
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      startColumn: range.start.character + 1
    };
  }

  return {
    filePath: fileUriToPath(definition.uri),
    startLine: definition.range.start.line + 1,
    endLine: definition.range.end.line + 1,
    startColumn: definition.range.start.character + 1
  };
};

const resolveStatusFromHealth = (health: CodexHealth): CodexStatus => {
  if (health.state === "ready") {
    return "ready";
  }

  return health.state === "missing" || health.state === "not_logged_in" ? "offline" : "error";
};

const resolveDisabledReason = (
  project: ProjectInfo | null,
  health: CodexHealth,
  activeRequestId: string | null
): string | undefined => {
  if (!project) {
    return "Open a folder to chat with Codex.";
  }

  if (activeRequestId) {
    return "Codex is still responding.";
  }

  if (health.state === "ready") {
    return undefined;
  }

  return health.summary;
};

const normalizeRequestedModel = (model: string): string | undefined => {
  const trimmed = model.trim();

  if (!trimmed || trimmed === "gpt-5-codex") {
    return undefined;
  }

  return trimmed;
};

const flattenTree = (node: FileNode): FileNode[] =>
  node.children?.length ? [node, ...node.children.flatMap((child) => flattenTree(child))] : [node];

const inFlightMessageToChatMessage = (
  pendingAssistantMessage: PendingAssistantMessage | null
): ChatMessage | null => {
  if (!pendingAssistantMessage) {
    return null;
  }

  return {
    id: pendingAssistantMessage.id,
    role: "assistant",
    content: pendingAssistantMessage.content,
    createdAt: pendingAssistantMessage.createdAt
  };
};

const flattenWorkspaceNodes = (nodes: FileNode[]): FileNode[] =>
  nodes.flatMap((node) => (node.children?.length ? [node, ...flattenWorkspaceNodes(node.children)] : [node]));

export function App() {
  const [desktopApi, setDesktopApi] = useState<DesktopApi | null>(() => window.codexCode ?? null);
  const [bridgeState, setBridgeState] = useState<"checking" | "ready" | "missing">(() =>
    window.codexCode ? "ready" : "checking"
  );
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [settings, setSettings] = useState<ProjectSettings>(defaultSettings);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [documents, setDocuments] = useState<Record<string, EditorDocument>>({});
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeChatMode, setActiveChatMode] = useState<CodexChatMode>(defaultChatContext.mode);
  const [status, setStatus] = useState<CodexStatus>("offline");
  const [codexHealth, setCodexHealth] = useState<CodexHealth>(defaultCodexHealth);
  const [draft, setDraft] = useState("");
  const [pendingAssistantMessage, setPendingAssistantMessage] =
    useState<PendingAssistantMessage | null>(null);
  const [highlight, setHighlight] = useState<HighlightRange | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [quickOpenQuery, setQuickOpenQuery] = useState("");
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);
  const [contextReady, setContextReady] = useState(false);
  const [pendingChord, setPendingChord] = useState<"openFolder" | null>(null);
  const [pendingNavigationTarget, setPendingNavigationTarget] = useState<DefinitionTarget | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [explorerVisible, setExplorerVisible] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(280);
  const [terminalFocusSignal, setTerminalFocusSignal] = useState(0);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const decorationIds = useRef<string[]>([]);
  const documentsRef = useRef<Record<string, EditorDocument>>({});
  const explorerPaneRef = useRef<HTMLElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const quickOpenInputRef = useRef<HTMLInputElement | null>(null);
  const contextSaveTimerRef = useRef<number | null>(null);
  const lspAdapterRef = useRef<LspClientAdapter | null>(null);
  const definitionDecorationIdsRef = useRef<string[]>([]);
  const definitionHoverTokenRef = useRef<string | null>(null);
  const editorDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);
  const monacoPythonPatchedRef = useRef(false);
  const documentLoadEpochsRef = useRef(new Map<string, number>());
  const terminalResizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const activePath = workspace?.selection.activePath ?? null;
  const activeEditor = workspace?.openEditors.find((editor) => editor.path === activePath) ?? null;
  const activeDocument = activePath ? documents[activePath] ?? null : null;
  const activeEditorLanguage = resolveEditorLanguage(activeEditor?.path);
  const activeBreadcrumbs = useMemo(() => {
    if (!project || !activeEditor) {
      return [];
    }

    return [project.name, ...getRelativePathSegments(project.rootPath, activeEditor.path)];
  }, [activeEditor, project]);
  const deferredQuickOpenQuery = useDeferredValue(quickOpenQuery);
  const quickOpenItems = useMemo<QuickOpenItem[]>(() => {
    if (!workspace) {
      return [];
    }

    const normalizedQuery = deferredQuickOpenQuery.trim().toLowerCase();

    return flattenWorkspaceNodes(workspace.tree)
      .filter((node) => node.type === "file")
      .map((node) => ({
        path: node.path,
        relativePath: node.relativePath,
        title: node.name
      }))
      .filter((item) => {
        if (!normalizedQuery) {
          return true;
        }

        return (
          item.title.toLowerCase().includes(normalizedQuery) ||
          item.relativePath.toLowerCase().includes(normalizedQuery)
        );
      })
      .slice(0, 50);
  }, [deferredQuickOpenQuery, workspace]);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    return () => {
      for (const disposable of editorDisposablesRef.current) {
        disposable.dispose();
      }
      editorDisposablesRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!editorRef.current || !monacoRef.current || !activeEditor) {
      return;
    }

    const model = editorRef.current.getModel();
    if (!model || fileUriToPath(model.uri.toString()) !== activeEditor.path) {
      return;
    }

    if (model.getLanguageId() !== activeEditorLanguage) {
      monacoRef.current.editor.setModelLanguage(model, activeEditorLanguage);
    }
  }, [activeEditor?.path, activeEditorLanguage]);

  useEffect(() => {
    if (desktopApi) {
      setBridgeState("ready");
      return;
    }

    let checks = 0;
    const intervalId = window.setInterval(() => {
      if (window.codexCode) {
        setDesktopApi(window.codexCode);
        setBridgeState("ready");
        window.clearInterval(intervalId);
        return;
      }

      checks += 1;
      if (checks >= 20) {
        setBridgeState("missing");
        window.clearInterval(intervalId);
      }
    }, 100);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [desktopApi]);

  const appendToolMessage = (content: string, error?: string) => {
    setMessages((current) => [
      ...current,
      {
        id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: "tool",
        content,
        createdAt: new Date().toISOString(),
        error
      }
    ]);
  };

  const applyChatSnapshot = (chat: ProjectChatSnapshot) => {
    setChatSessions(chat.sessions);
    setActiveChatId(chat.activeSessionId);
    setMessages(chat.session.messages);
    setDraft(chat.session.context?.draft ?? defaultChatContext.draft);
    setActiveChatMode(chat.session.context?.mode ?? defaultChatContext.mode);
    setPendingAssistantMessage(null);
  };

  const loadDocument = async (
    filePath: string,
    workspaceRoot: string | null = project?.rootPath ?? null
  ): Promise<string | null> => {
    if (!desktopApi) {
      return null;
    }

    const loadEpoch = (documentLoadEpochsRef.current.get(filePath) ?? 0) + 1;
    documentLoadEpochsRef.current.set(filePath, loadEpoch);

    const prewarmPromise = workspaceRoot
      ? lspAdapterRef.current?.prewarmDocument(workspaceRoot, filePath).catch(() => undefined)
      : undefined;

    try {
      const content = await desktopApi.readFile(filePath);
      if (documentLoadEpochsRef.current.get(filePath) !== loadEpoch) {
        return null;
      }

      const latestDocument = documentsRef.current[filePath];
      const effectiveContent = latestDocument?.isDirty ? latestDocument.content : content;

      setDocuments((current) => ({
        ...current,
        [filePath]: {
          content: current[filePath]?.isDirty ? current[filePath].content : content,
          hasExternalConflict: current[filePath]?.isDirty
            ? current[filePath]?.hasExternalConflict ?? false
            : false,
          isDirty: current[filePath]?.isDirty ?? false,
          isMissing: false
        }
      }));
      if (workspaceRoot) {
        await prewarmPromise;
        await lspAdapterRef.current?.ensureDocumentOpen(workspaceRoot, filePath, effectiveContent);
      }
      return effectiveContent;
    } catch (error) {
      if (documentLoadEpochsRef.current.get(filePath) !== loadEpoch) {
        return null;
      }

      setDocuments((current) => ({
        ...current,
        [filePath]: {
          content: current[filePath]?.content ?? "",
          hasExternalConflict: current[filePath]?.hasExternalConflict ?? false,
          isDirty: current[filePath]?.isDirty ?? false,
          isMissing: true
        }
      }));
      appendToolMessage(
        "Failed to load a workspace file.",
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  };

  const applyWorkspaceSnapshot = async (
    nextSnapshot: WorkspaceSnapshot,
    changes: WorkspaceFileChange[] = []
  ) => {
    const previousOpenPaths = new Set(workspace?.openEditors.map((editor) => editor.path) ?? []);
    const openPaths = new Set(nextSnapshot.openEditors.map((editor) => editor.path));
    const renamedChanges = changes.filter((change) => change.kind === "renamed");
    const changedPaths = changes
      .filter((change) => change.kind === "changed")
      .map((change) => change.path);

    setWorkspace(nextSnapshot);

    if (project) {
      const removedPaths = [...previousOpenPaths].filter((filePath) => !openPaths.has(filePath));
      await Promise.all(
        removedPaths.map((filePath) => lspAdapterRef.current?.notifyDocumentClose(project.rootPath, filePath))
      );
    }

    setDocuments((current) => {
      const nextDocuments: Record<string, EditorDocument> = { ...current };

      for (const change of renamedChanges) {
        if (change.previousPath && nextDocuments[change.previousPath] && !nextDocuments[change.path]) {
          nextDocuments[change.path] = {
            ...nextDocuments[change.previousPath],
            isMissing: false
          };
          delete nextDocuments[change.previousPath];
        }
      }

      for (const filePath of Object.keys(nextDocuments)) {
        if (!openPaths.has(filePath)) {
          delete nextDocuments[filePath];
        }
      }

      for (const editor of nextSnapshot.openEditors) {
        const currentDocument = nextDocuments[editor.path];
        nextDocuments[editor.path] = {
          content: currentDocument?.content ?? "",
          hasExternalConflict: editor.hasExternalConflict ?? currentDocument?.hasExternalConflict ?? false,
          isDirty: editor.isDirty,
          isMissing: editor.isMissing ?? false
        };
      }

      for (const filePath of changedPaths) {
        if (nextDocuments[filePath]?.isDirty) {
          nextDocuments[filePath] = {
            ...nextDocuments[filePath],
            hasExternalConflict: true
          };
        }
      }

      return nextDocuments;
    });

    const loadTargets = nextSnapshot.openEditors
      .filter((editor) => {
        const currentDocument = documentsRef.current[editor.path];

        if (!currentDocument) {
          return true;
        }

        if (changedPaths.includes(editor.path) && !currentDocument.isDirty) {
          return true;
        }

        return false;
      })
      .map((editor) => editor.path);

    await Promise.all(
      [...new Set(loadTargets)].map((filePath) => loadDocument(filePath, nextSnapshot.rootPath))
    );
  };

  const syncProject = async (snapshot: Awaited<ReturnType<DesktopApi["openProject"]>>) => {
    if (!desktopApi) {
      return;
    }

    setContextReady(false);
    lspAdapterRef.current?.resetProject();
    setProject(snapshot.project);
    setSettings(snapshot.settings);
    applyChatSnapshot(snapshot.chat);
    setCodexHealth(snapshot.project.codexHealth ?? defaultCodexHealth);
    setStatus(resolveStatusFromHealth(snapshot.project.codexHealth ?? defaultCodexHealth));
    setDocuments({});
    setQuickOpenVisible(false);
    setQuickOpenQuery("");
    setQuickOpenIndex(0);
    setTerminalVisible(false);

    const savedContext = {
      openPaths: snapshot.workspaceState.openPaths,
      activePath: snapshot.workspaceState.activePath
    };

    let nextWorkspace = await desktopApi.openWorkspace(snapshot.project.rootPath);
    const restorePaths = [...new Set(savedContext.openPaths.filter(Boolean))];
    const activeRestorePath =
      savedContext.activePath && !restorePaths.includes(savedContext.activePath)
        ? savedContext.activePath
        : null;

    for (const filePath of [...restorePaths, ...(activeRestorePath ? [activeRestorePath] : [])]) {
      nextWorkspace = await desktopApi.openWorkspaceFile(snapshot.project.rootPath, filePath);
    }

    if (savedContext.activePath) {
      nextWorkspace = await desktopApi.setWorkspaceActive(
        snapshot.project.rootPath,
        savedContext.activePath
      );
    }

    if (nextWorkspace.openEditors.length === 0) {
      const firstFile = nextWorkspace.tree
        .flatMap((node) => flattenTree(node))
        .find((node) => node.type === "file");

      if (firstFile) {
        nextWorkspace = await desktopApi.openWorkspaceFile(snapshot.project.rootPath, firstFile.path);
      }
    }

    await applyWorkspaceSnapshot(nextWorkspace);
    setContextReady(true);
  };

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    return desktopApi.subscribeCodexEvents((event) => {
      startTransition(() => {
        switch (event.kind) {
          case "status":
            setStatus(event.status);
            break;
          case "token":
            setPendingAssistantMessage((current) =>
              current
                ? {
                    ...current,
                    content: current.content
                      ? `${current.content}\n\n${event.chunk}`
                      : event.chunk
                  }
                : {
                    id: `pending_assistant_${Date.now()}`,
                    content: event.chunk,
                    createdAt: new Date().toISOString()
                  }
            );
            break;
          case "message":
            setMessages((current) => [...current, event.message]);
            setPendingAssistantMessage(null);
            break;
          case "error":
            setStatus("error");
            setMessages((current) => [
              ...current,
              {
                id: `err_${Date.now()}`,
                role: "tool",
                content: event.message,
                createdAt: new Date().toISOString(),
                error: event.details
              }
            ]);
            break;
          case "approval_request":
            setStatus("waiting_approval");
            setMessages((current) => [
              ...current,
              {
                id: `approval_${Date.now()}`,
                role: "tool",
                content: `Approval requested for command:\n\n\`\`\`sh\n${event.command}\n\`\`\``,
                createdAt: new Date().toISOString()
              }
            ]);
            break;
          case "command_output":
            break;
          case "completed":
            setActiveRequestId(null);
            setPendingAssistantMessage((current) => (current?.content.trim() ? current : null));
            break;
          default:
            break;
        }
      });
    });
  }, [desktopApi]);

  useEffect(() => {
    if (!desktopApi || !project) {
      return;
    }

    return desktopApi.subscribeWorkspaceEvents((event: WorkspaceEvent) => {
      if (event.snapshot.rootPath !== project.rootPath) {
        return;
      }

      void applyWorkspaceSnapshot(event.snapshot, event.kind === "changed" ? event.changes : []);
    });
  }, [desktopApi, project]);

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    const adapter = new LspClientAdapter(desktopApi);
    adapter.subscribe();
    lspAdapterRef.current = adapter;

    return () => {
      adapter.dispose();
      if (lspAdapterRef.current === adapter) {
        lspAdapterRef.current = null;
      }
    };
  }, [desktopApi]);

  useEffect(() => {
    if (!desktopApi) {
      return;
    }

    const focusExplorer = () => {
      explorerPaneRef.current?.querySelector<HTMLButtonElement>(".tree-label")?.focus();
    };

    const focusEditor = () => {
      editorRef.current?.focus();
    };

    const focusChat = () => {
      chatInputRef.current?.focus();
    };

    const focusTerminal = () => {
      if (!project) {
        return;
      }

      setTerminalVisible(true);
      setTerminalFocusSignal((current) => current + 1);
    };

    const openQuickOpen = () => {
      if (!workspace) {
        return;
      }

      setQuickOpenVisible(true);
      setQuickOpenIndex(0);
    };

    const closeQuickOpen = () => {
      setQuickOpenVisible(false);
      setQuickOpenQuery("");
      setQuickOpenIndex(0);
    };

    const goToDefinition = async () => {
      if (!project || !activeEditor || !editorRef.current || !lspAdapterRef.current) {
        return;
      }

      const position = editorRef.current.getPosition();
      if (!position) {
        return;
      }

      await navigateToDefinitionAt(position.lineNumber, position.column);
    };

    const formatDocument = async () => {
      if (!project || !activeEditor || !activeDocument || !lspAdapterRef.current) {
        return;
      }

      const { nextText, edits } = await lspAdapterRef.current.formatDocument(
        {
          workspaceRoot: project.rootPath,
          filePath: activeEditor.path,
          tabSize: 4,
          insertSpaces: true,
          trimTrailingWhitespace: true,
          insertFinalNewline: true
        },
        activeDocument.content
      );

      if (!edits.length || nextText === activeDocument.content) {
        return;
      }

      setDocuments((current) => ({
        ...current,
        [activeEditor.path]: {
          ...current[activeEditor.path],
          content: nextText,
          isDirty: settings.autoSave ? false : true,
          hasExternalConflict: false,
          isMissing: false
        }
      }));

      lspAdapterRef.current.notifyDocumentChange(
        project.rootPath,
        activeEditor.path,
        nextText,
        0
      );

      if (settings.autoSave) {
        await desktopApi.writeFile(activeEditor.path, nextText);
        await lspAdapterRef.current.notifyDocumentSave(project.rootPath, activeEditor.path, nextText);
        const snapshot = await desktopApi.setWorkspaceDirty(project.rootPath, activeEditor.path, false);
        await applyWorkspaceSnapshot(snapshot);
      } else if (!activeDocument.isDirty) {
        const snapshot = await desktopApi.setWorkspaceDirty(project.rootPath, activeEditor.path, true);
        await applyWorkspaceSnapshot(snapshot);
      }
    };

    const showLspStatus = async () => {
      if (!project || !lspAdapterRef.current) {
        return;
      }

      const statusInfo = await lspAdapterRef.current.getStatus(project.rootPath, activeEditor?.path);
      window.alert(
        [
          `Server: ${statusInfo.server}`,
          `Language: ${statusInfo.languageId}`,
          `Status: ${statusInfo.status}`,
          `Workspace: ${statusInfo.workspaceRoot}`,
          `PID: ${statusInfo.pid ?? "n/a"}`,
          statusInfo.detail ? `Detail: ${statusInfo.detail}` : null
        ]
          .filter(Boolean)
          .join("\n")
      );
    };

    const restartLspServer = async () => {
      if (!project || !lspAdapterRef.current) {
        return;
      }

      const statusInfo = await lspAdapterRef.current.getStatus(project.rootPath, activeEditor?.path);
      if (statusInfo.languageId === "unknown") {
        return;
      }

      await lspAdapterRef.current.restartServer(project.rootPath, statusInfo.languageId);
      if (activeEditor && activeDocument) {
        await lspAdapterRef.current.ensureDocumentOpen(project.rootPath, activeEditor.path, activeDocument.content);
      }
    };

    const stopLspServer = async () => {
      if (!project || !lspAdapterRef.current) {
        return;
      }

      const statusInfo = await lspAdapterRef.current.getStatus(project.rootPath, activeEditor?.path);
      if (statusInfo.languageId === "unknown") {
        return;
      }

      await lspAdapterRef.current.stopServer(project.rootPath, statusInfo.languageId);
    };

    const executeCommand = (command: AppCommand) => {
      switch (command) {
        case "project.openFolder":
          void openProjectDialog();
          break;
        case "file.save":
          void saveFile();
          break;
        case "file.quickOpen":
          openQuickOpen();
          break;
        case "file.closeActive":
          if (activePath) {
            void closeFile(activePath);
          }
          break;
        case "pane.focusExplorer":
          focusExplorer();
          break;
        case "pane.focusEditor":
          focusEditor();
          break;
        case "pane.focusChat":
          focusChat();
          break;
        case "terminal.toggle":
          setTerminalVisible((current) => Boolean(project) && !current);
          break;
        case "pane.toggleExplorer":
          setExplorerVisible((current) => !current);
          break;
        case "pane.toggleChat":
          setChatVisible((current) => !current);
          break;
        case "terminal.focus":
          focusTerminal();
          break;
        case "lsp.goToDefinition":
          void goToDefinition();
          break;
        case "lsp.formatDocument":
          void formatDocument();
          break;
        case "lsp.restartServer":
          void restartLspServer();
          break;
        case "lsp.stopServer":
          void stopLspServer();
          break;
        case "lsp.showStatus":
          void showLspStatus();
          break;
        default:
          break;
      }
    };

    const unsubscribe = desktopApi.subscribeAppCommands(executeCommand);

    const handleKeyDown = (event: KeyboardEvent) => {
      const hasModifier = event.metaKey || event.ctrlKey;

      if (pendingChord === "openFolder" && hasModifier && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setPendingChord(null);
        executeCommand("project.openFolder");
        return;
      }

      if (pendingChord && (!hasModifier || event.key.toLowerCase() !== "o")) {
        setPendingChord(null);
      }

      if (!hasModifier) {
        return;
      }

      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPendingChord("openFolder");
        window.setTimeout(() => {
          setPendingChord((current) => (current === "openFolder" ? null : current));
        }, 1400);
        return;
      }

      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        executeCommand("file.quickOpen");
        return;
      }

      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        executeCommand("file.closeActive");
        return;
      }

      if (event.key === "`") {
        event.preventDefault();
        executeCommand("terminal.toggle");
        return;
      }

      if (event.key.toLowerCase() === "b" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        executeCommand("pane.toggleExplorer");
        return;
      }

      if (event.key.toLowerCase() === "j" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        executeCommand("pane.toggleChat");
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        executeCommand("pane.focusExplorer");
        return;
      }

      if (event.key === "1") {
        event.preventDefault();
        executeCommand("pane.focusEditor");
        return;
      }

      if (event.key === "2") {
        event.preventDefault();
        executeCommand("terminal.focus");
        return;
      }

      if (event.key === "3") {
        event.preventDefault();
        executeCommand("pane.focusChat");
        return;
      }

      if (event.key === "Enter" && document.activeElement === chatInputRef.current) {
        event.preventDefault();
        void sendChat();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      unsubscribe();
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePath, desktopApi, pendingChord, project, workspace, draft, activeEditor, activeDocument, settings, codexHealth, activeRequestId]);

  useEffect(() => {
    if (!quickOpenVisible) {
      return;
    }

    quickOpenInputRef.current?.focus();
  }, [quickOpenVisible]);

  useEffect(() => {
    setQuickOpenIndex(0);
  }, [deferredQuickOpenQuery]);

  useEffect(() => {
    if (!desktopApi || !project || !activeChatId || !contextReady) {
      return;
    }

    if (contextSaveTimerRef.current) {
      window.clearTimeout(contextSaveTimerRef.current);
    }

    contextSaveTimerRef.current = window.setTimeout(() => {
      void desktopApi.updateChatContext(project.rootPath, activeChatId, {
        draft,
        mode: activeChatMode
      });
    }, 250);

    return () => {
      if (contextSaveTimerRef.current) {
        window.clearTimeout(contextSaveTimerRef.current);
      }
    };
  }, [activeChatId, activeChatMode, contextReady, desktopApi, draft, project]);

  useEffect(() => {
    if (!desktopApi || !project || !workspace || !contextReady) {
      return;
    }

    void desktopApi.updateWorkspaceState(project.rootPath, {
      openPaths: workspace.openEditors.map((editor) => editor.path),
      activePath: workspace.selection.activePath
    });
  }, [contextReady, desktopApi, project, workspace]);

  useEffect(() => {
    if (!highlight || !editorRef.current || !monacoRef.current) {
      return;
    }

    const monaco = monacoRef.current;
    decorationIds.current = editorRef.current.deltaDecorations(decorationIds.current, [
      {
        range: new monaco.Range(highlight.startLine, 1, highlight.endLine, 1),
        options: {
          isWholeLine: true,
          className: "editor-highlight"
        }
      }
    ]);

    editorRef.current.revealLineInCenter(highlight.startLine);
  }, [activePath, highlight]);

  useEffect(() => {
    clearDefinitionDecoration();
  }, [activePath]);

  useEffect(() => {
    if (!pendingNavigationTarget || !editorRef.current || activePath !== pendingNavigationTarget.filePath) {
      return;
    }

    const model = editorRef.current.getModel();
    if (!model || fileUriToPath(model.uri.toString()) !== pendingNavigationTarget.filePath) {
      return;
    }

    editorRef.current.setPosition({
      lineNumber: pendingNavigationTarget.startLine,
      column: pendingNavigationTarget.startColumn
    });
    editorRef.current.revealPositionInCenter({
      lineNumber: pendingNavigationTarget.startLine,
      column: pendingNavigationTarget.startColumn
    });
    setHighlight({
      startLine: pendingNavigationTarget.startLine,
      endLine: pendingNavigationTarget.endLine
    });
    editorRef.current.focus();
    setPendingNavigationTarget(null);
  }, [activePath, pendingNavigationTarget]);

  const openProjectDialog = async () => {
    if (!desktopApi) {
      return;
    }

    const snapshot = await desktopApi.openProjectDialog();
    if (snapshot) {
      await syncProject(snapshot);
    }
  };

  const openFile = async (filePath: string) => {
    if (!desktopApi || !project) {
      return;
    }

    const snapshot = await desktopApi.openWorkspaceFile(project.rootPath, filePath);
    await applyWorkspaceSnapshot(snapshot);
  };

  const createChat = async () => {
    if (!desktopApi || !project || activeRequestId) {
      return;
    }

    const chat = await desktopApi.createChat(project.rootPath);
    applyChatSnapshot(chat);
  };

  const selectChat = async (chatId: string) => {
    if (!desktopApi || !project || activeRequestId || chatId === activeChatId) {
      return;
    }

    const chat = await desktopApi.setActiveChat(project.rootPath, chatId);
    applyChatSnapshot(chat);
  };

  const selectQuickOpenItem = async (item?: QuickOpenItem) => {
    if (!item) {
      return;
    }

    setQuickOpenVisible(false);
    setQuickOpenQuery("");
    setQuickOpenIndex(0);
    await openFile(item.path);
    editorRef.current?.focus();
  };

  const activateFile = async (filePath: string) => {
    if (!desktopApi || !project) {
      return;
    }

    const snapshot = await desktopApi.setWorkspaceActive(project.rootPath, filePath);
    await applyWorkspaceSnapshot(snapshot);
  };

  const closeFile = async (filePath: string) => {
    if (!desktopApi || !project) {
      return;
    }

    const snapshot = await desktopApi.closeWorkspaceFile(project.rootPath, filePath);
    await applyWorkspaceSnapshot(snapshot);
  };

  const saveFile = async () => {
    if (!desktopApi || !project || !activeEditor || !activeDocument) {
      return;
    }

    try {
      await desktopApi.writeFile(activeEditor.path, activeDocument.content);
      await lspAdapterRef.current?.notifyDocumentSave(
        project.rootPath,
        activeEditor.path,
        activeDocument.content
      );
      const snapshot = await desktopApi.setWorkspaceDirty(project.rootPath, activeEditor.path, false);
      setDocuments((current) => ({
        ...current,
        [activeEditor.path]: {
          ...current[activeEditor.path],
          hasExternalConflict: false,
          isDirty: false,
          isMissing: false
        }
      }));
      await applyWorkspaceSnapshot(snapshot);
    } catch (error) {
      appendToolMessage(
        "Failed to save the active file.",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const sendChat = async () => {
    if (!project) {
      appendToolMessage("Open a folder before sending a Codex request.");
      return;
    }

    if (!activeChatId) {
      appendToolMessage("Create or select a chat before sending a Codex request.");
      return;
    }

    if (!desktopApi) {
      appendToolMessage("Desktop bridge is not ready, so Codex cannot be reached yet.");
      return;
    }

    const prompt = draft.trim();
    if (!prompt) {
      return;
    }

    const latestHealth = await desktopApi.getCodexHealth(project.rootPath);
    setCodexHealth(latestHealth);

    if (latestHealth.state !== "ready") {
      setStatus(resolveStatusFromHealth(latestHealth));
      appendToolMessage(latestHealth.summary, latestHealth.details);
      return;
    }

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString()
    };

    setMessages((current) => [...current, userMessage]);
    setPendingAssistantMessage({
      id: `pending_assistant_${Date.now()}`,
      content: "",
      createdAt: new Date().toISOString()
    });

    try {
      const { requestId } = await desktopApi.sendChat({
        projectRoot: project.rootPath,
        chatId: activeChatId,
        prompt,
        mode: activeChatMode,
        model: normalizeRequestedModel(settings.defaultModel)
      });

      setActiveRequestId(requestId);
      setDraft("");
      setStatus("thinking");
    } catch (error) {
      setPendingAssistantMessage(null);
      setStatus("error");
      appendToolMessage(
        "Codex request failed to start.",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  const openCitation = async (citation: FileCitation) => {
    if (!project) {
      return;
    }

    const targetPath = resolveProjectPath(project.rootPath, citation.filePath);
    await openFile(targetPath);
    if (citation.startLine) {
      setHighlight({
        startLine: citation.startLine,
        endLine: citation.endLine ?? citation.startLine
      });
    }
  };

  const clearDefinitionDecoration = () => {
    if (!editorRef.current) {
      return;
    }

    definitionDecorationIdsRef.current = editorRef.current.deltaDecorations(
      definitionDecorationIdsRef.current,
      []
    );
    definitionHoverTokenRef.current = null;
  };

  const navigateToDefinitionAt = async (
    lineNumber: number,
    column: number
  ): Promise<boolean> => {
    if (!project || !activeEditor || !lspAdapterRef.current) {
      return false;
    }

    const definitions = await lspAdapterRef.current.getDefinition(project.rootPath, activeEditor.path, {
      line: lineNumber - 1,
      character: column - 1
    });
    const firstDefinition = definitions[0];

    if (!firstDefinition) {
      return false;
    }

    const target = resolveDefinitionTarget(firstDefinition);
    setPendingNavigationTarget(target);

    if (target.filePath === activeEditor.path && editorRef.current) {
      editorRef.current.setPosition({
        lineNumber: target.startLine,
        column: target.startColumn
      });
      editorRef.current.revealPositionInCenter({
        lineNumber: target.startLine,
        column: target.startColumn
      });
      setHighlight({
        startLine: target.startLine,
        endLine: target.endLine
      });
      editorRef.current.focus();
      setPendingNavigationTarget(null);
      return true;
    }

    await openFile(target.filePath);
    return true;
  };

  const editorBeforeMount: BeforeMount = (monaco) => {
    if (monacoPythonPatchedRef.current) {
      return;
    }

    monaco.languages.setLanguageConfiguration("python", monacoPythonConf);
    monaco.languages.setMonarchTokensProvider("python", patchedPythonLanguage);
    monacoPythonPatchedRef.current = true;
  };

  const editorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    lspAdapterRef.current?.bindMonaco(monaco);
    monaco.editor.defineTheme("codex-control-room", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword", foreground: "ff7ab6" },
        { token: "string", foreground: "f6c177" },
        { token: "comment", foreground: "6b7685", fontStyle: "italic" },
        { token: "entity.name.function", foreground: "7dd3fc" },
        { token: "support.function", foreground: "7dd3fc" },
        { token: "entity.name.class", foreground: "7dd3fc" },
        { token: "constant", foreground: "c4b5fd" },
        { token: "keyword.control.import", foreground: "93c5fd" },
        { token: "meta.import", foreground: "93c5fd" },
        { token: "delimiter", foreground: "90a0b7" }
      ],
      colors: {
        "editor.background": "#0b1017",
        "editor.foreground": "#d8e2ef",
        "editorLineNumber.foreground": "#4f5d6d",
        "editorLineNumber.activeForeground": "#9fb2c8",
        "editor.selectionBackground": "#264f78",
        "editor.lineHighlightBackground": "#132030",
        "editorCursor.foreground": "#4da6ff",
        "editorIndentGuide.background1": "#ffffff0e",
        "editorIndentGuide.activeBackground1": "#4da6ff40",
        "editorGutter.background": "#0b1017",
        "editor.inactiveSelectionBackground": "#20374f",
        "editorWhitespace.foreground": "#ffffff10"
      }
    });
    monaco.editor.setTheme("codex-control-room");

    const activeModel = editor.getModel();
    if (activeModel && activeEditor && fileUriToPath(activeModel.uri.toString()) === activeEditor.path) {
      monaco.editor.setModelLanguage(activeModel, activeEditorLanguage);
    }

    for (const disposable of editorDisposablesRef.current) {
      disposable.dispose();
    }
    editorDisposablesRef.current = [];

    const isNavigableTarget = (targetType: number): boolean =>
      targetType === monaco.editor.MouseTargetType.CONTENT_TEXT;

    editorDisposablesRef.current.push(
      editor.onMouseLeave(() => {
        clearDefinitionDecoration();
      }),
      editor.onMouseMove((event) => {
        if (!project || !activeEditor || !lspAdapterRef.current) {
          clearDefinitionDecoration();
          return;
        }

        if (!(event.event.metaKey || event.event.ctrlKey) || !event.target.position) {
          clearDefinitionDecoration();
          return;
        }

        if (!isNavigableTarget(event.target.type)) {
          clearDefinitionDecoration();
          return;
        }

        const word = editor.getModel()?.getWordAtPosition(event.target.position);
        if (!word) {
          clearDefinitionDecoration();
          return;
        }

        const token = `${activeEditor.path}:${event.target.position.lineNumber}:${word.startColumn}:${word.endColumn}`;
        if (definitionHoverTokenRef.current === token) {
          return;
        }

        definitionHoverTokenRef.current = token;
        definitionDecorationIdsRef.current = editor.deltaDecorations(
          definitionDecorationIdsRef.current,
          [
            {
              range: new monaco.Range(
                event.target.position.lineNumber,
                word.startColumn,
                event.target.position.lineNumber,
                word.endColumn
              ),
              options: {
                inlineClassName: "editor-definition-link"
              }
            }
          ]
        );
      }),
      editor.onMouseDown((event) => {
        if (!(event.event.metaKey || event.event.ctrlKey) || !event.target.position) {
          return;
        }

        if (!isNavigableTarget(event.target.type)) {
          return;
        }

        event.event.preventDefault();
        void navigateToDefinitionAt(event.target.position.lineNumber, event.target.position.column);
      })
    );
  };

  const handleEditorChange = (value: string | undefined) => {
    if (!desktopApi || !project || !activeEditor) {
      return;
    }

    const nextValue = value ?? "";
    const currentDocument = documentsRef.current[activeEditor.path];
    const wasDirty = currentDocument?.isDirty ?? false;

    setDocuments((current) => ({
      ...current,
      [activeEditor.path]: {
        content: nextValue,
        hasExternalConflict: false,
        isDirty: settings.autoSave ? false : true,
        isMissing: false
      }
    }));
    lspAdapterRef.current?.notifyDocumentChange(
      project.rootPath,
      activeEditor.path,
      nextValue,
      Math.min(settings.lsp.completion.debounceMs, 75)
    );

    if (settings.autoSave) {
      void desktopApi
        .writeFile(activeEditor.path, nextValue)
        .then(() =>
          lspAdapterRef.current?.notifyDocumentSave(project.rootPath, activeEditor.path, nextValue)
        )
        .catch((error) => {
          appendToolMessage("Auto-save failed.", error instanceof Error ? error.message : String(error));
        });
      return;
    }

    if (!wasDirty) {
      void desktopApi
        .setWorkspaceDirty(project.rootPath, activeEditor.path, true)
        .then((snapshot) => applyWorkspaceSnapshot(snapshot))
        .catch((error) => {
          appendToolMessage(
            "Failed to mark the file dirty.",
            error instanceof Error ? error.message : String(error)
          );
        });
    }
  };

  const handleQuickOpenKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setQuickOpenVisible(false);
      setQuickOpenQuery("");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setQuickOpenIndex((current) => Math.min(current + 1, Math.max(quickOpenItems.length - 1, 0)));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setQuickOpenIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void selectQuickOpenItem(quickOpenItems[quickOpenIndex]);
    }
  };

  const startTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    terminalResizeStateRef.current = {
      startY: event.clientY,
      startHeight: terminalHeight
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const continueTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = terminalResizeStateRef.current;
    if (!resizeState) {
      return;
    }

    const nextHeight = resizeState.startHeight + resizeState.startY - event.clientY;
    setTerminalHeight(Math.max(160, Math.min(Math.floor(window.innerHeight * 0.6), nextHeight)));
  };

  const stopTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    terminalResizeStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!desktopApi) {
    return (
      <div className="bridge-shell">
        <TopBar project={null} status="offline" />
        <div className="bridge-error">
          <div className="panel bridge-panel">
            <div className="panel-header">
              <h2>{bridgeState === "checking" ? "Loading Desktop Bridge" : "Desktop Bridge Error"}</h2>
            </div>
            <div className="panel-body bridge-body">
              {bridgeState === "checking" ? (
                <p>Connecting preload and renderer…</p>
              ) : (
                <>
                  <p>
                    Preload API was not attached to <code>window.codexCode</code>.
                  </p>
                  <p>Restart the app after rebuilding the Electron main and preload processes.</p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        project={project}
        status={status}
        explorerVisible={explorerVisible}
        chatVisible={chatVisible}
        terminalVisible={terminalVisible}
        terminalDisabled={!project}
        onToggleExplorer={() => setExplorerVisible((current) => !current)}
        onToggleChat={() => setChatVisible((current) => !current)}
        onToggleTerminal={() => project && setTerminalVisible((current) => !current)}
      />
      {quickOpenVisible ? (
        <div className="quick-open-backdrop" onClick={() => setQuickOpenVisible(false)}>
          <div className="quick-open" onClick={(event) => event.stopPropagation()}>
            <input
              ref={quickOpenInputRef}
              className="quick-open-input"
              placeholder="Type a file name"
              value={quickOpenQuery}
              onChange={(event) => setQuickOpenQuery(event.target.value)}
              onKeyDown={handleQuickOpenKeyDown}
            />
            <div className="quick-open-results">
              {quickOpenItems.length ? (
                quickOpenItems.map((item, index) => (
                  <button
                    key={item.path}
                    className={`quick-open-item ${index === quickOpenIndex ? "active" : ""}`}
                    onClick={() => void selectQuickOpenItem(item)}
                  >
                    <span className="quick-open-title">{item.title}</span>
                    <span className="quick-open-path">{item.relativePath}</span>
                  </button>
                ))
              ) : (
                <div className="quick-open-empty">No matching files</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <div
        className={`workspace-grid ${explorerVisible ? "" : "no-explorer"} ${chatVisible ? "" : "no-chat"}`}
      >
        {explorerVisible ? (
          <WorkspaceExplorerPane
            panelRef={explorerPaneRef}
            files={workspace?.tree ?? []}
            activePath={activePath}
            openPaths={workspace?.openEditors.map((editor) => editor.path) ?? []}
            onOpenFile={(filePath) => void openFile(filePath)}
          />
        ) : null}
        <main className="editor-column">
          <section className="panel editor-pane">
            <div className="tab-strip">
              <div className="tab-rail">
                {workspace?.openEditors.length ? (
                  workspace.openEditors.map((editor: WorkspaceOpenEditor) => (
                    <div
                      key={editor.path}
                      className={`tab-item ${editor.path === activePath ? "active" : ""}`}
                    >
                      <button className="tab-button" onClick={() => void activateFile(editor.path)}>
                        {editor.isDirty ? <span className="tab-dirty-indicator" aria-hidden="true" /> : null}
                        <span className="tab-label">{editor.title}</span>
                        {editor.hasExternalConflict ? (
                          <span className="tab-conflict-indicator" aria-hidden="true" />
                        ) : null}
                      </button>
                      <button className="tab-close" onClick={() => void closeFile(editor.path)}>
                        ×
                      </button>
                    </div>
                  ))
                ) : (
                  <span className="tab-empty">No file open</span>
                )}
              </div>
            </div>
            {activeBreadcrumbs.length ? (
              <div className="editor-breadcrumbs" aria-label="File breadcrumbs">
                {activeBreadcrumbs.map((segment, index) => (
                  <span
                    key={`${segment}_${index}`}
                    className={`breadcrumb-segment ${index === activeBreadcrumbs.length - 1 ? "is-current" : ""}`}
                  >
                    {index > 0 ? <span className="breadcrumb-separator">/</span> : null}
                    <span className="breadcrumb-label">{segment}</span>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="editor-surface">
              {activeEditor && activeDocument ? (
                <div className="editor-host">
                  <Editor
                    beforeMount={editorBeforeMount}
                    height="100%"
                    loading={<div className="editor-loading">Loading editor…</div>}
                    defaultLanguage={activeEditorLanguage}
                    language={activeEditorLanguage}
                    path={activeEditor.path}
                    value={activeDocument.content}
                    theme="codex-control-room"
                    options={{
                      automaticLayout: true,
                      ariaLabel: activeEditor.title,
                      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                      fontSize: 14,
                      lineHeight: 22,
                      lineNumbersMinChars: 4,
                      minimap: { enabled: false },
                      overviewRulerBorder: false,
                      padding: { top: 12 },
                      renderLineHighlight: "gutter",
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      tabSize: 4
                    }}
                    onMount={editorDidMount}
                    onChange={handleEditorChange}
                  />
                  {activeDocument.hasExternalConflict ? (
                    <div className="editor-banner">
                      This file changed on disk while you had unsaved edits. Save or reopen deliberately.
                    </div>
                  ) : null}
                  {activeDocument.isMissing ? (
                    <div className="editor-banner warning">
                      This file is missing on disk. Saving will recreate it.
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="empty-editor">
                  <h2>Open a folder, then pick a file</h2>
                  <p>The MVP is just explorer, code editor, and AI chat.</p>
                </div>
              )}
            </div>
          </section>
          {project ? (
            <>
              <div
                className={`terminal-resizer ${terminalVisible ? "is-visible" : "is-hidden"}`}
                onPointerDown={startTerminalResize}
                onPointerMove={continueTerminalResize}
                onPointerUp={stopTerminalResize}
                onPointerCancel={stopTerminalResize}
              />
              <TerminalPanel
                desktopApi={desktopApi}
                projectRoot={project.rootPath}
                visible={terminalVisible}
                height={terminalHeight}
                focusSignal={terminalFocusSignal}
                onClose={() => setTerminalVisible(false)}
              />
            </>
          ) : null}
        </main>
        {chatVisible ? (
          <SideChat
            chats={chatSessions}
            activeChatId={activeChatId}
            messages={messages}
            inFlightMessage={inFlightMessageToChatMessage(pendingAssistantMessage)}
            draft={draft}
            mode={activeChatMode}
            canSend={Boolean(project) && codexHealth.state === "ready" && !activeRequestId}
            disabledReason={resolveDisabledReason(project, codexHealth, activeRequestId)}
            textareaRef={chatInputRef}
            createDisabled={Boolean(activeRequestId)}
            onDraftChange={setDraft}
            onModeChange={setActiveChatMode}
            onCreateChat={() => void createChat()}
            onSelectChat={(chatId) => void selectChat(chatId)}
            onSend={() => void sendChat()}
            onStop={() => activeRequestId && desktopApi.cancelChat(activeRequestId)}
            isRunning={Boolean(activeRequestId)}
            onCitationClick={(citation) => void openCitation(citation)}
          />
        ) : null}
      </div>
    </div>
  );
}
