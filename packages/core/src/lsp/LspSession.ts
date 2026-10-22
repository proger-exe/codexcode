import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  LspCapabilitySummary,
  LspDiagnostic,
  LspPosition,
  LspServerDescriptor,
  LspStatus,
  LspStatusState,
  LspTextEdit
} from "../types";
import { JsonRpcFramer, encodeJsonRpcMessage } from "./JsonRpcFramer";
import { pathToFileUri } from "./pathUri";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: NodeJS.Timeout;
};

type OpenDocumentState = {
  uri: string;
  version: number;
};

type PublishDiagnosticsParams = {
  uri: string;
  diagnostics: LspDiagnostic[];
};

type LspSessionEvents = {
  diagnostics: (payload: PublishDiagnosticsParams) => void;
  status: (status: LspStatus) => void;
  log: (payload: { level: "info" | "warn" | "error" | "debug"; message: string }) => void;
  crash: () => void;
};

const clientCapabilities = {
  textDocument: {
    synchronization: {
      didSave: true
    },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"]
      }
    },
    hover: {
      contentFormat: ["markdown", "plaintext"]
    },
    definition: {},
    formatting: {}
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: {}
  }
};

const emptyCapabilities = (): LspCapabilitySummary => ({
  completion: false,
  hover: false,
  definition: false,
  formatting: false,
  diagnostics: true
});

const resolveCapabilities = (capabilities: Record<string, unknown> | undefined): LspCapabilitySummary => ({
  completion: Boolean(capabilities?.completionProvider),
  hover: Boolean(capabilities?.hoverProvider),
  definition: Boolean(capabilities?.definitionProvider),
  formatting: Boolean(capabilities?.documentFormattingProvider),
  diagnostics: true,
  references: Boolean(capabilities?.referencesProvider),
  rename: Boolean(capabilities?.renameProvider),
  codeAction: Boolean(capabilities?.codeActionProvider),
  documentSymbol: Boolean(capabilities?.documentSymbolProvider),
  workspaceSymbol: Boolean(capabilities?.workspaceSymbolProvider),
  semanticTokens: Boolean(capabilities?.semanticTokensProvider)
});

export class LspSession {
  public readonly events = new EventEmitter();

  private readonly framer = new JsonRpcFramer();

  private readonly pendingRequests = new Map<number, PendingRequest>();

  private readonly openedDocuments = new Map<string, OpenDocumentState>();

  private process: ChildProcessWithoutNullStreams | null = null;

  private state: LspStatusState = "stopped";

  private nextRequestId = 1;

  private capabilities: LspCapabilitySummary = emptyCapabilities();

  private startPromise: Promise<void> | null = null;

  public constructor(
    public readonly workspaceRoot: string,
    public readonly languageId: string,
    private readonly server: LspServerDescriptor,
    private readonly options: {
      initializeTimeoutMs: number;
      requestTimeoutMs: number;
      traceMessages: boolean;
    }
  ) {}

  public getStatus(detail?: string): LspStatus {
    return {
      languageId: this.languageId,
      server: this.server.id,
      status: this.state,
      pid: this.process?.pid,
      workspaceRoot: this.workspaceRoot,
      capabilities: this.capabilities,
      detail
    };
  }

