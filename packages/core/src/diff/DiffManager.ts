import path from "node:path";
import { createId } from "../utils/id";
import { hashContent } from "../utils/fs";
import type { DiffApplyResult, DiffHunk, DiffLine, DiffPreview } from "../types";
import type { FileManager } from "../files/FileManager";

const DIFF_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const normalizeDiffPath = (rawPath: string): string =>
  rawPath.replace(/^a\//, "").replace(/^b\//, "").trim();

export const parseUnifiedDiffs = (projectRoot: string, rawDiff: string): DiffPreview[] => {
  const lines = rawDiff.split(/\r?\n/);
  const previews: DiffPreview[] = [];

  let currentFile: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (!currentFile || currentLines.length === 0) {
      currentFile = null;
      currentLines = [];
      return;
    }

    const hunks: DiffHunk[] = [];
    let activeHunk: DiffHunk | null = null;

    for (const line of currentLines) {
      const hunkMatch = line.match(DIFF_HEADER);

      if (hunkMatch) {
        activeHunk = {
          header: line,
          oldStart: Number(hunkMatch[1]),
          oldLines: Number(hunkMatch[2] ?? "1"),
          newStart: Number(hunkMatch[3]),
          newLines: Number(hunkMatch[4] ?? "1"),
          lines: []
        };
        hunks.push(activeHunk);
        continue;
      }

      if (!activeHunk) {
        continue;
      }

      const kind: DiffLine["kind"] =
        line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context";
      activeHunk.lines.push({
        kind,
        value: line.slice(1)
      });
    }

    previews.push({
      id: createId("diff"),
      filePath: path.join(projectRoot, currentFile),
      baseHash: "",
      rawDiff,
      hunks,
      createdAt: new Date().toISOString()
    });

    currentFile = null;
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      flush();
      currentFile = normalizeDiffPath(line.slice(4));
      continue;
    }

    if (currentFile) {
      currentLines.push(line);
    }
  }

  flush();

  return previews;
};

const applyHunksToContent = (content: string, hunks: DiffHunk[]): string => {
  const sourceLines = content.split(/\r?\n/);
  const result: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const targetIndex = Math.max(hunk.oldStart - 1, 0);

    while (sourceIndex < targetIndex) {
      result.push(sourceLines[sourceIndex] ?? "");
      sourceIndex += 1;
    }

    for (const line of hunk.lines) {
      if (line.kind === "context") {
        result.push(sourceLines[sourceIndex] ?? line.value);
        sourceIndex += 1;
        continue;
      }

      if (line.kind === "remove") {
        sourceIndex += 1;
        continue;
      }

      result.push(line.value);
    }
  }

  while (sourceIndex < sourceLines.length) {
    result.push(sourceLines[sourceIndex] ?? "");
    sourceIndex += 1;
  }

  return result.join("\n");
};

export class DiffManager {
  public constructor(private readonly fileManager: FileManager) {}

  public async hydrateBaseHash(diff: DiffPreview): Promise<DiffPreview> {
    const content = await this.fileManager.readFile(diff.filePath).catch(() => "");

    return {
      ...diff,
      baseHash: hashContent(content)
    };
  }

  public async apply(projectRoot: string, diff: DiffPreview): Promise<DiffApplyResult> {
    const currentContent = await this.fileManager.readFile(diff.filePath).catch(() => "");
    const currentHash = hashContent(currentContent);

    if (diff.baseHash && currentHash !== diff.baseHash) {
      return {
        applied: false,
        filePath: diff.filePath,
        reason: "The file changed after the diff was generated."
      };
    }

    const snapshotPath = await this.fileManager.snapshotFile(projectRoot, diff.filePath).catch(() => undefined);
    const nextContent = applyHunksToContent(currentContent, diff.hunks);
    await this.fileManager.writeFile(diff.filePath, nextContent);

    return {
      applied: true,
      filePath: diff.filePath,
      snapshotPath
    };
  }
}
