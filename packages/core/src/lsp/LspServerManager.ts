import { EventEmitter } from "node:events";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  LspCompletionItem,
  LspCompletionList,
  LspDiagnostic,
  LspEvent,
  LspFormatRequest,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspPosition,
  LspServerDescriptor,
  LspSettings,
  LspStatus,
  ProjectSettings
} from "../types";
import { LspConfigLoader } from "./LspConfig";
import { LspLogger } from "./LspLogger";
import { LspSession } from "./LspSession";
import { fileUriToPath } from "./pathUri";
import { resolveWorkspaceRoot } from "./workspaceRootResolver";

type RestartWindow = {
  attempts: number[];
};

type SessionRuntime = {
  descriptor: LspServerDescriptor;
  restartWindow: RestartWindow;
  session: LspSession;
};

const restartWindowMs = 60_000;
const maxRestartAttempts = 3;

const statusFromDetail = (
  descriptor: LspServerDescriptor,
  languageId: string,
  workspaceRoot: string,
  detail: string
): LspStatus => ({
  languageId,
  server: descriptor.id,
  status: "error",
  workspaceRoot,
  capabilities: {
    completion: false,
    hover: false,
    definition: false,
    formatting: false,
    diagnostics: true
  },
  detail
});

const normalizeCompletion = (result: unknown): LspCompletionList => {
  if (!result) {
    return {
      items: []
    };
  }

  if (Array.isArray(result)) {
    return {
      items: result as LspCompletionItem[]
    };
  }

  return result as LspCompletionList;
};

const normalizeDefinition = (result: unknown): Array<LspLocation | LspLocationLink> => {
  if (!result) {
    return [];
  }

  return Array.isArray(result) ? (result as Array<LspLocation | LspLocationLink>) : [result as LspLocation | LspLocationLink];
};

const formatLspError = (
  descriptor: LspServerDescriptor,
  languageId: string,
  error: unknown
): string => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("ENOENT")) {
    const languageLabel = languageId.charAt(0).toUpperCase() + languageId.slice(1);
    return `${languageLabel} LSP server not found: ${descriptor.command}\nInstall it or configure another server in lsp.config.json`;
  }

  return message;
};

export class LspServerManager {
  private readonly events = new EventEmitter();

  private readonly configLoader = new LspConfigLoader();

  private readonly logger = new LspLogger();

  private readonly sessions = new Map<string, SessionRuntime>();

  private readonly diagnostics = new Map<string, LspDiagnostic[]>();

  public subscribe(listener: (event: LspEvent) => void): () => void {
    this.events.on("event", listener);
    return () => {
      this.events.removeListener("event", listener);
    };
  }

