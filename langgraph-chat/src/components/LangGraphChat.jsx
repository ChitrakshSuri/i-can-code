import { useState, useEffect, useRef, useCallback } from "react";

const BACKEND_URL = "http://localhost:8000"; // Change to your FastAPI server URL

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchThreads() {
  const res = await fetch(`${BACKEND_URL}/threads`);
  if (!res.ok) throw new Error("Failed to fetch threads");
  return res.json(); // string[]
}

async function fetchHistory(threadId) {
  const res = await fetch(`${BACKEND_URL}/history/${threadId}`);
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json(); // { role, content }[]
}

async function* streamChat(threadId, userMessage) {
  const res = await fetch(`${BACKEND_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, message: userMessage }),
  });
  if (!res.ok) throw new Error("Stream failed");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") return;
        try {
          yield JSON.parse(raw);
          // shape: { type: "token"|"tool_start"|"tool_end", content: string }
        } catch {}
      }
    }
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolBadge({ name, done }) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "4px 10px",
      borderRadius: "var(--border-radius-md)",
      background: done ? "var(--color-background-success)" : "var(--color-background-warning)",
      color: done ? "var(--color-text-success)" : "var(--color-text-warning)",
      fontSize: 12,
      fontFamily: "var(--font-mono)",
      marginBottom: 8,
      transition: "all 0.3s ease",
    }}>
      <span style={{ fontSize: 14 }}>{done ? "✓" : "⟳"}</span>
      {done ? `${name} — done` : `Using ${name}…`}
    </div>
  );
}

function Message({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
      marginBottom: 16,
    }}>
      {msg.toolEvents?.map((t, i) => (
        <ToolBadge key={i} name={t.name} done={t.done} />
      ))}
      <div style={{
        maxWidth: isUser ? "72%" : "82%",
        padding: isUser ? "10px 14px" : "10px 0",
        borderRadius: isUser
          ? "16px 16px 4px 16px"
          : "4px 16px 16px 16px",
        background: isUser
          ? "var(--color-background-secondary)"
          : "transparent",
        color: "var(--color-text-primary)",
        fontSize: 14,
        lineHeight: 1.65,
        border: isUser
          ? "0.5px solid var(--color-border-tertiary)"
          : "0.5px solid transparent",
        boxShadow: isUser ? "var(--shadow-soft)" : "none",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {msg.content}
        {msg.streaming && (
          <span style={{
            display: "inline-block",
            width: 8,
            height: 14,
            background: "var(--color-text-secondary)",
            marginLeft: 3,
            verticalAlign: "text-bottom",
            animation: "blink 1s step-end infinite",
          }} />
        )}
      </div>
    </div>
  );
}

function ThreadItem({ threadId, active, onClick }) {
  const short = String(threadId).slice(0, 8);
  return (
    <button
      className="thread-btn"
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "8px 12px",
        borderRadius: "var(--border-radius-md)",
        border: active
          ? "0.5px solid var(--color-border-secondary)"
          : "0.5px solid transparent",
        background: active
          ? "var(--color-background-primary)"
          : "transparent",
        color: "var(--color-text-primary)",
        fontSize: 13,
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        marginBottom: 2,
        transition: "all 0.15s",
        boxShadow: active ? "var(--shadow-soft)" : "none",
      }}
    >
      <span style={{ color: "var(--color-text-secondary)", marginRight: 6 }}>
        #
      </span>
      {short}…
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LangGraphChat() {
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // ── Thread ops ────────────────────────────────────────────────────────────
  const loadThread = useCallback(async (threadId) => {
    setActiveThread(threadId);
    try {
      const history = await fetchHistory(threadId);
      setMessages(history);
    } catch {
      setMessages([]);
    }
  }, []);

  // ── Boot ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchThreads()
      .then((ids) => {
        setThreads(ids);
        if (ids.length > 0) {
          loadThread(ids[ids.length - 1]);
        }
      })
      .catch(() => {
        setError("Could not reach backend. Is it running?");
      });
  }, [loadThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const newChat = useCallback(() => {
    const id = crypto.randomUUID();
    setThreads((prev) => [id, ...prev]);
    setActiveThread(id);
    setMessages([]);
    inputRef.current?.focus();
  }, []);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const threadId = activeThread ?? (() => {
      const id = crypto.randomUUID();
      setThreads((prev) => [id, ...prev]);
      setActiveThread(id);
      return id;
    })();

    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setStreaming(true);

    // Placeholder for assistant reply
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", streaming: true, toolEvents: [] },
    ]);

    try {
      let content = "";
      let toolEvents = [];
      let activeToolName = null;

      for await (const event of streamChat(threadId, text)) {
        if (event.type === "token") {
          const updatedContent = content + event.content;
          content = updatedContent;

          const updatedToolEvents = [...toolEvents];

          setMessages((prev) => {
            const next = [...prev];

            next[next.length - 1] = {
              ...next[next.length - 1],
              content: updatedContent,
              toolEvents: updatedToolEvents,
            };

            return next;
          });
        } else if (event.type === "tool_start") {
          activeToolName = event.content;
          const updatedToolEvents = [
            ...toolEvents,
            { name: event.content, done: false },
          ];

          toolEvents = updatedToolEvents;

          setMessages((prev) => {
            const next = [...prev];

            next[next.length - 1] = {
              ...next[next.length - 1],
              toolEvents: updatedToolEvents,
            };

            return next;
          });
        } else if (event.type === "tool_end") {
          const toolName = activeToolName;
          const updatedToolEvents = toolEvents.map((t) =>
            t.name === toolName ? { ...t, done: true } : t
          );

          toolEvents = updatedToolEvents;

          setMessages((prev) => {
            const next = [...prev];

            next[next.length - 1] = {
              ...next[next.length - 1],
              toolEvents: updatedToolEvents,
            };

            return next;
          });
          activeToolName = null;
        } else if (event.type === "error") {
          throw new Error(event.content);
        }
      }

      // Finalize
      setMessages((prev) => {
        const next = [...prev];
        const last = { ...next[next.length - 1] };
        last.streaming = false;
        last.toolEvents = toolEvents.map((t) => ({ ...t, done: true }));
        next[next.length - 1] = last;
        return next;
      });
    } catch (e) {
      setError("Stream error: " + e.message);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setStreaming(false);
    }
  }, [input, streaming, activeThread]);

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes spin { to{transform:rotate(360deg)} }
        .thread-btn:hover { background: var(--color-background-secondary) !important; }
        .send-btn:not(:disabled):hover { background: var(--color-accent-hover) !important; }
        textarea:focus { outline: none; border-color: var(--color-border-secondary) !important; }
        textarea::placeholder { color: var(--color-text-tertiary); }
      `}</style>

      <div style={{
        display: "flex",
        height: "100vh",
        fontFamily: "var(--font-sans)",
        background: "var(--color-background-tertiary)",
        overflow: "hidden",
      }}>

        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <div style={{
          width: sidebarOpen ? 220 : 0,
          minWidth: sidebarOpen ? 220 : 0,
          overflow: "hidden",
          transition: "all 0.2s ease",
          background: "var(--color-background-secondary)",
          borderRight: "0.5px solid var(--color-border-tertiary)",
          display: "flex",
          flexDirection: "column",
          padding: sidebarOpen ? "16px 10px" : 0,
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
            paddingLeft: 4,
          }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)" }}>
              Conversations
            </span>
          </div>

          <button
            onClick={newChat}
            style={{
              width: "100%",
              padding: "7px 12px",
              borderRadius: "var(--border-radius-md)",
            border: "0.5px solid var(--color-border-secondary)",
              background: "var(--color-background-primary)",
              color: "var(--color-text-primary)",
              fontSize: 13,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 12,
              boxShadow: "var(--shadow-soft)",
            }}
          >
            + New chat
          </button>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {threads.map((id) => (
              <ThreadItem
                key={id}
                threadId={id}
                active={id === activeThread}
                onClick={() => loadThread(id)}
              />
            ))}
          </div>
        </div>

        {/* ── Main ────────────────────────────────────────────────────── */}
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>

          {/* Header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 20px",
            borderBottom: "0.5px solid var(--color-border-tertiary)",
            background: "var(--color-background-tertiary)",
          }}>
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-secondary)",
                fontSize: 18,
                padding: 4,
                borderRadius: "var(--border-radius-md)",
                lineHeight: 1,
              }}
              aria-label="Toggle sidebar"
            >
              ☰
            </button>
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)" }}>
              LangGraph Chat
            </span>
            {activeThread && (
              <span style={{
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-secondary)",
                marginLeft: "auto",
              }}>
                {String(activeThread).slice(0, 8)}…
              </span>
            )}
          </div>

          {/* Messages */}
          <div style={{
            flex: 1,
            overflowY: "auto",
            padding: "28px min(6vw, 56px)",
          }}>
            {error && (
              <div style={{
                padding: "10px 14px",
                borderRadius: "var(--border-radius-md)",
                background: "var(--color-background-danger)",
                color: "var(--color-text-danger)",
                fontSize: 13,
                marginBottom: 16,
                border: "0.5px solid var(--color-border-danger)",
              }}>
                {error}
              </div>
            )}

            {messages.length === 0 && !streaming && (
              <div style={{
                textAlign: "center",
                color: "var(--color-text-tertiary)",
                fontSize: 14,
                marginTop: 80,
              }}>
                Start a conversation
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} style={{ maxWidth: 840, margin: "0 auto" }}>
                <Message msg={msg} />
              </div>
            ))}
            <div ref={bottomRef} style={{ maxWidth: 840, margin: "0 auto" }} />
          </div>

          {/* Input */}
          <div style={{
            padding: "12px 20px 16px",
            borderTop: "0.5px solid var(--color-border-tertiary)",
            background: "var(--color-background-tertiary)",
          }}>
            <div style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              background: "var(--color-background-secondary)",
              border: "0.5px solid var(--color-border-secondary)",
              borderRadius: "var(--border-radius-lg)",
              padding: "8px 8px 8px 14px",
              maxWidth: 840,
              margin: "0 auto",
              boxShadow: "var(--shadow-soft)",
            }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={streaming}
                placeholder="Message…"
                rows={1}
                style={{
                  flex: 1,
                  border: "none",
                  background: "transparent",
                  resize: "none",
                  color: "var(--color-text-primary)",
                  fontSize: 14,
                  lineHeight: 1.6,
                  padding: 0,
                  fontFamily: "var(--font-sans)",
                  maxHeight: 120,
                  overflowY: "auto",
                }}
              />
              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={!input.trim() || streaming}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "var(--border-radius-md)",
                  border: "0.5px solid var(--color-border-info)",
                  background: streaming ? "var(--color-background-secondary)" : "var(--color-accent)",
                  color: "var(--color-text-on-accent)",
                  fontSize: 16,
                  cursor: streaming || !input.trim() ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  opacity: !input.trim() ? 0.4 : 1,
                  transition: "all 0.15s",
                }}
                aria-label="Send message"
              >
                {streaming ? (
                  <span style={{
                    display: "inline-block",
                    width: 14,
                    height: 14,
                    border: "2px solid var(--color-text-on-accent)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }} />
                ) : "↑"}
              </button>
            </div>
            <p style={{
              fontSize: 11,
              color: "var(--color-text-tertiary)",
              margin: "6px 0 0",
              textAlign: "center",
            }}>
              Enter to send · Shift+Enter for newline
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
