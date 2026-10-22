import path from "node:path";
import { promises as fs } from "node:fs";
import { createId } from "../utils/id";
import type {
  ChatMessage,
  ChatSessionCodexState,
  ChatSession,
  ChatSessionContext,
  ChatSessionSummary,
  ProjectChatIndex,
  ProjectChatSnapshot
} from "../types";

const sessionsDir = (projectRoot: string): string =>
  path.join(projectRoot, ".codex-code", "sessions");

const legacySessionFile = (projectRoot: string): string =>
  path.join(sessionsDir(projectRoot), "default.json");

const indexFile = (projectRoot: string): string =>
  path.join(sessionsDir(projectRoot), "index.json");

const sessionFile = (projectRoot: string, chatId: string): string =>
  path.join(sessionsDir(projectRoot), `${chatId}.json`);

const defaultContext = (): ChatSessionContext => ({
  draft: "",
  mode: "agent"
});

const defaultCodexSession = (): ChatSessionCodexState => ({
  id: null,
  state: "none"
});

const findJsonDocumentEnd = (raw: string): number | null => {
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (!started) {
      if (/\s/.test(char)) {
        continue;
      }

      if (char !== "{" && char !== "[") {
        return null;
      }

      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
};

const parseJsonWithRecovery = <T>(raw: string): { parsed: T; recovered: boolean } => {
  try {
    return {
      parsed: JSON.parse(raw) as T,
      recovered: false
    };
  } catch (error) {
    const documentEnd = findJsonDocumentEnd(raw);

    if (documentEnd === null) {
      throw error;
    }

    const prefix = raw.slice(0, documentEnd);
    const suffix = raw.slice(documentEnd);

    if (!suffix.trim()) {
      throw error;
    }

    return {
      parsed: JSON.parse(prefix) as T,
      recovered: true
    };
  }
};

const normalizeSession = (
  projectRoot: string,
  parsed: Partial<ChatSession>,
  sessionId?: string
): ChatSession => ({
  id: parsed.id ?? sessionId ?? createId("session"),
  projectRoot,
  createdAt: parsed.createdAt ?? new Date().toISOString(),
  updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  context: {
    ...defaultContext(),
    ...parsed.context
  },
  codexSession: {
    ...defaultCodexSession(),
    ...parsed.codexSession
  },
  messages: parsed.messages ?? []
});

const defaultSummary = (session: ChatSession): ChatSessionSummary => ({
  id: session.id,
  title: "New Chat",
  createdAt: session.createdAt,
  updatedAt: session.updatedAt
});

const deriveTitleFromMessage = (message: ChatMessage): string => {
  const normalized = message.content.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "New Chat";
  }

  return normalized.slice(0, 48).trim() || "New Chat";
};

