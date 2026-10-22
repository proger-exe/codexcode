import type { DiffPreview } from "@codex-code/core";

type DiffPreviewPanelProps = {
  diffs: DiffPreview[];
  onApply: (diff: DiffPreview) => void;
  onOpenFile: (filePath: string) => void;
};

export function DiffPreviewPanel({ diffs, onApply, onOpenFile }: DiffPreviewPanelProps) {
  if (diffs.length === 0) {
    return (
      <section className="panel diff-pane">
        <div className="panel-header">
          <h2>Diffs</h2>
        </div>
        <div className="panel-body empty-state">No pending diffs.</div>
      </section>
    );
  }

  return (
    <section className="panel diff-pane">
      <div className="panel-header">
        <h2>Diffs</h2>
      </div>
      <div className="panel-body diff-list">
        {diffs.map((diff) => (
          <article key={diff.id} className="diff-card">
            <div className="diff-card-header">
              <strong>{diff.filePath}</strong>
              <div>
                <button onClick={() => onOpenFile(diff.filePath)}>Open file</button>
                <button className="primary" onClick={() => onApply(diff)}>
                  Apply file
                </button>
              </div>
            </div>
            {diff.hunks.map((hunk) => (
              <div key={`${diff.id}-${hunk.header}`} className="hunk">
                <code>{hunk.header}</code>
                <pre>
                  {hunk.lines.map((line, index) => (
                    <div key={index} className={`diff-line ${line.kind}`}>
                      {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                      {line.value}
                    </div>
                  ))}
                </pre>
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
