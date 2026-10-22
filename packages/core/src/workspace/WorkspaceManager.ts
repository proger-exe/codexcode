import path from "node:path";
import { EventEmitter } from "node:events";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { loadIgnorePatterns, shouldIgnorePath } from "../utils/ignore";
import type {
  FileNode,
  WorkspaceEvent,
  WorkspaceFileChange,
  WorkspaceOpenEditor,
  WorkspaceSnapshot
} from "../types";

type RawWatchEvent = {
  eventType: string;
  relativePath: string;
};

type WorkspaceRuntime = {
  pendingEvents: RawWatchEvent[];
  reconcileTimer: NodeJS.Timeout | null;
  snapshot: WorkspaceSnapshot;
  watcher: FSWatcher | null;
};

const defaultIgnoredPaths = [".git", ".codex-code", "node_modules", ".venv", "dist", "build"];

const sortNodes = (left: FileNode, right: FileNode): number => {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
};

const flattenTree = (nodes: FileNode[]): FileNode[] =>
  nodes.flatMap((node) => (node.children?.length ? [node, ...flattenTree(node.children)] : [node]));

const mapFileNodes = (nodes: FileNode[]): Map<string, FileNode> =>
  new Map(flattenTree(nodes).map((node) => [node.path, node]));

const isFileNode = (node: FileNode | undefined): boolean => node?.type === "file";

export class WorkspaceManager {
  private readonly emitter = new EventEmitter();

  private readonly workspaces = new Map<string, WorkspaceRuntime>();

  public subscribe(listener: (event: WorkspaceEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.removeListener("event", listener);
    };
  }

  public async open(rootPath: string): Promise<WorkspaceSnapshot> {
    const absoluteRoot = path.resolve(rootPath);
    const existing = this.workspaces.get(absoluteRoot);
    const snapshot = await this.buildSnapshot(
      absoluteRoot,
      existing?.snapshot.openEditors ?? [],
      existing?.snapshot.selection.activePath ?? null
    );

    const runtime: WorkspaceRuntime = existing ?? {
      pendingEvents: [],
      reconcileTimer: null,
      snapshot,
      watcher: null
    };

    runtime.snapshot = snapshot;
    this.workspaces.set(absoluteRoot, runtime);
    this.ensureWatcher(absoluteRoot, runtime);
    this.emit({ kind: "snapshot", snapshot });
    return snapshot;
  }

  public async openFile(rootPath: string, filePath: string): Promise<WorkspaceSnapshot> {
    const runtime = await this.ensureWorkspace(rootPath);
    const resolvedPath = await this.resolveWorkspaceFilePath(rootPath, filePath, runtime.snapshot.tree);

    if (!resolvedPath) {
      throw new Error(`Workspace file not found: ${filePath}`);
    }

    const nextEditors = [...runtime.snapshot.openEditors];
    const existingIndex = nextEditors.findIndex((editor) => editor.path === resolvedPath);

    if (existingIndex === -1) {
      nextEditors.push({
        path: resolvedPath,
        title: path.basename(resolvedPath),
        isDirty: false
      });
    }

    const snapshot = await this.buildSnapshot(rootPath, nextEditors, resolvedPath);
    return this.replaceSnapshot(runtime, snapshot, { kind: "snapshot", snapshot });
  }

  public async closeFile(rootPath: string, filePath: string): Promise<WorkspaceSnapshot> {
    const runtime = await this.ensureWorkspace(rootPath);
    const index = runtime.snapshot.openEditors.findIndex((editor) => editor.path === filePath);
    const nextEditors = runtime.snapshot.openEditors.filter((editor) => editor.path !== filePath);

    let nextActive = runtime.snapshot.selection.activePath;
    if (nextActive === filePath) {
      nextActive =
        nextEditors[index]?.path ?? nextEditors[index - 1]?.path ?? nextEditors[0]?.path ?? null;
    }

    const snapshot = await this.buildSnapshot(rootPath, nextEditors, nextActive);
    return this.replaceSnapshot(runtime, snapshot, { kind: "snapshot", snapshot });
  }

  public async setActive(rootPath: string, filePath: string | null): Promise<WorkspaceSnapshot> {
    const runtime = await this.ensureWorkspace(rootPath);
    const resolvedPath =
      filePath === null
        ? null
        : await this.resolveWorkspaceFilePath(rootPath, filePath, runtime.snapshot.tree);

    if (filePath !== null && !resolvedPath) {
      throw new Error(`Workspace file not found: ${filePath}`);
    }

    const snapshot = await this.buildSnapshot(rootPath, runtime.snapshot.openEditors, resolvedPath);
    return this.replaceSnapshot(runtime, snapshot, { kind: "snapshot", snapshot });
  }