const sortByUpdatedAt = (sessions: ChatSessionSummary[]): ChatSessionSummary[] =>
  [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export class ChatSessionManager {
  private readonly pendingWrites = new Map<string, Promise<void>>();

  public async getSession(projectRoot: string, chatId: string): Promise<ChatSession> {
    await this.ensureMigrated(projectRoot);
    return this.readSession(projectRoot, chatId);
  }

  public async listSessions(projectRoot: string): Promise<ChatSessionSummary[]> {
    await this.ensureMigrated(projectRoot);
    const index = await this.readIndex(projectRoot);
    return index.sessions;
  }

  public async getProjectChatSnapshot(
    projectRoot: string,
    sessionId?: string
  ): Promise<ProjectChatSnapshot> {
    await this.ensureMigrated(projectRoot);
    const index = await this.readIndex(projectRoot);
    const targetSessionId = sessionId ?? index.activeSessionId ?? index.sessions[0]?.id;

    if (!targetSessionId) {
      const created = await this.createSession(projectRoot);
      return created;
    }

    const session = await this.readSession(projectRoot, targetSessionId);

    return {
      activeSessionId: index.activeSessionId,
      session,
      sessions: index.sessions
    };
  }

  public async createSession(projectRoot: string): Promise<ProjectChatSnapshot> {
    await this.ensureMigrated(projectRoot);
    const index = await this.readIndex(projectRoot);
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: createId("session"),
      projectRoot,
      createdAt: now,
      updatedAt: now,
      context: defaultContext(),
      codexSession: defaultCodexSession(),
      messages: []
    };
    const summary = defaultSummary(session);
    const nextIndex: ProjectChatIndex = {
      activeSessionId: session.id,
      sessions: [summary, ...index.sessions]
    };

    await Promise.all([
      this.persistSession(session),
      this.persistIndex(projectRoot, {
        activeSessionId: nextIndex.activeSessionId,
        sessions: sortByUpdatedAt(nextIndex.sessions)
      })
    ]);

    return {
      activeSessionId: session.id,
      session,
      sessions: sortByUpdatedAt(nextIndex.sessions)
    };
  }

  public async setActiveSession(
    projectRoot: string,
    sessionId: string
  ): Promise<ProjectChatSnapshot> {
    await this.ensureMigrated(projectRoot);
    const index = await this.readIndex(projectRoot);
    const nextIndex: ProjectChatIndex = {
      ...index,
      activeSessionId: sessionId
    };

    await this.persistIndex(projectRoot, nextIndex);
    const session = await this.readSession(projectRoot, sessionId);

    return {
      activeSessionId: sessionId,
      session,
      sessions: nextIndex.sessions
    };
  }

  public async appendMessage(
    projectRoot: string,
    chatId: string,
    message: ChatMessage
  ): Promise<ProjectChatSnapshot> {
    await this.ensureMigrated(projectRoot);
    const session = await this.readSession(projectRoot, chatId);
    const nextSession: ChatSession = {
      ...session,
      updatedAt: new Date().toISOString(),
      messages: [...session.messages, message]
    };

    const index = await this.readIndex(projectRoot);
    const nextSummary = this.updateSummary(defaultSummary(nextSession), index.sessions, nextSession, message);
    const nextIndex: ProjectChatIndex = {
      activeSessionId: index.activeSessionId === chatId ? chatId : index.activeSessionId,
      sessions: sortByUpdatedAt(nextSummary)
    };

    await Promise.all([
      this.persistSession(nextSession),
      this.persistIndex(projectRoot, nextIndex)
    ]);

    return {
      activeSessionId: nextIndex.activeSessionId,
      session: nextSession,
      sessions: nextIndex.sessions
    };
  }

  public async updateContext(
    projectRoot: string,
    chatId: string,
    context: Partial<ChatSessionContext>
  ): Promise<ProjectChatSnapshot> {
    await this.ensureMigrated(projectRoot);
    const session = await this.readSession(projectRoot, chatId);
    const nextSession: ChatSession = {
      ...session,
      updatedAt: session.updatedAt,
      context: {
        ...defaultContext(),
        ...session.context,
        ...context
      }
    };

    await this.persistSession(nextSession);
    const index = await this.readIndex(projectRoot);

    return {
      activeSessionId: index.activeSessionId,
      session: nextSession,
      sessions: index.sessions
    };
  }

  public async updateCodexSession(
    projectRoot: string,
    chatId: string,
    codexSession: Partial<ChatSessionCodexState>
  ): Promise<ProjectChatSnapshot> {
    await this.ensureMigrated(projectRoot);
    const session = await this.readSession(projectRoot, chatId);
    const nextSession: ChatSession = {
      ...session,
      updatedAt: new Date().toISOString(),
      codexSession: {
        ...defaultCodexSession(),
        ...session.codexSession,
        ...codexSession
      }
    };

    const index = await this.readIndex(projectRoot);
    const nextSummary = this.updateSummary(defaultSummary(nextSession), index.sessions, nextSession);
    const nextIndex: ProjectChatIndex = {
      activeSessionId: index.activeSessionId,
      sessions: sortByUpdatedAt(nextSummary)
    };

    await Promise.all([
      this.persistSession(nextSession),
      this.persistIndex(projectRoot, nextIndex)
    ]);

    return {
      activeSessionId: nextIndex.activeSessionId,
      session: nextSession,
      sessions: nextIndex.sessions
    };
  }

  public async listBootstrapMessages(
    projectRoot: string,
    chatId: string,
    options?: {
      excludeMessageId?: string;
      maxMessages?: number;
      maxBytes?: number;
    }
  ): Promise<ChatMessage[]> {
    await this.ensureMigrated(projectRoot);
    const session = await this.readSession(projectRoot, chatId);
    const maxMessages = options?.maxMessages ?? 40;
    const maxBytes = options?.maxBytes ?? 60 * 1024;
    const relevantMessages = session.messages.filter((message) => {
      if (message.id === options?.excludeMessageId) {
        return false;
      }

      return message.role === "user" || message.role === "assistant";
    });

    const selected: ChatMessage[] = [];
    let totalBytes = 0;

    for (let index = relevantMessages.length - 1; index >= 0; index -= 1) {
      const message = relevantMessages[index];
      const messageBytes = Buffer.byteLength(`${message.role}:${message.content}`, "utf8");

      if (selected.length >= maxMessages) {
        break;
      }

      if (selected.length > 0 && totalBytes + messageBytes > maxBytes) {
        break;
      }

      if (selected.length === 0 && messageBytes > maxBytes) {
        selected.unshift(message);
        break;
      }

      selected.unshift(message);
      totalBytes += messageBytes;
    }

    return selected;
  }

  private async ensureMigrated(projectRoot: string): Promise<void> {
    await fs.mkdir(sessionsDir(projectRoot), { recursive: true });

    try {
      await fs.access(indexFile(projectRoot));
      return;
    } catch {
      // Continue with migration/bootstrap.
    }

    try {
      const raw = await fs.readFile(legacySessionFile(projectRoot), "utf8");
      const { parsed } = parseJsonWithRecovery<Partial<ChatSession>>(raw);
      const legacy = normalizeSession(projectRoot, parsed, "default");
      const session = {
        ...legacy,
        id: legacy.id || createId("session")
      };
      const summary: ChatSessionSummary = {
        ...defaultSummary(session),
        title: this.resolveTitle(session, undefined)
      };
      const nextIndex: ProjectChatIndex = {
        activeSessionId: session.id,
        sessions: [summary]
      };

      await Promise.all([
        this.persistSession(session),
        this.persistIndex(projectRoot, nextIndex)
      ]);
      return;
    } catch {
      const now = new Date().toISOString();
      const session: ChatSession = {
        id: createId("session"),
        projectRoot,
        createdAt: now,
        updatedAt: now,
        context: defaultContext(),
        codexSession: defaultCodexSession(),
        messages: []
      };
      const nextIndex: ProjectChatIndex = {
        activeSessionId: session.id,
        sessions: [defaultSummary(session)]
      };

      await Promise.all([
        this.persistSession(session),
        this.persistIndex(projectRoot, nextIndex)
      ]);
    }
  }

  private async readIndex(projectRoot: string): Promise<ProjectChatIndex> {
    const raw = await fs.readFile(indexFile(projectRoot), "utf8");
    const { parsed, recovered } = parseJsonWithRecovery<Partial<ProjectChatIndex>>(raw);
    const sessions = sortByUpdatedAt(parsed.sessions ?? []);
    const index = {
      activeSessionId: parsed.activeSessionId ?? sessions[0]?.id ?? "",
      sessions
    };

    if (recovered) {
      await this.persistIndex(projectRoot, index);
    }

    return index;
  }

  private async readSession(projectRoot: string, chatId: string): Promise<ChatSession> {
    const raw = await fs.readFile(sessionFile(projectRoot, chatId), "utf8");
    const { parsed, recovered } = parseJsonWithRecovery<Partial<ChatSession>>(raw);
    const session = normalizeSession(projectRoot, parsed, chatId);

    if (recovered) {
      // Rewrite the recovered session immediately so future reads see clean JSON.
      await this.persistSession(session);
    }

    return session;
  }

  private async persistSession(session: ChatSession): Promise<void> {
    await this.persistJsonFile(sessionFile(session.projectRoot, session.id), session);
  }

  private async persistIndex(projectRoot: string, index: ProjectChatIndex): Promise<void> {
    await this.persistJsonFile(indexFile(projectRoot), index);
  }

  private async persistJsonFile(filePath: string, value: unknown): Promise<void> {
    const write = (this.pendingWrites.get(filePath) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
          .toString(16)
          .slice(2)}.tmp`;

        try {
          await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
          await fs.rename(tempPath, filePath);
        } finally {
          await fs.unlink(tempPath).catch(() => undefined);
        }
      });

    this.pendingWrites.set(filePath, write);

    try {
      await write;
    } finally {
      if (this.pendingWrites.get(filePath) === write) {
        this.pendingWrites.delete(filePath);
      }
    }
  }

  private updateSummary(
    fallbackSummary: ChatSessionSummary,
    summaries: ChatSessionSummary[],
    session: ChatSession,
    message?: ChatMessage
  ): ChatSessionSummary[] {
    const existing = summaries.find((entry) => entry.id === session.id) ?? fallbackSummary;
    const title =
      existing.title === "New Chat" && message?.role === "user"
        ? deriveTitleFromMessage(message)
        : existing.title || this.resolveTitle(session, message);

    const nextSummary: ChatSessionSummary = {
      id: session.id,
      title,
      createdAt: existing.createdAt ?? session.createdAt,
      updatedAt: session.updatedAt
    };

    return [
      nextSummary,
      ...summaries.filter((entry) => entry.id !== session.id)
    ];
  }

  private resolveTitle(session: ChatSession, message?: ChatMessage): string {
    const firstUserMessage =
      message?.role === "user"
        ? message
        : session.messages.find((entry) => entry.role === "user");

    return firstUserMessage ? deriveTitleFromMessage(firstUserMessage) : "New Chat";
  }
}
