import path from "node:path";
import { promises as fs } from "node:fs";
import { hashContent } from "../utils/fs";
import type { DiffPreview } from "../types";

export class FileManager {
  public async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf8");
  }

  public async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  public async createEntry(filePath: string, type: "file" | "directory"): Promise<void> {
    if (type === "directory") {
      await fs.mkdir(filePath, { recursive: true });
      return;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "", { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
  }

  public async deleteEntry(filePath: string): Promise<void> {
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
      return;
    }

    await fs.unlink(filePath);
  }

  public async renameEntry(oldPath: string, newPath: string): Promise<void> {
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.rename(oldPath, newPath);
  }

  public async getLineRange(filePath: string, startLine: number, endLine: number): Promise<string> {
    const content = await this.readFile(filePath);
    return content
      .split(/\r?\n/)
      .slice(Math.max(startLine - 1, 0), endLine)
      .join("\n");
  }

  public async getFileHash(filePath: string): Promise<string> {
    const content = await this.readFile(filePath);
    return hashContent(content);
  }

  public async snapshotFile(projectRoot: string, filePath: string): Promise<string> {
    const relativePath = path.relative(projectRoot, filePath);
    const snapshotDir = path.join(projectRoot, ".codex-code", "snapshots");
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const targetPath = path.join(snapshotDir, `${timestamp}_${relativePath.replaceAll(path.sep, "__")}`);
    const content = await this.readFile(filePath);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");

    return targetPath;
  }

  public async hasFileChanged(filePath: string, diff: DiffPreview): Promise<boolean> {
    const currentHash = await this.getFileHash(filePath);
    return currentHash !== diff.baseHash;
  }
}
