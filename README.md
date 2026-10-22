# CodexCode

Desktop IDE shell around the OpenAI Codex CLI: file tree, Monaco editor, integrated terminal, side chat with the agent, diff preview before applying edits, clickable file citations, and project templates with `AGENTS.md` scaffolding. Electron + React, the agent itself is the stock `codex` binary spawned as a subprocess.


## What is inside

| Package | Role |
|---|---|
| `apps/desktop` | Electron app (electron-vite): main process, preload bridge, React renderer, xterm terminal, node-pty |
| `packages/core` | Codex adapter (spawns `codex`, parses its JSON event stream), workspace and file services, diff engine, chat state, a small LSP client, IPC contracts |
| `packages/ui` | React components: file tree, side chat, diff panel, project wizard, top bar |
| `packages/templates` | Project templates and `AGENTS.md` presets |

## Run

Requires Node 22+, pnpm and an authenticated `codex` CLI on PATH.

```bash
pnpm install
pnpm dev                                   # electron-vite dev with hot reload
pnpm run typecheck
pnpm run dist:linux                        # AppImage in apps/desktop/dist/
```

## Status

Working prototype. Open items are in `TODO.md`; the original spec (RU) is `docs/techtask.md`.

## License

MIT
