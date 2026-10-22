import { useEffect, useState } from "react";
import type { ArchitectureTemplate } from "@codex-code/core";

type ProjectWizardProps = {
  open: boolean;
  templates: ArchitectureTemplate[];
  onClose: () => void;
  onGenerate: (input: {
    destinationPath: string;
    templateId: string;
    variables: Record<string, string>;
    initializeGit: boolean;
  }) => void;
};

export function ProjectWizard({ open, templates, onClose, onGenerate }: ProjectWizardProps) {
  const [templateId, setTemplateId] = useState<string>("");
  const [destinationPath, setDestinationPath] = useState("");
  const [initializeGit, setInitializeGit] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});

  const selectedTemplate = templates.find((entry) => entry.id === templateId) ?? templates[0];

  useEffect(() => {
    if (!open || !selectedTemplate) {
      return;
    }

    setTemplateId((current) => current || selectedTemplate.id);
    setValues(
      Object.fromEntries(
        selectedTemplate.variables.map((variable) => [variable.key, variable.defaultValue])
      )
    );
  }, [open, selectedTemplate]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="panel-header">
          <h2>New Project</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <label>
          Template
          <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination path
          <input
            value={destinationPath}
            onChange={(event) => setDestinationPath(event.target.value)}
            placeholder="/absolute/path/to/project"
          />
        </label>
        <div className="wizard-grid">
          {selectedTemplate?.variables.map((variable) => (
            <label key={variable.key}>
              {variable.label}
              <input
                value={values[variable.key] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [variable.key]: event.target.value
                  }))
                }
              />
            </label>
          ))}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={initializeGit}
            onChange={(event) => setInitializeGit(event.target.checked)}
          />
          Initialize git
        </label>
        <button
          className="primary"
          onClick={() =>
            onGenerate({
              destinationPath,
              templateId: selectedTemplate?.id ?? "",
              variables: values,
              initializeGit
            })
          }
          disabled={!destinationPath || !selectedTemplate}
        >
          Generate Project
        </button>
      </div>
    </div>
  );
}
