import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useUserName } from "@/lib/users";
import "@/styles/d2d.css";

/**
 * Kundtjänst-affärer i D2D-sälj.
 * - KundtjanstPanel: på adressen. Kundtjänst registrerar affären (tjänster i formuläret)
 *   och lämnar den till en säljare, som validerar och signerar (Såld eller Scrive).
 *   Säljaren ser en banner om att affären kom via kundtjänst.
 * - KundtjanstMina: startsidan i D2D-sälj, kundtjänstens överlämnade affärer (60 dagar).
 *   Behövs eftersom adressen ägs av säljaren efter överlämningen.
 * Lön: kundtjänst får alla pinnar till sin egen modell (andel av kr/pinne och trappa) och
 * säljaren säljarandelen av pinnarna — se lönemodellens "kundtjanst" och d2d_lon_manad.
 * Databas: d2d_kundtjanst_info, d2d_kundtjanst_lamna (20261014_1600_d2d_kundtjanst_lon.sql).
 */

type Info = {
  arKundtjanst: boolean;
  saljare: Array<{ id: string; namn: string }>;
  mina: Array<{ id: string; lgh: string | null; status: string | null; adress: string; kund: string | null;
                lamnad: string | null; saljare: string | null; pinnar: number }>;
};

let cache: { t: number; p: Promise<Info | null> } | null = null;
/** Hämtar kundtjänstinfo (cachas 60 s mellan adresserna). */
function hamtaInfo(tvinga = false): Promise<Info | null> {
  if (!tvinga && cache && Date.now() - cache.t < 60_000) return cache.p;
  const p = Promise.resolve(supabase.rpc("d2d_kundtjanst_info"))
    .then(({ data, error }) => (error ? null : (data as Info)))
    .catch(() => null);
  cache = { t: Date.now(), p };
  return p;
}

/** Är den inloggade kundtjänst (eller admin)? Kundtjänst ser alla adresser. */
export async function arKundtjanstNu(): Promise<boolean> {
  return !!(await hamtaInfo())?.arKundtjanst;
}

function useKundtjanstInfo(): Info | null {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => { let on = true; hamtaInfo().then((i) => { if (on) setInfo(i); }); return () => { on = false; }; }, []);
  return info;
}

const datum = (iso: unknown) => {
  const s = String(iso ?? "");
  return s ? new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "";
};

const STATUS: Record<string, string> = {
  aterkoppling: "Hos säljaren", sald: "Såld", scrive: "Signerad (Scrive)", anger: "Ånger",
  inte_saljbar: "Inte säljbar", kall_kund: "Kall kund",
};

/* ── På adressen ─────────────────────────────────────────────────────── */

