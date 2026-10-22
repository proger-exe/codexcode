import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject
} from "react";
import ReactMarkdown from "react-markdown";
import type { ChatMessage, ChatSessionSummary, CodexChatMode, FileCitation } from "@codex-code/core";

type SideChatProps = {
  chats: ChatSessionSummary[];
  activeChatId: string | null;
  messages: ChatMessage[];
  inFlightMessage?: ChatMessage | null;
  draft: string;
  mode: CodexChatMode;
  canSend: boolean;
  disabledReason?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  createDisabled?: boolean;
  onDraftChange: (value: string) => void;
  onModeChange: (mode: CodexChatMode) => void;
  onSend: () => void;
  onCreateChat: () => void;
  onSelectChat: (chatId: string) => void;
  onStop?: () => void;
  isRunning: boolean;
  onCitationClick: (citation: FileCitation) => void;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const flattenNodeText = (value: ReactNode): string =>
  Children.toArray(value)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }

      if (isValidElement<{ children?: ReactNode }>(child)) {
        return flattenNodeText(child.props.children);
      }

      return "";
    })
    .join("");

const buildFallbackCitation = (value: string, href: string): FileCitation | null => {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const hashMatch = trimmed.match(/^(.*?)(#L(\d+)(?:-L?(\d+))?)$/);
  if (hashMatch) {
    return {
      id: href,
      label: trimmed,
      filePath: hashMatch[1],
      startLine: Number(hashMatch[3]),
      endLine: hashMatch[4] ? Number(hashMatch[4]) : Number(hashMatch[3])
    };
  }

  const colonMatch = trimmed.match(/^(.*?)(:(\d+)(?:-(\d+))?)$/);
  if (colonMatch) {
    return {
      id: href,
      label: trimmed,
      filePath: colonMatch[1],
      startLine: Number(colonMatch[3]),
      endLine: colonMatch[4] ? Number(colonMatch[4]) : Number(colonMatch[3])
    };
  }

  return {
    id: href,
    label: trimmed,
    filePath: trimmed
  };
};

export function SideChat({
  chats,
  activeChatId,
  messages,
  inFlightMessage,
  draft,
  mode,
  canSend,
  disabledReason,
  textareaRef,
  createDisabled,
  onDraftChange,
  onModeChange,
  onSend,
  onCreateChat,
  onSelectChat,
  onStop,
  isRunning,
  onCitationClick
}: SideChatProps) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const renderedMessages = inFlightMessage ? [...messages, inFlightMessage] : messages;

  const setTextareaRef = (element: HTMLTextAreaElement | null) => {
    internalTextareaRef.current = element;
    if (textareaRef) {
      (textareaRef as { current: HTMLTextAreaElement | null }).current = element;
    }
  };

  useLayoutEffect(() => {
    const node = internalTextareaRef.current;
    if (!node) {
      return;
    }

    node.style.height = "auto";
    const maxHeight = 220;
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [draft]);

  const renderMessageContent = (message: ChatMessage) => {
    if (!message.content.trim()) {
      return null;
    }

    let transformed = message.content;

    for (const citation of [...(message.citations ?? [])].sort((left, right) => right.label.length - left.label.length)) {
      const canonicalLink = `[${citation.label}](codex-file://${citation.id})`;
      const escapedLabel = escapeRegExp(citation.label);
      const existingMarkdownLinkPattern = new RegExp(
        `\\[${escapedLabel}\\]\\((?:codex-file://[^)\\s]+|[^)\\s]+)\\)`,
        "g"
      );
      const rawLabelPattern = new RegExp(`(?<!\\[)${escapedLabel}(?!\\]\\()`, "g");

      transformed = transformed.replace(existingMarkdownLinkPattern, canonicalLink);
      transformed = transformed.replace(rawLabelPattern, canonicalLink);
    }

    return (
      <ReactMarkdown
        components={{
          a: ({ children, href }) => {
            if (href?.startsWith("codex-file://")) {
              const citationId = href.replace("codex-file://", "");
              const citation =
                message.citations?.find((entry) => entry.id === citationId) ??
                buildFallbackCitation(flattenNodeText(children), href);

              return (
                <button
                  className="inline-file-link"
                  onClick={(event) => {
                    event.preventDefault();
                    if (citation) {
                      onCitationClick(citation);
                    }
                  }}
                >
                  {children}
                </button>
              );
            }

            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          }
        }}
      >
        {transformed}
      </ReactMarkdown>
    );
  };

  useEffect(() => {
    if (!feedRef.current) {
      return;
    }

    feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [renderedMessages.length, inFlightMessage?.content]);

  return (
    <aside className="panel chat-pane">
      <div className="panel-header">
        <h2>Assistant</h2>
        <div className="chat-header-actions">
          {isRunning && onStop ? <button onClick={onStop}>Stop</button> : null}
          <button
            className="chat-plus-button"
            onClick={onCreateChat}
            disabled={createDisabled}
            aria-label="Create new chat"
          >
            +
          </button>
        </div>
      </div>
      <div className="chat-session-list">
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`chat-session-item ${chat.id === activeChatId ? "active" : ""}`}
            onClick={() => onSelectChat(chat.id)}
            disabled={isRunning}
          >
            <span className="chat-session-title">{chat.title}</span>
            <span className="chat-session-time">
              {new Date(chat.updatedAt).toLocaleDateString()} {new Date(chat.updatedAt).toLocaleTimeString()}
            </span>
          </button>
        ))}
      </div>
      <div ref={feedRef} className="chat-feed">
        {renderedMessages.map((message) => (
          <article
            key={message.id}
            className={`chat-message role-${message.role} ${message.id === inFlightMessage?.id ? "is-streaming" : ""} ${
              message.error ? "has-error" : ""
            }`}
          >
            <div className="chat-meta">
              <strong>{message.role}</strong>
              <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
            </div>
            {renderMessageContent(message)}
            {message.id === inFlightMessage?.id && isRunning ? (
              <p className="working-indicator" aria-label="Codex is still responding">
                <span className="working-dots" aria-hidden="true">
                  <span>.</span>
                  <span>.</span>
                  <span>.</span>
                </span>
              </p>
            ) : null}
            {message.error ? (
              <details className="error-details">
                <summary>CLI details</summary>
                <pre className="error-block">{message.error}</pre>
              </details>
            ) : null}
          </article>
        ))}
      </div>
      <div className="chat-compose">
        {disabledReason ? <p className="chat-hint">{disabledReason}</p> : null}
        <textarea
          ref={setTextareaRef}
          placeholder="Ask about the current project…"
          value={draft}
          rows={1}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        <div className="chat-mode-toggle" role="tablist" aria-label="Codex mode">
          <button
            className={`chat-mode-option ${mode === "agent" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={mode === "agent"}
            onClick={() => onModeChange("agent")}
            disabled={isRunning}
          >
            Agent
          </button>
          <button
            className={`chat-mode-option ${mode === "plan" ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={mode === "plan"}
            onClick={() => onModeChange("plan")}
            disabled={isRunning}
          >
            Plan
          </button>
        </div>
        <button className="primary" onClick={onSend} disabled={!draft.trim() || !canSend || isRunning}>
          Send
        </button>
      </div>
    </aside>
  );
}
