// ChatPanel — LM Studio-style chat with streaming, markdown, tool calling.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import { openDirDialog } from "./tauri";
import type { ChatMsg, ChatTool, ToolCallArg, ToolResult } from "./chatTypes";
import { streamChat } from "./streamChat";
import { enabledDefs, runTool } from "./tools";
import "./chat.css";

interface Props {
  baseUrl: string;
  apiKey: string;
  model: string;
  tools: ChatTool[];
  workspace: string;
  onWorkspaceChange: (w: string) => void;
  onToolsChange: (t: ChatTool[]) => void;
}

interface PendingTool {
  name: string;
  args: string;
  result?: string;
  ok?: boolean;
  running: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => {
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return code;
    }
  }, [lang, code]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-lang">{lang || "code"}</span>
        <button className="code-copy" onClick={copy}>
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>
      <pre>
        <code
          dangerouslySetInnerHTML={{ __html: highlighted }}
          style={{ fontFamily: "var(--mono)" }}
        />
      </pre>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const code = String(children).replace(/\n$/, "");
            return match ? (
              <CodeBlock lang={match[1]} code={code} />
            ) : (
              <code className="inline-code" {...props}>
                {children}
              </code>
            );
          },
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ToolCard({
  tool,
  running,
  onToggle,
}: {
  tool: ChatTool;
  running: boolean;
  onToggle: () => void;
}) {
  const icon =
    tool.category === "files" ? "📁" : tool.category === "web" ? "🌐" : tool.category === "math" ? "🧮" : "🕐";
  return (
    <div className={`skill-row ${tool.enabled ? "on" : "off"}`}>
      <span className="skill-icon">{icon}</span>
      <div className="skill-info">
        <div className="skill-name">{tool.def.function.name}</div>
        <div className="skill-desc">{tool.def.function.description}</div>
      </div>
      <button
        className={`toggle ${tool.enabled ? "on" : ""}`}
        onClick={onToggle}
        disabled={running}
        title={tool.enabled ? "Disable" : "Enable"}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

export default function ChatPanel({
  baseUrl,
  apiKey,
  model,
  tools,
  workspace,
  onWorkspaceChange,
  onToolsChange,
}: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingTools, setPendingTools] = useState<PendingTool[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [fullAccess, setFullAccess] = useState(
    () => localStorage.getItem("llamastudio-fullaccess") === "1"
  );
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const autoScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    autoScroll();
  }, [messages, pendingTools, autoScroll]);

  const systemPrompt = useMemo(
    () =>
      "You are LlamaStudio, a helpful local AI assistant running entirely on the user's machine. " +
      "Answer accurately and concisely. Use the provided tools when they help — e.g. list_files / read_file / write_file " +
      "to inspect and edit files, calculate for math, get_current_time for dates. You CAN create and edit files. " +
      `Your file access is ${fullAccess ? "NOT sandboxed — you can list/read files anywhere on this PC." : `sandboxed to the workspace: ${workspace || "(not set)"}`} ` +
      (fullAccess
        ? ""
        : "Paths outside it are blocked — if asked to access something outside the workspace, say so and offer to list inside the workspace instead. ") +
      "If you cannot complete a request with the available tools, say so clearly. " +
      "Format answers with Markdown (headings, lists, code blocks) for readability.",
    [workspace, fullAccess]
  );

  const handleSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setError(null);
    const userMsg: ChatMsg = { id: uid(), role: "user", content: text, ts: Date.now() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;

    // Assistant placeholder that we mutate as deltas arrive.
    const asstId = uid();
    setMessages((prev) => [
      ...prev,
      { id: asstId, role: "assistant", content: "", ts: Date.now() },
    ]);

    const ctx = { workspace, fullAccess, baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
    const history = newMessages.map((m) => ({
      role: m.role === "tool" ? ("tool" as const) : m.role,
      content: m.content,
    }));

    try {
      await streamChat({
        baseUrl,
        apiKey,
        model,
        messages: [{ role: "system", content: systemPrompt }, ...history],
        tools: enabledDefs(tools),
        signal: abort.signal,
        maxToolRounds: 6,
        onEvent: (ev) => {
          if (ev.type === "delta") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId ? { ...m, content: m.content + (ev.content ?? "") } : m
              )
            );
          } else if (ev.type === "reasoning") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === asstId
                  ? { ...m, reasoning: (m.reasoning ?? "") + (ev.reasoning ?? "") }
                  : m
              )
            );
          } else if (ev.type === "error") {
            setError(ev.error || "chat error");
            setMessages((prev) =>
              prev.map((m) => (m.id === asstId ? { ...m, error: true } : m))
            );
          }
        },
        toolExec: async (call: ToolCallArg) => {
          setPendingTools((prev) => [
            ...prev,
            { name: call.function.name, args: call.function.arguments, running: true },
          ]);
          const r: ToolResult = await runTool(tools, call, ctx);
          setPendingTools((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { ...copy[copy.length - 1], result: r.content, ok: r.ok, running: false };
            return copy;
          });
          return r;
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(false);
      abortRef.current = null;
      setTimeout(() => setPendingTools([]), 1200);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const clear = () => {
    if (streaming) return;
    setMessages([]);
    setPendingTools([]);
    setError(null);
  };

  const removeMsg = (id: string) => {
    if (streaming) return;
    setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const retryLast = () => {
    if (streaming || messages.length === 0) return;
    const lastIdx = [...messages].reverse().findIndex((m) => m.role === "user");
    if (lastIdx < 0) return;
    const idx = messages.length - 1 - lastIdx;
    const last = messages[idx];
    setMessages((prev) => prev.slice(0, idx));
    setInput(last.content);
    taRef.current?.focus();
  };

  return (
    <div className="chat-panel">
      <div className="chat-topbar">
        <div className="chat-model-info">
          <span className="model-dot" />
          {model || "no model"}
          {streaming && <span className="streaming-tag">streaming…</span>}
        </div>
        <div className="chat-actions">
          <button
            className="chat-btn"
            onClick={() => setShowSkills((s) => !s)}
            title="Skills & tools"
          >
            🧰 Skills
          </button>
          <button className="chat-btn" onClick={retryLast} disabled={streaming} title="Re-send last question">
            ↺ Retry
          </button>
          <button className="chat-btn" onClick={clear} disabled={streaming} title="Clear conversation">
            🗑 Clear
          </button>
        </div>
      </div>

      {showSkills && (
        <div className="skills-panel">
          <div className="skills-header">
            <h4>Skills &amp; Tools</h4>
            <span className="muted">The model can call enabled tools while chatting.</span>
          </div>
          <div className="workspace-row">
            <label>Workspace</label>
            <div className="ws-input-row">
              <input
                className="path-input"
                value={workspace}
                onChange={(e) => onWorkspaceChange(e.target.value)}
                placeholder="C:\Users\you\projects"
                disabled={fullAccess}
              />
              <button
                className="btn-small"
                onClick={async () => {
                  try {
                    const dir = await openDirDialog({ title: "Select workspace folder" });
                    if (typeof dir === "string") onWorkspaceChange(dir);
                  } catch {}
                }}
                title="Browse folder"
                disabled={fullAccess}
              >
                📂
              </button>
            </div>
            <div className="full-access-row">
              <span className="skill-info">
                <span className="skill-name">Full filesystem access</span>
                <span className="skill-desc">
                  Let the model read/list anywhere on this PC (ignores the workspace sandbox).
                </span>
              </span>
              <button
                className={`toggle ${fullAccess ? "on" : ""}`}
                onClick={() => {
                  const next = !fullAccess;
                  setFullAccess(next);
                  localStorage.setItem("llamastudio-fullaccess", next ? "1" : "0");
                }}
                title={fullAccess ? "Restrict to workspace" : "Allow anywhere"}
              >
                <span className="knob" />
              </button>
            </div>
            <p className="muted small">
              File tools are scoped to the workspace by default. Enable Full filesystem access to
              let the model list/read files anywhere on the PC.
            </p>
          </div>
          <div className="skills-list">
            {tools.map((t) => (
              <ToolCard
                key={t.def.function.name}
                tool={t}
                running={streaming}
                onToggle={() => {
                  onToolsChange(
                    tools.map((x) =>
                      x.def.function.name === t.def.function.name
                        ? { ...x, enabled: !x.enabled }
                        : x
                    )
                  );
                }}
              />
            ))}
          </div>
        </div>
      )}

      <div className="chat-history" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="chat-empty">
            <div className="empty-logo">🦙</div>
            <p>
              Start a conversation with your model.{" "}
              {tools.some((t) => t.enabled) && (
                <span>Tools are enabled — try "what files are in my workspace?"</span>
              )}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} onDelete={() => removeMsg(m.id)} />
        ))}
        {pendingTools.length > 0 && (
          <div className="tool-stack">
            {pendingTools.map((p, i) => (
              <div key={i} className={`tool-card ${p.running ? "running" : ""}`}>
                <div className="tool-card-head">
                  <span className="tool-spinner" />
                  <span className="tool-name">{p.name}</span>
                  {p.running && <span className="tool-status">running…</span>}
                </div>
                {p.args && (
                  <pre className="tool-args">{prettyArgs(p.args)}</pre>
                )}
                {p.result && (
                  <pre className={`tool-result ${p.ok ? "" : "err"}`}>
                    {truncateResult(p.result)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
        {error && <div className="chat-error">⚠ {error}</div>}
      </div>

      <div className="chat-input">
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={1}
        />
        {streaming ? (
          <button className="btn-stop" onClick={stop}>
            ■ Stop
          </button>
        ) : (
          <button className="btn-primary" onClick={handleSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg, onDelete }: { msg: ChatMsg; onDelete: () => void }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const [copied, setCopied] = useState(false);

  if (msg.role === "user") {
    return (
      <div className="msg-row user">
        <div className="msg-content user">
          <div className="msg-text">{msg.content}</div>
          <div className="msg-meta">
            <span className="msg-time">{fmtTime(msg.ts)}</span>
            <button className="msg-x" onClick={onDelete} title="Delete">✕</button>
          </div>
        </div>
      </div>
    );
  }

  if (msg.role === "tool") {
    return (
      <div className="msg-row tool">
        <div className="msg-content tool">
          <div className="msg-text mono">{msg.content}</div>
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg-row assistant">
      <div className="msg-avatar">🦙</div>
      <div className="msg-body">
        <div className="msg-content assistant">
          {msg.reasoning && (
            <div className="reasoning-block">
              <button className="reasoning-toggle" onClick={() => setShowReasoning((s) => !s)}>
                {showReasoning ? "▾" : "▸"} Thinking {showReasoning ? "" : `(${msg.reasoning.length} chars)`}
              </button>
              {showReasoning && (
                <div className="reasoning-text">{msg.reasoning}</div>
              )}
            </div>
          )}
          {msg.content ? (
            <Markdown text={msg.content} />
          ) : msg.error ? (
            <div className="err-text">⚠ failed to generate a response</div>
          ) : (
            <span className="cursor-blink" />
          )}
          <div className="msg-meta">
            <span className="msg-time">{fmtTime(msg.ts)}</span>
            {msg.content && (
              <button
                className="msg-x"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(msg.content);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {}
                }}
                title="Copy"
              >
                {copied ? "✓" : "⧉"}
              </button>
            )}
            <button className="msg-x" onClick={onDelete} title="Delete">✕</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function prettyArgs(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function truncateResult(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + "\n… truncated" : s;
}

function fmtTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
