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
        och signerar kunden, och får ett mejl med länk till kundkortet. Pinnarna räknas den månad kunden signerar.
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

/* ── Sidan "Sälj från kundtjänst" (under Alla lägenheter) ─────────────── */

type Salj = {
  alla: boolean;
  minaNya: number;
  saljare: Array<{ id: string; namn: string; nya: number; totalt: number }>;
  affarer: Array<{ id: string; status: string | null; ny: boolean; lgh: string | null; adress: string;
                   kund: string | null; telefon: string | null; saljareId: string | null; saljare: string | null;
                   kundtjanst: string | null; lamnad: string | null; pinnar: number }>;
};

/** Hämtar sidans data. DB: d2d_kundtjanst_salj (säljaren ser sina, admin/kundtjänst alla). */
function useKundtjanstSalj(): { data: Salj | null; fel: boolean } {
  const [data, setData] = useState<Salj | null>(null);
  const [fel, setFel] = useState(false);
  useEffect(() => {
    let on = true;
    Promise.resolve(supabase.rpc("d2d_kundtjanst_salj"))
      .then(({ data: d, error }) => { if (!on) return; if (error) setFel(true); else setData(d as Salj); })
      .catch(() => { if (on) setFel(true); });
    return () => { on = false; };
  }, []);
  return { data, fel };
}

/** Knappen under "Alla lägenheter" i projektlistan, med antal nya (mina nya för säljaren, alla nya för admin/kundtjänst). */
export function KundtjanstSaljKnapp({ onOpen }: { onOpen: () => void }) {
  const { data } = useKundtjanstSalj();
  if (!data || (!data.alla && data.affarer.length === 0)) return null;
  const nya = data.alla ? data.saljare.reduce((s, x) => s + x.nya, 0) : data.minaNya;
  return (
    <button type="button" className="btn btn--ghost d2d-alla__knapp d2d-ktsalj__knapp" onClick={onOpen}>
      <span aria-hidden>☎</span> Sälj från kundtjänst
      {nya > 0 && <span className="d2d-ktsalj__badge" aria-label={`${nya} nya`}>{nya} {nya === 1 ? "ny" : "nya"}</span>}
    </button>
  );
}

export function KundtjanstSaljSida({ onBack, onOpenLagenhet }: {
  onBack: () => void;
  onOpenLagenhet: (id: string) => void;
}) {
  const { data, fel } = useKundtjanstSalj();
  const [saljare, setSaljare] = useState<string | null>(null);
  const [baraNya, setBaraNya] = useState(false);

  const rader = (data?.affarer ?? []).filter((a) => (!saljare || a.saljareId === saljare) && (!baraNya || a.ny));
  const nyaTotalt = (data?.saljare ?? []).reduce((s, x) => s + x.nya, 0);

  return (
    <div className="d2d-detail d2d-ktsalj">
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack} aria-label="Tillbaka till projekt">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>Sälj från kundtjänst</h2>
          <span className="d2d-topbar__sub">{data ? `${data.affarer.length} st · ${nyaTotalt} ${nyaTotalt === 1 ? "ny" : "nya"}` : "Laddar…"}</span>
        </div>
      </div>

      {fel && <div className="d2d-empty">Kunde inte hämta kundtjänstens sälj. Försök igen.</div>}
      {!fel && !data && <div className="d2d-loading">Laddar…</div>}

      {data && (
        <>
          <p className="d2d-ktsalj__intro">
            Affärer som kundtjänst tagit emot och lämnat till en säljare. <strong>Ny</strong> = väntar på säljaren:
            ring kunden, validera tjänsterna och signera (Såld eller Scrive).{data.alla ? "" : " Du ser affärerna som lämnats till dig."}
          </p>

          {/* Antal nya per tilldelad säljare — klicka för att filtrera. */}
          <div className="d2d-status-picker d2d-ktsalj__saljare" role="group" aria-label="Filtrera på säljare">
            {data.alla && (
              <button type="button" className={`d2d-status-btn${!saljare ? " d2d-status-btn--active" : ""}`} onClick={() => setSaljare(null)}>
                Alla <span className="d2d-ktsalj__nya">{nyaTotalt} nya</span>
              </button>
            )}
            {data.saljare.map((s) => (
              <button key={s.id} type="button"
                className={`d2d-status-btn${saljare === s.id ? " d2d-status-btn--active" : ""}`}
                onClick={() => setSaljare(saljare === s.id ? null : s.id)}
                title={`${s.nya} nya av ${s.totalt}`}>
                {s.namn} <span className={`d2d-ktsalj__nya${s.nya > 0 ? " d2d-ktsalj__nya--har" : ""}`}>{s.nya} {s.nya === 1 ? "ny" : "nya"}</span>
              </button>
            ))}
            <label className="d2d-ktsalj__bara">
              <input type="checkbox" checked={baraNya} onChange={(e) => setBaraNya(e.target.checked)} /> Bara nya
            </label>
          </div>

          {rader.length === 0 && <div className="d2d-empty">{data.affarer.length === 0 ? "Inga affärer från kundtjänst ännu." : "Inga affärer med det urvalet."}</div>}

          <div className="d2d-list">
            {rader.map((a) => (
              <button key={a.id} type="button" className={`d2d-card d2d-ktsalj__rad${a.ny ? " d2d-ktsalj__rad--ny" : ""}`} onClick={() => onOpenLagenhet(a.id)}>
                <div className="d2d-card__main">
                  <span className="d2d-card__title">
                    {a.ny && <span className="d2d-ktsalj__ny">Ny</span>}
                    {a.adress || "—"}{a.lgh ? `, lgh ${a.lgh}` : ""}
                  </span>
                  <span className="d2d-card__sub">
                    {[a.kund, a.telefon, data.alla && a.saljare ? `→ ${a.saljare}` : null,
                      a.kundtjanst ? `från ${a.kundtjanst}` : null, datum(a.lamnad)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span className={`d2d-kt-mina__status d2d-kt-mina__status--${a.status ?? "x"}`}>
                  {a.ny ? "Väntar" : STATUS[a.status ?? ""] ?? a.status ?? "—"}
                  {a.pinnar > 0 && <small> {a.pinnar.toLocaleString("sv-SE", { maximumFractionDigits: 1 })} p</small>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
