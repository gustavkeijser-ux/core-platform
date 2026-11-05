import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/integrations/supabase/client";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Avtal: orderbekräftelse via Scrive (bara administratörer).
   CRM:et bygger en PDF av det som sålts (tjänster, priser, bindningstid och
   kunduppgifter) — från det signerade Scrive-avtalet eller lägenhetens sålda
   underlag. Den laddas upp i Scrive; administratören signerar med ett klick
   (utan BankID) och Scrive skickar den till kundens e-post.
   Edge-funktionen scrive-sign, åtgärderna order_*.
   ========================================================================== */

export type Orderbekraftelse = {
  id: string; lagenhetId: string; avtalId: string | null;
  status: "skapas" | "vantar" | "skickad" | "avbrutet" | "fel";
  mottagare: string | null; skapad: string; skickad: string | null; fel: string | null; harPdf: boolean; skapadAv: string | null;
};
type Rad = { label: string; kampanj: number | null; ordinarie: number | null };
type OrderUnderlag = {
  ordernummer: string; kund: { namn: string; epost: string | null; telefon: string | null };
  adress: { gata: string; lgh: string | null; postnummer: string | null; ort: string | null };
  manad: Rad[]; engang: Rad[]; totalKampanj: number; totalOrdinarie: number;
  kampanjManader: number; bindningManader: number; startdatum: string | null;
};

const kr = (n: number | null) => (n == null ? "–" : `${Math.round(n).toLocaleString("sv-SE")} kr`);
const kortDatum = (s: string | null) => (s ? new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "");

async function anropa(body: Record<string, unknown>): Promise<Record<string, any>> {
  const { data, error } = await supabase.functions.invoke("scrive-sign", { body });
  if (error) {
    // Funktionens felmeddelande ligger i svaret.
    const ctx = (error as { context?: Response }).context;
    let msg = "Något gick fel. Försök igen om en stund.";
    try { const j = await ctx?.json(); if (j?.error) msg = j.error; } catch { /* */ }
    throw new Error(msg);
  }
  return (data ?? {}) as Record<string, any>;
}

/** Senaste orderbekräftelsen per lägenhet (bara för administratörer). */
export function useOrderbekraftelser(aktiv: boolean) {
  const [map, setMap] = useState<Map<string, Orderbekraftelse>>(new Map());
  const ladda = useCallback(async () => {
    if (!aktiv) return;
    const { data, error } = await supabase.rpc("d2d_orderbekraftelse_lista" as never);
    if (error) return;
    setMap(new Map(((data ?? []) as Orderbekraftelse[]).map((o) => [o.lagenhetId, o])));
  }, [aktiv]);
  useEffect(() => { void ladda(); }, [ladda]);
  return { map, ladda };
}

/** Öppnar en adress i en flik som skapas direkt vid klicket (popup-skydd på mobilen). */
async function oppnaIFlik(hamta: () => Promise<string | null>) {
  const flik = window.open("", "_blank");
  try {
    const url = await hamta();
    if (!url) { flik?.close(); return false; }
    if (flik) flik.location.href = url; else window.location.href = url;
    return true;
  } catch (e) { flik?.close(); throw e; }
}

/** Cell i avtalslistorna: knapp för att skicka, eller läget för den senaste. */
export function OrderCell({ lagenhetId, avtalId, order, onAndrad }: {
  lagenhetId: string; avtalId?: string | null; order?: Orderbekraftelse; onAndrad: () => void;
}) {
  const [oppen, setOppen] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const stoppa = (e: React.MouseEvent) => e.stopPropagation();

  async function signera(e: React.MouseEvent) {
    stoppa(e); setFel(null);
    try {
      const ok = await oppnaIFlik(async () => {
        const r = await anropa({ action: "order_lank", orderId: order!.id });
        if (!r.url) onAndrad();
        return r.url ?? null;
      });
      if (!ok) setFel("Den går inte att signera längre.");
    } catch (x) { setFel(x instanceof Error ? x.message : String(x)); }
  }
  async function pdf(e: React.MouseEvent) {
    stoppa(e); setFel(null);
    try { await oppnaIFlik(async () => (await anropa({ action: "order_pdf", orderId: order!.id })).url ?? null); }
    catch (x) { setFel(x instanceof Error ? x.message : String(x)); }
  }

  const s = order?.status;
  return (
    <span className="d2dob-cell" onClick={stoppa}>
      {s === "skickad" ? (<>
        <span className="d2d-scrive__status d2d-scrive__status--signerat">Skickad {kortDatum(order!.skickad)}</span>
        {order!.harPdf && <button type="button" className="btn btn--ghost btn--sm" onClick={pdf}>PDF</button>}
      </>) : s === "vantar" || s === "skapas" ? (<>
        <span className="d2d-scrive__status d2d-scrive__status--vantar" title="Scrive skickar den till kunden när du har signerat">Väntar på din signatur</span>
        <button type="button" className="btn btn--brand btn--sm" onClick={signera}>Signera</button>
      </>) : (<>
        {s === "fel" && <span className="d2d-scrive__status d2d-scrive__status--fel" title={order!.fel ?? ""}>Misslyckades</span>}
        <button type="button" className="btn btn--ghost btn--sm" onClick={(e) => { stoppa(e); setOppen(true); }}>
          {s === "fel" || s === "avbrutet" ? "Skicka igen" : "Orderbekräftelse"}
        </button>
      </>)}
      {fel && <small className="formfield__error">{fel}</small>}
      {oppen && createPortal(<OrderDialog lagenhetId={lagenhetId} avtalId={avtalId ?? null}
        onClose={() => setOppen(false)} onSkickad={() => { setOppen(false); onAndrad(); }} />, document.body)}
    </span>
  );
}

