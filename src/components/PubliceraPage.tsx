import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import "@/styles/publicera.css";

/* =============================================================================
   Inställningar → Publicera. Visar det som gjorts i testmiljön (grenen staging)
   men inte publicerats, och publicerar det till riktiga CRM:et med en knapp.
   Allt mot GitHub sker i edge function "publicera" (token ligger där, aldrig här).
   Publiceringen startar bygget av riktiga CRM:et: nya databasändringar körs mot
   riktiga databasen först, sedan byggs sidan (några minuter).
   ========================================================================== */

type Korning = { status: string; slutsats: string | null; tid: string; url: string; titel: string } | null;
type Status = {
  andringar: Array<{ sha: string; meddelande: string; tid: string; av: string | null }>;
  antal: number; migreringar: string[]; funktioner: string[]; filer: number; riktigaFore: number;
  bygge: Korning; testbygge: Korning; kanPublicera: boolean;
};

async function anropa<T>(action: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke("publicera", { body: { action } });
  if (error) {
    let j: { error?: string } | null = null;
    try { j = await (error as { context?: Response }).context?.json(); } catch { /* */ }
    throw new Error(j?.error ?? "Kunde inte nå publiceringen.");
  }
  return data as T;
}

const tid = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–");

function Bygge({ namn, k }: { namn: string; k: Korning }) {
  if (!k) return <div className="pub__bygge"><span>{namn}</span><span className="pub__chip">Inget bygge än</span></div>;
  const [text, ton] = k.status !== "completed" ? ["Bygger…", "pagar"]
    : k.slutsats === "success" ? ["Klart", "ok"] : ["Misslyckades", "fel"];
  return (
    <div className="pub__bygge">
      <span>{namn}</span>
      <span className={`pub__chip pub__chip--${ton}`}>{text}</span>
      <span className="pub__sub">{tid(k.tid)} · {k.titel}</span>
      <a href={k.url} target="_blank" rel="noreferrer">Visa</a>
    </div>
  );
}

export function PubliceraPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bekrafta, setBekrafta] = useState(false);
  const [klart, setKlart] = useState<string | null>(null);

  const ladda = useCallback(async () => {
    try { setSt(await anropa<Status>("status")); setFel(null); }
    catch (e) { setFel(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void ladda(); }, [ladda]);

  // Medan ett bygge pågår: uppdatera var 10:e sekund.
  const pagar = st?.bygge?.status && st.bygge.status !== "completed";
  useEffect(() => {
    if (!pagar && !klart) return;
    const t = window.setInterval(() => { void ladda(); }, 10000);
    return () => window.clearInterval(t);
  }, [pagar, klart, ladda]);

  const publicera = async () => {
    setBusy(true); setFel(null);
    try {
      const r = await anropa<{ publicerat: boolean; meddelande?: string }>("publicera");
      setKlart(r.publicerat ? "Publicerat. Riktiga CRM:et byggs nu — det tar några minuter." : (r.meddelande ?? "Inget att publicera."));
      setBekrafta(false);
      window.setTimeout(() => { void ladda(); }, 4000);
    } catch (e) { setFel(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="pub">
      <div className="pub__head">
        <div>
          <h2>Publicera</h2>
          <p className="pub__sub">Det som gjorts i testmiljön (test.crm.connectestate.se) men ännu inte finns i riktiga CRM:et.</p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void ladda()} disabled={busy}>Uppdatera</button>
      </div>

      {fel && <div className="formfield__error" role="alert">{fel}</div>}
      {klart && <div className="pub__klart" role="status">{klart}</div>}
      {!st && !fel && <p className="pub__sub">Hämtar…</p>}

      {st && (
        <>
          <section className="card pub__kort">
            <div className="pub__rad">
              <strong>{st.antal === 0 ? "Allt är publicerat" : `${st.antal} opublicerade ändringar`}</strong>
              {st.antal > 0 && <span className="pub__sub">{st.filer} filer</span>}
            </div>
            {st.riktigaFore > 0 && (
              <p className="pub__varning">Riktiga CRM:et har {st.riktigaFore} ändringar som inte finns i testmiljön. De ligger kvar vid publicering.</p>
            )}
            {st.andringar.length > 0 && (
              <ul className="pub__lista">
                {st.andringar.map((a) => (
                  <li key={a.sha}><span>{a.meddelande}</span><span className="pub__sub">{tid(a.tid)}{a.av ? ` · ${a.av}` : ""}</span></li>
                ))}
              </ul>
            )}
            {st.migreringar.length > 0 && (
              <div className="pub__del">
                <strong>Databasändringar ({st.migreringar.length})</strong>
                <p className="pub__sub">Körs mot riktiga databasen innan sidan byggs. Misslyckas en publiceras ingenting.</p>
                <ul className="pub__filer">{st.migreringar.map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            )}
            {st.funktioner.length > 0 && (
              <div className="pub__del">
                <strong>Serverfunktioner ({st.funktioner.join(", ")})</strong>
                <p className="pub__sub">Följer inte med knappen — be agenten deploya dem till riktiga CRM:et efter publiceringen.</p>
              </div>
            )}

            {st.antal > 0 && (st.kanPublicera ? (
              !bekrafta ? (
                <button type="button" className="btn btn--brand pub__knapp" disabled={busy || !!pagar} onClick={() => setBekrafta(true)}>
                  {pagar ? "Ett bygge pågår…" : "Publicera till riktiga CRM:et"}
                </button>
              ) : (
                <div className="pub__bekrafta">
                  <span>Publicera {st.antal} ändringar till riktiga CRM:et nu?</span>
                  <div className="pub__knappar">
                    <button type="button" className="btn btn--brand" disabled={busy} onClick={() => void publicera()}>{busy ? "Publicerar…" : "Ja, publicera"}</button>
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setBekrafta(false)}>Avbryt</button>
                  </div>
                </div>
              )
            ) : <p className="pub__sub">Bara Gustav kan publicera.</p>)}
          </section>

          <section className="card pub__kort">
            <strong>Senaste byggen</strong>
            <Bygge namn="Riktiga CRM:et" k={st.bygge} />
            <Bygge namn="Testmiljön" k={st.testbygge} />
          </section>
        </>
      )}
    </div>
  );
}
