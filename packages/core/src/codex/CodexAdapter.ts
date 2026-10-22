import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseUnifiedDiffs } from "../diff/DiffManager";
import type {
  ChatMessage,
  CodexCommandRequest,
  CodexEvent,
  CodexHealth,
  CodexStatus,
  DiffPreview
} from "../types";
import { extractFileCitations } from "../utils/citations";
import { createId } from "../utils/id";

type ActiveRun = {
  process: ChildProcessWithoutNullStreams;
  emitter: EventEmitter;
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
};

type RunOptions = {
  existingSessionId?: string | null;
  bootstrapMessages?: ChatMessage[];
};

type RunCompletion = {
  exitCode: number;
  hadAssistantMessage: boolean;
  recovered: boolean;
  sessionId: string | null;
  sessionState: "active" | "broken" | "none";
  usedResume: boolean;
};

type AttemptKind = "fresh" | "resume";

type AttemptResult = {
  exitCode: number;
  hadAssistantMessage: boolean;
  recoverableResumeFailure: boolean;
  sessionId: string | null;
};

type SessionMeta = {
  cwd?: string;
  id: string;
};

const diffFencePattern = /```diff\s+([\s\S]*?)```/g;
const sessionFilePattern = /^rollout-.*\.jsonl$/;

const statusFromRaw = (value: string): CodexStatus => {
  const normalized = value.toLowerCase();

  if (normalized.includes("approval")) {
    return "waiting_approval";
  }

  if (normalized.includes("edit")) {
    return "editing";
  }

  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }

  if (normalized.includes("think") || normalized.includes("run")) {
    return "thinking";
  }

  return "ready";
};

const createAssistantMessage = (
  projectRoot: string,
  content: string
): ChatMessage => ({
  id: createId("msg"),
  role: "assistant",
  content,
  createdAt: new Date().toISOString(),
  citations: extractFileCitations(content, projectRoot)
});

const extractDiffs = (content: string, projectRoot: string): DiffPreview[] => {
  const previews: DiffPreview[] = [];

  for (const match of content.matchAll(diffFencePattern)) {
    const diffText = match[1]?.trim();

    if (!diffText) {
      continue;
    }

    previews.push(
      ...parseUnifiedDiffs(projectRoot, diffText).map((preview) => ({
        ...preview,
        rawDiff: diffText
      }))
    );
  }

  if (previews.length === 0 && (content.includes("diff --git") || content.includes("@@"))) {
    previews.push(...parseUnifiedDiffs(projectRoot, content));
  }

  return previews;
};

const normalizeModelName = (value?: string): string | undefined => {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "gpt-5-codex") {
    return undefined;
  }

  return trimmed;
};

const shouldExtractTextForType = (type: string): boolean => {
  const normalized = type.toLowerCase();

  if (normalized.includes("error")) {
    return false;
  }

  if (normalized.includes("status") && !normalized.includes("message") && !normalized.includes("output")) {
    return false;
  }

  return true;
};

const extractTextFragments = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextFragments(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directKeys = ["delta", "text", "content", "message", "output_text"];
  const nestedKeys = ["part", "parts", "item", "items", "data", "value"];

  const direct = directKeys.flatMap((key) => extractTextFragments(record[key]));
  if (direct.length > 0) {
    return direct;
  }

  return nestedKeys.flatMap((key) => extractTextFragments(record[key]));
};