function OrderDialog({ lagenhetId, avtalId, onClose, onSkickad }: {
  lagenhetId: string; avtalId: string | null; onClose: () => void; onSkickad: () => void;
}) {
  const [u, setU] = useState<{ url: string | null; order: OrderUnderlag } | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [skickar, setSkickar] = useState(false);

  useEffect(() => {
    let on = true;
    anropa({ action: "order_forhand", lagenhetId, avtalId })
      .then((r) => { if (on) setU({ url: r.url ?? null, order: r.order as OrderUnderlag }); })
      .catch((e) => { if (on) setFel(e instanceof Error ? e.message : String(e)); });
    return () => { on = false; };
  }, [lagenhetId, avtalId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !skickar) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, skickar]);

  async function skicka() {
    setSkickar(true); setFel(null);
    try {
      await oppnaIFlik(async () => (await anropa({ action: "order_skicka", lagenhetId, avtalId })).url ?? null);
      onSkickad();
    } catch (e) { setFel(e instanceof Error ? e.message : String(e)); setSkickar(false); }
  }

  const o = u?.order;
  const saknarEpost = o && !o.kund.epost;
  return (
    <div className="d2dob-bakgrund" onClick={() => { if (!skickar) onClose(); }}>
      <div className="d2dob" role="dialog" aria-modal="true" aria-label="Skicka orderbekräftelse" onClick={(e) => e.stopPropagation()}>
        <header className="d2dob__huvud">
          <h2>Orderbekräftelse</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} disabled={skickar} aria-label="Stäng">Stäng</button>
        </header>

        <div className="d2dob__kropp">
          {!o && !fel && <p className="formfield__help">Hämtar det som sålts…</p>}
          {fel && <div className="formfield__error">{fel}</div>}
          {o && (<>
            <div className="d2dob__kund">
              <b>{o.kund.namn}</b>
              <span>{[o.adress.gata, o.adress.lgh && `lgh ${o.adress.lgh}`, [o.adress.postnummer, o.adress.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</span>
              <span>{o.kund.epost ?? <em className="d2dob__saknas">E-post saknas</em>}{o.kund.telefon ? ` · ${o.kund.telefon}` : ""}</span>
            </div>

            <table className="d2dob__tabell">
              <thead><tr><th>Tjänst</th><th>Kampanj/mån</th><th>Ordinarie</th></tr></thead>
              <tbody>
                {o.manad.map((r, i) => (
                  <tr key={i}><td>{r.label}</td><td>{kr(r.kampanj)}</td><td>{kr(r.ordinarie)}</td></tr>
                ))}
                <tr className="d2dob__summa"><td>Totalt per månad</td><td>{kr(o.totalKampanj)}</td><td>{kr(o.totalOrdinarie)}</td></tr>
                {o.engang.map((r, i) => (
                  <tr key={`e${i}`} className="d2dob__engang"><td>{r.label} (engång)</td><td>{kr(r.kampanj)}</td><td>{kr(r.ordinarie)}</td></tr>
                ))}
              </tbody>
            </table>

            <dl className="d2dob__villkor">
              <div><dt>Bindningstid</dt><dd>{o.bindningManader} månader</dd></div>
              <div><dt>Kampanjperiod</dt><dd>{o.kampanjManader} månader</dd></div>
              <div><dt>Startdatum</dt><dd>{o.startdatum ?? "Meddelas senare"}</dd></div>
            </dl>

            <p className="formfield__help">
              Orderbekräftelsen läggs upp i Scrive. Du signerar den i en ny flik (ett klick, inget BankID) och sedan
              skickar Scrive den till {o.kund.epost ?? "kundens e-post"}{o.kund.telefon ? " och som sms" : ""}.
            </p>
          </>)}
        </div>

        <footer className="d2dob__fot">
          {u?.url && <a className="btn btn--ghost" href={u.url} target="_blank" rel="noreferrer">Förhandsgranska PDF</a>}
          <button type="button" className="btn btn--brand" disabled={!o || !!saknarEpost || skickar} onClick={() => { void skicka(); }}>
            {skickar ? "Skickar…" : "Skicka via Scrive"}
          </button>
        </footer>
      </div>
    </div>
  );
}
