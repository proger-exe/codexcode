import { createHash } from "node:crypto";

export const toPosixPath = (value: string): string => value.replaceAll("\\", "/");

export const hashContent = (content: string): string =>
  createHash("sha256").update(content).digest("hex");