const formatCliError = (
  fallbackMessage: string,
  rawDetails: string,
  version?: string
): { message: string; details?: string; state: CodexHealth["state"] } => {
  const normalized = rawDetails.toLowerCase();
  const details = rawDetails.trim() || undefined;
  const versionLabel = version ? ` (${version})` : "";

  if (
    normalized.includes("401 unauthorized") ||
    normalized.includes("responses_websocket") ||
    normalized.includes("authentication failed")
  ) {
    return {
      state: "auth_error",
      message:
        `codex-cli${versionLabel} rejected the current session while talking to the model. ` +
        "Run `codex logout && codex login`, then try again.",
      details
    };
  }

  if (
    normalized.includes("not logged in") ||
    normalized.includes("please login") ||
    normalized.includes("run `codex login`") ||
    normalized.includes("login required")
  ) {
    return {
      state: "not_logged_in",
      message: `codex-cli${versionLabel} is not logged in. Run \`codex login\`, then try again.`,
      details
    };
  }

  if (
    normalized.includes("failed to initialize in-process app-server client") ||
    normalized.includes("read-only file system") ||
    normalized.includes("permission denied")
  ) {
    return {
      state: "runtime_error",
      message:
        `codex-cli${versionLabel} failed before the model responded. ` +
        "This looks like a local CLI runtime/bootstrap problem.",
      details
    };
  }

  if (normalized.includes("unknown model") || normalized.includes("model")) {
    return {
      state: "runtime_error",
      message:
        `codex-cli${versionLabel} rejected the configured model. ` +
        "Use the CLI default or set a model that your CLI account can access.",
      details
    };
  }

  return {
    state: "runtime_error",
    message: fallbackMessage,
    details
  };
};

const isRecoverableResumeFailure = (details: string): boolean => {
  const normalized = details.toLowerCase();

  return (
    normalized.includes("resume") &&
    (
      normalized.includes("not found") ||
      normalized.includes("no session") ||
      normalized.includes("unknown session") ||
      normalized.includes("invalid session") ||
      normalized.includes("could not find")
    )
  );
};

