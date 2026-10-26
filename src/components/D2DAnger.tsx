import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lasXlsx } from "@/lib/xlsx";
import "@/styles/d2d.css";

/**
 * Ånger — en kund som signerat/köpt men ångrat sig.
 * - AngerPanel: på adressen i D2D-sälj. Säljaren (som sålde), kundtjänst och admin markerar
 *   ånger; bara admin kan ta bort den. Tjänsterna ligger kvar (statistik på vad som såldes).
 * - MinaAnger: Blitz → Översikt, säljarens egna ånger (admin ser alla per säljare).
 * - TeliaImport: Telias VT-fil (orderstatus Cancelled = ånger, Open/Complete = orderlagd).
 * Databas: d2d_markera_anger, d2d_ta_bort_anger, d2d_anger_statistik, d2d_telia_vt_import.
 */

const KALLA: Record<string, string> = { kund: "Kunden hörde av sig", telia: "Telia-underlag", annan: "Annat" };
const idag = () => new Date().toLocaleDateString("sv-SE");
const fmt = (iso: unknown) => {
  const s = String(iso ?? "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return "—";
  return new Date(`${s.slice(0, 10)}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
};

/* ── På adressen ─────────────────────────────────────────────────────── */

export function AngerPanel({ lagenhetId, status, data, isAdmin, onAndrad, sparaForst }: {
  lagenhetId: string; status: string; data: Record<string, unknown>; isAdmin: boolean;
  /** Spara väntande ändringar i formuläret först, så de inte skriver över statusen. */
  sparaForst?: () => Promise<void>;
  onAndrad: (status: string, data: Record<string, unknown>) => void;
}) {
  const [oppen, setOppen] = useState(false);
  const [datum, setDatum] = useState(idag());
  const [kalla, setKalla] = useState("kund");
  const [kommentar, setKommentar] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);

  const kor = async (fn: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    setBusy(true); setFel(null);
    await sparaForst?.();
    const { data: res, error } = await fn();
    setBusy(false);
    if (error) { setFel(error.message || "Något gick fel."); return; }
    const r = res as { status: string; data: Record<string, unknown> };
    setOppen(false); setKommentar("");
    onAndrad(r.status, r.data ?? {});
  };

  if (status === "anger") {
    return (
      <section className="d2d-anger d2d-anger--aktiv" aria-label="Ånger">
        <div className="d2d-anger__head">
          <span className="d2d-anger__ikon" aria-hidden>↩</span>
          <strong>Kunden har ångrat sig</strong>
          <span className="d2d-anger__datum">{fmt(data.anger_datum)}</span>
        </div>
        <p className="d2d-anger__text">
          {KALLA[String(data.anger_kalla ?? "kund")] ?? "Ånger"}
          {data.anger_status_fore === "scrive" ? " · var signerad med Scrive" : data.anger_status_fore === "sald" ? " · var Såld" : ""}
          {data.anger_kommentar ? ` — ${String(data.anger_kommentar)}` : ""}
        </p>
        <p className="d2d-anger__hint">Räknas inte som sälj. Tjänsterna som såldes ligger kvar i statistiken.</p>
        {isAdmin && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
            onClick={() => void kor(() => supabase.rpc("d2d_ta_bort_anger", { p_lag: lagenhetId }))}>
            {busy ? "Tar bort…" : "Ta bort ånger"}
          </button>
        )}
        {fel && <span className="d2d-tillf-form__fel">{fel}</span>}
      </section>
    );
  }

  if (status !== "sald" && status !== "scrive") return null;

  if (!oppen) {
    return (
      <div className="d2d-anger__oppna">
        <button type="button" className="linklike" onClick={() => setOppen(true)}>Kunden har ångrat sig…</button>
      </div>
    );
  }

  return (
    <form className="d2d-anger d2d-tillf-form" onSubmit={(e) => {
      e.preventDefault();
      void kor(() => supabase.rpc("d2d_markera_anger", { p_lag: lagenhetId, p_kalla: kalla, p_datum: datum || null, p_kommentar: kommentar.trim() || null }));
    }}>
      <h3>Markera ånger</h3>
      <p className="d2d-anger__hint">Adressen får status Ånger och räknas bort från säljaren. Vad som såldes sparas och ångern loggas. Bara admin kan ta bort en ånger.</p>
      <label className="d2d-tillf-form__falt">
        <span className="label">Datum för ångern</span>
        <input className="input" type="date" value={datum} max={idag()} onChange={(e) => setDatum(e.target.value)} />
      </label>
      <label className="d2d-tillf-form__falt">
        <span className="label">Hur fick vi veta?</span>
        <select className="input" value={kalla} onChange={(e) => setKalla(e.target.value)}>
          <option value="kund">Kunden hörde av sig</option>
          <option value="telia">Telia-underlag</option>
          <option value="annan">Annat</option>
        </select>
      </label>
      <label className="d2d-tillf-form__falt">
        <span className="label">Kommentar</span>
        <textarea className="input d2d-fel__text" rows={2} value={kommentar} onChange={(e) => setKommentar(e.target.value)}
          placeholder="T.ex. varför kunden ångrade sig" />
      </label>
      {fel && <span className="d2d-tillf-form__fel">{fel}</span>}
      <div className="d2d-tillf-form__knappar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOppen(false)} disabled={busy}>Avbryt</button>
        <button type="submit" className="btn btn--danger btn--sm" disabled={busy}>{busy ? "Sparar…" : "Markera ånger"}</button>
      </div>
    </form>
  );
}

/* ── Statistik ───────────────────────────────────────────────────────── */

type AngerStat = {
  alla: boolean; antal: number; salda: number;
  perSaljare: Array<{ id: string; namn: string | null; anger: number; kund: number; telia: number; salda: number }>;
  lista: Array<{ id: string; kund: string | null; adress: string; ort: string | null; datum: string | null; kalla: string | null;
    kommentar: string | null; statusFore: string | null; saljare: string | null; mine: boolean }>;
};

export function useAngerStatistik(fran?: string | null, till?: string | null) {
  const [stat, setStat] = useState<AngerStat | null>(null);
  const ladda = useCallback(async () => {
    const { data, error } = await supabase.rpc("d2d_anger_statistik", { p_fran: fran || null, p_till: till || null });
    setStat(error ? null : (data as AngerStat));
  }, [fran, till]);
  useEffect(() => { void ladda(); }, [ladda]);
  return { stat, ladda };
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** Blitz → Översikt: säljarens ånger. Admin/kundtjänst ser alla per säljare. */
export function MinaAnger({ minId }: { minId: string | null }) {
  const { stat } = useAngerStatistik();
  const [visaLista, setVisaLista] = useState(false);
  if (!stat) return null;
  const jag = stat.perSaljare.find((p) => p.id === minId);
  const minaRader = stat.lista.filter((r) => r.mine);
  const manadStart = new Date(); manadStart.setDate(1);
  const iManad = minaRader.filter((r) => r.datum && new Date(`${r.datum}T12:00:00`) >= manadStart).length;

  return (
    <section className="d2dd__section d2d-anger-stat">
      <h2 className="d2dd__rubrik">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
        {stat.alla ? "Ånger" : "Mina ånger"}
      </h2>
      <div className="d2dd__kpis">
        <div className="d2dd__kpi"><span className="d2dd__kpi-varde d2d-anger-stat__tal">{stat.alla ? stat.antal : (jag?.anger ?? 0)}</span><span className="d2dd__kpi-etikett">Totalt</span></div>
        {!stat.alla && <div className="d2dd__kpi"><span className="d2dd__kpi-varde">{iManad}</span><span className="d2dd__kpi-etikett">Denna månad</span></div>}
        <div className="d2dd__kpi">
          <span className="d2dd__kpi-varde">{stat.alla ? pct(stat.antal, stat.salda) : pct(jag?.anger ?? 0, jag?.salda ?? 0)} %</span>
          <span className="d2dd__kpi-etikett">av {stat.alla ? stat.salda : (jag?.salda ?? 0)} sålda</span>
        </div>
      </div>
      {stat.alla && stat.perSaljare.some((p) => p.anger > 0) && (
        <ul className="d2d-anger-stat__lista">
          {stat.perSaljare.filter((p) => p.anger > 0).map((p) => (
            <li key={p.id}><span>{p.namn ?? "Okänd"}</span><span><strong>{p.anger}</strong> av {p.salda} ({pct(p.anger, p.salda)} %)</span></li>
          ))}
        </ul>
      )}
      {stat.lista.length > 0 && (
        <button type="button" className="linklike d2d-anger-stat__visa" onClick={() => setVisaLista((v) => !v)}>
          {visaLista ? "Dölj" : `Visa ${stat.alla ? "alla" : "mina"} ånger (${stat.lista.length})`}
        </button>
      )}
      {visaLista && (
        <ul className="d2d-anger-stat__lista d2d-anger-stat__lista--rader">
          {stat.lista.slice(0, 50).map((r) => (
            <li key={r.id}>
              <span><strong>{r.kund ?? "Okänd kund"}</strong><br />{r.adress}{stat.alla && r.saljare ? ` · ${r.saljare}` : ""}</span>
              <span>{fmt(r.datum)}<br />{KALLA[r.kalla ?? "kund"] ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Telia-underlag (VT-filen) ───────────────────────────────────────── */

type ImportRad = {
  rad: number; order: string | null; status: string | null; atgard: string; traffar: number;
  lagenhetId: string | null; statusNu: string | null; kund: string | null; adress: string | null; saljare: string | null; filAdress: string;
};
const ATGARD: Record<string, { label: string; kort: string; ton: string }> = {
  anger: { label: "Markeras som ånger", kort: "blir ånger", ton: "fel" },
  orderlagd: { label: "Orderlagd — VT-beställning markeras beställd", kort: "orderlagda", ton: "ok" },
  scrive_till_sald: { label: "Orderlagd — Scrive-affären blir Såld", kort: "Scrive → Såld", ton: "ok" },
  redan_anger: { label: "Redan ånger", kort: "redan ånger", ton: "neutral" },
  konflikt: { label: "Telia säger orderlagd men adressen har ånger — kolla", kort: "att kolla", ton: "varn" },
  ingen_traff: { label: "Hittades inte i CRM", kort: "hittades inte", ton: "varn" },
  flera_traffar: { label: "Flera adresser matchar — hanteras inte", kort: "flera träffar", ton: "varn" },
  okand_status: { label: "Okänd orderstatus", kort: "okänd status", ton: "varn" },
};

/** Excel-datum (serienummer) eller text → ISO. */
function tillIso(v: string | undefined): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.replace(" ", "T");
  const n = Number(v.replace(",", "."));
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const ms = Math.round((n - 25569) * 86400000);
    const d = new Date(ms);
    // Excel-tiden är lokal (svensk) tid utan zon: skriv ut den som den står.
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
  }
  return null;
}

export function TeliaImport({ onKlar }: { onKlar?: () => void }) {
  const filRef = useRef<HTMLInputElement>(null);
  const [rader, setRader] = useState<Record<string, unknown>[] | null>(null);
  const [filnamn, setFilnamn] = useState("");
  const [resultat, setResultat] = useState<ImportRad[] | null>(null);
  const [kord, setKord] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);

  const valjFil = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fil = e.target.files?.[0];
    e.target.value = "";
    if (!fil) return;
    setFel(null); setResultat(null); setKord(false); setBusy(true);
    try {
      const blad = await lasXlsx(fil);
      const rubriker = (blad.rader[0] ?? []).map((h) => String(h ?? "").trim().toLowerCase());
      const kol = (namn: string) => rubriker.indexOf(namn);
      if (kol("orderstatus") < 0) throw new Error("Hittar inte kolumnen orderstatus — är det Telias VT-fil?");
      const varde = (r: string[], namn: string) => { const i = kol(namn); return i < 0 ? undefined : (String(r[i] ?? "").trim() || undefined); };
      const ut = blad.rader.slice(1).filter((r) => r && r.some((c) => String(c ?? "").trim() !== "")).map((r, i) => ({
        rad: i + 2,
        order: varde(r, "order_number") ?? null,
        status: varde(r, "orderstatus") ?? null,
        persnr: varde(r, "persnr") ?? null,
        adress: varde(r, "adress") ?? null,
        gatnummer: varde(r, "gatnummer") ?? null,
        uppgang: varde(r, "uppgang") ?? null,
        lgh: varde(r, "lagenhets_nr") ?? null,
        postnr: varde(r, "postnr") ?? null,
        uppdaterad: tillIso(varde(r, "last_updated")),
      }));
      setRader(ut); setFilnamn(fil.name);
      const { data, error } = await supabase.rpc("d2d_telia_vt_import", { p_rader: ut, p_kor: false });
      if (error) throw new Error(error.message);
      setResultat(((data as { rader: ImportRad[] }).rader) ?? []);
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Kunde inte läsa filen.");
      setRader(null);
    } finally { setBusy(false); }
  };

  const genomfor = async () => {
    if (!rader) return;
    setBusy(true); setFel(null);
    const { data, error } = await supabase.rpc("d2d_telia_vt_import", { p_rader: rader, p_kor: true });
    setBusy(false);
    if (error) { setFel(error.message); return; }
    setResultat(((data as { rader: ImportRad[] }).rader) ?? []);
    setKord(true);
    onKlar?.();
  };

  const antal = useMemo(() => {
    const c: Record<string, number> = {};
    (resultat ?? []).forEach((r) => { c[r.atgard] = (c[r.atgard] ?? 0) + 1; });
    return c;
  }, [resultat]);
  const atgarder = (antal.anger ?? 0) + (antal.orderlagd ?? 0) + (antal.scrive_till_sald ?? 0);

  return (
    <section className="card telia-imp">
      <div className="telia-imp__head">
        <div>
          <h2>Telia-underlag</h2>
          <p className="vt-panel__regel">Läs in Telias VT-fil. Orderstatus <b>Cancelled</b> blir ånger (räknas bort från säljaren), <b>Open</b>/<b>Complete</b> markerar VT-beställningen som beställd, och en adress som står på Scrive blir Såld (Scrive-avtalet ersätts). Matchning på personnummer, annars adress och lägenhetsnummer. Du ser resultatet innan något ändras.</p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => filRef.current?.click()}>
          {busy && !resultat ? "Läser…" : "Välj fil (.xlsx)"}
        </button>
        <input ref={filRef} type="file" accept=".xlsx" onChange={(e) => void valjFil(e)} style={{ display: "none" }} />
      </div>
      {fel && <div className="formfield__error">{fel}</div>}
      {resultat && (
        <>
          <div className="telia-imp__summa">
            <strong>{filnamn}</strong> · {resultat.length} rader ·{" "}
            {Object.entries(antal).map(([k, n]) => `${n} ${ATGARD[k]?.kort ?? k}`).join(" · ")}
          </div>
          <div className="rtable-scroll">
            <table className="rtable telia-imp__tabell">
              <thead><tr><th>Rad</th><th>Orderstatus</th><th>I filen</th><th>I CRM</th><th>Åtgärd</th></tr></thead>
              <tbody>
                {resultat.map((r) => (
                  <tr key={r.rad} className="rtable__row">
                    <td data-label="Rad">{r.rad}</td>
                    <td data-label="Orderstatus">{r.status ?? "—"}</td>
                    <td data-label="I filen">{r.filAdress}</td>
                    <td data-label="I CRM">{r.lagenhetId ? <span className="telia-imp__crm">{r.kund ?? "—"}<span className="telia-imp__sub">{r.adress}{r.saljare ? ` · ${r.saljare}` : ""}</span></span> : "—"}</td>
                    <td data-label="Åtgärd"><span className={`telia-imp__atg telia-imp__atg--${ATGARD[r.atgard]?.ton ?? "neutral"}`}>{kord && ["anger", "orderlagd", "scrive_till_sald"].includes(r.atgard) ? "✓ " : ""}{ATGARD[r.atgard]?.label ?? r.atgard}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="telia-imp__knappar">
            {kord ? <span className="telia-imp__klar">Klart — {atgarder} adresser uppdaterade.</span> : (
              <>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setResultat(null); setRader(null); }}>Avbryt</button>
                <button type="button" className="btn btn--brand btn--sm" disabled={busy || atgarder === 0} onClick={() => void genomfor()}>
                  {busy ? "Genomför…" : `Genomför (${atgarder})`}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
