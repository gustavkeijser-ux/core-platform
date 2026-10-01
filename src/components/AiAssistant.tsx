import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { type AiProposal, listPendingProposals, decideProposal, sendAiMessage, DataError } from "@/lib/data";
import { getCaseSummary, type CaseSummary } from "@/lib/cases";
import { loadSummary } from "@/lib/statusCounts";

/* =============================================================================
   ConnectEstate AI — en assistent för hela systemet.
   Öppnas från ikonen ovanför Import i menyn som en liten panel nere till
   vänster: först en mini-översikt med förslag på frågor, sedan chatten.
   Assistenten läser allt användaren själv får se; ändringar blir förslag
   som godkänns här i panelen.
   ========================================================================== */

marked.setOptions({ gfm: true, breaks: true });
const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);

/** Maskoten: en skärm med ett blinkande ansikte, i våra färger. */
export function AiMascot({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg className={`ai-mascot${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      {/* hörlurar */}
      <path d="M7 24c0-9 7.6-16 17-16s17 7 17 16" fill="none" stroke="var(--ai-accent)" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="2.5" y="21" width="6" height="12" rx="3" fill="var(--ai-accent)" />
      <rect x="39.5" y="21" width="6" height="12" rx="3" fill="var(--ai-accent)" />
      {/* öron */}
      <path d="M13.5 13.5 15 6.8c.2-.9 1.3-1.2 1.9-.5l4.4 5.2z" fill="var(--ai-accent)" />
      <path d="M34.5 13.5 33 6.8c-.2-.9-1.3-1.2-1.9-.5l-4.4 5.2z" fill="var(--ai-accent)" />
      {/* huvud och skärm */}
      <rect x="7.5" y="10.5" width="33" height="30" rx="11" fill="var(--ai-frame)" />
      <rect x="11.5" y="14.5" width="25" height="22" rx="7" fill="var(--ai-screen)" />
      {/* ansikte: C-öga, blinkande öga, leende */}
      <g fill="none" stroke="var(--ai-glow)" strokeWidth="2.4" strokeLinecap="round">
        <path d="M21.2 21.4a3.2 3.2 0 1 0 0 3.9" />
        <path className="ai-mascot__wink" d="M26.5 23.4h5" />
        <path d="M20.5 29.2c2.2 2 4.8 2 7 0" />
      </g>
    </svg>
  );
}

type Msg = { role: "user" | "assistant"; text: string; proposals?: AiProposal[] };

const TOOL_LABEL: Record<string, string> = {
  create_record: "Skapa post", update_record: "Uppdatera post", create_task: "Skapa uppgift", add_activity: "Logga aktivitet",
};

function fmtVal(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Läsbar beskrivning av vad ett förslag gör. */
function proposalLines(p: AiProposal): string[] {
  const out: string[] = [];
  for (const a of p.actions) {
    const g = a.args ?? {};
    if (a.tool === "create_task") {
      out.push(`”${fmtVal(g.title)}”${g.dueAt ? ` · senast ${new Date(String(g.dueAt)).toLocaleDateString("sv-SE")}` : ""}`);
    } else if (a.tool === "add_activity") {
      out.push(String(g.body ?? "").slice(0, 160));
    } else {
      if (a.tool === "create_record" && g.objectType) out.push(`Typ: ${g.objectType}`);
      if (g.status) out.push(`Status → ${g.status}`);
      const data = (g.data ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data).slice(0, 8)) out.push(`${k}: ${fmtVal(v)}`);
    }
  }
  return out;
}

function ProposalCard({ p }: { p: AiProposal }) {
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done"; text?: string; ok?: boolean }>({ kind: "idle" });
  async function decide(approve: boolean) {
    setState({ kind: "busy" });
    try {
      const r = await decideProposal(p.id, approve);
      const err = r.result && !Array.isArray(r.result) ? r.result.error : undefined;
      setState(r.state === "applied" ? { kind: "done", ok: true, text: "Genomfört" }
        : r.state === "rejected" ? { kind: "done", ok: false, text: "Avvisat" }
        : { kind: "done", ok: false, text: `Gick inte att genomföra${err ? `: ${err}` : ""}` });
    } catch (e) {
      setState({ kind: "idle", text: e instanceof DataError ? e.message : "Kunde inte hantera förslaget." });
    }
  }
  const tool = p.actions[0]?.tool ?? "";
  return (
    <div className={`ai-proposal${state.kind === "done" ? (state.ok ? " ai-proposal--ok" : " ai-proposal--off") : ""}`}>
      <div className="ai-proposal__head">
        <span className="ai-proposal__tag">Förslag</span>
        {TOOL_LABEL[tool] ?? tool}
      </div>
      <ul className="ai-proposal__lines">
        {proposalLines(p).map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      {state.kind === "done" ? (
        <div className="ai-proposal__result">{state.ok ? "✓ " : ""}{state.text}</div>
      ) : (
        <div className="ai-proposal__actions">
          {state.text && <span className="formfield__error">{state.text}</span>}
          <button className="btn btn--ghost btn--sm" disabled={state.kind === "busy"} onClick={() => void decide(false)}>Avvisa</button>
          <button className="btn btn--brand btn--sm" disabled={state.kind === "busy"} onClick={() => void decide(true)}>
            {state.kind === "busy" ? "Sparar…" : "Godkänn"}
          </button>
        </div>
      )}
    </div>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
    </svg>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  userName: string;
  /** Vad användaren tittar på just nu, t.ex. "Ärenden" eller "posten 'FREJA 1' (id …)". */
  context?: string;
  hasOpenRecord?: boolean;
};

export function AiPanel({ open, onClose, userName, context, hasOpenRecord }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<AiProposal[]>([]);
  const [cases, setCases] = useState<CaseSummary | null>(null);
  const [tasksDue, setTasksDue] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Mini-översikten laddas varje gång panelen öppnas på startläget.
  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 60);
    if (msgs.length > 0) return;
    getCaseSummary().then(setCases).catch(() => setCases(null));
    loadSummary().then((s) => setTasksDue(s.tasksDueSoon?.count ?? 0)).catch(() => setTasksDue(null));
    listPendingProposals().then(setPending).catch(() => setPending([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, sending]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || sending) return;
    setInput("");
    setError(null);
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setSending(true);
    try {
      const res = await sendAiMessage(q, threadId, context);
      setThreadId(res.threadId);
      let proposals: AiProposal[] = [];
      if (res.pendingProposals.length) {
        const all = await listPendingProposals().catch(() => []);
        proposals = all.filter((p) => res.pendingProposals.includes(p.id));
      }
      setMsgs((m) => [...m, { role: "assistant", text: res.reply || "…", proposals }]);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte nå AI-assistenten.");
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }

  function newChat() {
    setMsgs([]); setThreadId(undefined); setError(null); setInput("");
    listPendingProposals().then(setPending).catch(() => {});
    inputRef.current?.focus();
  }

  const first = (userName || "").split(/[\s@]/)[0];
  const hour = new Date().getHours();
  const greet = hour < 10 ? "God morgon" : hour < 18 ? "Hej" : "God kväll";
  const suggestions = [
    ...(hasOpenRecord ? ["Sammanfatta posten jag har öppen"] : []),
    "Sammanfatta läget i CRM:et idag",
    "Vilka ärenden har inte fått svar än?",
    "Vad har jag för uppgifter den här veckan?",
    "Hur går Door2Door-försäljningen?",
  ].slice(0, 4);
  const tiles = [
    cases && { n: cases.today.unassigned, label: "Otilldelade ärenden", q: "Vilka ärenden är otilldelade, och vilka är mest bråttom?" },
    cases && { n: cases.today.createdToday, label: "Nya ärenden idag", q: "Sammanfatta dagens nya ärenden" },
    tasksDue != null && { n: tasksDue, label: "Uppgifter som förfaller", q: "Vilka uppgifter förfaller snart?" },
  ].filter(Boolean) as Array<{ n: number; label: string; q: string }>;

  return (
    <>
      {open && <div className="ai-panel-scrim" onClick={onClose} />}
      <section className={`ai-panel${open ? " ai-panel--open" : ""}`} role="dialog" aria-label="ConnectEstate AI" aria-hidden={!open}>
        <header className="ai-panel__head">
          <span className="ai-panel__avatar"><AiMascot size={30} /></span>
          <div className="ai-panel__titles">
            <div className="ai-panel__title">ConnectEstate AI</div>
            <div className="ai-panel__sub"><span className="ai-panel__dot" />Når hela systemet</div>
          </div>
          {msgs.length > 0 && (
            <button className="ai-panel__iconbtn" onClick={newChat} title="Ny konversation" aria-label="Ny konversation">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
            </button>
          )}
          <button className="ai-panel__iconbtn" onClick={onClose} title="Stäng (Esc)" aria-label="Stäng">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="ai-panel__body" ref={scrollRef}>
          {msgs.length === 0 ? (
            <div className="ai-home">
              <div className="ai-home__hero">
                <AiMascot size={64} className="ai-mascot--hero" />
                <div>
                  <div className="ai-home__greet">{greet}{first ? ` ${first}` : ""}!</div>
                  <div className="ai-home__lead">Fråga om kunder, fastigheter, affärer, leveranser, D2D eller ärenden — jag letar i hela CRM:et.</div>
                </div>
              </div>

              {tiles.length > 0 && (
                <div className="ai-home__tiles">
                  {tiles.map((t) => (
                    <button key={t.label} className="ai-tile" onClick={() => void ask(t.q)}>
                      <span className="ai-tile__n">{t.n}</span>
                      <span className="ai-tile__label">{t.label}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="ai-home__label">Förslag</div>
              <div className="ai-home__chips">
                {suggestions.map((s) => (
                  <button key={s} className="ai-chip" onClick={() => void ask(s)}>
                    <span>{s}</span>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
                  </button>
                ))}
              </div>

              {pending.length > 0 && (
                <>
                  <div className="ai-home__label">Väntar på ditt godkännande · {pending.length}</div>
                  {pending.slice(0, 5).map((p) => <ProposalCard key={p.id} p={p} />)}
                </>
              )}
            </div>
          ) : (
            <div className="ai-thread">
              {msgs.map((m, i) => (
                <div key={i} className={`ai-msg ai-msg--${m.role}`}>
                  {m.role === "assistant" && <span className="ai-msg__avatar"><AiMascot size={22} /></span>}
                  <div className="ai-msg__col">
                    {m.role === "assistant"
                      ? <div className="ai-msg__bubble ai-markdown" dangerouslySetInnerHTML={{ __html: md(m.text) }} />
                      : <div className="ai-msg__bubble">{m.text}</div>}
                    {m.proposals?.map((p) => <ProposalCard key={p.id} p={p} />)}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="ai-msg ai-msg--assistant">
                  <span className="ai-msg__avatar"><AiMascot size={22} /></span>
                  <div className="ai-msg__bubble ai-msg__bubble--typing">
                    <span className="ai-typing"><span /><span /><span /></span>
                    Letar i CRM:et…
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <div className="ai-panel__error">{error}</div>}
        </div>

        <form className="ai-panel__compose" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
          <textarea
            ref={inputRef}
            className="ai-panel__input"
            rows={1}
            placeholder="Fråga vad som helst om CRM:et…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }}
          />
          <button className="ai-panel__send" type="submit" disabled={sending || !input.trim()} aria-label="Skicka">
            <SendIcon />
          </button>
        </form>
        <div className="ai-panel__foot">Ändringar kräver ditt godkännande · AI kan ha fel</div>
      </section>
    </>
  );
}
