import { createRequire } from "node:module";
import type {
  AppCommand,
  ChatMessage,
  CodexEvent,
  DiffPreview,
  ProjectSettings,
  WorkspaceEvent
} from "@codex-code/core";
import {
  ChatSessionManager,
  CodexAdapter,
  DiffManager,
  FileManager,
  ProjectManager,
  TemplateManager,
  WorkspaceManager,
  ipcChannels
} from "@codex-code/core";
import { LspServerManager } from "../../../../packages/core/src/lsp/LspServerManager";
import { TerminalManager } from "./TerminalManager";

const require = createRequire(import.meta.url);
const { BrowserWindow, dialog, ipcMain } = require("electron") as typeof import("electron");

const fileManager = new FileManager();
const chatSessionManager = new ChatSessionManager();
const codexAdapter = new CodexAdapter();
const projectManager = new ProjectManager(fileManager, chatSessionManager, codexAdapter);
const diffManager = new DiffManager(fileManager);
const templateManager = new TemplateManager(projectManager);
const workspaceManager = new WorkspaceManager();
const lspServerManager = new LspServerManager();
const terminalManager = new TerminalManager();

let registered = false;
let activeWindow: InstanceType<typeof BrowserWindow> | null = null;
let activeProjectRoot: string | null = null;

const broadcast = (payload: CodexEvent & { requestId: string }) => {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(ipcChannels.codexEvent, payload);
  }
};

const broadcastWorkspace = (payload: WorkspaceEvent) => {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(ipcChannels.workspaceEvent, payload);
  }
};

const broadcastAppCommand = (command: AppCommand) => {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(ipcChannels.appCommand, command);
  }
};

const broadcastLsp = (payload: Parameters<typeof lspServerManager.subscribe>[0] extends (event: infer Event) => void ? Event : never) => {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(ipcChannels.lspEvent, payload);
  }
};

const broadcastTerminal = (payload: Parameters<typeof terminalManager.subscribe>[0] extends (event: infer Event) => void ? Event : never) => {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(ipcChannels.terminalEvent, payload);
  }
};

const createUserMessage = (
  request: Parameters<typeof codexAdapter.run>[0]
): ChatMessage => ({
  id: `msg_${Date.now()}`,
  role: "user",
  content: request.prompt,
  createdAt: new Date().toISOString(),
  attachedFiles: request.attachedFiles,
  selectedRange: request.selection
    ? {
        filePath: request.selection.filePath,
        startLine: request.selection.startLine,
        endLine: request.selection.endLine
      }
    : undefined
});