  public async setDirty(
    rootPath: string,
    filePath: string,
    isDirty: boolean
  ): Promise<WorkspaceSnapshot> {
    const runtime = await this.ensureWorkspace(rootPath);
    const nextEditors = runtime.snapshot.openEditors.map((editor) =>
      editor.path === filePath
        ? {
            ...editor,
            isDirty,
            hasExternalConflict: isDirty ? editor.hasExternalConflict : false
          }
        : editor
    );
    const snapshot = await this.buildSnapshot(
      rootPath,
      nextEditors,
      runtime.snapshot.selection.activePath
    );
    return this.replaceSnapshot(runtime, snapshot, { kind: "snapshot", snapshot });
  }

  public async markConflict(rootPath: string, filePath: string, hasConflict: boolean): Promise<WorkspaceSnapshot> {
    const runtime = await this.ensureWorkspace(rootPath);
    const nextEditors = runtime.snapshot.openEditors.map((editor) =>
      editor.path === filePath ? { ...editor, hasExternalConflict: hasConflict } : editor
    );
    const snapshot = await this.buildSnapshot(
      rootPath,
      nextEditors,
      runtime.snapshot.selection.activePath
    );
    return this.replaceSnapshot(runtime, snapshot, { kind: "snapshot", snapshot });
  }

  public async reconcile(rootPath: string, changes?: WorkspaceFileChange[]): Promise<WorkspaceSnapshot> {
    const runtime = await this.ensureWorkspace(rootPath);
    const nextTree = await this.indexTree(rootPath);
    const normalizedChanges =
      changes && changes.length > 0
        ? changes
        : this.buildChangeSet(rootPath, runtime.snapshot.tree, nextTree, runtime.pendingEvents);
    runtime.pendingEvents = [];

    const snapshot = this.mergeSnapshot(runtime.snapshot, nextTree, normalizedChanges);
    return this.replaceSnapshot(runtime, snapshot, {
      kind: "changed",
      snapshot,
      changes: normalizedChanges
    });
  }

  public findWorkspaceRootForPath(filePath: string): string | null {
    const absolutePath = path.resolve(filePath);

    for (const rootPath of this.workspaces.keys()) {
      if (absolutePath === rootPath || absolutePath.startsWith(`${rootPath}${path.sep}`)) {
        return rootPath;
      }
    }

    return null;
  }

  private async resolveWorkspaceFilePath(
    rootPath: string,
    filePath: string,
    tree: FileNode[]
  ): Promise<string | null> {
    const absoluteTarget = path.resolve(filePath);
    const fileNodes = flattenTree(tree).filter((node) => node.type === "file");

    const exactMatch = fileNodes.find((node) => path.resolve(node.path) === absoluteTarget);
    if (exactMatch) {
      return exactMatch.path;
    }

    if (absoluteTarget === rootPath || absoluteTarget.startsWith(`${rootPath}${path.sep}`)) {
      const relativeTarget = path.relative(rootPath, absoluteTarget);
      const normalizedTarget = path.join(rootPath, relativeTarget);
      const normalizedMatch = fileNodes.find((node) => path.resolve(node.path) === normalizedTarget);

      if (normalizedMatch) {
        return normalizedMatch.path;
      }
    }

    const [realRootPath, realTargetPath] = await Promise.all([
      this.safeRealpath(rootPath),
      this.safeRealpath(absoluteTarget)
    ]);

    if (!realTargetPath) {
      return null;
    }

    if (realRootPath && (realTargetPath === realRootPath || realTargetPath.startsWith(`${realRootPath}${path.sep}`))) {
      const relativeTarget = path.relative(realRootPath, realTargetPath);
      const normalizedTarget = path.join(rootPath, relativeTarget);
      const normalizedMatch = fileNodes.find((node) => path.resolve(node.path) === normalizedTarget);

      if (normalizedMatch) {
        return normalizedMatch.path;
      }
    }

    for (const node of fileNodes) {
      const nodeRealPath = await this.safeRealpath(node.path);
      if (nodeRealPath === realTargetPath) {
        return node.path;
      }
    }

    return null;
  }

  private async safeRealpath(targetPath: string): Promise<string | null> {
    try {
      return await fs.realpath(targetPath);
    } catch {
      return null;
    }
  }

  private async ensureWorkspace(rootPath: string): Promise<WorkspaceRuntime> {
    const absoluteRoot = path.resolve(rootPath);
    const runtime = this.workspaces.get(absoluteRoot);

    if (runtime) {
      return runtime;
    }

    await this.open(absoluteRoot);
    return this.workspaces.get(absoluteRoot)!;
  }

  private async buildSnapshot(
    rootPath: string,
    openEditors: WorkspaceOpenEditor[],
    activePath: string | null
  ): Promise<WorkspaceSnapshot> {
    const tree = await this.indexTree(rootPath);
    return this.mergeSnapshot(
      {
        rootPath,
        tree,
        openEditors,
        selection: { activePath }
      },
      tree,
      []
    );
  }

