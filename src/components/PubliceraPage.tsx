import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import "@/styles/publicera.css";

/* =============================================================================
   Inställningar → Publicera. Varje uppgift som gjorts i testmiljön visas för sig
   och Gustav publicerar eller nekar den. "Visa" öppnar uppgiften i testmiljön.
   Allt mot GitHub sker i edge function "publicera" (token ligger där, aldrig här).
   En publicering startar bygget av riktiga CRM:et: nya databasändringar körs mot
   riktiga databasen först, sedan byggs sidan (några minuter).
   ========================================================================== */

type Korning = { status: string; slutsats: string | null; tid: string; url: string; titel: string } | null;
type Uppgift = {
  id: string; titel: string; omrade: string; bestallare: string; testlank: string; sammanfattning: string;
  antal: number; skapad: string | null; senast: string | null; av: string | null; filer: number;
  migreringar: string[]; funktioner: string[]; testmiljo: "ja" | "pagar" | "krock"; testUrl: string | null;
};
type Nekad = { id: string; titel: string; omrade: string; testlank: string };
type Andring = { sha: string; meddelande: string; tid: string };
type Status = {
  uppgifter: Uppgift[]; nekade: Nekad[];
  aldre: { antal: number; andringar: Andring[]; migreringar: string[]; funktioner: string[] } | null;
  okopplade: Andring[]; bygge: Korning; testbygge: Korning; kanPublicera: boolean;
};

async function anropa<T>(action: string, uppgift?: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke("publicera", { body: { action, uppgift } });
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

type Fraga = { id: string; typ: "publicera" | "neka" } | null;

function UppgiftKort({ u, kan, busy, fraga, setFraga, gor }: {
  u: Uppgift; kan: boolean; busy: boolean; fraga: Fraga;
  setFraga: (f: Fraga) => void; gor: (typ: "publicera" | "neka", id: string) => void;
}) {
  const fragar = fraga?.id === u.id ? fraga.typ : null;
  return (
    <li className="card pub__uppgift">
      <div className="pub__uppgift-huvud">
        <div className="pub__uppgift-titel">
          <strong>{u.titel}</strong>
          <span className="pub__sub">
            {[u.omrade, u.bestallare && `beställd av ${u.bestallare}`, tid(u.senast)].filter(Boolean).join(" · ")}
          </span>
        </div>
        <a className="btn btn--ghost btn--sm" href={u.testlank} target="_blank" rel="noreferrer">Visa</a>
      </div>
      {u.sammanfattning && <p className="pub__text">{u.sammanfattning}</p>}
      <div className="pub__chips">
        {u.testmiljo === "ja" && <span className="pub__chip pub__chip--ok">I testmiljön</span>}
        {u.testmiljo === "pagar" && <span className="pub__chip pub__chip--pagar">Läggs in i testmiljön…</span>}
        {u.testmiljo === "krock" && (
          <a className="pub__chip pub__chip--fel" href={u.testUrl ?? "#"} target="_blank" rel="noreferrer">Kom inte in i testmiljön (krock)</a>
        )}
        {u.migreringar.length > 0 && <span className="pub__chip pub__chip--pagar">Ändrar databasen</span>}
        {u.funktioner.length > 0 && <span className="pub__chip">Serverfunktion: {u.funktioner.join(", ")}</span>}
      </div>
      {u.funktioner.length > 0 && (
        <p className="pub__sub">Serverfunktioner följer inte med knappen — be agenten lägga ut dem i riktiga CRM:et efter publiceringen.</p>
      )}
      {kan && (fragar ? (
        <div className={`pub__bekrafta${fragar === "neka" ? " pub__bekrafta--neka" : ""}`}>
          <span>
            {fragar === "publicera"
              ? `Publicera "${u.titel}" till riktiga CRM:et nu?${u.migreringar.length ? " Databasändringen körs mot riktiga databasen." : ""}`
              : `Neka "${u.titel}"? Den publiceras inte men ligger kvar i testmiljön. Du kan ångra.`}
          </span>
          <div className="pub__knappar">
            <button type="button" className={`btn ${fragar === "publicera" ? "btn--brand" : "btn--danger"}`} disabled={busy} onClick={() => gor(fragar, u.id)}>
              {busy ? "Arbetar…" : fragar === "publicera" ? "Ja, publicera" : "Ja, neka"}
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setFraga(null)}>Avbryt</button>
          </div>
        </div>
      ) : (
        <div className="pub__knappar">
          <button type="button" className="btn btn--brand" disabled={busy || u.testmiljo !== "ja"} onClick={() => setFraga({ id: u.id, typ: "publicera" })}>Publicera</button>
          <button type="button" className="btn btn--danger" disabled={busy} onClick={() => setFraga({ id: u.id, typ: "neka" })}>Neka</button>
        </div>
      ))}
    </li>
  );
}

