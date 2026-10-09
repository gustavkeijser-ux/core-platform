import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/* =============================================================================
   Avtal som säljarna gjort för hand i Scrive (utanför CRM:et).
   Hämtas från Scrive (scrive-sign, åtgärden "okopplade"), visas med tolkade
   kunduppgifter, tjänster och förslag på lägenhet, och kopplas med "koppla":
   kunduppgifter, tjänster och säljare skrivs in på lägenheten, statusen blir
   "Signera med Scrive" och avtalet (status, signerad PDF) hämtas som om det
   skapats härifrån.
     • Avtal-sidan (admin): alla okopplade dokument, välj lägenhet fritt.
     • Lägenheten i säljarvyn: bara dokument som matchar lägenheten.
   ========================================================================== */

export type OkoppladForslag = {
  lagenhetId: string; poang: number; skal: string[]; adress: string; lgh: string | null; ort: string | null;
  kundNamn: string | null; status: string; saljare: string | null;
};
export type OkoppladDok = {
  id: string; titel: string; status: string; crmStatus: string; skapad: string | null; signerad: string | null;
  kundNamn: string | null; epost: string | null; telefon: string | null; personnummer: string | null;
  adress: string | null; lgh: string | null; ort: string | null; avsandare: string | null; avsandareNamn: string | null;
  tjansterText: string[]; osaker: boolean; startdatum: string | null; forslag: OkoppladForslag[];
};
type KopplaSvar = { ok: boolean; status: string; tjanster: string[]; falt: string[]; saljare: string | null; nyStatus: string | null; osaker: boolean };

async function anropa<T = any>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("scrive-sign", { body });
  if (error) {
    let j: any = null;
    try { j = await (error as { context?: Response }).context?.json(); } catch { /* */ }
    throw new Error(j?.error ?? "Kunde inte nå Scrive-kopplingen.");
  }
  return data as T;
}

const STATUS_TEXT: Record<string, string> = { signerat: "Signerat", vantar: "Väntar på signatur", skapas: "Utkast", avvisat: "Avvisat", avbrutet: "Avbrutet", fel: "Fel" };
const LAG_STATUS: Record<string, string> = {
  ej_knackad: "Ej knackad", inte_hemma: "Inte hemma", aterkoppling: "Återkoppling", inte_intresserad: "Inte intresserad",
  befintlig_telia: "Befintlig Telia", intresserad: "Intresserad", sald: "Såld", scrive: "Signera med Scrive", kall_kund: "Kall kund",
};
const datum = (s: string | null) => (s ? new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) : "–");
const titel = (s: string | null) => (s ? s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : "");
const lagText = (f: { adress: string; lgh: string | null; ort: string | null; kundNamn: string | null }) =>
  [[titel(f.adress), f.lgh && `lgh ${f.lgh}`].filter(Boolean).join(", "), titel(f.ort), f.kundNamn].filter(Boolean).join(" · ");

/** Sök lägenheter fritt (adress eller kundnamn) — RLS avgör vad som syns. */
async function sokLagenheter(q: string): Promise<OkoppladForslag[]> {
  const s = q.trim().replace(/[%,()]/g, " ");
  if (s.length < 2) return [];
  const [gata, nr] = s.split(/\s+(?=\d)/);
  const fr = supabase.from("records").select("id, status, data").eq("object_type", "d2d_lagenhet").is("deleted_at", null)
    .or(`data->>gatunamn.ilike.%${gata}%,data->>kund_namn.ilike.%${s}%`).limit(nr ? 60 : 20);
  const { data } = await fr;
  const rader = (data ?? []).map((r: any) => {
    const d = r.data ?? {};
    return { lagenhetId: r.id as string, poang: 0, skal: [] as string[], status: r.status as string,
      adress: [d.gatunamn, d.gatunummer, d.ingang].filter(Boolean).join(" "), lgh: d.name ? String(d.name) : null,
      ort: d.postort ? String(d.postort) : null, kundNamn: d.kund_namn ? String(d.kund_namn) : null, saljare: null };
  });
  const nrS = (nr ?? "").replace(/\D/g, "");
  return (nrS ? rader.filter((r) => String(r.adress).includes(nrS)) : rader)
    .sort((a, b) => a.adress.localeCompare(b.adress, "sv") || Number(a.lgh) - Number(b.lgh)).slice(0, 20);
}

