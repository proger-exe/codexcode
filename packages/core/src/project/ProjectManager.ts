import path from "node:path";
import { promises as fs } from "node:fs";
import { loadIgnorePatterns, shouldIgnorePath } from "../utils/ignore";
import type {
  FileNode,
  ProjectInfo,
  ProjectSettings,
  ProjectSnapshot,
  ProjectWorkspaceState
} from "../types";
import type { ChatSessionManager } from "../chat/ChatSessionManager";
import type { FileManager } from "../files/FileManager";
import type { CodexAdapter } from "../codex/CodexAdapter";

export const defaultProjectSettings: ProjectSettings = {
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

const defaultWorkspaceState = (): ProjectWorkspaceState => ({
  openPaths: [],
  activePath: null
});

const ensureProjectDataDir = async (rootPath: string): Promise<string> => {
  const dir = path.join(rootPath, ".codex-code");
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(dir, "snapshots"), { recursive: true });
  await fs.mkdir(path.join(dir, "templates-cache"), { recursive: true });
  return dir;
};

const workspaceStateFile = (rootPath: string): string =>
  path.join(rootPath, ".codex-code", "workspace.json");

const fileNodeSorter = (left: FileNode, right: FileNode): number => {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
};

export class ProjectManager {
  private readonly recentProjects = new Set<string>();

  public constructor(
    private readonly fileManager: FileManager,
    private readonly chatSessionManager: ChatSessionManager,
    private readonly codexAdapter: CodexAdapter
  ) {}

  public async openProject(rootPath: string): Promise<ProjectSnapshot> {
    const absoluteRoot = path.resolve(rootPath);
    const [project, settings, tree, chat, workspaceState] = await Promise.all([
      this.getProjectInfo(absoluteRoot),
      this.getSettings(absoluteRoot),
      this.indexProject(absoluteRoot),
      this.chatSessionManager.getProjectChatSnapshot(absoluteRoot),
      this.getWorkspaceState(absoluteRoot)
    ]);

    this.recentProjects.add(absoluteRoot);

    return {
      project,
      settings,
      tree,
      chat,
      workspaceState
    };
  }

  public async getProjectInfo(rootPath: string): Promise<ProjectInfo> {
    const [gitStat, agentsStat, codexHealth] = await Promise.all([
      fs.stat(path.join(rootPath, ".git")).then(() => true).catch(() => false),
      fs.stat(path.join(rootPath, "AGENTS.md")).then(() => true).catch(() => false),
      this.codexAdapter.getHealth(rootPath)
    ]);

    return {
      rootPath,
      name: path.basename(rootPath),
      isGitRepo: gitStat,
      hasAgentsMd: agentsStat,
      codexAvailable: codexHealth.state === "ready",
      codexHealth,
      openedAt: new Date().toISOString()
    };
  }

  public async indexProject(rootPath: string): Promise<FileNode[]> {
    const ignorePatterns = await loadIgnorePatterns(rootPath, defaultProjectSettings.ignoredPaths);

    const walk = async (dirPath: string): Promise<FileNode[]> => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const children: FileNode[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        if (!relativePath || shouldIgnorePath(relativePath, ignorePatterns)) {
          continue;
        }

        if (entry.isDirectory()) {
          children.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: "directory",
            children: await walk(fullPath)
          });
          continue;
        }

        if (entry.isFile()) {
          children.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: "file"
          });
        }
      }

      return children.sort(fileNodeSorter);
    };

    return walk(rootPath);
  }

  public async getSettings(rootPath: string): Promise<ProjectSettings> {
    const settingsPath = path.join(await ensureProjectDataDir(rootPath), "settings.json");

    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      return this.normalizeSettings({ ...defaultProjectSettings, ...JSON.parse(raw) } as ProjectSettings);
    } catch {
      await fs.writeFile(settingsPath, JSON.stringify(defaultProjectSettings, null, 2), "utf8");
      return defaultProjectSettings;
    }
  }

  public async updateSettings(rootPath: string, settings: ProjectSettings): Promise<ProjectSettings> {
    const settingsPath = path.join(await ensureProjectDataDir(rootPath), "settings.json");
    const next = this.normalizeSettings({ ...defaultProjectSettings, ...settings });
    await fs.writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  public async refreshProject(rootPath: string): Promise<FileNode[]> {
    return this.indexProject(rootPath);
  }

  public listRecentProjects(): string[] {
    return [...this.recentProjects];
  }

  public async ensureMetadata(rootPath: string): Promise<void> {
    await ensureProjectDataDir(rootPath);
  }

  public async getWorkspaceState(rootPath: string): Promise<ProjectWorkspaceState> {
    const targetPath = workspaceStateFile(rootPath);

    try {
      const raw = await fs.readFile(targetPath, "utf8");
      return {
        ...defaultWorkspaceState(),
        ...JSON.parse(raw)
      } as ProjectWorkspaceState;
    } catch {
      const initial = defaultWorkspaceState();
      await fs.writeFile(targetPath, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }
  }

  public async updateWorkspaceState(
    rootPath: string,
    workspaceState: Partial<ProjectWorkspaceState>
  ): Promise<ProjectWorkspaceState> {
    const next = {
      ...(await this.getWorkspaceState(rootPath)),
      ...workspaceState
    };
    await fs.writeFile(workspaceStateFile(rootPath), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  private normalizeSettings(settings: ProjectSettings): ProjectSettings {
    const normalized: ProjectSettings = {
      ...defaultProjectSettings,
      ...settings,
      lsp: {
        ...defaultProjectSettings.lsp,
        ...settings.lsp,
        diagnostics: {
          ...defaultProjectSettings.lsp.diagnostics,
          ...settings.lsp?.diagnostics
        },
        completion: {
          ...defaultProjectSettings.lsp.completion,
          ...settings.lsp?.completion
        },
        formatting: {
          ...defaultProjectSettings.lsp.formatting,
          ...settings.lsp?.formatting
        }
      }
    };

    if (normalized.defaultModel === "gpt-5-codex") {
      normalized.defaultModel = "gpt-5.4";
    }

    return normalized;
  }
}
