import { useEffect, useRef, useState } from "react";
import type { Agent, AiProposal } from "@/lib/data";
import { listAgents, listPendingProposals, decideProposal, sendAiMessage, DataError } from "@/lib/data";
import { marked } from "marked";
import DOMPurify from "dompurify";

type ChatMsg = { role: "user" | "assistant"; text: string };

// Konfigurera marked — ingen async, inga oönskade features
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

const TOOL_LABELS: Record<string, string> = {
  create_record: "Skapa post",
  update_record: "Uppdatera post",
  create_task: "Skapa uppgift",
  add_activity: "Logga aktivitet",
};

const TOOL_ICONS: Record<string, string> = {
  create_record: "+",
  update_record: "~",
  create_task: "✓",
  add_activity: "●",
};

const AGENT_ICONS: Record<string, JSX.Element> = {
  sales: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 12 5 6 9 9 15 2" />
      <polyline points="11 2 15 2 15 6" />
    </svg>
  ),
  delivery: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 3h9v7H1z" />
      <path d="M10 6h3l2 3v4h-5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="13" r="1.5" />
    </svg>
  ),
  support: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h12a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 3V4a1 1 0 011-1z" />
    </svg>
  ),
  management: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <line x1="5" y1="6" x2="11" y2="6" />
      <line x1="5" y1="10" x2="9" y2="10" />
    </svg>
  ),
};

function defaultAgentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="10" height="8" rx="2" />
      <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AiChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentKey, setAgentKey] = useState<string>("");
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listAgents().then((a) => {
      setAgents(a);
      if (a.length > 0) setAgentKey(a[0].key);
    });
    refreshProposals();
  }, []);

  useEffect(() => {
    setThreadId(undefined);
    setMessages([]);
  }, [agentKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function refreshProposals() {
    listPendingProposals().then(setProposals).catch(() => {});
  }

  async function send() {
    if (!input.trim() || !agentKey) return;
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setSending(true);
    setError(null);
    try {
      const res = await sendAiMessage(agentKey, text, threadId);
      setThreadId(res.threadId);
      setMessages((m) => [...m, { role: "assistant", text: res.reply || "…" }]);
      if (res.pendingProposals.length > 0) refreshProposals();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte nå AI-agenten. Kontrollera att API-nyckeln är konfigurerad.");
    } finally {
      setSending(false);
    }
  }

  async function onDecide(id: string, approve: boolean) {
    try {
      await decideProposal(id, approve);
      refreshProposals();
    } catch (e) {
      alert(e instanceof DataError ? e.message : "Kunde inte hantera förslaget.");
    }
  }

  const activeAgent = agents.find((a) => a.key === agentKey);

  return (
    <div className="page">
      <div className="agent-tabs">
        {agents.map((a) => (
          <button key={a.key} className="agent-tab" aria-current={a.key === agentKey} onClick={() => setAgentKey(a.key)}>
            {AGENT_ICONS[a.key] ?? defaultAgentIcon()}
            {a.name}
          </button>
        ))}
      </div>

      {activeAgent && (
        <div className="ai-agent-desc">
          Chatta med {activeAgent.name}
        </div>
      )}

      <div className="ai-layout">
        <div className="card ai-chat-card">
          <div className="ai-messages">
            {messages.length === 0 && (
              <div className="empty-state">
                <div className="ai-empty-icon">{AGENT_ICONS[agentKey] ?? defaultAgentIcon()}</div>
                Skriv en fråga nedan för att börja chatta med {activeAgent?.name ?? "agenten"}.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ai-bubble ai-bubble--${m.role}`}>
                {m.role === "assistant" ? (
                  <div
                    className="ai-markdown"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }}
                  />
                ) : (
                  m.text
                )}
              </div>
            ))}
            {sending && (
              <div className="ai-bubble ai-bubble--assistant ai-bubble--pending">
                <div className="ai-typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          {error && <div className="formfield__error" style={{ margin: "0 var(--sp-6) var(--sp-4)" }}>{error}</div>}
          <div className="ai-input-row">
            <textarea
              className="input input--area ai-input"
              placeholder="Fråga agenten…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <button className="btn btn--brand" onClick={send} disabled={sending || !input.trim()}>Skicka</button>
          </div>
        </div>

        <div className="card">
          <div className="section-title">
            Väntande förslag
            {proposals.length > 0 && (
              <span className="section-title__badge">{proposals.length}</span>
            )}
          </div>
          {proposals.length === 0 && <div className="empty-state">Inga väntande förslag.</div>}
          {proposals.map((p) => (
            <div key={p.id} className="proposal-row">
              {p.actions.map((a, i) => (
                <div key={i} className="proposal-row__tool">
                  <span className="proposal-row__tool-icon">{TOOL_ICONS[a.tool] ?? "⚡"}</span>
                  {TOOL_LABELS[a.tool] ?? a.tool}
                </div>
              ))}
              {p.rationale && <div className="proposal-row__rationale">{p.rationale}</div>}
              <div className="proposal-row__actions">
                <button className="btn btn--brand btn--sm" onClick={() => onDecide(p.id, true)}>Godkänn</button>
                <button className="btn btn--danger btn--sm" onClick={() => onDecide(p.id, false)}>Avvisa</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
