import os from "node:os";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { TerminalCreateRequest, TerminalEvent, TerminalSession } from "@codex-code/core";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

type TerminalRuntime = TerminalSession & {
  process: IPty;
};

const clampDimension = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.floor(value)));

const assertDirectory = (cwd: string): void => {
  if (!cwd || /[\r\n\0]/.test(cwd)) {
    throw new Error("Terminal working directory is invalid.");
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(cwd);
  } catch (error) {
    throw new Error(`Terminal working directory is not accessible: ${cwd}`, { cause: error });
  }

  if (!stats.isDirectory()) {
    throw new Error(`Terminal working directory is not a directory: ${cwd}`);
  }
};

const resolveShell = (): string => {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }

  return process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");
};

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalRuntime>();
  private readonly events = new EventEmitter();

  public subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.events.on("event", listener);
    return () => {
      this.events.off("event", listener);
    };
  }

  public create(request: TerminalCreateRequest): TerminalSession {
    const id = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    assertDirectory(request.cwd);
    const shell = resolveShell();
    const cols = clampDimension(request.cols, 20, 400);
    const rows = clampDimension(request.rows, 4, 120);
    let terminalProcess: IPty;

    try {
      terminalProcess = pty.spawn(shell, [], {
        cols,
        rows,
        cwd: request.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          FORCE_COLOR: "1"
        }
      });
    } catch (error) {
      throw new Error(`Failed to start terminal shell: ${shell}`, { cause: error });
    }

    const session: TerminalRuntime = {
      id,
      cwd: request.cwd,
      shell,
      pid: terminalProcess.pid,
      process: terminalProcess
    };

    this.sessions.set(id, session);

    terminalProcess.onData((data) => {
      this.emit({
        kind: "data",
        terminalId: id,
        data
      });
    });

    terminalProcess.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      this.emit({
        kind: "exit",
        terminalId: id,
        exitCode,
        signal
      });
    });

    return {
      id,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pid
    };
  }

  public write(terminalId: string, data: string): void {
    const session = this.getRuntime(terminalId);
    try {
      session.process.write(data);
    } catch (error) {
      this.emitError(terminalId, `Failed to write to terminal: ${this.describeError(error)}`);
      throw error;
    }
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    const session = this.getRuntime(terminalId);
    try {
      session.process.resize(clampDimension(cols, 20, 400), clampDimension(rows, 4, 120));
    } catch (error) {
      this.emitError(terminalId, `Failed to resize terminal: ${this.describeError(error)}`);
      throw error;
    }
  }

  public kill(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return;
    }

    this.sessions.delete(terminalId);
    try {
      session.process.kill();
    } catch (error) {
      this.emitError(terminalId, `Failed to kill terminal: ${this.describeError(error)}`);
      throw error;
    }
  }

  public killAll(): void {
    for (const terminalId of [...this.sessions.keys()]) {
      this.kill(terminalId);
    }
  }

  private getRuntime(terminalId: string): TerminalRuntime {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw new Error(`Terminal session ${terminalId} is not running.`);
    }

    return session;
  }

  private emit(event: TerminalEvent): void {
    this.events.emit("event", event);
  }

  private emitError(terminalId: string, message: string): void {
    this.emit({
      kind: "error",
      terminalId,
      message
    });
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
