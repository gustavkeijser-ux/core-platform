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
                      tabellen d2d_lon_behorighet): lön per säljare och månad =
                      provision (pinnar × kr/pinne) + bonus + justeringar
                      (tillägg/avdrag med kommentar). DB: d2d_lon_prognos,
                      d2d_lon_justering_lagg_till/ta_bort.
   ========================================================================== */

type Trappsteg = { pinnar: number; bonus: number };
type Lonemodell = {
  pinnar: Record<string, number>;
  trappa: Trappsteg[];
  krPerPinne?: number;
  utbetalningManaderEfter?: number;
  /** Första dagen som räknas (ÅÅÅÅ-MM-DD). */
  startdatum?: string | null;
  /** Sista dagen i första löneperioden. Första perioden 26 september–31 oktober 2026, sedan kalendermånader. */
  forstaPeriodTill?: string | null;
  updatedAt?: string | null;
};

type Niva = {
  niva: number | null; bonus: number; nastaNiva: number | null; nastaBonus: number | null; kvar: number | null;
};
type Justering = { id: string; belopp: number; kommentar: string; skapadAt: string; skapadAv: string | null };
/** Riktig lön räknas bara på Såld. "vantar" = Scrive-signerade som ännu inte är Sålda:
 *  visas inom parentes och ingår bara i den potentiella lönen (…InklVantar). */
type SaljareRad = Niva & {
  id: string; namn: string; pinnar: number; vantar: number; affarer: number; affarerVantar: number;
  bonusInklVantar: number;
  /** Lön (bara på Löner-sidan — Blitz får inte beloppen): provision = pinnar × kr/pinne,
   *  lon = provision + bonus + justeringar. */
  provision?: number; provisionInklVantar?: number; justeringar?: number; lon?: number; lonInklVantar?: number;
  justeringarRader?: Justering[];
  produkter?: Array<{ nyckel: string; antal: number; pinnar: number; antalScrive?: number; pinnarScrive?: number }>;
};
type Manad = {
  manad: string; utbetalning: string; krPerPinne?: number; saljare: SaljareRad[];
  /** Löneperioden: kalendermånaden, men tidigast från modellens startdatum. */
  periodFran?: string; periodTill?: string;
};

