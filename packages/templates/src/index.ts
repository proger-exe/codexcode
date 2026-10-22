type ArchitectureTemplate = {
  id: string;
  name: string;
  description: string;
  languages: string[];
  files: Array<{ path: string; content: string }>;
  directories: string[];
  agentsTemplate: string;
  variables: Array<{
    key: string;
    label: string;
    defaultValue: string;
    required: boolean;
  }>;
  commands: {
    install?: string;
    dev?: string;
    test?: string;
    lint?: string;
    build?: string;
  };
};

const minimalAgentsTemplate = `# AGENTS.md

## Project purpose
- {{projectName}} is a focused codebase.

## Stack
- Language: {{language}}
- Test command: {{testCommand}}
- Lint command: {{lintCommand}}
- Run command: {{runCommand}}

## Rules
- Keep changes minimal and local.
- Do not touch secrets or deployment config without explicit approval.
- Prefer tests for behavior changes.

## Response style
- Explain user-facing risk briefly.
- Reference files with clickable paths and line numbers when possible.
`;

export const templates: ArchitectureTemplate[] = [
  {
    id: "minimal",
    name: "Minimal",
    description: "Small service or utility repository.",
    languages: ["typescript", "python", "javascript"],
    directories: ["src", "tests"],
    files: [
      {
        path: "README.md",
        content: "# {{projectName}}\n\nGenerated with codex-code.\n"
      },
      {
        path: "src/main.ts",
        content: "export const hello = () => \"{{projectName}}\";\n"
      },
      {
        path: "tests/main.test.ts",
        content: "import { hello } from \"../src/main\";\n\nconsole.log(hello());\n"
      }
    ],
    agentsTemplate: minimalAgentsTemplate,
    variables: [
      { key: "projectName", label: "Project Name", defaultValue: "my-project", required: true },
      { key: "language", label: "Language", defaultValue: "typescript", required: true },
      { key: "testCommand", label: "Test Command", defaultValue: "pnpm test", required: true },
      { key: "lintCommand", label: "Lint Command", defaultValue: "pnpm lint", required: true },
      { key: "runCommand", label: "Run Command", defaultValue: "pnpm dev", required: true }
    ],
    commands: {
      dev: "pnpm dev",
      test: "pnpm test",
      lint: "pnpm lint"
    }
  },
  {
    id: "python-backend",
    name: "Python Backend",
    description: "FastAPI-style backend with layered modules.",
    languages: ["python"],
    directories: [
      "app/api",
      "app/core",
      "app/domain",
      "app/services",
      "app/infrastructure",
      "tests",
      "alembic"
    ],
    files: [
      {
        path: "README.md",
        content: "# {{projectName}}\n\nPython backend scaffold.\n"
      },
      {
        path: "app/main.py",
        content:
          "from fastapi import FastAPI\n\napp = FastAPI(title=\"{{projectName}}\")\n\n\n@app.get(\"/health\")\ndef healthcheck() -> dict[str, str]:\n    return {\"status\": \"ok\"}\n"
      },
      {
        path: "tests/test_health.py",
        content: "def test_placeholder() -> None:\n    assert True\n"
      }
    ],
    agentsTemplate: `# AGENTS.md

## Project purpose
- {{projectName}} is a Python backend.

## Stack
- Framework: {{framework}}
- Package manager: {{packageManager}}
- Test command: {{testCommand}}
- Lint command: {{lintCommand}}
- Run command: {{runCommand}}

## Architecture rules
- Domain logic stays outside transport and persistence layers.
- Services orchestrate domain use-cases.
- Infrastructure owns external integrations.

## Safety
- Do not read .env files without approval.
- Do not change migrations or deployment config without approval.
`,
    variables: [
      { key: "projectName", label: "Project Name", defaultValue: "api-service", required: true },
      { key: "framework", label: "Framework", defaultValue: "fastapi", required: true },
      { key: "packageManager", label: "Package Manager", defaultValue: "uv", required: true },
      { key: "testCommand", label: "Test Command", defaultValue: "pytest", required: true },
      { key: "lintCommand", label: "Lint Command", defaultValue: "ruff check .", required: true },
      {
        key: "runCommand",
        label: "Run Command",
        defaultValue: "uvicorn app.main:app --reload",
        required: true
      }
    ],
    commands: {
      dev: "uvicorn app.main:app --reload",
      test: "pytest",
      lint: "ruff check ."
    }
  },
  {
    id: "typescript-frontend",
    name: "TypeScript Frontend",
    description: "React/Vite style frontend with layered folders.",
    languages: ["typescript"],
    directories: [
      "src/components",
      "src/pages",
      "src/shared",
      "src/entities",
      "src/features",
      "src/app"
    ],
    files: [
      {
        path: "README.md",
        content: "# {{projectName}}\n\nTypeScript frontend scaffold.\n"
      },
      {
        path: "src/app/App.tsx",
        content:
          "export function App() {\n  return <main><h1>{{projectName}}</h1></main>;\n}\n"
      },
      {
        path: "src/main.tsx",
        content:
          "import React from \"react\";\nimport ReactDOM from \"react-dom/client\";\nimport { App } from \"./app/App\";\n\nReactDOM.createRoot(document.getElementById(\"root\")!).render(<App />);\n"
      }
    ],
    agentsTemplate: `# AGENTS.md

## Project purpose
- {{projectName}} is a TypeScript frontend.

## Stack
- Framework: {{framework}}
- Package manager: {{packageManager}}
- Test command: {{testCommand}}
- Lint command: {{lintCommand}}
- Run command: {{runCommand}}

## Architecture rules
- Shared UI belongs in shared/components only when reused.
- Features own orchestration; entities own business data shapes.
- Avoid tight coupling between pages and low-level utilities.
`,
    variables: [
      { key: "projectName", label: "Project Name", defaultValue: "web-app", required: true },
      { key: "framework", label: "Framework", defaultValue: "react", required: true },
      { key: "packageManager", label: "Package Manager", defaultValue: "pnpm", required: true },
      { key: "testCommand", label: "Test Command", defaultValue: "pnpm test", required: true },
      { key: "lintCommand", label: "Lint Command", defaultValue: "pnpm lint", required: true },
      { key: "runCommand", label: "Run Command", defaultValue: "pnpm dev", required: true }
    ],
    commands: {
      dev: "pnpm dev",
      test: "pnpm test",
      lint: "pnpm lint",
      build: "pnpm build"
    }
  }
];
