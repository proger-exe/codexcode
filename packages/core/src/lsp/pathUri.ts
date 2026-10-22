import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const pathToFileUri = (filePath: string): string => pathToFileURL(path.resolve(filePath)).toString();

export const fileUriToPath = (uri: string): string => fileURLToPath(uri);
