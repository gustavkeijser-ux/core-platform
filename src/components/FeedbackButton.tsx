import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/* =============================================================================
   Feedbackknappen längst ned till höger. Öppnar en liten ruta där man väljer
   kategori, modul och prioritet och beskriver vad det gäller. Skickas till
   Teams via edge function feedback-send (och sparas alltid i tabellen feedback).
   ========================================================================== */

const CATEGORIES = ["Fel / bugg", "Förbättring", "Ny funktion", "Design", "Fråga", "Övrigt"];
const PRIORITIES: Array<{ key: string; label: string }> = [
  { key: "low", label: "Låg" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "Hög" },
  { key: "critical", label: "Kritisk" },
];

function WarnIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13.5" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

type Props = {
  /** Menyns moduler att välja bland. */
  modules: string[];
  /** Modulen man står i när man öppnar rutan (förvald). */
  currentModule: string;
};

export function FeedbackButton({ modules, currentModule }: Props) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [module, setModule] = useState(currentModule);
  const [priority, setPriority] = useState("normal");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { teams: boolean }>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Förval: modulen man står i, varje gång rutan öppnas.
  useEffect(() => {
    if (!open) return;
    setModule(modules.includes(currentModule) ? currentModule : "Annat");
    setTimeout(() => textRef.current?.focus(), 60);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function reset() {
    setCategory(CATEGORIES[0]); setPriority("normal"); setMessage(""); setError(null); setDone(null);
  }

  async function send() {
    if (!message.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const { data, error: err } = await supabase.functions.invoke("feedback-send", {
        body: { category, module, priority, message: message.trim(), page: window.location.hash || "#/" },
      });
      if (err) {
        let detail = "Kunde inte skicka feedbacken.";
        try { const b = await (err as { context?: Response }).context?.json(); if (b?.error) detail = b.error; } catch { /* */ }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      setDone({ teams: !!data?.teams });
      setTimeout(() => { setOpen(false); reset(); }, 2600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte skicka feedbacken.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className={`fb-btn${open ? " fb-btn--open" : ""}`} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} aria-label="Lämna feedback" title="Lämna feedback">
        <span className="fb-btn__icon"><WarnIcon size={15} /></span>
        <span className="fb-btn__label">Feedback</span>
      </button>

      {open && <div className="fb-scrim" onClick={() => setOpen(false)} />}
      {open && (
        <section className="fb-panel" role="dialog" aria-label="Lämna feedback">
          <header className="fb-panel__head">
            <span className="fb-panel__badge"><WarnIcon size={18} /></span>
            <div className="fb-panel__titles">
              <div className="fb-panel__title">Lämna feedback</div>
              <div className="fb-panel__sub">Fel, idéer eller önskemål — skickas direkt till Teams</div>
            </div>
            <button className="ai-panel__iconbtn" onClick={() => setOpen(false)} aria-label="Stäng" title="Stäng (Esc)">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </header>

          {done ? (
            <div className="fb-panel__done">
              <div className="fb-panel__check">✓</div>
              <div className="fb-panel__done-title">Tack! Din feedback är skickad.</div>
              <div className="ink-faint">{done.teams ? "Den har skickats till Teams." : "Den är sparad — Teams-kopplingen är inte uppsatt ännu."}</div>
            </div>
          ) : (
            <form className="fb-panel__body" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <div className="fb-field">
                <span className="label">Kategori</span>
                <div className="chips">
                  {CATEGORIES.map((c) => (
                    <button type="button" key={c} className="chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>
                  ))}
                </div>
              </div>

              <div className="fb-field">
                <label className="label" htmlFor="fb-module">Modul</label>
                <select id="fb-module" className="input" value={module} onChange={(e) => setModule(e.target.value)}>
                  {modules.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              <div className="fb-field">
                <span className="label">Prioritet</span>
                <div className="chips">
                  {PRIORITIES.map((p) => (
                    <button type="button" key={p.key} className={`chip chip--prio-${p.key}`} aria-pressed={priority === p.key}
                      onClick={() => setPriority(p.key)}>{p.label}</button>
                  ))}
                </div>
              </div>

              <div className="fb-field">
                <label className="label" htmlFor="fb-msg">Beskrivning</label>
                <textarea id="fb-msg" ref={textRef} className="input input--area fb-panel__text" value={message} maxLength={4000}
                  placeholder="Vad vill du ändra, eller vad fungerar inte? Beskriv gärna steg för steg."
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
              </div>

              {error && <div className="formfield__error">{error}</div>}
              <div className="fb-panel__actions">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)} disabled={busy}>Avbryt</button>
                <button type="submit" className="btn btn--brand btn--sm" disabled={busy || !message.trim()}>{busy ? "Skickar…" : "Skicka feedback"}</button>
              </div>
            </form>
          )}
        </section>
      )}
    </>
  );
}
