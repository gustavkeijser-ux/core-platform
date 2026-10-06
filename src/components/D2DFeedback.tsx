import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import "@/styles/d2d.css";

/* =============================================================================
   Feedback från dörrsäljarna (Blitz).

   D2DFeedbackFlik      — fliken Feedback i säljarvyn (telefon, 390 px): skriv
                          och skicka, se egna inskick och status.
   D2DFeedbackGranskning — sidan Säljarfeedback i CRM:et, bara för granskaren
                          (Lukas): godkänn med redigerbar text (→ feedbacklistan
                          + Teams via d2d-feedback-send) eller neka med anledning.
   DB: d2d_feedback, d2d_feedback_skicka/lista/godkann/neka/antal_vantar.
   ========================================================================== */

type FeedbackRad = {
  id: string;
  text: string;
  page: string | null;
  status: "vantar" | "godkand" | "nekad";
  createdAt: string;
  granskadAt: string | null;
  granskadAv: string | null;
  godkandText: string | null;
  nekadAnledning: string | null;
  saljare: { id: string | null; name: string; email: string | null };
  min: boolean;
};

const STATUS: Record<FeedbackRad["status"], { label: string; cls: string }> = {
  vantar: { label: "Väntar på granskning", cls: "d2d-fb-status--vantar" },
  godkand: { label: "Godkänd", cls: "d2d-fb-status--godkand" },
  nekad: { label: "Nekad", cls: "d2d-fb-status--nekad" },
};

const nar = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" }) : "";

async function hamtaLista(): Promise<FeedbackRad[]> {
  const { data, error } = await supabase.rpc("d2d_feedback_lista");
  if (error) throw new Error(error.message);
  return (data ?? []) as FeedbackRad[];
}

/** Antal inskick som väntar — siffran i CRM-menyn hos granskaren. */
export async function d2dFeedbackAntalVantar(): Promise<number> {
  const { data } = await supabase.rpc("d2d_feedback_antal_vantar");
  return typeof data === "number" ? data : 0;
}

/** Är den inloggade granskare (styr om menyvalet Säljarfeedback visas)? */
export async function d2dFeedbackArGranskare(): Promise<boolean> {
  const { data } = await supabase.rpc("d2d_feedback_ar_granskare");
  return data === true;
}

// ─── Säljarens flik ──────────────────────────────────────────────────────────