export function PubliceraPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fraga, setFraga] = useState<Fraga>(null);
  const [aldreFraga, setAldreFraga] = useState(false);
  const [klart, setKlart] = useState<string | null>(null);
  const [visaNekade, setVisaNekade] = useState(false);

  const ladda = useCallback(async () => {
    try { setSt(await anropa<Status>("status")); setFel(null); }
    catch (e) { setFel(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void ladda(); }, [ladda]);

  // Medan ett bygge pågår eller något läggs in i testmiljön: uppdatera var 10:e sekund.
  const pagar = st?.bygge?.status && st.bygge.status !== "completed";
  const testPagar = st?.uppgifter.some((u) => u.testmiljo === "pagar");
  useEffect(() => {
    if (!pagar && !testPagar && !klart) return;
    const t = window.setInterval(() => { void ladda(); }, 10000);
    return () => window.clearInterval(t);
  }, [pagar, testPagar, klart, ladda]);

  const kor = async (action: string, id: string | undefined, text: (r: { titel?: string; varning?: string | null; meddelande?: string; publicerat?: boolean }) => string) => {
    setBusy(true); setFel(null);
    try {
      const r = await anropa<{ titel?: string; varning?: string | null; meddelande?: string; publicerat?: boolean }>(action, id);
      setKlart(text(r) + (r.varning ? ` ${r.varning}` : ""));
      setFraga(null); setAldreFraga(false);
      await ladda();
    } catch (e) { setFel(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const gor = (typ: "publicera" | "neka", id: string) => {
    const titel = st?.uppgifter.find((u) => u.id === id)?.titel ?? id;
    void kor(typ, id, () => typ === "publicera"
      ? `"${titel}" är publicerad. Riktiga CRM:et byggs nu — det tar några minuter.`
      : `"${titel}" är nekad.`);
  };

  const kan = !!st?.kanPublicera;
  return (
    <div className="pub">
      <div className="pub__head">
        <div>
          <h2>Publicera</h2>
          <p className="pub__sub">Uppgifter som gjorts i testmiljön (test.crm.connectestate.se). Prova med Visa, publicera eller neka var för sig.</p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void ladda()} disabled={busy}>Uppdatera</button>
      </div>

      {fel && <div className="formfield__error" role="alert">{fel}</div>}
      {klart && <div className="pub__klart" role="status">{klart}</div>}
      {!st && !fel && <p className="pub__sub">Hämtar…</p>}

      {st && (
        <>
          {pagar && <p className="pub__varning">Riktiga CRM:et byggs just nu. Vänta tills bygget är klart innan du publicerar nästa.</p>}

          {st.uppgifter.length === 0 && !st.aldre && (
            <section className="card pub__kort"><strong>Inget väntar på godkännande</strong></section>
          )}

          {st.uppgifter.length > 0 && (
            <ul className="pub__uppgifter">
              {st.uppgifter.map((u) => (
                <UppgiftKort key={u.id} u={u} kan={kan} busy={busy || !!pagar} fraga={fraga} setFraga={setFraga} gor={gor} />
              ))}
            </ul>
          )}

          {st.aldre && (
            <section className="card pub__kort">
              <div className="pub__rad">
                <strong>Ändringar gjorda före uppgifterna ({st.aldre.antal})</strong>
                <a className="btn btn--ghost btn--sm" href="https://test.crm.connectestate.se" target="_blank" rel="noreferrer">Visa</a>
              </div>
              <p className="pub__sub">Gjordes direkt i testmiljön innan uppgifterna fanns och kan bara publiceras tillsammans.</p>
              <ul className="pub__lista">
                {st.aldre.andringar.map((a) => (
                  <li key={a.sha}><span>{a.meddelande}</span><span className="pub__sub">{tid(a.tid)}</span></li>
                ))}
              </ul>
              {st.aldre.migreringar.length > 0 && <span className="pub__chip pub__chip--pagar">Ändrar databasen ({st.aldre.migreringar.length})</span>}
              {kan && (aldreFraga ? (
                <div className="pub__bekrafta">
                  <span>Publicera alla {st.aldre.antal} ändringar till riktiga CRM:et nu?</span>
                  <div className="pub__knappar">
                    <button type="button" className="btn btn--brand" disabled={busy} onClick={() => void kor("publicera_aldre", undefined, (r) => r.publicerat ? "Publicerat. Riktiga CRM:et byggs nu — det tar några minuter." : (r.meddelande ?? "Inget att publicera."))}>
                      {busy ? "Arbetar…" : "Ja, publicera"}
                    </button>
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setAldreFraga(false)}>Avbryt</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn--brand pub__knapp" disabled={busy || !!pagar} onClick={() => setAldreFraga(true)}>Publicera alla</button>
              ))}
            </section>
          )}

          {st.okopplade.length > 0 && (
            <section className="card pub__kort">
              <strong>I testmiljön men utanför uppgifterna ({st.okopplade.length})</strong>
              <p className="pub__varning">Gjordes direkt i testmiljön och kan inte publiceras härifrån. Be agenten göra om dem som en uppgift.</p>
              <ul className="pub__lista">
                {st.okopplade.map((a) => (
                  <li key={a.sha}><span>{a.meddelande}</span><span className="pub__sub">{tid(a.tid)}</span></li>
                ))}
              </ul>
            </section>
          )}

          {st.nekade.length > 0 && (
            <section className="card pub__kort">
              <button type="button" className="pub__fallut" onClick={() => setVisaNekade((v) => !v)} aria-expanded={visaNekade}>
                <strong>Nekade ({st.nekade.length})</strong><span aria-hidden>{visaNekade ? "▾" : "▸"}</span>
              </button>
              {visaNekade && (
                <ul className="pub__lista">
                  {st.nekade.map((n) => (
                    <li key={n.id}>
                      <span>{n.titel}{n.omrade ? <span className="pub__sub"> · {n.omrade}</span> : null}</span>
                      <span className="pub__knappar">
                        <a className="btn btn--ghost btn--sm" href={n.testlank} target="_blank" rel="noreferrer">Visa</a>
                        {kan && (
                          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void kor("angra_neka", n.id, () => `"${n.titel}" väntar på godkännande igen.`)}>Ångra</button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {!kan && <p className="pub__sub">Bara Gustav kan publicera eller neka.</p>}

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