  private mergeSnapshot(
    previous: WorkspaceSnapshot,
    nextTree: FileNode[],
    changes: WorkspaceFileChange[]
  ): WorkspaceSnapshot {
    const nodeMap = mapFileNodes(nextTree);
    const renamedChanges = changes.filter((change) => change.kind === "renamed");

    const nextEditors = previous.openEditors.flatMap((editor) => {
        const renamed = renamedChanges.find((change) => change.previousPath === editor.path);
        const nextPath = renamed?.path ?? editor.path;
        const existingNode = nodeMap.get(nextPath);

        if (existingNode && existingNode.type === "file") {
          return [{
            ...editor,
            path: nextPath,
            title: path.basename(nextPath),
            isMissing: false
          }];
        }

        if (editor.isDirty) {
          return [{
            ...editor,
            path: nextPath,
            title: path.basename(nextPath),
            isMissing: true
          }];
        }

        return [];
      });

    const validActivePath = nextEditors.some((editor) => editor.path === previous.selection.activePath)
      ? previous.selection.activePath
      : nextEditors[0]?.path ?? null;

    return {
      rootPath: previous.rootPath,
      tree: nextTree,
      openEditors: nextEditors,
      selection: {
        activePath: validActivePath
      }
    };
  }

  private async indexTree(rootPath: string): Promise<FileNode[]> {
    const ignorePatterns = await loadIgnorePatterns(rootPath, defaultIgnoredPaths);

    const walk = async (directoryPath: string): Promise<FileNode[]> => {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      const nodes: FileNode[] = [];

      for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        if (!relativePath || shouldIgnorePath(relativePath, ignorePatterns)) {
          continue;
        }

        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: "directory",
            children: await walk(fullPath)
          });
          continue;
        }

        if (entry.isFile()) {
          nodes.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: "file"
          });
        }
      }

      return nodes.sort(sortNodes);
    };

    return walk(rootPath);
  }

  private buildChangeSet(
    rootPath: string,
    previousTree: FileNode[],
    nextTree: FileNode[],
    pendingEvents: RawWatchEvent[]
  ): WorkspaceFileChange[] {
    const previousMap = mapFileNodes(previousTree);
    const nextMap = mapFileNodes(nextTree);
    const changes = new Map<string, WorkspaceFileChange>();

    for (const [nodePath, node] of previousMap) {
      if (!nextMap.has(nodePath)) {
        changes.set(`removed:${nodePath}`, {
          kind: "removed",
          path: nodePath,
          nodeType: node.type
        });
      }
    }

    for (const [nodePath, node] of nextMap) {
      if (!previousMap.has(nodePath)) {
        changes.set(`added:${nodePath}`, {
          kind: "added",
          path: nodePath,
          nodeType: node.type
        });
      }
    }

    for (const pending of pendingEvents) {
      const absolutePath = path.join(rootPath, pending.relativePath);
      const existing = nextMap.get(absolutePath) ?? previousMap.get(absolutePath);

      if (!existing || !isFileNode(existing)) {
        continue;
      }

      if (!changes.has(`added:${absolutePath}`) && !changes.has(`removed:${absolutePath}`)) {
        changes.set(`changed:${absolutePath}`, {
          kind: "changed",
          path: absolutePath,
          nodeType: existing.type
        });
      }
    }

    return [...changes.values()];
  }

  private ensureWatcher(rootPath: string, runtime: WorkspaceRuntime): void {
    if (runtime.watcher) {
      return;
    }

    runtime.watcher = watch(
      rootPath,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) {
          return;
        }

        const relativePath = filename.toString();

        if (
          defaultIgnoredPaths.some(
            (ignoredPath) =>
              relativePath === ignoredPath ||
              relativePath.startsWith(`${ignoredPath}${path.sep}`) ||
              relativePath.startsWith(`${ignoredPath}/`)
          )
        ) {
          return;
        }

        runtime.pendingEvents.push({
          eventType: "change",
          relativePath
        });

        if (runtime.reconcileTimer) {
          clearTimeout(runtime.reconcileTimer);
        }

        runtime.reconcileTimer = setTimeout(() => {
          runtime.reconcileTimer = null;
          void this.reconcile(rootPath);
        }, 120);
      }
    );
  }

  private replaceSnapshot(
    runtime: WorkspaceRuntime,
    snapshot: WorkspaceSnapshot,
    event: WorkspaceEvent
  ): WorkspaceSnapshot {
    runtime.snapshot = snapshot;
    this.emit(event);
    return snapshot;
  }

  private emit(event: WorkspaceEvent): void {
    this.emitter.emit("event", event);
  }
}