export function D2DFeedbackFlik() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [skickat, setSkickat] = useState(false);
  const [rader, setRader] = useState<FeedbackRad[]>([]);
  const [laddar, setLaddar] = useState(true);

  const ladda = useCallback(() => {
    hamtaLista().then(setRader).catch(() => {}).finally(() => setLaddar(false));
  }, []);
  useEffect(() => { ladda(); }, [ladda]);

  async function skicka() {
    const t = text.trim();
    if (!t) { setFel("Skriv vad det gäller."); return; }
    setBusy(true); setFel(null);
    const { error } = await supabase.rpc("d2d_feedback_skicka", { p_text: t, p_page: window.location.hash || null });
    setBusy(false);
    if (error) { setFel(error.message); return; }
    setText(""); setSkickat(true); ladda();
    window.setTimeout(() => setSkickat(false), 4000);
  }

  return (
    <div className="d2d-list d2d-fb">
      <div className="d2d-list__header">
        <h2>Feedback</h2>
        <span className="d2d-list__count">{rader.length} st</span>
      </div>

      <div className="d2d-fb__form">
        <p className="d2d-fb__hint">
          Något som strular, saknas eller kan bli bättre i Blitz? Skriv här — Lukas läser och skickar vidare.
        </p>
        <textarea
          className="input d2d-fb__text"
          rows={4}
          placeholder="Beskriv vad det gäller…"
          value={text}
          maxLength={4000}
          onChange={(e) => { setText(e.target.value); setFel(null); }}
          disabled={busy}
        />
        {fel && <div className="d2d-fb__error" role="alert">{fel}</div>}
        {skickat && <div className="d2d-fb__ok" role="status">Tack! Din feedback är skickad till Lukas.</div>}
        <button className="btn btn--primary d2d-fb__send" onClick={skicka} disabled={busy || !text.trim()}>
          {busy ? "Skickar…" : "Skicka feedback"}
        </button>
      </div>

      <h3 className="d2d-form-section__title">Mina inskick</h3>
      {laddar && <div className="d2d-loading">Laddar…</div>}
      {!laddar && rader.length === 0 && <div className="d2d-empty">Du har inte skickat någon feedback ännu.</div>}
      {rader.map((r) => (
        <div key={r.id} className="d2d-card d2d-fb-card">
          <div className="d2d-card__main">
            <span className={`d2d-fb-status ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
            <span className="d2d-fb-card__text">{r.text}</span>
            {r.status === "godkand" && r.godkandText && r.godkandText !== r.text && (
              <span className="d2d-fb-card__note">Skickad vidare som: ”{r.godkandText}”</span>
            )}
            {r.status === "nekad" && r.nekadAnledning && (
              <span className="d2d-fb-card__note">Anledning: {r.nekadAnledning}</span>
            )}
            <span className="d2d-card__sub">{nar(r.createdAt)}{r.granskadAt ? ` · granskad ${nar(r.granskadAt)}` : ""}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Granskarens sida i CRM:et ──────────────────────────────────────────────

export function D2DFeedbackGranskning({ onAntalAndrat }: { onAntalAndrat?: () => void }) {
  const [rader, setRader] = useState<FeedbackRad[]>([]);
  const [laddar, setLaddar] = useState(true);
  const [fel, setFel] = useState<string | null>(null);
  const [oppen, setOppen] = useState<string | null>(null);      // raden som granskas
  const [text, setText] = useState("");
  const [anledning, setAnledning] = useState("");
  const [busy, setBusy] = useState(false);
  const [visaKlara, setVisaKlara] = useState(false);

  const ladda = useCallback(() => {
    hamtaLista().then(setRader).catch((e) => setFel(e.message)).finally(() => setLaddar(false));
  }, []);
  useEffect(() => { ladda(); }, [ladda]);

  function oppna(r: FeedbackRad) {
    setOppen(r.id); setText(r.text); setAnledning(""); setFel(null);
  }

  async function godkann(r: FeedbackRad) {
    const t = text.trim();
    if (!t) { setFel("Texten får inte vara tom."); return; }
    setBusy(true); setFel(null);
    const { data, error } = await supabase.functions.invoke("d2d-feedback-send", { body: { id: r.id, text: t } });
    setBusy(false);
    const svar = data as { ok?: boolean; teams?: boolean; error?: string } | null;
    if (error || !svar?.ok) {
      // Felmeddelandet från funktionen ligger i svaret (400), annars i error.
      setFel(svar?.error ?? error?.message ?? "Kunde inte godkänna feedbacken");
      return;
    }
    setOppen(null); ladda(); onAntalAndrat?.();
  }

  async function neka(r: FeedbackRad) {
    setBusy(true); setFel(null);
    const { error } = await supabase.rpc("d2d_feedback_neka", { p_id: r.id, p_anledning: anledning.trim() || null });
    setBusy(false);
    if (error) { setFel(error.message); return; }
    setOppen(null); ladda(); onAntalAndrat?.();
  }

  const vantande = rader.filter((r) => r.status === "vantar");
  const klara = rader.filter((r) => r.status !== "vantar");

  if (laddar) return <div className="d2d-fbg__loading">Laddar…</div>;

  return (
    <div className="d2d-fbg">
      <p className="d2d-fbg__intro">
        Säljarnas feedback från Blitz. Godkänd feedback hamnar i menyn Feedback och skickas till Teams —
        du kan ändra texten innan du skickar vidare.
      </p>
      {fel && !oppen && <div className="d2d-fb__error" role="alert">{fel}</div>}

      <h3 className="d2d-fbg__h3">Väntar på granskning <span className="d2d-list__count">{vantande.length} st</span></h3>
      {vantande.length === 0 && <div className="d2d-empty">Inget väntar just nu.</div>}
      {vantande.map((r) => (
        <div key={r.id} className={`d2d-fbg-card${oppen === r.id ? " d2d-fbg-card--open" : ""}`}>
          <div className="d2d-fbg-card__head">
            <div>
              <strong>{r.saljare.name}</strong>
              <span className="d2d-card__sub"> · {nar(r.createdAt)}</span>
            </div>
            {oppen !== r.id && <button className="btn btn--sm" onClick={() => oppna(r)}>Granska</button>}
          </div>
          {oppen !== r.id && <div className="d2d-fbg-card__text">{r.text}</div>}
          {oppen === r.id && (
            <div className="d2d-fbg-card__edit">
              <label className="d2d-fbg__label" htmlFor={`fb-text-${r.id}`}>Text som skickas vidare (redigera vid behov)</label>
              <textarea id={`fb-text-${r.id}`} className="input d2d-fb__text" rows={5} value={text} maxLength={4000}
                onChange={(e) => setText(e.target.value)} disabled={busy} />
              {text.trim() !== r.text && (
                <details className="d2d-fbg__orig">
                  <summary>Säljarens ursprungliga text</summary>
                  <div className="d2d-fbg-card__text">{r.text}</div>
                </details>
              )}
              <label className="d2d-fbg__label" htmlFor={`fb-neka-${r.id}`}>Anledning om du nekar (valfritt, säljaren ser den)</label>
              <input id={`fb-neka-${r.id}`} className="input" value={anledning} maxLength={500}
                placeholder="T.ex. Finns redan, eller otydligt — be om mer info" onChange={(e) => setAnledning(e.target.value)} disabled={busy} />
              {fel && <div className="d2d-fb__error" role="alert">{fel}</div>}
              <div className="d2d-fbg-card__actions">
                <button className="btn btn--primary" onClick={() => godkann(r)} disabled={busy || !text.trim()}>
                  {busy ? "Skickar…" : "Godkänn och skicka till Gustav"}
                </button>
                <button className="btn btn--danger" onClick={() => neka(r)} disabled={busy}>Neka</button>
                <button className="btn btn--ghost" onClick={() => setOppen(null)} disabled={busy}>Avbryt</button>
              </div>
            </div>
          )}
        </div>
      ))}

      <button className="btn btn--ghost btn--sm d2d-fbg__toggle" onClick={() => setVisaKlara((v) => !v)}>
        {visaKlara ? "Dölj granskade" : `Visa granskade (${klara.length})`}
      </button>
      {visaKlara && klara.map((r) => (
        <div key={r.id} className="d2d-fbg-card d2d-fbg-card--done">
          <div className="d2d-fbg-card__head">
            <div>
              <strong>{r.saljare.name}</strong>
              <span className="d2d-card__sub"> · {nar(r.createdAt)}</span>
            </div>
            <span className={`d2d-fb-status ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
          </div>
          <div className="d2d-fbg-card__text">{r.status === "godkand" ? (r.godkandText ?? r.text) : r.text}</div>
          {r.status === "nekad" && r.nekadAnledning && <div className="d2d-fb-card__note">Anledning: {r.nekadAnledning}</div>}
          <div className="d2d-card__sub">{r.granskadAv ? `${r.granskadAv} · ` : ""}{nar(r.granskadAt)}</div>
        </div>
      ))}
    </div>
  );
}