export const registerIpcHandlers = (window: InstanceType<typeof BrowserWindow>): void => {
  activeWindow = window;

  if (registered) {
    return;
  }

  registered = true;
  workspaceManager.subscribe((event) => {
    broadcastWorkspace(event);
  });
  lspServerManager.subscribe((event) => {
    broadcastLsp(event);
  });
  terminalManager.subscribe((event) => {
    broadcastTerminal(event);
  });

  ipcMain.handle(ipcChannels.projectOpen, async (_event, rootPath: string) => {
    if (activeProjectRoot && activeProjectRoot !== rootPath) {
      await lspServerManager.stopWorkspace(activeProjectRoot);
      terminalManager.killAll();
    }
    await projectManager.ensureMetadata(rootPath);
    activeProjectRoot = rootPath;
    return projectManager.openProject(rootPath);
  });

  ipcMain.handle(ipcChannels.projectOpenDialog, async () => {
    const result = await dialog.showOpenDialog(activeWindow ?? window, {
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const rootPath = result.filePaths[0];
    if (activeProjectRoot && activeProjectRoot !== rootPath) {
      await lspServerManager.stopWorkspace(activeProjectRoot);
      terminalManager.killAll();
    }
    await projectManager.ensureMetadata(rootPath);
    activeProjectRoot = rootPath;
    return projectManager.openProject(rootPath);
  });

  ipcMain.handle(ipcChannels.projectRefresh, async (_event, rootPath: string) =>
    projectManager.refreshProject(rootPath)
  );

  ipcMain.handle(ipcChannels.projectRecent, async () => projectManager.listRecentProjects());

  ipcMain.handle(ipcChannels.fileRead, async (_event, filePath: string) =>
    fileManager.readFile(filePath)
  );
  ipcMain.handle(
    ipcChannels.fileWrite,
    async (_event, filePath: string, content: string) => {
      await fileManager.writeFile(filePath, content);
      const workspaceRoot = workspaceManager.findWorkspaceRootForPath(filePath);
      if (workspaceRoot) {
        await workspaceManager.reconcile(workspaceRoot);
      }
    }
  );
  ipcMain.handle(
    ipcChannels.fileCreate,
    async (_event, filePath: string, type: "file" | "directory") => {
      await fileManager.createEntry(filePath, type);
      const workspaceRoot = workspaceManager.findWorkspaceRootForPath(filePath);
      if (workspaceRoot) {
        await workspaceManager.reconcile(workspaceRoot);
      }
    }
  );
  ipcMain.handle(ipcChannels.fileDelete, async (_event, filePath: string) => {
    const workspaceRoot = workspaceManager.findWorkspaceRootForPath(filePath);
    await fileManager.deleteEntry(filePath);
    if (workspaceRoot) {
      await workspaceManager.reconcile(workspaceRoot);
    }
  });
  ipcMain.handle(ipcChannels.fileRename, async (_event, oldPath: string, newPath: string) => {
    const workspaceRoot = workspaceManager.findWorkspaceRootForPath(oldPath);
    await fileManager.renameEntry(oldPath, newPath);
    if (workspaceRoot) {
      await workspaceManager.reconcile(workspaceRoot, [
        {
          kind: "renamed",
          path: newPath,
          previousPath: oldPath,
          nodeType: "file"
        }
      ]);
    }
  });

  ipcMain.handle(ipcChannels.chatList, async (_event, rootPath: string) =>
    chatSessionManager.listSessions(rootPath)
  );
  ipcMain.handle(ipcChannels.chatCreate, async (_event, rootPath: string) =>
    chatSessionManager.createSession(rootPath)
  );
  ipcMain.handle(ipcChannels.chatOpen, async (_event, rootPath: string, chatId: string) =>
    chatSessionManager.getProjectChatSnapshot(rootPath, chatId)
  );
  ipcMain.handle(ipcChannels.chatSetActive, async (_event, rootPath: string, chatId: string) =>
    chatSessionManager.setActiveSession(rootPath, chatId)
  );
  ipcMain.handle(
    ipcChannels.chatContextUpdate,
    async (_event, rootPath: string, chatId: string, context) => {
      await chatSessionManager.updateContext(rootPath, chatId, context);
    }
  );

  ipcMain.handle(ipcChannels.codexHealth, async (_event, projectRoot?: string) =>
    codexAdapter.getHealth(projectRoot)
  );

  ipcMain.handle(ipcChannels.workspaceOpen, async (_event, rootPath: string) =>
    workspaceManager.open(rootPath)
  );
  ipcMain.handle(
    ipcChannels.workspaceFileOpen,
    async (_event, rootPath: string, filePath: string) => workspaceManager.openFile(rootPath, filePath)
  );
  ipcMain.handle(
    ipcChannels.workspaceFileClose,
    async (_event, rootPath: string, filePath: string) => workspaceManager.closeFile(rootPath, filePath)
  );
  ipcMain.handle(
    ipcChannels.workspaceActiveSet,
    async (_event, rootPath: string, filePath: string | null) =>
      workspaceManager.setActive(rootPath, filePath)
  );
  ipcMain.handle(
    ipcChannels.workspaceDirtySet,
    async (_event, rootPath: string, filePath: string, isDirty: boolean) =>
      workspaceManager.setDirty(rootPath, filePath, isDirty)
  );
  ipcMain.handle(ipcChannels.workspaceReconcile, async (_event, rootPath: string) =>
    workspaceManager.reconcile(rootPath)
  );
  ipcMain.handle(
    ipcChannels.workspaceStateUpdate,
    async (_event, rootPath: string, state) => projectManager.updateWorkspaceState(rootPath, state)
  );
  ipcMain.handle(ipcChannels.lspDocumentOpen, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    await lspServerManager.openDocument(settings, request.workspaceRoot, request.filePath, request.text);
  });
  ipcMain.handle(ipcChannels.lspDocumentChange, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    await lspServerManager.changeDocument(
      settings,
      request.workspaceRoot,
      request.filePath,
      request.text,
      request.version
    );
  });
  ipcMain.handle(ipcChannels.lspDocumentSave, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    await lspServerManager.saveDocument(settings, request.workspaceRoot, request.filePath, request.text);
  });
  ipcMain.handle(ipcChannels.lspDocumentClose, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    await lspServerManager.closeDocument(settings, request.workspaceRoot, request.filePath);
  });
  ipcMain.handle(ipcChannels.lspPrewarm, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    await lspServerManager.prewarm(settings, request.workspaceRoot, request.filePath);
  });
  ipcMain.handle(ipcChannels.lspCompletion, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    return lspServerManager.getCompletion(settings, request.workspaceRoot, request.filePath, request.position);
  });
  ipcMain.handle(ipcChannels.lspHover, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    return lspServerManager.getHover(settings, request.workspaceRoot, request.filePath, request.position);
  });
  ipcMain.handle(ipcChannels.lspDefinition, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    return lspServerManager.getDefinition(settings, request.workspaceRoot, request.filePath, request.position);
  });
  ipcMain.handle(ipcChannels.lspFormatDocument, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    return lspServerManager.formatDocument(settings, request);
  });
  ipcMain.handle(ipcChannels.lspRestartServer, async (_event, workspaceRoot: string, languageId: string) => {
    const settings = await projectManager.getSettings(workspaceRoot);
    return lspServerManager.restartServer(settings, workspaceRoot, languageId);
  });
  ipcMain.handle(ipcChannels.lspStopServer, async (_event, workspaceRoot: string, languageId: string) => {
    const settings = await projectManager.getSettings(workspaceRoot);
    await lspServerManager.stopServer(settings, workspaceRoot, languageId);
  });
  ipcMain.handle(ipcChannels.lspStatus, async (_event, request) => {
    const settings = await projectManager.getSettings(request.workspaceRoot);
    return lspServerManager.getStatus(settings, request.workspaceRoot, request.filePath, request.languageId);
  });

  ipcMain.handle(ipcChannels.terminalCreate, async (_event, request) =>
    terminalManager.create(request)
  );
  ipcMain.handle(ipcChannels.terminalWrite, async (_event, terminalId: string, data: string) => {
    terminalManager.write(terminalId, data);
  });
  ipcMain.handle(
    ipcChannels.terminalResize,
    async (_event, terminalId: string, cols: number, rows: number) => {
      terminalManager.resize(terminalId, cols, rows);
    }
  );
  ipcMain.handle(ipcChannels.terminalKill, async (_event, terminalId: string) => {
    terminalManager.kill(terminalId);
  });

  ipcMain.handle(ipcChannels.chatSend, async (_event, request) => {
    const userMessage = createUserMessage(request);
    await chatSessionManager.appendMessage(request.projectRoot, request.chatId, userMessage);
    const session = await chatSessionManager.getSession(request.projectRoot, request.chatId);
    const bootstrapMessages =
      session.codexSession.state === "active" && session.codexSession.id
        ? []
        : await chatSessionManager.listBootstrapMessages(request.projectRoot, request.chatId, {
            excludeMessageId: userMessage.id,
            maxMessages: 40,
            maxBytes: 60 * 1024
          });
    const run = await codexAdapter.run(request, {
      existingSessionId: session.codexSession.state === "active" ? session.codexSession.id : null,
      bootstrapMessages
    });

    run.emitter.on("event", async (event: CodexEvent) => {
      let payload = event;

      if (event.kind === "message") {
        const hydratedDiffs = await Promise.all(
          (event.message.diffs ?? []).map((diff) => diffManager.hydrateBaseHash(diff))
        );
        payload = {
          ...event,
          message: {
            ...event.message,
            diffs: hydratedDiffs
          }
        };
        await chatSessionManager.appendMessage(request.projectRoot, request.chatId, payload.message);
      }

      if (event.kind === "diff") {
        payload = {
          ...event,
          diff: await diffManager.hydrateBaseHash(event.diff)
        };
      }

      if (event.kind === "error") {
        await chatSessionManager.appendMessage(request.projectRoot, request.chatId, {
          id: `err_${Date.now()}`,
          role: "tool",
          content: event.message,
          createdAt: new Date().toISOString(),
          error: event.details
        });
      }

      if (event.kind === "completed") {
        await workspaceManager.reconcile(request.projectRoot);
      }

      broadcast({ requestId: run.requestId, ...payload });
    });

    void run.completion.then(async (completion) => {
      if (completion.sessionId && completion.sessionState === "active") {
        const now = new Date().toISOString();
        const isNewSessionId = completion.sessionId !== session.codexSession.id;
        await chatSessionManager.updateCodexSession(request.projectRoot, request.chatId, {
          id: completion.sessionId,
          state: "active",
          createdAt: isNewSessionId ? now : (session.codexSession.createdAt ?? now),
          lastUsedAt: now,
          lastBootstrappedAt: completion.recovered || isNewSessionId
            ? now
            : session.codexSession.lastBootstrappedAt
        });
        return;
      }

      if (completion.usedResume && completion.sessionState === "broken") {
        await chatSessionManager.updateCodexSession(request.projectRoot, request.chatId, {
          state: "broken",
          lastUsedAt: new Date().toISOString()
        });
      }
    });

    return { requestId: run.requestId };
  });

  ipcMain.handle(ipcChannels.chatCancel, async (_event, requestId: string) => {
    codexAdapter.cancel(requestId);
  });

  ipcMain.handle(
    ipcChannels.diffApply,
    async (_event, projectRoot: string, diff: DiffPreview) =>
      diffManager.apply(projectRoot, diff)
  );

  ipcMain.handle(ipcChannels.templateList, async () => templateManager.listTemplates());
  ipcMain.handle(ipcChannels.templateGenerate, async (_event, input) =>
    templateManager.generateProject(input)
  );

  ipcMain.handle(
    ipcChannels.settingsUpdate,
    async (_event, rootPath: string, settings: ProjectSettings) =>
      projectManager.updateSettings(rootPath, settings)
  );
};

export const emitAppCommand = (command: AppCommand): void => {
  broadcastAppCommand(command);
};

export const shutdownBackgroundServices = async (): Promise<void> => {
  terminalManager.killAll();
  if (activeProjectRoot) {
    await lspServerManager.stopWorkspace(activeProjectRoot);
    activeProjectRoot = null;
  }
};
