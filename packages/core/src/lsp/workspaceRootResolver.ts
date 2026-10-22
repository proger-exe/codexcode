import path from "node:path";
import { promises as fs } from "node:fs";

const hasMarker = async (directory: string, marker: string): Promise<boolean> => {
  try {
    await fs.access(path.join(directory, marker));
    return true;
  } catch {
    return false;
  }
};

export const resolveWorkspaceRoot = async (
  projectRoot: string,
  filePath: string,
  rootPatterns: string[]
): Promise<string> => {
  let current = path.dirname(path.resolve(filePath));
  const absoluteProjectRoot = path.resolve(projectRoot);

  while (current.startsWith(absoluteProjectRoot)) {
    for (const marker of rootPatterns) {
      if (await hasMarker(current, marker)) {
        return current;
      }
    }

    if (current === absoluteProjectRoot) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return absoluteProjectRoot;
};
