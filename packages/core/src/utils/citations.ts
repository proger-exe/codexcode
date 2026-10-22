import path from "node:path";
import { createId } from "./id";
import type { FileCitation } from "../types";

const CITATION_PATTERNS: RegExp[] = [
  /`([^`\n]+\.[a-zA-Z0-9]+)`/g,
  /\[\s*([^\]\n]+?\.[a-zA-Z0-9]+(?::\d+(?:-\d+)?)?)\s*\]/g,
  /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]+#L\d+(?:-L?\d+)?)\b/g,
  /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)\b/g,
  /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g
];

const parseLineRange = (
  lineSpec?: string
): Pick<FileCitation, "startLine" | "endLine"> => {
  if (!lineSpec) {
    return {};
  }

  if (lineSpec.startsWith("#L")) {
    const normalized = lineSpec.replace("#L", "");
    const [start, rawEnd] = normalized.split("-");
    const end = rawEnd?.replace(/^L/, "");

    return {
      startLine: Number(start),
      endLine: end ? Number(end) : Number(start)
    };
  }

  if (lineSpec.startsWith(":")) {
    const normalized = lineSpec.slice(1);
    const [start, end] = normalized.split("-");

    return {
      startLine: Number(start),
      endLine: end ? Number(end) : Number(start)
    };
  }

  return {};
};

export const extractFileCitations = (content: string, projectRoot?: string): FileCitation[] => {
  const matches = new Map<string, FileCitation>();

  for (const pattern of CITATION_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const rawValue = match[1];

      if (!rawValue || rawValue.startsWith(".")) {
        continue;
      }

      const hashIndex = rawValue.indexOf("#L");
      const colonIndex = rawValue.match(/:\d/)?.index ?? -1;
      const separatorIndex =
        hashIndex >= 0 ? hashIndex : colonIndex >= 0 ? colonIndex : rawValue.length;
      const filePath = rawValue.slice(0, separatorIndex);
      const lineSpec =
        separatorIndex < rawValue.length ? rawValue.slice(separatorIndex) : undefined;

      if (!filePath.includes("/") && !filePath.includes(".")) {
        continue;
      }

      const normalizedPath = path.normalize(filePath);
      const dedupeKey = `${normalizedPath}:${lineSpec ?? ""}`;

      if (projectRoot && path.isAbsolute(normalizedPath) && !normalizedPath.startsWith(projectRoot)) {
        continue;
      }

      if (!matches.has(dedupeKey)) {
        matches.set(dedupeKey, {
          id: createId("citation"),
          label: rawValue,
          filePath: normalizedPath,
          ...parseLineRange(lineSpec)
        });
      }
    }
  }

  return [...matches.values()];
};