const formatBootstrapTranscript = (messages: ChatMessage[]): string =>
  messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content.trim()}`)
    .join("\n\n");

const extractSessionIdFromPayload = (payload: Record<string, unknown>, type: string): string | null => {
  const directCandidates = [
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
    payload.id
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      if (type.includes("session") || type.includes("thread")) {
        return candidate.trim();
      }
    }
  }

  const sessionRecord = payload.session;
  if (sessionRecord && typeof sessionRecord === "object") {
    const sessionId = (sessionRecord as Record<string, unknown>).id;
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  }

  return null;
};

export class CodexAdapter {
  private readonly runs = new Map<string, ActiveRun>();

  public async checkAvailability(): Promise<boolean> {
    const health = await this.getHealth();
    return health.state !== "missing";
  }

  public async getHealth(projectRoot?: string): Promise<CodexHealth> {
    const versionResult = await this.runCommand(["--version"], projectRoot);

    if (versionResult.spawnError || versionResult.code !== 0) {
      return {
        state: "missing",
        summary: "codex-cli is not available in PATH.",
        details: (versionResult.spawnError || versionResult.stderr || versionResult.stdout).trim() || undefined
      };
    }

    const version = versionResult.stdout.trim() || versionResult.stderr.trim() || undefined;
    const loginResult = await this.runCommand(["login", "status"], projectRoot);
    const rawStatus = `${loginResult.stdout}\n${loginResult.stderr}`.trim();

    if (loginResult.spawnError) {
      return {
        state: "runtime_error",
        summary: "codex-cli could not be started to check login status.",
        details: loginResult.spawnError,
        version
      };
    }

    if (loginResult.code !== 0) {
      const failure = formatCliError(
        "codex-cli failed to report its login status.",
        rawStatus,
        version
      );
      return {
        state: failure.state,
        summary: failure.message,
        details: failure.details,
        version
      };
    }

    if (rawStatus.toLowerCase().includes("not logged in")) {
      return {
        state: "not_logged_in",
        summary: "codex-cli is installed, but no login session was found.",
        details: rawStatus || undefined,
        version
      };
    }

    return {
      state: "ready",
      summary: "codex-cli is installed and logged in.",
      details: rawStatus || undefined,
      version
    };
  }

  public async run(
    request: CodexCommandRequest,
    options: RunOptions = {}
  ): Promise<{
    requestId: string;
    emitter: EventEmitter;
    completion: Promise<RunCompletion>;
  }> {
    const requestId = createId("run");
    const emitter = new EventEmitter();

    const completion = this.executeRun(requestId, emitter, request, options)
      .finally(() => {
        this.runs.delete(requestId);
      });

    return { requestId, emitter, completion };
  }

  public cancel(requestId: string): void {
    const activeRun = this.runs.get(requestId);

    if (!activeRun) {
      return;
    }

    activeRun.process.kill("SIGTERM");
  }

  private async executeRun(
    requestId: string,
    emitter: EventEmitter,
    request: CodexCommandRequest,
    options: RunOptions
  ): Promise<RunCompletion> {
    const initialAttemptKind: AttemptKind =
      options.existingSessionId && options.existingSessionId.trim() ? "resume" : "fresh";
    const firstAttempt = await this.executeAttempt(
      requestId,
      emitter,
      request,
      options,
      initialAttemptKind
    );

    if (!firstAttempt.recoverableResumeFailure) {
      return {
        exitCode: firstAttempt.exitCode,
        hadAssistantMessage: firstAttempt.hadAssistantMessage,
        recovered: false,
        sessionId: firstAttempt.sessionId,
        sessionState:
          firstAttempt.sessionId && firstAttempt.exitCode === 0
            ? "active"
            : initialAttemptKind === "resume"
              ? "broken"
              : "none",
        usedResume: initialAttemptKind === "resume"
      };
    }

    const recoveryAttempt = await this.executeAttempt(
      requestId,
      emitter,
      request,
      {
        ...options,
        existingSessionId: null
      },
      "fresh"
    );

    return {
      exitCode: recoveryAttempt.exitCode,
      hadAssistantMessage: recoveryAttempt.hadAssistantMessage,
      recovered: true,
      sessionId: recoveryAttempt.sessionId,
      sessionState:
        recoveryAttempt.sessionId && recoveryAttempt.exitCode === 0 ? "active" : "broken",
      usedResume: true
    };
  }

  private async executeAttempt(
    requestId: string,
    emitter: EventEmitter,
    request: CodexCommandRequest,
    options: RunOptions,
    attemptKind: AttemptKind
  ): Promise<AttemptResult> {
    const selectedModel = normalizeModelName(request.model);
    const lastMessagePath = path.join(
      request.projectRoot,
      ".codex-code",
      "runtime",
      `last-message-${requestId}.txt`
    );
    const beforeSessionFiles = attemptKind === "fresh" ? await this.listSessionFiles() : [];

    await fs.mkdir(path.dirname(lastMessagePath), { recursive: true });
    const args = [
      "exec",
      ...(attemptKind === "resume" && options.existingSessionId ? ["resume", options.existingSessionId] : []),
      "--json",
      "--skip-git-repo-check"
    ];

    if (attemptKind !== "resume") {
      args.push("--color", "never", "--sandbox", "workspace-write", "--cd", request.projectRoot);
    }

    if (selectedModel) {
      args.push("--model", selectedModel);
    }

    args.push("--output-last-message", lastMessagePath);
    args.push("-");

    const child = spawn("codex", args, {
      cwd: request.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.buildExecutionEnv()
    });

    this.runs.set(requestId, { process: child, emitter });
    child.stdin.end(this.buildPrompt(request, options.bootstrapMessages), "utf8");

    setTimeout(() => {
      emitter.emit(
        "event",
        { kind: "status", status: "thinking" satisfies CodexStatus } satisfies CodexEvent
      );
    }, 0);

    return new Promise<AttemptResult>((resolve) => {
      let assistantContent = "";
      let capturedSessionId = attemptKind === "resume" ? options.existingSessionId?.trim() ?? null : null;
      const jsonErrorMessages: string[] = [];
      let stderrOutput = "";
      let stdoutBuffer = "";
      let terminalSpawnError: Error | null = null;

      const emitEvent = (event: CodexEvent): void => {
        emitter.emit("event", event);
      };

      const handleJsonLine = (line: string): void => {
        try {
          const payload = JSON.parse(line) as Record<string, unknown>;
          const type = String(payload.type ?? payload.event ?? payload.kind ?? "message");
          const sessionId = extractSessionIdFromPayload(payload, type);

          if (!capturedSessionId && sessionId) {
            capturedSessionId = sessionId;
          }

          if (type.includes("error")) {
            jsonErrorMessages.push(String(payload.message ?? payload.error ?? "Codex command failed."));
            return;
          }

          if (type.includes("status")) {
            emitEvent({
              kind: "status",
              status: statusFromRaw(String(payload.status ?? payload.state ?? type)),
              message: String(payload.message ?? "")
            });
          }

          const rawText = shouldExtractTextForType(type) ? extractTextFragments(payload).join("") : "";

          if (rawText) {
            assistantContent += rawText;
            emitEvent({ kind: "token", chunk: rawText });
          }

          const command = payload.command;

          if (typeof command === "string") {
            emitEvent({
              kind: "approval_request",
              command,
              reason: typeof payload.reason === "string" ? payload.reason : undefined
            });
          }
        } catch {
          if (line.trim()) {
            assistantContent += `${line}\n`;
            emitEvent({ kind: "token", chunk: `${line}\n` });
          }
        }
      };

      const parseBuffer = (chunk: string): void => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          handleJsonLine(line);
        }
      };

      child.stdout.on("data", (chunk) => {
        parseBuffer(chunk.toString("utf8"));
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        stderrOutput += text;
        emitEvent({ kind: "command_output", output: text });
      });

      child.on("error", (error) => {
        terminalSpawnError = error;
      });

      child.on("close", async (code) => {
        if (stdoutBuffer.trim()) {
          handleJsonLine(stdoutBuffer);
        }

        let lastMessageContent = "";
        try {
          lastMessageContent = (await fs.readFile(lastMessagePath, "utf8")).trim();
        } catch {
          lastMessageContent = "";
        }

        try {
          await fs.unlink(lastMessagePath);
        } catch {
          // Ignore cleanup failures for temp response capture.
        }

        if (!capturedSessionId && attemptKind === "fresh") {
          capturedSessionId = await this.findFreshSessionId(request.projectRoot, beforeSessionFiles);
        }

        const normalizedAssistantContent = (lastMessageContent || assistantContent).trim();
        const rawFailureDetails = [
          stderrOutput.trim(),
          ...jsonErrorMessages,
          terminalSpawnError?.message ?? ""
        ]
          .filter(Boolean)
          .join("\n")
          .trim();
        const recoverableResumeFailure =
          attemptKind === "resume" &&
          (code ?? 1) !== 0 &&
          !normalizedAssistantContent &&
          isRecoverableResumeFailure(rawFailureDetails);

        if (terminalSpawnError && !recoverableResumeFailure) {
          emitEvent({
            kind: "error",
            message: "codex-cli could not be started. Make sure `codex` is installed and available in PATH.",
            details: terminalSpawnError.message
          });
        }

        if ((code ?? 1) !== 0 && !normalizedAssistantContent && !recoverableResumeFailure && !terminalSpawnError) {
          const failure = formatCliError(
            `codex-cli exited with code ${code ?? 1} before it returned a response.`,
            rawFailureDetails,
            undefined
          );
          emitEvent({
            kind: "error",
            message: failure.message,
            details: failure.details
          });
        }

        if (normalizedAssistantContent) {
          const message = createAssistantMessage(request.projectRoot, normalizedAssistantContent);
          const diffs = extractDiffs(message.content, request.projectRoot);

          if (diffs.length > 0) {
            message.diffs = diffs;
          }

          emitEvent({ kind: "message", message });

          for (const citation of message.citations ?? []) {
            emitEvent({ kind: "citation", citation });
          }

          for (const diff of diffs) {
            emitEvent({ kind: "diff", diff });
          }
        }

        if (!recoverableResumeFailure) {
          emitEvent({ kind: "status", status: (code ?? 1) === 0 ? "ready" : "error" });
          emitEvent({ kind: "completed", exitCode: code ?? 1 });
        }

        resolve({
          exitCode: code ?? 1,
          hadAssistantMessage: Boolean(normalizedAssistantContent),
          recoverableResumeFailure,
          sessionId: capturedSessionId
        });
      });
    });
  }

  private buildPrompt(request: CodexCommandRequest, bootstrapMessages?: ChatMessage[]): string {
    const parts = [
      `You are running inside codex-code in ${request.mode} mode.`,
      request.mode === "plan"
        ? [
            "Plan mode rules:",
            "- Analyze and plan only.",
            "- Do not edit files.",
            "- Do not produce diffs or patches as the result.",
            "- Do not carry out command-driven implementation work.",
            "- Return a concrete implementation plan with goal, steps, risks, testing, and assumptions."
          ].join("\n")
        : [
            "Agent mode rules:",
            "- You may behave like a normal implementation-oriented coding agent.",
            "- Prefer concrete, actionable output over vague advice."
          ].join("\n")
    ];

    if (bootstrapMessages?.length) {
      parts.push("This is a continuation of an existing codex-code chat.");
      parts.push("Recent chat history:");
      parts.push(formatBootstrapTranscript(bootstrapMessages));
    }

    if (request.selection) {
      parts.push(`File: ${request.selection.filePath}`);
      parts.push(`Range: L${request.selection.startLine}-L${request.selection.endLine}`);
      parts.push("Selected code:");
      parts.push(request.selection.selectedText);
    }

    if (request.attachedFiles && request.attachedFiles.length > 0) {
      parts.push(`Attached files: ${request.attachedFiles.join(", ")}`);
    }

    parts.push("Task:");
    parts.push(request.prompt);

    return parts.join("\n\n");
  }

  private buildExecutionEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  private async findFreshSessionId(
    projectRoot: string,
    beforeSessionFiles: string[]
  ): Promise<string | null> {
    const currentSessionFiles = await this.listSessionFiles();
    const previous = new Set(beforeSessionFiles);
    const newFiles = currentSessionFiles.filter((filePath) => !previous.has(filePath));

    for (const filePath of newFiles.reverse()) {
      const meta = await this.readSessionMeta(filePath);
      if (meta?.cwd === projectRoot) {
        return meta.id;
      }
    }

    return null;
  }

  private async listSessionFiles(): Promise<string[]> {
    const rootPath = path.join(homedir(), ".codex", "sessions");
    const sessionFiles: string[] = [];

    const walk = async (directoryPath: string): Promise<void> => {
      let entries: Array<import("node:fs").Dirent<string>>;

      try {
        entries = await fs.readdir(directoryPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }

        if (entry.isFile() && sessionFilePattern.test(entry.name)) {
          sessionFiles.push(entryPath);
        }
      }
    };

    await walk(rootPath);
    sessionFiles.sort();
    return sessionFiles;
  }

  private async readSessionMeta(filePath: string): Promise<SessionMeta | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const firstLine = raw.split(/\r?\n/, 1)[0];
      if (!firstLine.trim()) {
        return null;
      }

      const parsed = JSON.parse(firstLine) as {
        payload?: {
          cwd?: string;
          id?: string;
        };
        type?: string;
      };

      if (parsed.type !== "session_meta" || !parsed.payload?.id) {
        return null;
      }

      return {
        cwd: parsed.payload.cwd,
        id: parsed.payload.id
      };
    } catch {
      return null;
    }
  }

  private runCommand(args: string[], cwd?: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn("codex", args, {
        cwd,
        env: this.buildExecutionEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let spawnError: string | undefined;

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        spawnError = error.message;
      });

      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
          spawnError
        });
      });
    });
  }
}
