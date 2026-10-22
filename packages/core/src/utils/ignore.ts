import path from "node:path";
import { promises as fs } from "node:fs";
import { toPosixPath } from "./fs";

const DEFAULT_IGNORES = [
  ".git",
  ".codex-code",
  "node_modules",
  ".venv",
  "dist",
  "build",
  "__pycache__",
  ".DS_Store"
];

const normalizePattern = (pattern: string): string =>
  pattern.trim().replace(/^\/+/, "").replace(/\/+$/, "");

const wildcardToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const wildcarded = escaped.replaceAll("**", "__DOUBLE_STAR__").replaceAll("*", "[^/]*");
  return new RegExp(
    `(^|/)${wildcarded.replaceAll("__DOUBLE_STAR__", ".*")}(?:$|/)`
  );
};

export const loadIgnorePatterns = async (rootPath: string, extra: string[] = []): Promise<string[]> => {
  const patterns = new Set<string>([...DEFAULT_IGNORES, ...extra]);

  for (const fileName of [".gitignore", ".codexignore"]) {
    const filePath = path.join(rootPath, fileName);

    try {
      const content = await fs.readFile(filePath, "utf8");

      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
          continue;
        }

        patterns.add(normalizePattern(trimmed));
      }
    } catch {
      continue;
    }
  }

  return [...patterns].filter(Boolean);
};

export const shouldIgnorePath = (relativePath: string, patterns: string[]): boolean => {
  const normalized = toPosixPath(relativePath);

  return patterns.some((pattern) => {
    const normalizedPattern = normalizePattern(pattern);

    if (!normalizedPattern) {
      return false;
    }

    if (!normalizedPattern.includes("*")) {
      return (
        normalized === normalizedPattern ||
        normalized.startsWith(`${normalizedPattern}/`) ||
        normalized.split("/").includes(normalizedPattern)
      );
    }

    return wildcardToRegExp(normalizedPattern).test(normalized);
  });
};