  public async start(): Promise<void> {
    if (this.state === "ready") {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {

    this.updateState("starting");

    this.process = spawn(this.server.command, this.server.args, {
      cwd: this.workspaceRoot,
      shell: false,
      stdio: "pipe"
    });

    this.process.stdout.on("data", (chunk: Buffer) => {
      try {
        const messages = this.framer.push(chunk);
        for (const message of messages) {
          this.handleMessage(message as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification);
        }
      } catch (error) {
        this.emitLog("error", error instanceof Error ? error.message : String(error));
      }
    });

    this.process.stderr.on("data", (chunk: Buffer) => {
      this.emitLog("warn", chunk.toString("utf8").trim());
    });

    this.process.once("error", (error) => {
      this.emitLog("error", error.message);
      this.failPendingRequests(error);
      this.updateState("error", error.message);
      this.events.emit("crash");
    });

    this.process.once("exit", (code, signal) => {
      const detail = `Language server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.emitLog(code === 0 ? "info" : "error", detail);
      this.failPendingRequests(new Error(detail));
      if (this.state !== "stopped") {
        this.updateState("error", detail);
        this.events.emit("crash");
      }
    });

    const initializeResult = (await this.sendRequest(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileUri(this.workspaceRoot),
        workspaceFolders: [
          {
            uri: pathToFileUri(this.workspaceRoot),
            name: path.basename(this.workspaceRoot)
          }
        ],
        capabilities: clientCapabilities
      },
      this.options.initializeTimeoutMs
    )) as {
      capabilities?: Record<string, unknown>;
    };

    this.capabilities = resolveCapabilities(initializeResult.capabilities);
    await this.sendNotification("initialized", {});
    this.updateState("ready");
  }

  public async stop(): Promise<void> {
    if (!this.process || this.state === "stopped") {
      this.updateState("stopped");
      return;
    }

    this.updateState("stopped");
    this.failPendingRequests(new Error("LSP session stopped."));
    this.process.kill();
    this.process = null;
  }

  public async didOpen(filePath: string, text: string): Promise<void> {
    await this.ensureReady();
    const uri = pathToFileUri(filePath);
    this.openedDocuments.set(filePath, { uri, version: 1 });
    await this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.languageId,
        version: 1,
        text
      }
    });
  }

  public async didChange(filePath: string, text: string, version: number): Promise<void> {
    await this.ensureReady();
    const opened = this.openedDocuments.get(filePath);
    if (!opened) {
      await this.didOpen(filePath, text);
      return;
    }

    opened.version = version;
    await this.sendNotification("textDocument/didChange", {
      textDocument: {
        uri: opened.uri,
        version
      },
      contentChanges: [{ text }]
    });
  }

  public async didSave(filePath: string, text?: string): Promise<void> {
    await this.ensureReady();
    const opened = this.openedDocuments.get(filePath);
    if (!opened) {
      return;
    }

    await this.sendNotification("textDocument/didSave", {
      textDocument: {
        uri: opened.uri
      },
      text
    });
  }

  public async didClose(filePath: string): Promise<void> {
    await this.ensureReady();
    const opened = this.openedDocuments.get(filePath);
    if (!opened) {
      return;
    }

    this.openedDocuments.delete(filePath);
    await this.sendNotification("textDocument/didClose", {
      textDocument: {
        uri: opened.uri
      }
    });
  }

  public async completion(filePath: string, position: LspPosition): Promise<unknown> {
    await this.ensureReady();
    return this.sendDocumentRequest(filePath, "textDocument/completion", {
      position
    });
  }

  public async hover(filePath: string, position: LspPosition): Promise<unknown> {
    await this.ensureReady();
    return this.sendDocumentRequest(filePath, "textDocument/hover", {
      position
    });
  }

  public async definition(filePath: string, position: LspPosition): Promise<unknown> {
    await this.ensureReady();
    return this.sendDocumentRequest(filePath, "textDocument/definition", {
      position
    });
  }

  public async formatDocument(
    filePath: string,
    options: {
      tabSize: number;
      insertSpaces: boolean;
      trimTrailingWhitespace: boolean;
      insertFinalNewline: boolean;
    }
  ): Promise<LspTextEdit[]> {
    await this.ensureReady();
    return (await this.sendDocumentRequest(filePath, "textDocument/formatting", {
      options,
      textDocument: {
        uri: this.getDocumentUri(filePath)
      }
    })) as LspTextEdit[];
  }

  public on<EventName extends keyof LspSessionEvents>(
    eventName: EventName,
    listener: LspSessionEvents[EventName]
  ): void {
    this.events.on(eventName, listener);
  }

  public removeListener<EventName extends keyof LspSessionEvents>(
    eventName: EventName,
    listener: LspSessionEvents[EventName]
  ): void {
    this.events.removeListener(eventName, listener);
  }

  private async ensureReady(): Promise<void> {
    if (this.state === "ready") {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    await this.start();
  }

  private async sendDocumentRequest(
    filePath: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return this.sendRequest(method, {
      textDocument: {
        uri: this.getDocumentUri(filePath)
      },
      ...params
    });
  }

  private getDocumentUri(filePath: string): string {
    return this.openedDocuments.get(filePath)?.uri ?? pathToFileUri(filePath);
  }

  private async sendNotification(method: string, params: unknown): Promise<void> {
    if (!this.process) {
      throw new Error("LSP process is not running.");
    }

    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params
    };
    this.trace("outgoing-notification", payload);
    this.process.stdin.write(encodeJsonRpcMessage(payload));
  }

  private async sendRequest(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs
  ): Promise<unknown> {
    if (!this.process) {
      throw new Error("LSP process is not running.");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    this.trace("outgoing-request", payload);
    this.process.stdin.write(encodeJsonRpcMessage(payload));

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout
      });
    });
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification): void {
    this.trace("incoming", message);

    if ("id" in message && "result" in message || "error" in message) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if ("id" in message && "method" in message) {
      void this.handleServerRequest(message);
      return;
    }

    if ("method" in message) {
      this.handleNotification(message);
    }
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    const result =
      message.method === "workspace/configuration"
        ? []
        : message.method === "workspace/applyEdit"
          ? { applied: false }
          : null;

    if (!this.process) {
      return;
    }

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: message.id,
      result
    };

    this.process.stdin.write(encodeJsonRpcMessage(response));
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as PublishDiagnosticsParams;
      this.events.emit("diagnostics", params);
      return;
    }

    if (message.method === "window/logMessage" || message.method === "window/showMessage") {
      const params = message.params as { message?: string };
      if (params?.message) {
        this.emitLog("info", params.message);
      }
    }
  }

  private failPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  private updateState(state: LspStatusState, detail?: string): void {
    this.state = state;
    this.events.emit("status", this.getStatus(detail));
  }

  private emitLog(level: "info" | "warn" | "error" | "debug", message: string): void {
    this.events.emit("log", { level, message });
  }

  private trace(direction: string, payload: unknown): void {
    if (!this.options.traceMessages) {
      return;
    }

    this.emitLog("debug", `${direction}: ${JSON.stringify(payload)}`);
  }
}
