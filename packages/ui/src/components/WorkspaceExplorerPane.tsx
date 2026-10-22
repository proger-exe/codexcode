import { useMemo, useState, type RefObject } from "react";
import type { WorkspaceNode } from "@codex-code/core";

type WorkspaceExplorerPaneProps = {
  files: WorkspaceNode[];
  activePath: string | null;
  openPaths: string[];
  panelRef?: RefObject<HTMLElement | null>;
  onOpenFile: (filePath: string) => void;
};

type ExplorerNodeProps = {
  activePath: string | null;
  collapsedPaths: Set<string>;
  depth: number;
  node: WorkspaceNode;
  openPaths: string[];
  onOpenFile: (filePath: string) => void;
  onToggleDirectory: (filePath: string) => void;
};

const resolveFileIconKind = (node: WorkspaceNode): string => {
  if (node.type === "directory") {
    return "folder";
  }

  if (node.name === ".env") {
    return "env";
  }

  const extension = node.name.includes(".") ? node.name.split(".").pop()?.toLowerCase() : "";

  switch (extension) {
    case "py":
    case "pyi":
      return "python";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "cjs":
    case "mjs":
      return "javascript";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "yml":
    case "yaml":
    case "toml":
      return "config";
    default:
      return "file";
  }
};

function TreeIcon({ kind, isDirectory }: { kind: string; isDirectory: boolean }) {
  if (isDirectory) {
    return (
      <span className={`tree-icon is-${kind}`} aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none">
          <path
            d="M1.75 4.25A1.5 1.5 0 0 1 3.25 2.75H6.1c.4 0 .77.16 1.06.44l.9.9c.14.14.33.21.53.21h4.16a1.5 1.5 0 0 1 1.5 1.5v5.95a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5V4.25Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  return (
    <span className={`tree-icon is-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none">
        <path
          d="M4.25 1.75h4.9L12.5 5.1v7.65a1.5 1.5 0 0 1-1.5 1.5h-6.75a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M9.25 1.9v3.35h3.35" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function ExplorerNode({
  activePath,
  collapsedPaths,
  depth,
  node,
  onOpenFile,
  onToggleDirectory,
  openPaths
}: ExplorerNodeProps) {
  const isDirectory = node.type === "directory";
  const isCollapsed = isDirectory && collapsedPaths.has(node.path);
  const isOpen = openPaths.includes(node.path);
  const isPythonFile = !isDirectory && node.name.endsWith(".py");
  const isInitFile = !isDirectory && node.name === "__init__.py";
  const iconKind = resolveFileIconKind(node);

  return (
    <div className={`tree-node ${isDirectory ? "is-directory" : "is-file"}`}>
      <div className={`tree-row ${activePath === node.path ? "active" : ""}`}>
        <button
          className={`tree-label ${isDirectory ? "is-directory" : "is-file"} ${isPythonFile ? "is-python" : ""} ${
            isInitFile ? "is-init-file" : ""
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => {
            if (isDirectory) {
              onToggleDirectory(node.path);
              return;
            }

            onOpenFile(node.path);
          }}
        >
          <span className="tree-caret">{isDirectory ? (isCollapsed ? "▸" : "▾") : ""}</span>
          <TreeIcon kind={iconKind} isDirectory={isDirectory} />
          <span className="tree-name">{node.name}</span>
          {!isDirectory && isOpen ? <span className="tree-open-indicator" /> : null}
        </button>
      </div>
      {node.children?.length && !isCollapsed ? (
        <div className="tree-children">
          {node.children.map((child) => (
            <ExplorerNode
              key={child.path}
              activePath={activePath}
              collapsedPaths={collapsedPaths}
              depth={depth + 1}
              node={child}
              onOpenFile={onOpenFile}
              onToggleDirectory={onToggleDirectory}
              openPaths={openPaths}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceExplorerPane({
  activePath,
  files,
  panelRef,
  onOpenFile,
  openPaths
}: WorkspaceExplorerPaneProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const openPathSet = useMemo(() => new Set(openPaths), [openPaths]);

  const handleToggleDirectory = (filePath: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);

      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }

      return next;
    });
  };

  return (
    <aside ref={panelRef} className="panel file-tree">
      <div className="panel-header">
        <h2>Explorer</h2>
      </div>
      <div className="panel-body">
        {files.map((node) => (
          <ExplorerNode
            key={node.path}
            activePath={activePath}
            collapsedPaths={collapsedPaths}
            depth={0}
            node={node}
            onOpenFile={onOpenFile}
            onToggleDirectory={handleToggleDirectory}
            openPaths={[...openPathSet]}
          />
        ))}
      </div>
    </aside>
  );
}