export function KundtjanstPanel({ lagenhetId, status, data, sparaForst, onLamnad }: {
  lagenhetId: string; status: string | null; data: Record<string, unknown>;
  /** Spara formulärets väntande ändringar (tjänsterna) innan affären lämnas. */
  sparaForst: () => Promise<void>;
  /** Affären är lämnad — adressen ägs nu av säljaren, gå tillbaka. */
  onLamnad: () => void;
}) {
  const info = useKundtjanstInfo();
  const ktId = data.kundtjanst ? String(data.kundtjanst) : null;
  const ktNamn = useUserName(ktId);
  const [oppen, setOppen] = useState(false);
  const [saljare, setSaljare] = useState("");
  const [kommentar, setKommentar] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);

  // Redan lämnad: banner till säljaren (och alla andra som ser adressen).
  if (ktId) {
    return (
      <section className="d2d-kt d2d-kt--lamnad" aria-label="Kundtjänstaffär">
        <div className="d2d-kt__head">
          <span className="d2d-kt__ikon" aria-hidden>☎</span>
          <strong>Affär via kundtjänst</strong>
          <span className="d2d-kt__datum">{datum(data.kundtjanst_lamnad)}</span>
        </div>
        <p className="d2d-kt__text">
          {ktNamn && ktNamn !== "…" ? ktNamn : "Kundtjänst"} tog emot affären. {status === "sald" || status === "scrive"
            ? "Affären är signerad."
            : "Validera tjänsterna med kunden och signera — Såld eller Signera med Scrive."}
        </p>
        <p className="d2d-kt__hint">Pinnarna delas enligt lönemodellen: kundtjänst får sin del och säljaren säljarandelen.</p>
      </section>
    );
  }

  if (!info?.arKundtjanst || !status || ["sald", "scrive", "anger"].includes(status)) return null;

  if (!oppen) {
    return (
      <p className="d2d-kt__oppna">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOppen(true)}>☎ Kundtjänst: lämna affären till en säljare</button>
      </p>
    );
  }

  const lamna = async () => {
    if (!saljare) { setFel("Välj säljaren som ska validera och signera."); return; }
    setBusy(true); setFel(null);
    try { await sparaForst(); } catch { /* formulärets egna fel visas där */ }
    const { error } = await supabase.rpc("d2d_kundtjanst_lamna", {
      p_lagenhet: lagenhetId, p_saljare: saljare, p_kommentar: kommentar.trim() || null,
    });
    setBusy(false);
    if (error) { setFel(error.message || "Något gick fel."); return; }
    void hamtaInfo(true);
    onLamnad();
  };

  return (
    <section className="d2d-kt d2d-kt--form" aria-label="Lämna till säljare">
      <div className="d2d-kt__head">
        <span className="d2d-kt__ikon" aria-hidden>☎</span>
        <strong>Lämna affären till en säljare</strong>
      </div>
      <p className="d2d-kt__hint">
        Fyll i kundens uppgifter och tjänsterna nedan först. Säljaren får adressen som Återkoppling och validerar
        och signerar kunden. Pinnarna räknas den månad kunden signerar.
      </p>
      <label className="d2d-kt__falt">Säljare
        <select className="input input--sm" value={saljare} onChange={(e) => { setSaljare(e.target.value); setFel(null); }} disabled={busy}>
          <option value="">Välj säljare…</option>
          {(info.saljare ?? []).map((s) => <option key={s.id} value={s.id}>{s.namn}</option>)}
        </select>
      </label>
      <label className="d2d-kt__falt">Till säljaren (valfritt)
        <input className="input input--sm" value={kommentar} maxLength={300} placeholder="T.ex. ring kunden efter 17"
          onChange={(e) => setKommentar(e.target.value)} disabled={busy} />
      </label>
      {fel && <div className="d2d-fb__error" role="alert">{fel}</div>}
      <div className="d2d-kt__knappar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setOppen(false); setFel(null); }} disabled={busy}>Avbryt</button>
        <button type="button" className="btn btn--brand btn--sm" onClick={() => void lamna()} disabled={busy}>{busy ? "Lämnar…" : "Lämna till säljaren"}</button>
      </div>
    </section>
  );
}

/* ── Startsidan: mina överlämnade affärer ───────────────────────────── */

export function KundtjanstMina() {
  const info = useKundtjanstInfo();
  if (!info?.arKundtjanst || !info.mina?.length) return null;
  return (
    <section className="d2d-kt-mina" aria-label="Mina kundtjänstaffärer">
      <h2 className="d2d-kt-mina__rubrik">Mina kundtjänstaffärer <small>senaste 60 dagarna</small></h2>
      <ul className="d2d-kt-mina__lista">
        {info.mina.map((a) => (
          <li key={a.id}>
            <span className="d2d-kt-mina__adress">
              <strong>{a.adress || "—"}{a.lgh ? `, lgh ${a.lgh}` : ""}</strong>
              <small>{[a.kund, a.saljare ? `→ ${a.saljare}` : null, datum(a.lamnad)].filter(Boolean).join(" · ")}</small>
            </span>
            <span className={`d2d-kt-mina__status d2d-kt-mina__status--${a.status ?? "x"}`}>
              {STATUS[a.status ?? ""] ?? a.status ?? "—"}
              {a.pinnar > 0 && <small> {a.pinnar.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} p</small>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
