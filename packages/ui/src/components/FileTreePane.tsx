import { useState } from "react";
import type { FileNode } from "@codex-code/core";

type FileTreePaneProps = {
  files: FileNode[];
  selectedPath: string | null;
  onOpenFile: (filePath: string) => void;
};

type TreeNodeProps = Omit<FileTreePaneProps, "files"> & {
  collapsedPaths: Set<string>;
  node: FileNode;
  onToggleDirectory: (filePath: string) => void;
  depth: number;
};

function TreeNode({
  collapsedPaths,
  depth,
  node,
  selectedPath,
  onOpenFile,
  onToggleDirectory
}: TreeNodeProps) {
  const isDirectory = node.type === "directory";
  const isCollapsed = isDirectory && collapsedPaths.has(node.path);

  return (
    <div className="tree-node">
      <div className={`tree-row ${selectedPath === node.path ? "active" : ""}`}>
        <button
          className="tree-label"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => {
            if (isDirectory) {
              onToggleDirectory(node.path);
            } else {
              onOpenFile(node.path);
            }
          }}
        >
          <span className="tree-caret">{isDirectory ? (isCollapsed ? "▸" : "▾") : ""}</span>
          <span>{node.name}</span>
        </button>
      </div>
      {node.children?.length && !isCollapsed ? (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              collapsedPaths={collapsedPaths}
              depth={depth + 1}
              node={child}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
              onToggleDirectory={onToggleDirectory}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FileTreePane(props: FileTreePaneProps) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());

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
    <aside className="panel file-tree">
      <div className="panel-header">
        <h2>Files</h2>
      </div>
      <div className="panel-body">
        {props.files.map((node) => (
          <TreeNode
            key={node.path}
            collapsedPaths={collapsedPaths}
            depth={0}
            node={node}
            onToggleDirectory={handleToggleDirectory}
            {...props}
          />
        ))}
      </div>
    </aside>
  );
}
