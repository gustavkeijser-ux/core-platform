import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { downloadCsv } from "@/lib/csv";
import { SkeletonRows } from "./PageChrome";
import { STATUS_CONFIG } from "./D2DSellerApp";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Kontaktlista.

   Alla D2D-lägenheter där vi fått in telefon och/eller e-post: namn, telefon,
   e-post, adress, lägenhetsnummer och när uppgifterna kom in.

   Säkerhet (allt avgörs i databasen, inte här):
   - Bara personer i d2d_kontakt_behorighet (Gustav, Lukas, Anton) får svar från
     d2d_kontaktlista / d2d_kontaktlista_export / d2d_kontakt_logglista — andra
     får ett fel. Menyvalet visas bara för dem (d2d_kontakt_behorig).
   - Varje visning/sökning och varje export loggas (vem, när, sökord, antal).
   - Inget sparas i webbläsarens lagring; listan hämtas en sida i taget.
   - Personnummer ingår inte.
   ========================================================================== */

type Kontakt = {
  id: string; namn: string | null; telefon: string | null; epost: string | null;
  gata: string | null; postnummer: string | null; postort: string | null; lgh: string | null;
  fastighet: string | null; status: string | null; saljare: string | null; inkom: string | null;
};
type Logg = { tid: string; handling: "visa" | "export"; sok: string | null; antal: number | null; vem: string | null };

const SIDA = 100;

export async function d2dKontaktBehorig(): Promise<boolean> {
  const { data } = await supabase.rpc("d2d_kontakt_behorig");
  return data === true;
}

const datum = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }) : "–";
const tidpunkt = (iso: string) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" });
const statusText = (s: string | null) =>
  (s && (STATUS_CONFIG as Record<string, { label: string }>)[s]?.label) || (s === "anger" ? "Ånger" : s === "scrive" ? "Signera med Scrive" : s ?? "–");
const ortText = (k: Kontakt) => [k.postnummer, k.postort].filter(Boolean).join(" ");
const telLank = (t: string) => `tel:${t.replace(/[^\d+]/g, "")}`;

