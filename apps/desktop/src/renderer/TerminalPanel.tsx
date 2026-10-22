import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { DesktopApi, TerminalSession } from "@codex-code/core";
import "@xterm/xterm/css/xterm.css";

type TerminalPanelProps = {
  desktopApi: DesktopApi;
  projectRoot: string;
  visible: boolean;
  height: number;
  focusSignal: number;
  onClose: () => void;
};

const initialCols = 100;
const initialRows = 24;

type TerminalStatus = "idle" | "starting" | "running" | "exited" | "error";

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function TerminalPanel({
  desktopApi,
  projectRoot,
  visible,
  height,
  focusSignal,
  onClose
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const createInFlightRef = useRef<Promise<void> | null>(null);
  const visibleRef = useRef(visible);
  const lifecycleTokenRef = useRef(0);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const setError = useCallback((error: unknown) => {
    setStatus("error");
    setDetail(describeError(error));
  }, []);

  const fit = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const sessionId = sessionRef.current?.id;

    if (!terminal || !fitAddon || !hostRef.current || !visibleRef.current) {
      return;
    }

    try {
      fitAddon.fit();
    } catch (error) {
      setError(error);
      return;
    }

    if (sessionId) {
      void desktopApi.resizeTerminal(sessionId, terminal.cols, terminal.rows).catch((error) => {
        if (sessionRef.current?.id === sessionId) {
          setError(error);
        }
      });
    }
  }, [desktopApi, setError]);

  const createSession = useCallback(async () => {
    if (sessionRef.current) {
      window.requestAnimationFrame(fit);
      return createInFlightRef.current ?? Promise.resolve();
    }

    if (createInFlightRef.current) {
      return createInFlightRef.current;
    }

    const lifecycleToken = lifecycleTokenRef.current;
    setStatus("starting");
    setDetail("");

    let createPromise: Promise<void>;
    createPromise = desktopApi
      .createTerminal({
        cwd: projectRoot,
        cols: terminalRef.current?.cols ?? initialCols,
        rows: terminalRef.current?.rows ?? initialRows
      })
      .then((nextSession) => {
        if (lifecycleTokenRef.current !== lifecycleToken) {
          void desktopApi.killTerminal(nextSession.id).catch(() => undefined);
          return;
        }

        sessionRef.current = nextSession;
        setSession(nextSession);
        setStatus("running");
        setDetail("");
        window.requestAnimationFrame(fit);
      })
      .catch((error) => {
        if (lifecycleTokenRef.current === lifecycleToken) {
          sessionRef.current = null;
          setSession(null);
          setError(error);
        }
      })
      .finally(() => {
        if (createInFlightRef.current === createPromise) {
          createInFlightRef.current = null;
        }
      });

    createInFlightRef.current = createPromise;
    return createPromise;
  }, [desktopApi, fit, projectRoot, setError]);

  const restart = useCallback(async () => {
    const terminal = terminalRef.current;
    const oldSession = sessionRef.current;
    const oldCreate = createInFlightRef.current;

    lifecycleTokenRef.current += 1;
    sessionRef.current = null;
    setSession(null);
    setDetail("");

    if (oldSession) {
      await desktopApi.killTerminal(oldSession.id).catch(() => undefined);
    }

    terminal?.reset();
    setStatus("idle");
    await oldCreate?.catch(() => undefined);
    await createSession();
  }, [createSession, desktopApi]);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: "#090e15",
        foreground: "#d8e2ef",
        cursor: "#55d6ff",
        selectionBackground: "#264f78",
        black: "#0b1017",
        blue: "#4da6ff",
        brightBlack: "#647181",
        brightBlue: "#7cc0ff",
        brightCyan: "#8be9fd",
        brightGreen: "#7ee2a8",
        brightMagenta: "#c4b5fd",
        brightRed: "#ff7a86",
        brightWhite: "#ffffff",
        brightYellow: "#f7d774",
        cyan: "#55d6ff",
        green: "#35e879",
        magenta: "#8b5cf6",
        red: "#ff5f6d",
        white: "#e6edf7",
        yellow: "#f0c674"
      }
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminal.onData((data) => {
      const sessionId = sessionRef.current?.id;
      if (sessionId) {
        void desktopApi.writeTerminal(sessionId, data).catch((error) => {
          if (sessionRef.current?.id === sessionId) {
            setError(error);
          }
        });
      }
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    window.requestAnimationFrame(fit);

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [desktopApi, fit, setError]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    void createSession();
    window.requestAnimationFrame(() => {
      fit();
      terminalRef.current?.focus();
    });
  }, [createSession, fit, visible]);

  useEffect(() => {
    if (visible) {
      terminalRef.current?.focus();
    }
  }, [focusSignal, visible]);

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fit);
    });

    if (hostRef.current) {
      resizeObserver.observe(hostRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [fit]);

  useEffect(() => {
    const unsubscribe = desktopApi.subscribeTerminalEvents((event) => {
      if (event.terminalId !== sessionRef.current?.id) {
        return;
      }

      if (event.kind === "data") {
        terminalRef.current?.write(event.data);
        return;
      }

      if (event.kind === "exit") {
        sessionRef.current = null;
        setSession(null);
        setStatus("exited");
        setDetail(
          event.signal
            ? `Exited with code ${event.exitCode ?? "n/a"} and signal ${event.signal}.`
            : `Exited with code ${event.exitCode ?? "n/a"}.`
        );
        return;
      }

      setStatus("error");
      setDetail(event.message);
    });

    return unsubscribe;
  }, [desktopApi]);

  useEffect(() => {
    return () => {
      lifecycleTokenRef.current += 1;
      const sessionId = sessionRef.current?.id;
      if (sessionId) {
        void desktopApi.killTerminal(sessionId);
      }
      sessionRef.current = null;
      setSession(null);
      setStatus("idle");
      setDetail("");
    };
  }, [desktopApi, projectRoot]);

  const shellName = session?.shell.split(/[\\/]/).pop() ?? "shell";

  return (
    <section
      className={`terminal-panel ${visible ? "is-visible" : "is-hidden"}`}
      style={{ height: visible ? `${height}px` : 0 }}
      aria-hidden={!visible}
    >
      <div className="terminal-toolbar">
        <div className="terminal-title">
          <strong>Terminal</strong>
          <span>{status === "running" ? shellName : status}</span>
          <span className="terminal-cwd">{projectRoot}</span>
        </div>
        <div className="terminal-actions">
          {detail ? <span className="terminal-detail">{detail}</span> : null}
          <button onClick={() => terminalRef.current?.clear()} disabled={!terminalRef.current}>
            Clear
          </button>
          <button onClick={() => void restart()}>Restart</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <div ref={hostRef} className="terminal-host" />
    </section>
  );
}
