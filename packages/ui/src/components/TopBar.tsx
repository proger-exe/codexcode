import type { CodexStatus, ProjectInfo } from "@codex-code/core";

type TopBarProps = {
  project: ProjectInfo | null;
  status: CodexStatus;
  explorerVisible?: boolean;
  chatVisible?: boolean;
  terminalVisible?: boolean;
  terminalDisabled?: boolean;
  onToggleExplorer?: () => void;
  onToggleChat?: () => void;
  onToggleTerminal?: () => void;
};

const statusLabel: Record<CodexStatus, string> = {
  ready: "Ready",
  thinking: "Thinking",
  editing: "Editing",
  waiting_approval: "Approval",
  error: "Error",
  offline: "Offline"
};

const modKey = () =>
  typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

export function TopBar({
  project,
  status,
  explorerVisible,
  chatVisible,
  terminalVisible,
  terminalDisabled,
  onToggleExplorer,
  onToggleChat,
  onToggleTerminal
}: TopBarProps) {
  const mod = modKey();
  const hasToggles = onToggleExplorer || onToggleChat || onToggleTerminal;

  return (
    <header className="topbar">
      <div className="topbar-project">
        {hasToggles ? (
          <div className="topbar-toggles" role="group" aria-label="Toggle panels">
            {onToggleExplorer ? (
              <button
                type="button"
                className={`topbar-toggle ${explorerVisible ? "is-active" : ""}`}
                onClick={onToggleExplorer}
                aria-pressed={Boolean(explorerVisible)}
                aria-label="Toggle file tree"
                title={`Toggle file tree (${mod}+B)`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                  <line x1="6" y1="2.5" x2="6" y2="13.5" />
                </svg>
              </button>
            ) : null}
            {onToggleTerminal ? (
              <button
                type="button"
                className={`topbar-toggle ${terminalVisible ? "is-active" : ""}`}
                onClick={onToggleTerminal}
                aria-pressed={Boolean(terminalVisible)}
                aria-label="Toggle terminal"
                title={`Toggle terminal (${mod}+\`)`}
                disabled={terminalDisabled}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                  <polyline points="4,7 6.5,9 4,11" />
                  <line x1="8" y1="11" x2="12" y2="11" />
                </svg>
              </button>
            ) : null}
            {onToggleChat ? (
              <button
                type="button"
                className={`topbar-toggle ${chatVisible ? "is-active" : ""}`}
                onClick={onToggleChat}
                aria-pressed={Boolean(chatVisible)}
                aria-label="Toggle assistant"
                title={`Toggle assistant (${mod}+J)`}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                  <line x1="10" y1="2.5" x2="10" y2="13.5" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}
        <span className="project-label">{project?.name ?? "No folder open"}</span>
        {project ? <span className="project-path">{project.rootPath}</span> : null}
      </div>
      <div className="topbar-title-slot" aria-hidden="true">
        <strong className="app-title">codex-code</strong>
      </div>
      <div className="topbar-actions">
        <span className={`status-pill status-${status}`}>Codex: {statusLabel[status]}</span>
      </div>
    </header>
  );
}