export function D2DKontaktlistaPage({ onOpenRecord }: { onOpenRecord: (id: string) => void }) {
  const [sok, setSok] = useState("");
  const [aktivtSok, setAktivtSok] = useState("");
  const [rader, setRader] = useState<Kontakt[] | null>(null);
  const [totalt, setTotalt] = useState(0);
  const [laddar, setLaddar] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [exportFraga, setExportFraga] = useState(false);
  const [exporterar, setExporterar] = useState(false);
  const [visaLogg, setVisaLogg] = useState(false);
  const [logg, setLogg] = useState<Logg[] | null>(null);
  const anrop = useRef(0);

  // Sök med kort fördröjning så att varje tangent inte blir en loggad sökning.
  useEffect(() => {
    const t = setTimeout(() => setAktivtSok(sok.trim()), 400);
    return () => clearTimeout(t);
  }, [sok]);

  const hamta = useCallback(async (offset: number) => {
    const mitt = ++anrop.current;
    setLaddar(true); setFel(null);
    const { data, error } = await supabase.rpc("d2d_kontaktlista", { p_sok: aktivtSok || null, p_limit: SIDA, p_offset: offset });
    if (mitt !== anrop.current) return;
    setLaddar(false);
    if (error) { setFel(error.message); return; }
    const svar = data as { totalt: number; rader: Kontakt[] };
    setTotalt(svar.totalt);
    setRader((f) => (offset === 0 ? svar.rader : [...(f ?? []), ...svar.rader]));
  }, [aktivtSok]);

  useEffect(() => { setRader(null); void hamta(0); }, [hamta]);

  const hamtaLogg = useCallback(async () => {
    const { data, error } = await supabase.rpc("d2d_kontakt_logglista");
    if (error) { setFel(error.message); return; }
    setLogg((data as Logg[]) ?? []);
  }, []);
  useEffect(() => { if (visaLogg) void hamtaLogg(); }, [visaLogg, hamtaLogg]);

  const exportera = async () => {
    setExporterar(true); setFel(null);
    const { data, error } = await supabase.rpc("d2d_kontaktlista_export", { p_sok: aktivtSok || null });
    setExporterar(false); setExportFraga(false);
    if (error) { setFel(error.message); return; }
    const lista = (data as Kontakt[]) ?? [];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const huvud = ["Namn", "Telefon", "E-post", "Adress", "Lägenhet", "Postnummer", "Ort", "Fastighet", "Status", "Säljare", "Inkom"];
    const csv = [huvud, ...lista.map((k) => [k.namn, k.telefon, k.epost, k.gata, k.lgh, k.postnummer, k.postort, k.fastighet,
      statusText(k.status), k.saljare, datum(k.inkom)])].map((r) => r.map(cell).join(";")).join("\r\n");
    downloadCsv(`kontaktlista-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    if (visaLogg) void hamtaLogg();
  };

  return (
    <div className="page d2dkl">
      <div className="d2dkl__info card">
        <svg className="d2dkl__las" viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
        <p>
          Känsliga personuppgifter. Listan syns bara för behöriga, och varje visning, sökning och export
          loggas med namn och tid. Dela inte uppgifterna utanför Connectestate.
        </p>
      </div>

      <div className="utf__filter d2dkl__filter">
        <input className="input input--sm d2dkl__sok" type="search" autoComplete="off" spellCheck={false}
          placeholder="Sök namn, telefon, e-post, adress…" aria-label="Sök i kontaktlistan"
          value={sok} onChange={(e) => setSok(e.target.value)} />
        <span className="d2dkl__antal">{rader ? `${totalt.toLocaleString("sv-SE")} kontakter` : ""}</span>
        <div className="d2dkl__knappar">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setVisaLogg((v) => !v)} aria-expanded={visaLogg}>
            {visaLogg ? "Dölj logg" : "Visa logg"}
          </button>
          <button type="button" className="btn btn--sm" disabled={!totalt || exporterar} onClick={() => setExportFraga(true)}>
            Exportera
          </button>
        </div>
      </div>

      {exportFraga && (
        <div className="card d2dkl__export" role="alertdialog" aria-label="Bekräfta export">
          <p>
            Du exporterar <b>{totalt.toLocaleString("sv-SE")}</b> kontakter{aktivtSok ? <> (sökning ”{aktivtSok}”)</> : null} till
            en CSV-fil. Exporten loggas med ditt namn. Spara filen säkert och radera den när den inte behövs.
          </p>
          <div className="d2dkl__knappar">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExportFraga(false)} disabled={exporterar}>Avbryt</button>
            <button type="button" className="btn btn--sm" onClick={() => void exportera()} disabled={exporterar}>
              {exporterar ? "Exporterar…" : "Ladda ner CSV"}
            </button>
          </div>
        </div>
      )}

      {fel && <div className="formfield__error">{fel}</div>}

      {visaLogg && (
        <section className="card utf__sek d2dkl__logg">
          <div className="utf__sekhuvud"><h2>Logg</h2><small className="utf__sub">senaste 100 händelserna</small></div>
          {!logg ? <SkeletonRows rows={3} /> : logg.length === 0 ? <p className="formfield__help">Inget loggat ännu.</p> : (
            <ul className="d2dkl__logglista">
              {logg.map((l, i) => (
                <li key={i}>
                  <span className="d2dkl__loggtid">{tidpunkt(l.tid)}</span>
                  <span><b>{l.vem ?? "Okänd"}</b> {l.handling === "export" ? "exporterade" : "visade"} {l.antal ?? 0} kontakter
                    {l.sok && <> · sökning ”{l.sok}”</>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!rader && !fel && <div className="card"><SkeletonRows rows={8} /></div>}

      {rader && (
        <section className="card utf__sek">
          {rader.length === 0 ? (
            <p className="formfield__help">{aktivtSok ? "Inga kontakter matchar sökningen." : "Inga kontaktuppgifter har kommit in ännu."}</p>
          ) : (
            <div className="rtable-scroll">
              <table className="rtable d2dkl__tabell">
                <thead>
                  <tr><th>Namn</th><th>Telefon</th><th>E-post</th><th>Adress</th><th>Status</th><th>Inkom</th></tr>
                </thead>
                <tbody>
                  {rader.map((k) => (
                    <tr key={k.id} className="rtable__row rtable__row--click" onClick={() => onOpenRecord(k.id)}>
                      <td data-label="Namn" className="rtable__title"><span>{k.namn ?? "–"}</span></td>
                      <td data-label="Telefon">
                        {k.telefon ? <a href={telLank(k.telefon)} onClick={(e) => e.stopPropagation()}>{k.telefon}</a> : "–"}
                      </td>
                      <td data-label="E-post" className="d2dkl__epost">
                        {k.epost ? <a href={`mailto:${k.epost}`} onClick={(e) => e.stopPropagation()}>{k.epost}</a> : "–"}
                      </td>
                      <td data-label="Adress">
                        <span>{[k.gata, k.lgh && `lgh ${k.lgh}`].filter(Boolean).join(", ") || "–"}
                          {ortText(k) && <small className="utf__sub"> {ortText(k)}</small>}</span>
                      </td>
                      <td data-label="Status">
                        <span>{statusText(k.status)}{k.saljare && <small className="utf__sub"> {k.saljare}</small>}</span>
                      </td>
                      <td data-label="Inkom" className="d2dkl__datum">{datum(k.inkom)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rader.length < totalt && (
            <button type="button" className="btn btn--ghost d2dkl__fler" disabled={laddar} onClick={() => void hamta(rader.length)}>
              {laddar ? "Hämtar…" : `Visa fler (${(totalt - rader.length).toLocaleString("sv-SE")} kvar)`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