  public async openDocument(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    text: string
  ): Promise<void> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);
    if (!resolution) {
      return;
    }

    if (Buffer.byteLength(text, "utf8") > settings.lsp.maxFileSizeBytes) {
      this.events.emit("event", {
        kind: "log",
        workspaceRoot,
        languageId: resolution.languageId,
        level: "warn",
        message: `LSP disabled for large file: ${filePath}`
      } satisfies LspEvent);
      return;
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return;
    }

    try {
      await resolution.runtime.session.didOpen(filePath, text);
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
    }
  }

  public async changeDocument(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    text: string,
    version: number
  ): Promise<void> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);
    if (!resolution) {
      return;
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return;
    }

    try {
      await resolution.runtime.session.didChange(filePath, text, version);
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
    }
  }

  public async saveDocument(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    text?: string
  ): Promise<void> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);
    if (!resolution) {
      return;
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return;
    }

    try {
      await resolution.runtime.session.didSave(filePath, text);
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
    }
  }

  public async closeDocument(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string
  ): Promise<void> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath, false);
    if (!resolution) {
      return;
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return;
    }

    try {
      await resolution.runtime.session.didClose(filePath);
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
    }
  }

  public async prewarm(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string
  ): Promise<void> {
    const startedAt = performance.now();
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);

    if (!resolution || resolution.runtime.session.getStatus().status === "error") {
      return;
    }

    await this.logger.log(
      resolution.runtime.session.workspaceRoot,
      resolution.languageId,
      "debug",
      `LSP warmup ready for ${filePath} in ${Math.round(performance.now() - startedAt)}ms`
    );
  }

  public async getCompletion(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    position: LspPosition
  ): Promise<LspCompletionList> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);
    if (!resolution || !settings.lsp.completion.enabled) {
      return { items: [] };
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return { items: [] };
    }

    try {
      const startedAt = performance.now();
      const result = normalizeCompletion(await resolution.runtime.session.completion(filePath, position));
      await this.logger.log(
        resolution.runtime.session.workspaceRoot,
        resolution.languageId,
        "debug",
        `Completion for ${filePath} resolved in ${Math.round(performance.now() - startedAt)}ms`
      );
      return result;
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
      return { items: [] };
    }
  }

  public async getHover(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    position: LspPosition
  ): Promise<LspHover | null> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);
    if (!resolution) {
      return null;
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return null;
    }

    try {
      return (await resolution.runtime.session.hover(filePath, position)) as LspHover | null;
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
      return null;
    }
  }

  public async getDefinition(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    position: LspPosition
  ): Promise<Array<LspLocation | LspLocationLink>> {
    const resolution = await this.resolveSession(settings, workspaceRoot, filePath);
    if (!resolution) {
      return [];
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return [];
    }

    try {
      return normalizeDefinition(await resolution.runtime.session.definition(filePath, position));
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
      return [];
    }
  }

  public async formatDocument(
    settings: ProjectSettings,
    request: LspFormatRequest
  ) {
    const resolution = await this.resolveSession(settings, request.workspaceRoot, request.filePath);
    if (!resolution || !settings.lsp.formatting.enabled) {
      return [];
    }

    if (resolution.runtime.session.getStatus().status === "error") {
      return [];
    }

    try {
      return await resolution.runtime.session.formatDocument(request.filePath, {
        tabSize: request.tabSize,
        insertSpaces: request.insertSpaces,
        trimTrailingWhitespace: request.trimTrailingWhitespace,
        insertFinalNewline: request.insertFinalNewline
      });
    } catch (error) {
      this.emitSessionFailure(
        resolution.runtime.descriptor,
        resolution.languageId,
        resolution.runtime.session.workspaceRoot,
        error
      );
      return [];
    }
  }

  public async restartServer(
    settings: ProjectSettings,
    workspaceRoot: string,
    languageId: string
  ): Promise<LspStatus> {
    const existingKey = [...this.sessions.keys()].find((key) => key.endsWith(`::${languageId}`));
    if (existingKey) {
      const existing = this.sessions.get(existingKey)!;
      await existing.session.stop();
      this.sessions.delete(existingKey);
    }

    const descriptor = await this.configLoader.resolveServer(workspaceRoot, settings.lsp, languageId);
    if (!descriptor) {
      return statusFromDetail(
        {
          id: languageId,
          command: "",
          args: [],
          languages: [languageId],
          fileExtensions: [],
          rootPatterns: []
        },
        languageId,
        workspaceRoot,
        `No LSP server configured for ${languageId}.`
      );
    }

    const resolvedRoot = workspaceRoot;
    const runtime = await this.createRuntime(settings.lsp, resolvedRoot, languageId, descriptor);
    return runtime.session.getStatus();
  }

  public async stopServer(
    _settings: ProjectSettings,
    workspaceRoot: string,
    languageId: string
  ): Promise<void> {
    const sessionKey = [...this.sessions.keys()].find(
      (key) => key === `${workspaceRoot}::${languageId}` || key.endsWith(`::${languageId}`)
    );

    if (!sessionKey) {
      return;
    }

    const runtime = this.sessions.get(sessionKey);
    if (!runtime) {
      return;
    }

    await runtime.session.stop();
    this.sessions.delete(sessionKey);
  }

  public async stopWorkspace(workspaceRoot: string): Promise<void> {
    const matching = [...this.sessions.keys()].filter((key) => key.startsWith(`${workspaceRoot}::`));
    await Promise.all(
      matching.map(async (key) => {
        const runtime = this.sessions.get(key);
        if (!runtime) {
          return;
        }

        await runtime.session.stop();
        this.sessions.delete(key);
      })
    );
  }

  public async getStatus(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath?: string,
    languageId?: string
  ): Promise<LspStatus> {
    if (!settings.lsp.enabled) {
      return {
        languageId: languageId ?? "unknown",
        server: "disabled",
        status: "disabled",
        workspaceRoot,
        capabilities: {
          completion: false,
          hover: false,
          definition: false,
          formatting: false,
          diagnostics: false
        }
      };
    }

    const detectedLanguageId = languageId ?? (filePath ? await this.detectLanguageId(workspaceRoot, filePath) : null);

    if (!detectedLanguageId) {
      return {
        languageId: "unknown",
        server: "unconfigured",
        status: "stopped",
        workspaceRoot,
        capabilities: {
          completion: false,
          hover: false,
          definition: false,
          formatting: false,
          diagnostics: false
        },
        detail: "No LSP language configured for this file."
      };
    }

    const sessionKey = [...this.sessions.keys()].find((key) => key.endsWith(`::${detectedLanguageId}`));
    const runtime = sessionKey ? this.sessions.get(sessionKey) : null;

    if (runtime) {
      return runtime.session.getStatus();
    }

    const descriptor = await this.configLoader.resolveServer(workspaceRoot, settings.lsp, detectedLanguageId);

    if (!descriptor) {
      return {
        languageId: detectedLanguageId,
        server: "unconfigured",
        status: "error",
        workspaceRoot,
        capabilities: {
          completion: false,
          hover: false,
          definition: false,
          formatting: false,
          diagnostics: false
        },
        detail: `No LSP server configured for ${detectedLanguageId}.`
      };
    }

    return {
      languageId: detectedLanguageId,
      server: descriptor.id,
      status: "stopped",
      workspaceRoot,
      capabilities: {
        completion: false,
        hover: false,
        definition: false,
        formatting: false,
        diagnostics: true
      }
    };
  }

  public getDiagnostics(filePath: string): LspDiagnostic[] {
    return this.diagnostics.get(filePath) ?? [];
  }

  public async detectLanguageId(workspaceRoot: string, filePath: string): Promise<string | null> {
    const config = await this.configLoader.load(workspaceRoot);
    return this.configLoader.detectLanguageId(filePath, config);
  }

  private async resolveSession(
    settings: ProjectSettings,
    workspaceRoot: string,
    filePath: string,
    autoStart = true
  ): Promise<{ languageId: string; runtime: SessionRuntime } | null> {
    if (!settings.lsp.enabled) {
      return null;
    }

    const languageId = await this.detectLanguageId(workspaceRoot, filePath);
    if (!languageId) {
      return null;
    }

    const descriptor = await this.configLoader.resolveServer(workspaceRoot, settings.lsp, languageId);
    if (!descriptor) {
      this.events.emit("event", {
        kind: "status",
        status: statusFromDetail(
          {
            id: languageId,
            command: "",
            args: [],
            languages: [languageId],
            fileExtensions: [],
            rootPatterns: []
          },
          languageId,
          workspaceRoot,
          `No LSP server configured for ${languageId}.`
        )
      } satisfies LspEvent);
      return null;
    }

    if (!this.configLoader.validateCommand(descriptor.command)) {
      this.events.emit("event", {
        kind: "status",
        status: statusFromDetail(descriptor, languageId, workspaceRoot, "Invalid LSP server command.")
      } satisfies LspEvent);
      return null;
    }

    const resolvedRoot = await resolveWorkspaceRoot(workspaceRoot, filePath, descriptor.rootPatterns);
    const sessionKey = `${resolvedRoot}::${languageId}`;
    const existing = this.sessions.get(sessionKey);

    if (existing) {
      return {
        languageId,
        runtime: existing
      };
    }

    if (!autoStart) {
      return null;
    }

    const runtime = await this.createRuntime(settings.lsp, resolvedRoot, languageId, descriptor);
    return {
      languageId,
      runtime
    };
  }

  private async createRuntime(
    settings: LspSettings,
    resolvedRoot: string,
    languageId: string,
    descriptor: LspServerDescriptor
  ): Promise<SessionRuntime> {
    const runtime: SessionRuntime = {
      descriptor,
      restartWindow: {
        attempts: []
      },
      session: new LspSession(resolvedRoot, languageId, descriptor, {
        initializeTimeoutMs: 20_000,
        requestTimeoutMs: 10_000,
        traceMessages: settings.traceMessages
      })
    };

    runtime.session.on("diagnostics", (payload) => {
      const filePath = fileUriToPath(payload.uri);
      this.diagnostics.set(filePath, payload.diagnostics);
      this.events.emit("event", {
        kind: "diagnostics",
        workspaceRoot: resolvedRoot,
        filePath,
        diagnostics: payload.diagnostics
      } satisfies LspEvent);
    });

    runtime.session.on("status", (status) => {
      this.events.emit("event", {
        kind: "status",
        status
      } satisfies LspEvent);
    });

    runtime.session.on("log", async ({ level, message }) => {
      await this.logger.log(resolvedRoot, languageId, level, message);
      this.events.emit("event", {
        kind: "log",
        workspaceRoot: resolvedRoot,
        languageId,
        level,
        message
      } satisfies LspEvent);
    });

    runtime.session.on("crash", () => {
      void this.handleCrash(settings, resolvedRoot, languageId, descriptor, runtime.restartWindow);
    });

    this.sessions.set(`${resolvedRoot}::${languageId}`, runtime);

    try {
      await this.assertExecutable(descriptor.command);
      await runtime.session.start();
    } catch (error) {
      this.emitSessionFailure(descriptor, languageId, resolvedRoot, error);
    }

    return runtime;
  }

  private async handleCrash(
    settings: LspSettings,
    workspaceRoot: string,
    languageId: string,
    descriptor: LspServerDescriptor,
    restartState: RestartWindow
  ): Promise<void> {
    const now = Date.now();
    restartState.attempts = restartState.attempts.filter((attempt) => now - attempt < restartWindowMs);
    if (restartState.attempts.length >= maxRestartAttempts) {
      this.events.emit("event", {
        kind: "status",
        status: statusFromDetail(
          descriptor,
          languageId,
          workspaceRoot,
          `LSP restart limit reached for ${languageId}.`
        )
      } satisfies LspEvent);
      return;
    }

    restartState.attempts.push(now);
    const runtime = await this.createRuntime(settings, workspaceRoot, languageId, descriptor);
    runtime.restartWindow.attempts = restartState.attempts;
  }

  private async assertExecutable(command: string): Promise<void> {
    if (command.includes(path.sep)) {
      await fs.access(command, fsConstants.X_OK);
      return;
    }

    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

    for (const entry of pathEntries) {
      const candidate = path.join(entry, command);
      try {
        await fs.access(candidate, fsConstants.X_OK);
        return;
      } catch {
        // Keep searching PATH.
      }
    }

    throw new Error(`spawn ${command} ENOENT`);
  }

  private emitSessionFailure(
    descriptor: LspServerDescriptor,
    languageId: string,
    workspaceRoot: string,
    error: unknown
  ): void {
    const detail = formatLspError(descriptor, languageId, error);
    this.events.emit("event", {
      kind: "status",
      status: statusFromDetail(descriptor, languageId, workspaceRoot, detail)
    } satisfies LspEvent);
    this.events.emit("event", {
      kind: "log",
      workspaceRoot,
      languageId,
      level: "error",
      message: detail
    } satisfies LspEvent);
  }
}
