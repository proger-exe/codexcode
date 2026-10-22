import path from "node:path";
import { promises as fs } from "node:fs";
import type { LspConfig, LspServerConfig, LspServerDescriptor, LspSettings } from "../types";

const defaultConfig: LspConfig = {
  servers: {
    pyright: {
      command: "pyright-langserver",
      args: ["--stdio"],
      languages: ["python"],
      fileExtensions: [".py", ".pyi"],
      rootPatterns: ["pyproject.toml", "setup.py", "requirements.txt", ".git"]
    },
    pylsp: {
      command: "pylsp",
      args: [],
      languages: ["python"],
      fileExtensions: [".py", ".pyi"],
      rootPatterns: ["pyproject.toml", "setup.py", "requirements.txt", ".git"]
    }
  }
};

const configFile = (workspaceRoot: string): string => path.join(workspaceRoot, "lsp.config.json");

const isServerConfig = (value: unknown): value is LspServerConfig => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const config = value as Partial<LspServerConfig>;
  return (
    typeof config.command === "string" &&
    Array.isArray(config.args) &&
    Array.isArray(config.languages) &&
    Array.isArray(config.fileExtensions) &&
    Array.isArray(config.rootPatterns)
  );
};

export class LspConfigLoader {
  public async load(workspaceRoot: string): Promise<LspConfig> {
    try {
      const raw = await fs.readFile(configFile(workspaceRoot), "utf8");
      const parsed = JSON.parse(raw) as Partial<LspConfig>;
      const merged = {
        servers: {
          ...defaultConfig.servers
        }
      };

      for (const [serverId, serverConfig] of Object.entries(parsed.servers ?? {})) {
        if (isServerConfig(serverConfig)) {
          merged.servers[serverId] = this.normalizeServerConfig(serverConfig);
        }
      }

      return merged;
    } catch {
      return defaultConfig;
    }
  }

  public async resolveServer(
    workspaceRoot: string,
    settings: LspSettings,
    languageId: string
  ): Promise<LspServerDescriptor | null> {
    const config = await this.load(workspaceRoot);
    const preferredServerId = settings.defaultServers[languageId];

    const descriptor = preferredServerId
      ? config.servers[preferredServerId]
      : Object.values(config.servers).find((server) => server.languages.includes(languageId));

    if (!descriptor) {
      return null;
    }

    const serverId =
      preferredServerId ??
      Object.entries(config.servers).find(([, server]) => server === descriptor)?.[0] ??
      languageId;

    return {
      id: serverId,
      ...this.normalizeServerConfig(descriptor)
    };
  }

  public detectLanguageId(filePath: string, config: LspConfig = defaultConfig): string | null {
    const extension = path.extname(filePath).toLowerCase();

    for (const server of Object.values(config.servers)) {
      if (server.fileExtensions.includes(extension)) {
        return server.languages[0] ?? null;
      }
    }

    return null;
  }

  public validateCommand(command: string): boolean {
    return Boolean(command.trim()) && !/[\r\n\0]/.test(command);
  }

  private normalizeServerConfig(server: LspServerConfig): LspServerConfig {
    return {
      command: server.command.trim(),
      args: server.args.map((arg) => String(arg)),
      languages: server.languages.map((language) => language.trim()).filter(Boolean),
      fileExtensions: server.fileExtensions.map((extension) => extension.toLowerCase()),
      rootPatterns: server.rootPatterns.map((pattern) => pattern.trim()).filter(Boolean)
    };
  }
}