export function ScriveOkopplade({ lagenhetId, onKopplad, oppenFranStart = false }: {
  /** Säljarvyn: bara dokument som matchar den här lägenheten. Utan = alla (admin). */
  lagenhetId?: string;
  onKopplad?: (svar: KopplaSvar & { lagenhetId: string; dokumentId: string }) => void;
  oppenFranStart?: boolean;
}) {
  const [oppen, setOppen] = useState(oppenFranStart);
  const [dok, setDok] = useState<OkoppladDok[] | null>(null);
  const [fler, setFler] = useState(false);
  const [offset, setOffset] = useState(0);
  const [alla, setAlla] = useState(false);
  const [laddar, setLaddar] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [val, setVal] = useState<Record<string, string>>({});          // dokument → vald lägenhet
  const [sok, setSok] = useState<Record<string, string>>({});          // dokument → söktext
  const [traffar, setTraffar] = useState<Record<string, OkoppladForslag[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [klart, setKlart] = useState<Record<string, string>>({});       // dokument → resultattext

  const laddarRef = useRef(false);
  const hamta = useCallback(async (nyOffset = 0) => {
    if (laddarRef.current) return;
    laddarRef.current = true;
    setLaddar(true); setFel(null);
    try {
      const r = await anropa<{ dokument: OkoppladDok[]; fler: boolean; antalIScrive: number }>({
        action: "okopplade", lagenhetId, offset: nyOffset, max: 40, alla,
      });
      setDok((d) => (nyOffset === 0 ? r.dokument : [...(d ?? []), ...r.dokument]));
      setFler(r.fler); setOffset(nyOffset + 40);
      // Förifyll bästa förslaget när det är tydligt (≥ 50 poäng och ensamt i toppen).
      setVal((v) => {
        const n = { ...v };
        for (const d of r.dokument) {
          const [a, b] = d.forslag;
          if (lagenhetId) n[d.id] = lagenhetId;
          else if (a && a.poang >= 50 && (!b || b.poang < a.poang) && !n[d.id]) n[d.id] = a.lagenhetId;
        }
        return n;
      });
    } catch (e) { setFel((e as Error).message); }
    finally { laddarRef.current = false; setLaddar(false); }
  }, [lagenhetId, alla]);

  // Öppnad utan lista (första gången, Uppdatera, byte av urval) → hämta.
  useEffect(() => { if (oppen && dok === null) void hamta(0); }, [oppen, dok, hamta]);

  async function koppla(d: OkoppladDok) {
    const lag = val[d.id];
    if (!lag) return;
    setBusy(d.id); setFel(null);
    try {
      const r = await anropa<KopplaSvar>({ action: "koppla", dokumentId: d.id, lagenhetId: lag });
      const delar = [
        STATUS_TEXT[r.status] ?? r.status,
        r.tjanster.length ? `tjänster: ${r.tjanster.join(", ")}` : (r.osaker ? "tjänsterna kunde inte läsas ur avtalet — fyll i dem på lägenheten" : null),
        r.saljare ? `säljare: ${r.saljare}` : null,
        r.nyStatus ? "lägenheten fick status Signera med Scrive" : null,
      ].filter(Boolean);
      setKlart((k) => ({ ...k, [d.id]: `Kopplat · ${delar.join(" · ")}` }));
      onKopplad?.({ ...r, lagenhetId: lag, dokumentId: d.id });
    } catch (e) { setFel((e as Error).message); }
    finally { setBusy(null); }
  }

  async function sokFor(id: string, q: string) {
    setSok((s) => ({ ...s, [id]: q }));
    const t = await sokLagenheter(q);
    setTraffar((x) => ({ ...x, [id]: t }));
  }

  const rubrik = lagenhetId ? "Finns avtalet redan i Scrive?" : "Hämta avtal som gjorts direkt i Scrive";

  if (!oppen) {
    return (
      <button type="button" className={`btn btn--ghost${lagenhetId ? " btn--sm" : ""}`} onClick={() => setOppen(true)}>{rubrik}</button>
    );
  }

  return (
    <div className={`d2d-okop${lagenhetId ? " d2d-okop--lag" : ""}`}>
      <div className="d2d-okop__head">
        <span className="d2d-avtal__title">{rubrik}</span>
        <div className="d2d-okop__verktyg">
          {!lagenhetId && (
            <label className="d2d-okop__alla">
              <input type="checkbox" checked={alla} onChange={(e) => { setAlla(e.target.checked); setDok(null); }} />
              Visa även utkast och avbrutna
            </label>
          )}
          <button type="button" className="btn btn--ghost btn--sm" disabled={laddar} onClick={() => setDok(null)}>
            {laddar ? "Hämtar…" : "Uppdatera"}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOppen(false)} aria-label="Stäng">Stäng</button>
        </div>
      </div>
      <p className="d2d-okop__ingress">
        {lagenhetId
          ? "Dokument i Scrive som stämmer med den här lägenheten (kundens namn, personnummer, telefon, e-post eller adress) och som inte redan finns i CRM:et."
          : "Dokument i Scrive som inte finns i CRM:et. Kontrollera lägenheten och tryck Koppla — kunduppgifter och tjänster skrivs in på lägenheten, som får status Signera med Scrive."}
      </p>

      {fel && <p className="d2d-scrive__fel">{fel}</p>}
      {dok === null && laddar && <p className="formfield__help">Hämtar från Scrive…</p>}
      {dok !== null && dok.length === 0 && (
        <p className="formfield__help">{lagenhetId ? "Inget avtal i Scrive stämmer med den här lägenheten." : "Alla avtal i Scrive finns redan i CRM:et."}</p>
      )}

      <div className="d2d-okop__lista">
        {(dok ?? []).map((d) => {
          const valt = val[d.id];
          const valtRad = d.forslag.find((f) => f.lagenhetId === valt) ?? (traffar[d.id] ?? []).find((f) => f.lagenhetId === valt) ?? null;
          const klar = klart[d.id];
          return (
            <div key={d.id} className={`d2d-okop__kort${klar ? " d2d-okop__kort--klar" : ""}`}>
              <div className="d2d-okop__rad1">
                <b>{d.kundNamn ?? "Okänd kund"}</b>
                <span className={`d2d-scrive__status d2d-scrive__status--${d.crmStatus}`}>{STATUS_TEXT[d.crmStatus] ?? d.crmStatus}</span>
                <span className="d2d-okop__meta">{datum(d.signerad ?? d.skapad)}{d.avsandareNamn ? ` · ${d.avsandareNamn}` : ""}</span>
              </div>
              <div className="d2d-okop__meta">
                {[d.adress && `${d.adress}${d.lgh ? `, lgh ${d.lgh}` : ""}`, d.ort, d.personnummer, d.telefon, d.epost].filter(Boolean).join(" · ") || d.titel}
              </div>
              <div className="d2d-okop__tj">
                {d.tjansterText.length ? d.tjansterText.join(", ") : <i>{d.osaker ? "Tjänsterna kunde inte läsas ur dokumentet" : "Inga tjänster ikryssade"}</i>}
                {d.startdatum ? ` · start ${d.startdatum}` : ""}
              </div>

              {klar ? (
                <p className="d2d-scrive__info">✓ {klar}</p>
              ) : (
                <div className="d2d-okop__koppla">
                  {!lagenhetId && (
                    <div className="d2d-okop__valj">
                      {d.forslag.length > 0 && (
                        <div className="d2d-okop__forslag">
                          {d.forslag.map((f) => (
                            <button key={f.lagenhetId} type="button"
                              className={`d2d-reason-chip d2d-okop__chip${valt === f.lagenhetId ? " d2d-okop__chip--vald" : ""}`}
                              onClick={() => setVal((v) => ({ ...v, [d.id]: f.lagenhetId }))}
                              title={`Matchar på ${f.skal.join(", ")}`}>
                              {lagText(f)}
                              <small> {LAG_STATUS[f.status] ?? f.status}{f.saljare ? ` · ${f.saljare}` : ""} · {f.skal.join(", ")}</small>
                            </button>
                          ))}
                        </div>
                      )}
                      <input className="input input--sm" placeholder="Sök annan lägenhet (gata nr eller kund)…" value={sok[d.id] ?? ""}
                        onChange={(e) => void sokFor(d.id, e.target.value)} />
                      {(traffar[d.id] ?? []).length > 0 && (sok[d.id] ?? "").trim().length >= 2 && (
                        <div className="d2d-okop__forslag">
                          {(traffar[d.id] ?? []).map((f) => (
                            <button key={f.lagenhetId} type="button"
                              className={`d2d-reason-chip d2d-okop__chip${valt === f.lagenhetId ? " d2d-okop__chip--vald" : ""}`}
                              onClick={() => setVal((v) => ({ ...v, [d.id]: f.lagenhetId }))}>
                              {lagText(f)}<small> {LAG_STATUS[f.status] ?? f.status}</small>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="d2d-okop__knappar">
                    {!lagenhetId && <span className="d2d-okop__meta">{valtRad ? `→ ${lagText(valtRad)}` : "Välj lägenhet"}</span>}
                    <button type="button" className="btn btn--brand btn--sm" disabled={!valt || busy === d.id} onClick={() => void koppla(d)}>
                      {busy === d.id ? "Kopplar…" : lagenhetId ? "Koppla hit" : "Koppla"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {fler && dok && (
        <button type="button" className="btn btn--ghost btn--sm" disabled={laddar} onClick={() => void hamta(offset)}>
          {laddar ? "Hämtar…" : "Hämta fler från Scrive"}
        </button>
      )}
    </div>
  );
}
