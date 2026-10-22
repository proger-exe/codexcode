import path from "node:path";
import { promises as fs } from "node:fs";
import type { ArchitectureTemplate, CreateProjectInput } from "../types";
import type { ProjectManager } from "../project/ProjectManager";
import { templates } from "@codex-code/templates";

const applyTemplateVariables = (content: string, variables: Record<string, string>): string =>
  content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? "");

export class TemplateManager {
  public constructor(private readonly projectManager: ProjectManager) {}

  public listTemplates(): ArchitectureTemplate[] {
    return templates;
  }

  public async generateProject(input: CreateProjectInput) {
    const template = templates.find((entry) => entry.id === input.templateId);

    if (!template) {
      throw new Error(`Unknown template: ${input.templateId}`);
    }

    await fs.mkdir(input.destinationPath, { recursive: true });

    for (const directory of template.directories) {
      await fs.mkdir(path.join(input.destinationPath, directory), { recursive: true });
    }

    for (const file of template.files) {
      const targetPath = path.join(input.destinationPath, file.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(
        targetPath,
        applyTemplateVariables(file.content, input.variables),
        "utf8"
      );
    }

    await fs.writeFile(
      path.join(input.destinationPath, "AGENTS.md"),
      applyTemplateVariables(template.agentsTemplate, input.variables),
      "utf8"
    );

    if (input.initializeGit) {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        const child = spawn("git", ["init"], { cwd: input.destinationPath, stdio: "ignore" });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
    }

    return this.projectManager.openProject(input.destinationPath);
  }
}