const MANADER = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
/** "2026-10" → "oktober 2026" */
const manadNamn = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MANADER[m - 1]} ${y}` : ym;
};
/** Löneperiodens namn: "oktober 2026", eller t.ex. "26 september–31 oktober 2026" när den inte är en hel månad. */
const periodNamn = (m: Pick<Manad, "manad" | "periodFran" | "periodTill">) => {
  const f = m.periodFran?.split("-").map(Number), t = m.periodTill?.split("-").map(Number);
  if (!f || !t || (f[2] === 1 && f[1] === t[1])) return manadNamn(m.manad);
  if (f[1] === t[1]) return `${f[2]}–${t[2]} ${MANADER[t[1] - 1]} ${t[0]}`;
  return `${f[2]} ${MANADER[f[1] - 1]}${f[0] !== t[0] ? ` ${f[0]}` : ""}–${t[2]} ${MANADER[t[1] - 1]} ${t[0]}`;
};
/** Scrive-signerade inom parentes efter siffran, bara när det finns några. */
const Paren = ({ n, f }: { n: number | null | undefined; f?: (n: number) => string }) =>
  n ? <small className="d2d-lon__scrive"> ({f ? f(n) : n})</small> : null;
const kr = (n: number | null | undefined) =>
  n == null ? "—" : `${Math.round(n).toLocaleString("sv-SE")} kr`;
const pn = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nar = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "";

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
        Varje såld tjänst ger pinnar. Lön = pinnar × kr per pinne (provision) + trappans bonus när ett steg nås, räknat per löneperiod
        (första perioden från startdatumet till "Första perioden slutar", därefter kalendermånader). Den riktiga lönen räknas bara på adresser med status Såld; Scrive-signerade visas inom parentes
        och ingår bara i den potentiella lönen. Säljarna ser sina pinnar och nästa nivå i Blitz → Översikt; sidan Löner visar lönen per
        säljare med justeringar. TV Start och TV Bas ger inga pinnar.
      </p>

      <div className="d2d-lon-editor__villkor">
        <label>Provision, kr per pinne
          <input className="input input--sm" inputMode="decimal" value={utkast.krPerPinne ?? ""}
            onChange={(e) => { setSparat(false); setUtkast((u) => u && ({ ...u, krPerPinne: tal(e.target.value) ?? undefined })); }} />
        </label>
        <label>Räknas från
          <input className="input input--sm" type="date" value={utkast.startdatum ?? ""}
            onChange={(e) => { setSparat(false); setUtkast((u) => u && ({ ...u, startdatum: e.target.value || null })); }} />
        </label>
        <label>Första perioden slutar
          <input className="input input--sm" type="date" value={utkast.forstaPeriodTill ?? ""}
            onChange={(e) => { setSparat(false); setUtkast((u) => u && ({ ...u, forstaPeriodTill: e.target.value || null })); }} />
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
            <span className="d2d-lon-editor__th">Bonus/pinne</span>
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

export type PinnOversikt = Manad & {
  trappa: Trappsteg[];
  jag: string | null;
  /** Den inloggades egen lön (servern skickar aldrig andras). */
  minLon?: { provision: number; bonus: number; justeringar: number; lon: number; lonInklVantar: number; krPerPinne: number } | null;
};
export type PinnSaljare = SaljareRad;

/** Hämtar innevarande månads pinnar (alla säljare) + egen lön. Uppdateras var 5:e minut. */
export function usePinnOversikt(): PinnOversikt | null {
  const [data, setData] = useState<PinnOversikt | null>(null);
  useEffect(() => {
    let on = true;
    const ladda = () => supabase.rpc("d2d_pinnar_oversikt").then(({ data, error }) => { if (on && !error) setData(data as PinnOversikt); });
    ladda();
    const t = window.setInterval(ladda, 5 * 60_000);
    return () => { on = false; window.clearInterval(t); };
  }, []);
  return data;
}

/** Ett säljarkort: stapeln mäts mot säljarens eget nästa delmål (från föregående
 *  nivå, eller 0, till nästa). Högsta nivån nådd = grön full stapel. */
export function PinnKort({ s, trappa, jag, lon, onOpen }: {
  s: SaljareRad; trappa: Trappsteg[]; jag?: boolean; lon?: PinnOversikt["minLon"]; onOpen?: () => void;
}) {
  const fran = s.niva ?? 0;
  const till = s.nastaNiva ?? s.niva ?? trappa[0]?.pinnar ?? 1;
  const bredd = Math.max(till - fran, 0.0001);
  const andel = s.nastaNiva == null ? 1 : Math.min(1, Math.max(0, (s.pinnar - fran) / bredd));
  const vantarAndel = s.nastaNiva == null ? 0 : Math.min(1 - andel, s.vantar / bredd);
  const klar = s.nastaNiva == null && s.niva != null;
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag type={onOpen ? "button" : undefined} onClick={onOpen}
      className={`d2d-pinnar__kort${jag ? " d2d-pinnar__kort--jag" : ""}${klar ? " d2d-pinnar__kort--klar" : ""}${onOpen ? " d2d-pinnar__kort--klick" : ""}`}>
      <div className="d2d-pinnar__kort-head">
        <span className="d2d-pinnar__namn">{s.namn}{jag ? " (du)" : ""}</span>
        <span className="d2d-pinnar__tal">{pn(s.pinnar)}<Paren n={s.vantar} f={pn} /> <small>pinnar</small></span>
      </div>
      <div className="d2d-pinnar__stapel" role="progressbar" aria-valuemin={fran} aria-valuemax={till} aria-valuenow={s.pinnar}
        title={`${pn(s.pinnar)} av ${till} pinnar${s.vantar ? ` (+${pn(s.vantar)} Scrive-signerade, räknas när de blir Sålda)` : ""}`}>
        <div className="d2d-pinnar__fyll" style={{ width: `${andel * 100}%` }} />
        {vantarAndel > 0 && (
          <div className="d2d-pinnar__fyll d2d-pinnar__fyll--vantar" style={{ left: `${andel * 100}%`, width: `${vantarAndel * 100}%` }} />
        )}
      </div>
      <div className="d2d-pinnar__kort-fot">
        <span className="d2d-pinnar__delmal">
          {s.niva != null ? <span className="d2d-pinnar__nadd">✓ {s.niva} nådd · {kr(s.bonus)}</span> : <span>{fran}</span>}
        </span>
        <span className="d2d-pinnar__kvar">
          {s.nastaNiva != null
            ? <><strong>{pn(s.kvar)}</strong> kvar till {s.nastaNiva} ({kr(s.nastaBonus)})</>
            : <>Högsta nivån nådd</>}
        </span>
      </div>
      {lon && (
        <div className="d2d-pinnar__lon">
          <span>Din lön hittills</span>
          <strong>{kr(lon.lon)}</strong>
          <small>
            {pn(s.pinnar)} × {kr(lon.krPerPinne)}{lon.bonus > 0 ? ` + bonus ${kr(lon.bonus)}` : ""}
            {lon.justeringar ? ` ${lon.justeringar > 0 ? "+" : "−"} ${kr(Math.abs(lon.justeringar))}` : ""}
            {lon.lonInklVantar > lon.lon ? ` · potentiellt ${kr(lon.lonInklVantar)} inkl. Scrive` : ""}
          </small>
        </div>
      )}
    </Tag>
  );
}

// ─── Blitz → Översikt: pinnar den här månaden ───────────────────────────────

export function BlitzPinnar({ minId, data, onOpenProfil }: {
  minId: string | null; data: PinnOversikt | null; onOpenProfil?: (id: string) => void;
}) {
  if (!data) return null;                    // tyst — översikten fungerar utan
  const trappa = [...(data.trappa ?? [])].sort((a, b) => a.pinnar - b.pinnar);
  const jag = minId ?? data.jag;
  const rader = data.saljare.filter((s) => s.pinnar + s.vantar > 0 || s.id === jag);

  return (
    <section className="d2dd__section d2d-pinnar">
      <h2 className="d2dd__rubrik">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></svg>
        Pinnar — {periodNamn(data)}
      </h2>
      {rader.length === 0 ? (
        <div className="d2dd__tom">Inga pinnar ännu den här löneperioden</div>
      ) : (
        <div className="d2d-pinnar__kort-lista">
          {rader.map((s) => (
            <PinnKort key={s.id} s={s} trappa={trappa} jag={s.id === jag}
              lon={s.id === jag ? data.minLon : undefined}
              onOpen={onOpenProfil ? () => onOpenProfil(s.id) : undefined} />
          ))}
        </div>
      )}
      {trappa.length > 0 && (
        <p className="d2d-pinnar__trappa">
          Trappa: {trappa.map((t) => `${t.pinnar} → ${kr(t.bonus)}`).join(" · ")}
          <br />Pinnar räknas på Såld. Inom parentes = Scrive-signerade, som räknas när adressen blir Såld.
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
  const [jBelopp, setJBelopp] = useState("");
  const [jKommentar, setJKommentar] = useState("");
  const [jFel, setJFel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ladda = useCallback(() => {
    supabase.rpc("d2d_lon_prognos", { p_manad: null, p_antal: antal }).then(({ data, error }) => {
      if (error) { setFel(error.message); return; }
      setData(data as { modell: Lonemodell; manader: Manad[] });
    });
  }, [antal]);
  useEffect(() => { setData(null); ladda(); }, [ladda]);

  function oppna(key: string) {
    setOppen((o) => (o === key ? null : key)); setJBelopp(""); setJKommentar(""); setJFel(null);
  }

  async function laggTill(m: Manad, s: SaljareRad) {
    const belopp = Number(jBelopp.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(belopp) || belopp === 0) { setJFel("Ange ett belopp (minus för avdrag)."); return; }
    if (!jKommentar.trim()) { setJFel("Skriv vad justeringen gäller."); return; }
    setBusy(true); setJFel(null);
    const { error } = await supabase.rpc("d2d_lon_justering_lagg_till", {
      p_user: s.id, p_manad: `${m.manad}-01`, p_belopp: belopp, p_kommentar: jKommentar.trim(),
    });
    setBusy(false);
    if (error) { setJFel(error.message); return; }
    setJBelopp(""); setJKommentar(""); ladda();
  }

  async function taBort(j: Justering) {
    if (!window.confirm(`Ta bort justeringen ${kr(j.belopp)} – ${j.kommentar}?`)) return;
    setBusy(true);
    const { error } = await supabase.rpc("d2d_lon_justering_ta_bort", { p_id: j.id });
    setBusy(false);
    if (error) { setJFel(error.message); return; }
    ladda();
  }

  if (fel) return <div className="page"><div className="formfield__error">{fel}</div></div>;
  if (!data) return <div className="page"><p className="formfield__help">Räknar löner…</p></div>;
  if (data.manader.length === 0) {
    return <div className="page"><p className="formfield__help">Ingen löneperiod har startat ännu (räknas från {data.modell.startdatum ?? "startdatumet"}).</p></div>;
  }

  const nu = data.manader[0];
  const krPinne = data.modell.krPerPinne ?? 0;
  const sum = (m: Manad, f: (s: SaljareRad) => number | undefined) => m.saljare.reduce((a, s) => a + (f(s) ?? 0), 0);

  return (
    <div className="page d2d-loner">
      <section className="card d2d-loner__intro">
        <p>
          Lön = <strong>{kr(krPinne)} per pinne</strong> + bonus när ett trappsteg nås + justeringar. Den riktiga lönen räknas bara på adresser
          med status <strong>Såld</strong>, den löneperiod de blev sålda; lönen betalas ut {data.modell.utbetalningManaderEfter ?? 1} månad{(data.modell.utbetalningManaderEfter ?? 1) === 1 ? "" : "er"} efter.
          Scrive-signerade som ännu inte är Sålda står inom parentes och ingår bara i den potentiella lönen. Klicka på en säljare för underlag och justeringar.
          Modellen ändras under Inställningar → Priser.
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
        const lon = sum(m, (s) => s.lon);
        const lonInkl = sum(m, (s) => s.lonInklVantar);
        const arNu = m === nu;
        return (
          <section key={m.manad} className="card d2d-loner__manad">
            <header className="d2d-loner__head">
              <div>
                <h2>{periodNamn(m)}{arNu ? <span className="d2d-loner__pagar">pågår</span> : null}</h2>
                <span className="d2d-loner__sub">Utbetalas med lönen i {manadNamn(m.utbetalning)}</span>
              </div>
              <div className="d2d-loner__summa">
                <span className="d2d-loner__summa-tal">{kr(lon)}</span>
                <span className="d2d-loner__summa-text">
                  att betala ut · provision {kr(sum(m, (s) => s.provision))} · bonus {kr(sum(m, (s) => s.bonus))}
                  {sum(m, (s) => s.justeringar) !== 0 ? ` · justeringar ${kr(sum(m, (s) => s.justeringar))}` : ""}
                  {lonInkl > lon ? ` · potentiellt ${kr(lonInkl)} inkl. Scrive` : ""}
                </span>
              </div>
            </header>

            <div className="d2d-loner__tabell" role="table">
              <div className="d2d-loner__tr d2d-loner__tr--head" role="row">
                <span>Säljare</span><span>Affärer</span><span>Pinnar</span><span>Provision</span><span>Bonus</span><span>Justeringar</span><span>Lön</span>
              </div>
              {m.saljare.map((s) => {
                const key = `${m.manad}|${s.id}`;
                const open = oppen === key;
                return (
                  <div key={s.id} className={`d2d-loner__rad${open ? " d2d-loner__rad--open" : ""}`}>
                    <button type="button" className="d2d-loner__tr" role="row" aria-expanded={open} onClick={() => oppna(key)}>
                      <span className="d2d-loner__namn">{s.namn}</span>
                      <span>{s.affarer}<Paren n={s.affarerVantar} /></span>
                      <span className="d2d-loner__pinnar">{pn(s.pinnar)}<Paren n={s.vantar} f={pn} /></span>
                      <span>{kr(s.provision)}</span>
                      <span className={s.bonus > 0 ? "d2d-loner__bonus--ja" : undefined}>
                        {s.bonus > 0 ? kr(s.bonus) : "—"}
                        {s.nastaNiva != null && <small> {pn(s.kvar)} kvar till {s.nastaNiva}</small>}
                      </span>
                      <span className={s.justeringar ? (s.justeringar < 0 ? "d2d-loner__neg" : "d2d-loner__pos") : undefined}>{s.justeringar ? kr(s.justeringar) : "—"}</span>
                      <span className="d2d-loner__lon">
                        {kr(s.lon)}{(s.lonInklVantar ?? 0) > (s.lon ?? 0) ? <small className="d2d-lon__scrive" title="Potentiell lön inkl. Scrive-signerade"> ({kr(s.lonInklVantar)})</small> : null}
                      </span>
                    </button>
                    {open && (
                      <div className="d2d-loner__detalj">
                        <div className="d2d-loner__detalj-kol">
                          <h4>Underlag</h4>
                          {(s.produkter ?? []).length === 0 ? (
                            <span className="d2d-loner__sub">Inga sålda eller Scrive-signerade tjänster den här löneperioden.</span>
                          ) : (
                            <div className="d2d-loner__produkter">
                              {(s.produkter ?? []).map((p) => (
                                <div key={p.nyckel} className="d2d-loner__produkt">
                                  <span>{produktEtikett(p.nyckel, fields)}</span>
                                  <span>{p.antal}<Paren n={p.antalScrive} /> st</span>
                                  <span>{pn(p.pinnar)}<Paren n={p.pinnarScrive} f={pn} /> p</span>
                                </div>
                              ))}
                              <div className="d2d-loner__produkt d2d-loner__produkt--summa">
                                <span>{pn(s.pinnar)} pinnar × {kr(krPinne)}</span><span /><span>{kr(s.provision)}</span>
                              </div>
                              {s.bonus > 0 && (
                                <div className="d2d-loner__produkt d2d-loner__produkt--summa">
                                  <span>Bonus, nivå {s.niva}</span><span /><span>{kr(s.bonus)}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="d2d-loner__detalj-kol">
                          <h4>Justeringar</h4>
                          {(s.justeringarRader ?? []).length === 0 && <span className="d2d-loner__sub">Inga justeringar.</span>}
                          {(s.justeringarRader ?? []).map((j) => (
                            <div key={j.id} className="d2d-loner__just">
                              <span className={j.belopp < 0 ? "d2d-loner__neg" : "d2d-loner__pos"}>{j.belopp > 0 ? "+" : ""}{kr(j.belopp)}</span>
                              <span className="d2d-loner__just-text">{j.kommentar}<small> · {j.skapadAv ?? ""} {nar(j.skapadAt)}</small></span>
                              <button type="button" className="btn btn--ghost btn--sm" onClick={() => taBort(j)} disabled={busy} aria-label="Ta bort justering">×</button>
                            </div>
                          ))}
                          <div className="d2d-loner__just-form">
                            <input className="input input--sm" inputMode="decimal" placeholder="Belopp, t.ex. −500" value={jBelopp}
                              onChange={(e) => { setJBelopp(e.target.value); setJFel(null); }} disabled={busy} aria-label="Belopp" />
                            <input className="input input--sm" placeholder="Vad gäller det?" value={jKommentar} maxLength={300}
                              onChange={(e) => { setJKommentar(e.target.value); setJFel(null); }} disabled={busy} aria-label="Kommentar" />
                            <button type="button" className="btn btn--brand btn--sm" onClick={() => laggTill(m, s)} disabled={busy}>Lägg till</button>
                          </div>
                          {jFel && <div className="d2d-fb__error" role="alert">{jFel}</div>}
                        </div>
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
