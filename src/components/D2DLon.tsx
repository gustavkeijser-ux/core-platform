import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FieldDef } from "@/lib/data";
import { prisKategorier } from "./D2DAvtal";
import "@/styles/d2d.css";

/* =============================================================================
   Lönemodell för dörrsäljarna (Blitz).

   Varje såld tjänst ger "pinnar" (t.ex. bredband 1,0, TV Mini 0,1). Pinnarna
   per månad ger en bonus enligt en trappa (80 pinnar → 5 000 kr osv.) som
   betalas ut månaden efter. Allt räknas i databasen:

   LonemodellEditor — Inställningar → Priser, under prislistan (admin):
                      pinnar per produkt, trappan, kr/pinne, utbetalningsmånad.
                      DB: get_d2d_lonemodell, set_d2d_lonemodell.
   BlitzPinnar      — Blitz → Översikt: en stapel per säljare för innevarande
                      månad med trappstegen markerade. DB: d2d_pinnar_oversikt.
   D2DLonerPage     — Door to door → Löner (bara Lukas, Jonas, Gustav —
                      tabellen d2d_lon_behorighet): kommande bonusar per månad,
                      per säljare och produkt. DB: d2d_lon_prognos.
   ========================================================================== */

type Trappsteg = { pinnar: number; bonus: number };
type Lonemodell = {
  pinnar: Record<string, number>;
  trappa: Trappsteg[];
  krPerPinne?: number;
  utbetalningManaderEfter?: number;
  updatedAt?: string | null;
};

type Niva = {
  niva: number | null; bonus: number; nastaNiva: number | null; nastaBonus: number | null; kvar: number | null;
};
type SaljareRad = Niva & {
  id: string; namn: string; pinnar: number; vantar: number; affarer: number; affarerVantar: number;
  bonusInklVantar: number;
  produkter?: Array<{ nyckel: string; antal: number; pinnar: number }>;
};
type Manad = { manad: string; utbetalning: string; saljare: SaljareRad[] };

