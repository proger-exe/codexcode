import path from "node:path";
import { promises as fs } from "node:fs";

export class LspLogger {
  public async log(
    workspaceRoot: string,
    languageId: string,
    level: "info" | "warn" | "error" | "debug",
    message: string
  ): Promise<void> {
    const logDir = path.join(workspaceRoot, ".codex-code", "logs");
    const logPath = path.join(logDir, "lsp.log");
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(
      logPath,
      `[${new Date().toISOString()}] [${languageId}] [${level.toUpperCase()}] ${message}\n`,
      "utf8"
    );
  }
}