const MANADER = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
/** "2026-10" → "oktober 2026" */
const manadNamn = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MANADER[m - 1]} ${y}` : ym;
};
const kr = (n: number | null | undefined) =>
  n == null ? "—" : `${Math.round(n).toLocaleString("sv-SE")} kr`;
const pn = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Produktnyckel ("salt_tv:tv_bas") → etikett ("TV – TV Mini") via fältdefinitionerna. */
function produktEtikett(nyckel: string, fields: FieldDef[]): string {
  const [falt, val] = nyckel.split(":");
  const f = fields.find((x) => x.key === falt);
  if (!f) return nyckel;
  if (!val) return f.label;
  const c = f.options.choices?.find((x) => x.key === val);
  return c ? `${f.label} – ${c.label}` : `${f.label} – ${val}`;
}

/** Raderna i lönemodellen: samma produkter som prislistan, men bredband samlat. */
function pinnRader(fields: FieldDef[]): Array<{ nyckel: string; label: string; grupp: string }> {
  const ut: Array<{ nyckel: string; label: string; grupp: string }> = [];
  for (const f of prisKategorier(fields)) {
    if (f.key === "salt_router" || f.key === "salt_tvbox") continue;       // engångskostnader ger inga pinnar
    if (f.fieldType === "boolean" || f.key === "salt_bredband") {
      ut.push({ nyckel: f.key, label: f.key === "salt_bredband" ? "Bredband (alla hastigheter)" : f.label, grupp: f.label });
      continue;
    }
    for (const c of f.options.choices ?? []) ut.push({ nyckel: `${f.key}:${c.key}`, label: c.label, grupp: f.label });
  }
  if (!ut.some((r) => r.nyckel === "salt_mobil:extra_anvandare")) {
    ut.push({ nyckel: "salt_mobil:extra_anvandare", label: "Extra användare", grupp: "Mobil" });
  }
  return ut;
}

// ─── Admin: redigera lönemodellen ───────────────────────────────────────────

export function LonemodellEditor({ fields }: { fields: FieldDef[] }) {
  const [bas, setBas] = useState<Lonemodell | null>(null);
  const [utkast, setUtkast] = useState<Lonemodell | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [sparar, setSparar] = useState(false);
  const [sparat, setSparat] = useState(false);
  const rader = useMemo(() => pinnRader(fields), [fields]);

  useEffect(() => {
    let on = true;
    supabase.rpc("get_d2d_lonemodell").then(({ data, error }) => {
      if (!on) return;
      if (error) { setFel(error.message); return; }
      const m = data as Lonemodell;
      setBas(m); setUtkast(JSON.parse(JSON.stringify(m)));
    });
    return () => { on = false; };
  }, []);

  const andrad = useMemo(() => JSON.stringify(utkast) !== JSON.stringify(bas), [utkast, bas]);
  const tal = (raw: string) => { const n = Number(raw.replace(",", ".")); return raw.trim() === "" || !Number.isFinite(n) ? null : n; };

  function sattPinnar(nyckel: string, raw: string) {
    setSparat(false);
    setUtkast((u) => {
      if (!u) return u;
      const p = { ...u.pinnar };
      const n = tal(raw);
      if (n == null) delete p[nyckel]; else p[nyckel] = n;
      return { ...u, pinnar: p };
    });
  }
  function sattSteg(i: number, k: keyof Trappsteg, raw: string) {
    setSparat(false);
    setUtkast((u) => {
      if (!u) return u;
      const t = u.trappa.map((s, j) => (j === i ? { ...s, [k]: tal(raw) ?? 0 } : s));
      return { ...u, trappa: t };
    });
  }
  function taBortSteg(i: number) { setSparat(false); setUtkast((u) => u && ({ ...u, trappa: u.trappa.filter((_, j) => j !== i) })); }
  function laggTillSteg() {
    setSparat(false);
    setUtkast((u) => {
      if (!u) return u;
      const sista = u.trappa[u.trappa.length - 1];
      return { ...u, trappa: [...u.trappa, { pinnar: (sista?.pinnar ?? 40) + 40, bonus: (sista?.bonus ?? 0) + 5000 }] };
    });
  }

  async function spara() {
    if (!utkast) return;
    setSparar(true); setFel(null);
    const data = { ...utkast, trappa: [...utkast.trappa].filter((s) => s.pinnar > 0).sort((a, b) => a.pinnar - b.pinnar) };
    const { data: svar, error } = await supabase.rpc("set_d2d_lonemodell", { p_data: data });
    setSparar(false);
    if (error) { setFel(error.message); return; }
    const m = svar as Lonemodell;
    setBas(m); setUtkast(JSON.parse(JSON.stringify(m))); setSparat(true);
  }

  if (fel && !utkast) return <div className="formfield__error">Kunde inte hämta lönemodellen: {fel}</div>;
  if (!utkast) return <p className="formfield__help">Hämtar lönemodellen…</p>;

  const grupper = [...new Set(rader.map((r) => r.grupp))];
  return (
    <div className="d2d-lon-editor">
      <h2 className="d2d-lon-editor__h2">Lönemodell</h2>
      <p className="field-config__hint">
        Varje såld tjänst ger pinnar. Pinnarna per månad (sålda adresser och signerade Scrive-avtal) ger bonus enligt trappan.
        Säljarna ser sina pinnar och nästa nivå i Blitz → Översikt; Löner-sidan visar kommande bonusar. TV Start och TV Bas ger inga pinnar.
      </p>

      <div className="d2d-lon-editor__villkor">
        <label>Kr per pinne (information)
          <input className="input input--sm" inputMode="decimal" value={utkast.krPerPinne ?? ""}
            onChange={(e) => { setSparat(false); setUtkast((u) => u && ({ ...u, krPerPinne: tal(e.target.value) ?? undefined })); }} />
        </label>
        <label>Utbetalas månader efter
          <input className="input input--sm" inputMode="numeric" value={utkast.utbetalningManaderEfter ?? ""}
            onChange={(e) => { setSparat(false); setUtkast((u) => u && ({ ...u, utbetalningManaderEfter: tal(e.target.value) ?? undefined })); }} />
        </label>
      </div>

      <div className="d2d-lon-editor__kolumner">
        <section>
          <h3>Pinnar per produkt</h3>
          {grupper.map((g) => (
            <div key={g} className="d2d-lon-editor__grupp">
              <span className="d2d-lon-editor__gruppnamn">{g}</span>
              {rader.filter((r) => r.grupp === g).map((r) => (
                <label key={r.nyckel} className="d2d-lon-editor__rad">
                  <span>{r.label}</span>
                  <input className="input input--sm" inputMode="decimal" aria-label={`${r.label} – pinnar`}
                    value={utkast.pinnar[r.nyckel] ?? ""} placeholder="0"
                    onChange={(e) => sattPinnar(r.nyckel, e.target.value)} />
                </label>
              ))}
            </div>
          ))}
        </section>

        <section>
          <h3>Bonustrappa</h3>
          <div className="d2d-lon-editor__trappa">
            <span className="d2d-lon-editor__th">Pinnar</span>
            <span className="d2d-lon-editor__th">Bonus (kr)</span>
            <span className="d2d-lon-editor__th">Ger dig/pinne</span>
            <span />
            {utkast.trappa.map((s, i) => (
              <div key={i} className="d2d-lon-editor__steg">
                <input className="input input--sm" inputMode="numeric" aria-label={`Steg ${i + 1} pinnar`} value={s.pinnar} onChange={(e) => sattSteg(i, "pinnar", e.target.value)} />
                <input className="input input--sm" inputMode="numeric" aria-label={`Steg ${i + 1} bonus`} value={s.bonus} onChange={(e) => sattSteg(i, "bonus", e.target.value)} />
                <span className="d2d-lon-editor__per">{s.pinnar > 0 ? `${Math.round(s.bonus / s.pinnar)} kr` : "—"}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => taBortSteg(i)} aria-label="Ta bort steg">×</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={laggTillSteg}>+ Lägg till steg</button>
        </section>
      </div>

      {fel && <div className="formfield__error">{fel}</div>}
      <div className="d2d-prislista__fot">
        {sparat && !andrad && <span className="d2d-prislista__sparat">✓ Sparat</span>}
        {andrad && <button className="btn btn--ghost" onClick={() => setUtkast(JSON.parse(JSON.stringify(bas)))} disabled={sparar}>Ångra ändringar</button>}
        <button className="btn btn--brand" onClick={() => void spara()} disabled={sparar || !andrad}>{sparar ? "Sparar…" : "Spara lönemodell"}</button>
      </div>
    </div>
  );
}

// ─── Blitz → Översikt: pinnar den här månaden ───────────────────────────────

type Oversikt = Manad & { trappa: Trappsteg[]; jag: string | null };

export function BlitzPinnar({ minId }: { minId: string | null }) {
  const [data, setData] = useState<Oversikt | null>(null);
  const [fel, setFel] = useState(false);

  const ladda = useCallback(() => {
    supabase.rpc("d2d_pinnar_oversikt").then(({ data, error }) => {
      if (error) { setFel(true); return; }
      setData(data as Oversikt);
    });
  }, []);
  useEffect(() => {
    ladda();
    const t = window.setInterval(ladda, 5 * 60_000);
    return () => window.clearInterval(t);
  }, [ladda]);

  if (fel || !data) return null;                    // tyst — översikten fungerar utan
  const trappa = [...(data.trappa ?? [])].sort((a, b) => a.pinnar - b.pinnar);
  const jag = minId ?? data.jag;
  const rader = data.saljare.filter((s) => s.pinnar + s.vantar > 0 || s.id === jag);

  /** Varje säljare mäts mot sitt eget nästa delmål: stapeln fylls från
   *  föregående nivå (eller 0) till nästa. Högsta nivån nådd = full stapel. */
  const segment = (s: SaljareRad) => {
    const fran = s.niva ?? 0;
    const till = s.nastaNiva ?? s.niva ?? trappa[0]?.pinnar ?? 1;
    const bredd = Math.max(till - fran, 0.0001);
    const andel = s.nastaNiva == null ? 1 : Math.min(1, Math.max(0, (s.pinnar - fran) / bredd));
    const vantarAndel = s.nastaNiva == null ? 0 : Math.min(1 - andel, s.vantar / bredd);
    return { fran, till, andel, vantarAndel };
  };

  return (
    <section className="d2dd__section d2d-pinnar">
      <h2 className="d2dd__rubrik">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></svg>
        Pinnar — {manadNamn(data.manad)}
      </h2>
      {rader.length === 0 ? (
        <div className="d2dd__tom">Inga pinnar ännu den här månaden</div>
      ) : (
        <div className="d2d-pinnar__kort-lista">
          {rader.map((s) => {
            const seg = segment(s);
            const klar = s.nastaNiva == null && s.niva != null;
            return (
              <div key={s.id} className={`d2d-pinnar__kort${s.id === jag ? " d2d-pinnar__kort--jag" : ""}${klar ? " d2d-pinnar__kort--klar" : ""}`}>
                <div className="d2d-pinnar__kort-head">
                  <span className="d2d-pinnar__namn">{s.namn}{s.id === jag ? " (du)" : ""}</span>
                  <span className="d2d-pinnar__tal">{pn(s.pinnar)} <small>pinnar</small></span>
                </div>
                <div className="d2d-pinnar__stapel" role="progressbar" aria-valuemin={seg.fran} aria-valuemax={seg.till} aria-valuenow={s.pinnar}
                  title={`${pn(s.pinnar)} av ${seg.till} pinnar${s.vantar ? `, ${pn(s.vantar)} väntar på signering` : ""}`}>
                  <div className="d2d-pinnar__fyll" style={{ width: `${seg.andel * 100}%` }} />
                  {seg.vantarAndel > 0 && (
                    <div className="d2d-pinnar__fyll d2d-pinnar__fyll--vantar" style={{ left: `${seg.andel * 100}%`, width: `${seg.vantarAndel * 100}%` }} />
                  )}
                </div>
                <div className="d2d-pinnar__kort-fot">
                  <span className="d2d-pinnar__delmal">
                    {s.niva != null ? <span className="d2d-pinnar__nadd">✓ {s.niva} nådd · {kr(s.bonus)}</span> : <span>{seg.fran}</span>}
                  </span>
                  <span className="d2d-pinnar__kvar">
                    {s.nastaNiva != null
                      ? <><strong>{pn(s.kvar)}</strong> kvar till {s.nastaNiva} ({kr(s.nastaBonus)})</>
                      : <>Högsta nivån nådd</>}
                    {s.vantar > 0 && <span className="d2d-pinnar__vantar"> · {pn(s.vantar)} väntar</span>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {trappa.length > 0 && (
        <p className="d2d-pinnar__trappa">
          Trappa: {trappa.map((t) => `${t.pinnar} → ${kr(t.bonus)}`).join(" · ")}
        </p>
      )}
    </section>
  );
}

// ─── Door to door → Löner (Lukas, Jonas, Gustav) ────────────────────────────

export async function d2dLonBehorig(): Promise<boolean> {
  const { data } = await supabase.rpc("d2d_lon_behorig");
  return data === true;
}

export function D2DLonerPage({ fields }: { fields: FieldDef[] }) {
  const [data, setData] = useState<{ modell: Lonemodell; manader: Manad[] } | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [antal, setAntal] = useState(3);
  const [oppen, setOppen] = useState<string | null>(null);     // "manad|saljare"

  useEffect(() => {
    let on = true;
    setData(null);
    supabase.rpc("d2d_lon_prognos", { p_manad: null, p_antal: antal }).then(({ data, error }) => {
      if (!on) return;
      if (error) { setFel(error.message); return; }
      setData(data as { modell: Lonemodell; manader: Manad[] });
    });
    return () => { on = false; };
  }, [antal]);

  if (fel) return <div className="page"><div className="formfield__error">{fel}</div></div>;
  if (!data) return <div className="page"><p className="formfield__help">Räknar pinnar…</p></div>;

  const nu = data.manader[0];
  return (
    <div className="page d2d-loner">
      <section className="card d2d-loner__intro">
        <p>
          Bonus enligt lönemodellen (Inställningar → Priser). En adress räknas den månad den blev såld eller signerad i Scrive;
          bonusen betalas ut {data.modell.utbetalningManaderEfter ?? 1} månad{(data.modell.utbetalningManaderEfter ?? 1) === 1 ? "" : "er"} efter.
          Skickade men inte signerade avtal visas som "väntar" och ger ingen bonus förrän de signerats.
        </p>
        <label className="d2d-loner__antal">Visa
          <select className="input input--sm" value={antal} onChange={(e) => setAntal(Number(e.target.value))}>
            <option value={1}>bara denna månad</option>
            <option value={3}>3 månader</option>
            <option value={6}>6 månader</option>
            <option value={12}>12 månader</option>
          </select>
        </label>
      </section>

      {data.manader.map((m) => {
        const summa = m.saljare.reduce((a, s) => a + (s.bonus ?? 0), 0);
        const summaInkl = m.saljare.reduce((a, s) => a + (s.bonusInklVantar ?? 0), 0);
        const arNu = m === nu;
        return (
          <section key={m.manad} className="card d2d-loner__manad">
            <header className="d2d-loner__head">
              <div>
                <h2>{manadNamn(m.manad)}{arNu ? <span className="d2d-loner__pagar">pågår</span> : null}</h2>
                <span className="d2d-loner__sub">Utbetalas med lönen i {manadNamn(m.utbetalning)}</span>
              </div>
              <div className="d2d-loner__summa">
                <span className="d2d-loner__summa-tal">{kr(summa)}</span>
                <span className="d2d-loner__summa-text">att betala ut{summaInkl > summa ? ` · ${kr(summaInkl)} om väntande signeras` : ""}</span>
              </div>
            </header>

            <div className="d2d-loner__tabell" role="table">
              <div className="d2d-loner__tr d2d-loner__tr--head" role="row">
                <span>Säljare</span><span>Affärer</span><span>Pinnar</span><span>Väntar</span><span>Nivå</span><span>Nästa nivå</span><span>Bonus</span>
              </div>
              {m.saljare.map((s) => {
                const key = `${m.manad}|${s.id}`;
                const open = oppen === key;
                return (
                  <div key={s.id} className={`d2d-loner__rad${open ? " d2d-loner__rad--open" : ""}`}>
                    <button type="button" className="d2d-loner__tr" role="row" aria-expanded={open} onClick={() => setOppen(open ? null : key)}>
                      <span className="d2d-loner__namn">{s.namn}</span>
                      <span>{s.affarer}{s.affarerVantar ? <small> (+{s.affarerVantar})</small> : null}</span>
                      <span className="d2d-loner__pinnar">{pn(s.pinnar)}</span>
                      <span className="d2d-loner__vantar">{s.vantar > 0 ? pn(s.vantar) : "—"}</span>
                      <span>{s.niva ?? "—"}</span>
                      <span>{s.nastaNiva != null ? <>{s.nastaNiva} <small>({pn(s.kvar)} kvar)</small></> : "—"}</span>
                      <span className={`d2d-loner__bonus${s.bonus > 0 ? " d2d-loner__bonus--ja" : ""}`}>
                        {kr(s.bonus)}{s.bonusInklVantar > s.bonus ? <small> → {kr(s.bonusInklVantar)}</small> : null}
                      </span>
                    </button>
                    {open && (
                      <div className="d2d-loner__detalj">
                        {(s.produkter ?? []).length === 0 ? (
                          <span className="d2d-loner__sub">Inga sålda eller signerade tjänster den här månaden.</span>
                        ) : (
                          <div className="d2d-loner__produkter">
                            {(s.produkter ?? []).map((p) => (
                              <div key={p.nyckel} className="d2d-loner__produkt">
                                <span>{produktEtikett(p.nyckel, fields)}</span>
                                <span>{p.antal} st</span>
                                <span>{pn(p.pinnar)} p</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {m.saljare.length === 0 && <div className="d2dd__tom">Inga säljare</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
