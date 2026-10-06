import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import "@/styles/d2d.css";
import { BlitzPinnar, usePinnOversikt } from "./D2DLon";
import { ProfilRad, SaljarProfil, Fyrverkeri, manadsPlacering } from "./D2DProfil";

// =============================================================================
// D2D-dashboard — startsidan i Door to Door.
// Topplista per period, Hall of Fame (antal #1-dagar/-månader), senaste sälj
// och statistik per säljare. Allt räknas här i klienten från
// d2d_saljstatistik() (ett sälj = en adress med status Såld + tidpunkten då
// den sattes till Såld, eller en Scrive-signering: status "Signera med Scrive"
// med signerat avtal, s = true). Scrive-signeringar räknas med i alla siffror
// och visas dessutom inom parentes: "15 (3)" = 15 totalt varav 3 Scrive.
// =============================================================================

type Salj = { t: string; u: string; p: string | null; s?: boolean };
type Saljare = { id: string; namn: string };
type Data = { salj: Salj[]; saljare: Saljare[]; utanTid: number };

type PeriodKey = "idag" | "igar" | "vecka" | "forraVecka" | "manad" | "forraManad" | "ar" | "allt" | "egen";

const PERIODER: Array<{ key: PeriodKey; label: string }> = [
  { key: "idag", label: "Idag" },
  { key: "igar", label: "Igår" },
  { key: "vecka", label: "Denna vecka" },
  { key: "forraVecka", label: "Förra veckan" },
  { key: "manad", label: "Denna månad" },
  { key: "forraManad", label: "Förra månaden" },
  { key: "ar", label: "I år" },
  { key: "allt", label: "All time" },
  { key: "egen", label: "Välj period" },
];

const MANADER = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

// ── Datumhjälp (lokal tid) ────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const dagNyckel = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const manadNyckel = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const startAvDag = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDagar = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Måndag i veckan (svensk vecka). */
const startAvVecka = (d: Date) => plusDagar(startAvDag(d), -((d.getDay() + 6) % 7));
const arVardag = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

function isoVecka(d: Date): { ar: number; vecka: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dag);
  const arStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { ar: t.getUTCFullYear(), vecka: Math.ceil(((t.getTime() - arStart.getTime()) / 86400000 + 1) / 7) };
}
const veckoNyckel = (d: Date) => { const v = isoVecka(d); return `${v.ar}-V${pad(v.vecka)}`; };

function periodIntervall(key: PeriodKey, egenFran: string, egenTill: string): [Date, Date] {
  const nu = new Date();
  const idag = startAvDag(nu);
  switch (key) {
    case "idag": return [idag, plusDagar(idag, 1)];
    case "igar": return [plusDagar(idag, -1), idag];
    case "vecka": { const s = startAvVecka(nu); return [s, plusDagar(s, 7)]; }
    case "forraVecka": { const s = plusDagar(startAvVecka(nu), -7); return [s, plusDagar(s, 7)]; }
    case "manad": return [new Date(nu.getFullYear(), nu.getMonth(), 1), new Date(nu.getFullYear(), nu.getMonth() + 1, 1)];
    case "forraManad": return [new Date(nu.getFullYear(), nu.getMonth() - 1, 1), new Date(nu.getFullYear(), nu.getMonth(), 1)];
    case "ar": return [new Date(nu.getFullYear(), 0, 1), new Date(nu.getFullYear() + 1, 0, 1)];
    case "allt": return [new Date(2000, 0, 1), new Date(2100, 0, 1)];
    case "egen": {
      const f = egenFran ? new Date(egenFran + "T00:00:00") : new Date(2000, 0, 1);
      const t = egenTill ? plusDagar(new Date(egenTill + "T00:00:00"), 1) : new Date(2100, 0, 1);
      return [f, t];
    }
  }
}

function relTid(t: Date): string {
  const min = Math.round((Date.now() - t.getTime()) / 60000);
  if (min < 1) return "nyss";
  if (min < 60) return `${min} min sedan`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h sedan`;
  const d = Math.round(h / 24);
  return d === 1 ? "i går" : `${d} dagar sedan`;
}

/** Antal Scrive-signeringar inom parentes efter en siffra; visas bara när det finns några. */
const Scrive = ({ n }: { n: number }) => n > 0 ? <span className="d2dd__scrive">({n})</span> : null;

const forNamn = (namn: string) => namn.split(/\s+/)[0] || namn;

/** Alla som delar topplaceringen (flera #1 vid lika antal). */
function vinnare(rakning: Map<string, number>): string[] {
  let max = 0;
  for (const v of rakning.values()) max = Math.max(max, v);
  if (max === 0) return [];
  return [...rakning.entries()].filter(([, v]) => v === max).map(([k]) => k);
}

// ── Ikoner ────────────────────────────────────────────────────────────────
const Krona = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7l4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7z" /><path d="M5 21h14" />
  </svg>
);
const Medalj = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="15" r="6" /><path d="M8.5 10.5L6 3h4l2 5 2-5h4l-2.5 7.5" />
  </svg>
);
const Chevron = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s" }} aria-hidden>
    <path d="M4 6l4 4 4-4" />
  </svg>
);

// =============================================================================

export function D2DDashboard({ minId }: { minId: string | null }) {
  const [data, setData] = useState<Data | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("manad");
  const [egenFran, setEgenFran] = useState("");
  const [egenTill, setEgenTill] = useState("");
  const [visaAktivitet, setVisaAktivitet] = useState(true);
  const [visaStatistik, setVisaStatistik] = useState(false);
  const [valdaStat, setValdaStat] = useState<string[]>([]);
  // Säljarprofil (D2DProfil.tsx) och fyrverkeri när man leder månaden.
  const [profil, setProfil] = useState<string | null>(null);
  const [fira, setFira] = useState(false);
  const pinnData = usePinnOversikt();

  useEffect(() => {
    let avbruten = false;
    const hamta = async () => {
      const { data: d, error } = await supabase.rpc("d2d_saljstatistik");
      if (avbruten) return;
      if (error) { setFel("Kunde inte hämta säljstatistiken."); return; }
      setData(d as Data);
    };
    void hamta();
    // Uppdatera var 60:e sekund så topplistan lever under dagen.
    const t = window.setInterval(() => void hamta(), 60_000);
    return () => { avbruten = true; window.clearInterval(t); };
  }, []);

  const salj = useMemo(() => (data?.salj ?? []).map((s) => ({ ...s, d: new Date(s.t) })), [data]);
  const namn = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of data?.saljare ?? []) m.set(s.id, forNamn(s.namn));
    return m;
  }, [data]);
  const namnPa = (id: string) => namn.get(id) ?? "Okänd";

  // ── Team-siffror ───────────────────────────────────────────────────────
  const team = useMemo(() => {
    const nu = new Date();
    const dag = dagNyckel(nu), man = manadNyckel(nu), ar = nu.getFullYear();
    let d = 0, m = 0, a = 0, ds = 0, ms = 0, as = 0;
    for (const s of salj) {
      if (dagNyckel(s.d) === dag) { d++; if (s.s) ds++; }
      if (manadNyckel(s.d) === man) { m++; if (s.s) ms++; }
      if (s.d.getFullYear() === ar) { a++; if (s.s) as++; }
    }
    return { d, m, a, ds, ms, as };
  }, [salj]);

  // ── Topplista för vald period ──────────────────────────────────────────
  const topplista = useMemo(() => {
    const [fran, till] = periodIntervall(period, egenFran, egenTill);
    const r = new Map<string, number>(), sc = new Map<string, number>();
    for (const s of salj) if (s.d >= fran && s.d < till) {
      r.set(s.u, (r.get(s.u) ?? 0) + 1);
      if (s.s) sc.set(s.u, (sc.get(s.u) ?? 0) + 1);
    }
    const rader = [...r.entries()].sort((a, b) => b[1] - a[1] || namnPa(a[0]).localeCompare(namnPa(b[0]), "sv"));
    return { rader, scrive: sc, totalt: rader.reduce((s, [, n]) => s + n, 0), totaltScrive: [...sc.values()].reduce((s, n) => s + n, 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salj, period, egenFran, egenTill, namn]);

  // ── Hall of Fame + förra månadens vinnare ──────────────────────────────
  const hall = useMemo(() => {
    const perDag = new Map<string, Map<string, number>>();
    const perManad = new Map<string, Map<string, number>>();
    for (const s of salj) {
      for (const [karta, nyckel] of [[perDag, dagNyckel(s.d)], [perManad, manadNyckel(s.d)]] as const) {
        const m = karta.get(nyckel) ?? new Map<string, number>();
        m.set(s.u, (m.get(s.u) ?? 0) + 1);
        karta.set(nyckel, m);
      }
    }
    const dagar = new Map<string, number>(), manader = new Map<string, number>();
    for (const m of perDag.values()) for (const u of vinnare(m)) dagar.set(u, (dagar.get(u) ?? 0) + 1);
    for (const m of perManad.values()) for (const u of vinnare(m)) manader.set(u, (manader.get(u) ?? 0) + 1);
    const alla = new Set([...dagar.keys(), ...manader.keys()]);
    const rader = [...alla].map((u) => ({ u, dagar: dagar.get(u) ?? 0, manader: manader.get(u) ?? 0 }))
      .sort((a, b) => b.dagar - a.dagar || b.manader - a.manader);

    const nu = new Date();
    const forra = new Date(nu.getFullYear(), nu.getMonth() - 1, 1);
    const forraVinnare = vinnare(perManad.get(manadNyckel(forra)) ?? new Map());
    return { rader, forraVinnare, forraManad: `${MANADER[forra.getMonth()]} ${forra.getFullYear()}` };
  }, [salj]);

  // ── Statistik per säljare ──────────────────────────────────────────────
  const statistik = useMemo(() => {
    return valdaStat.map((u) => {
      const egna = salj.filter((s) => s.u === u).map((s) => s.d).sort((a, b) => a.getTime() - b.getTime());
      if (egna.length === 0) return { u, snitt: 0, streak: 0, pbDag: null, pbVecka: null, pbManad: null };
      const dag = new Map<string, number>(), vecka = new Map<string, number>(), manad = new Map<string, number>();
      for (const d of egna) {
        dag.set(dagNyckel(d), (dag.get(dagNyckel(d)) ?? 0) + 1);
        vecka.set(veckoNyckel(d), (vecka.get(veckoNyckel(d)) ?? 0) + 1);
        manad.set(manadNyckel(d), (manad.get(manadNyckel(d)) ?? 0) + 1);
      }
      const bast = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      // Snitt per arbetsdag från första säljet till idag.
      let arbetsdagar = 0, langst = 0, nuvarande = 0;
      const slut = startAvDag(new Date());
      for (let d = startAvDag(egna[0]); d <= slut; d = plusDagar(d, 1)) {
        const harSalj = dag.has(dagNyckel(d));
        if (arVardag(d)) {
          arbetsdagar++;
          // Streak: vardagar i rad med minst ett sälj (helger bryter inte).
          if (harSalj) { nuvarande++; langst = Math.max(langst, nuvarande); }
          else if (d < slut) nuvarande = 0;
        } else if (harSalj) {
          nuvarande++; langst = Math.max(langst, nuvarande);
        }
      }
      const [pdK, pdV] = bast(dag), [pvK, pvV] = bast(vecka), [pmK, pmV] = bast(manad);
      const [pmAr, pmMan] = pmK.split("-");
      return {
        u,
        snitt: egna.length / Math.max(arbetsdagar, 1),
        streak: langst,
        pbDag: { v: pdV, etikett: `${pdK.slice(8)}/${pdK.slice(5, 7)}` },
        pbVecka: { v: pvV, etikett: pvK },
        pbManad: { v: pmV, etikett: `${MANADER[Number(pmMan) - 1]} ${pmAr}` },
      };
    });
  }, [salj, valdaStat]);

  // Fyrverkeri när den inloggade leder månadens topplista — en gång per dag
  // och webbläsarsession när man går in i översikten (sessionStorage kan
  // saknas/kasta, då visas det bara som vanligt).
  const ledarManad = useMemo(() => manadsPlacering(salj).ledare, [salj]);
  useEffect(() => {
    if (!minId || !ledarManad.includes(minId)) return;
    const nyckel = `blitz-fyrverkeri:${minId}:${dagNyckel(new Date())}`;
    try { if (sessionStorage.getItem(nyckel)) return; sessionStorage.setItem(nyckel, "1"); } catch { /* visa ändå */ }
    setFira(true);
  }, [minId, ledarManad]);

  if (fel) return <div className="d2d-empty">{fel}</div>;
  if (!data) return <div className="d2d-loading">Laddar översikten…</div>;
  const fullNamn = (id: string) => data.saljare.find((s) => s.id === id)?.namn ?? namnPa(id);

  const periodEtikett = PERIODER.find((p) => p.key === period)?.label ?? "";
  const aktivitet = salj.slice(0, 12);
  const statSaljare = [...new Set([...data.saljare.map((s) => s.id), ...salj.map((s) => s.u)])]
    .map((id) => ({ id, n: salj.filter((s) => s.u === id).length }))
    .sort((a, b) => b.n - a.n || namnPa(a.id).localeCompare(namnPa(b.id), "sv"));

  return (
    <div className="d2dd">
      {fira && (
        <Fyrverkeri
          text={ledarManad.length > 1 ? `Du delar förstaplatsen i ${MANADER[new Date().getMonth()]}!` : `Du leder ${MANADER[new Date().getMonth()]}!`}
          onDone={() => setFira(false)} />
      )}
      {profil && (
        <SaljarProfil id={profil} namn={fullNamn(profil)} minId={minId} salj={salj} namnPa={namnPa} pinnar={pinnData}
          onClose={() => setProfil(null)} onFira={() => setFira(true)} />
      )}

      {/* Profiler — alla säljare, du först. Klick öppnar profilen. */}
      <ProfilRad saljare={data.saljare} minId={minId} salj={salj} onOpen={setProfil} />

      {/* Team — totalt */}
      <section className="d2dd__section">
        <h2 className="d2dd__rubrik">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 010 7M18 14.8c1.8.7 3 2.4 3.5 5.2" /></svg>
          Team — totalt antal sälj
        </h2>
        <div className="d2dd__kpis">
          <div className="d2dd__kpi"><span className="d2dd__kpi-varde">{team.d}<Scrive n={team.ds} /></span><span className="d2dd__kpi-etikett">Idag</span></div>
          <div className="d2dd__kpi"><span className="d2dd__kpi-varde">{team.m}<Scrive n={team.ms} /></span><span className="d2dd__kpi-etikett">Månad</span></div>
          <div className="d2dd__kpi"><span className="d2dd__kpi-varde">{team.a}<Scrive n={team.as} /></span><span className="d2dd__kpi-etikett">År</span></div>
        </div>
        {(team.ds + team.ms + team.as) > 0 && <p className="d2dd__scrive-hint">Siffran inom parentes = varav signerade med Scrive.</p>}
      </section>

      {/* Pinnar och bonustrappa den här månaden (lönemodellen, D2DLon.tsx) */}
      <BlitzPinnar minId={minId} data={pinnData} onOpenProfil={setProfil} />

      {/* Förra månadens toppsäljare */}
      {hall.forraVinnare.length > 0 && (
        <section className="d2dd__vinnare">
          <span className="d2dd__vinnare-ikon"><Krona size={22} /></span>
          <div>
            <div className="d2dd__vinnare-titel">Förra månadens toppsäljare · {hall.forraManad}</div>
            <div className="d2dd__vinnare-namn">
              {hall.forraVinnare.map(namnPa).join(" & ")}
              {minId && hall.forraVinnare.includes(minId) ? " — det är du! 🎉" : ""}
            </div>
          </div>
        </section>
      )}

      {/* Perioder */}
      <section className="d2dd__section">
        <div className="d2dd__perioder" role="group" aria-label="Period">
          {PERIODER.map((p) => (
            <button key={p.key} type="button" className="d2dd__period" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        {period === "egen" && (
          <div className="d2dd__egen">
            <label>Från <input type="date" className="input" value={egenFran} onChange={(e) => setEgenFran(e.target.value)} /></label>
            <label>Till <input type="date" className="input" value={egenTill} onChange={(e) => setEgenTill(e.target.value)} /></label>
          </div>
        )}
      </section>

      {/* Topplista */}
      <section className="d2dd__section">
        <h2 className="d2dd__rubrik">Topplista — {periodEtikett.toLowerCase()}</h2>
        {topplista.rader.length === 0 ? (
          <div className="d2dd__tom">Inga sälj ännu</div>
        ) : (
          <div className="d2dd__lista">
            <div className="d2dd__rad d2dd__rad--totalt">
              <span className="d2dd__plats">Σ</span>
              <span className="d2dd__namn">Totalt</span>
              <span className="d2dd__antal">{topplista.totalt}<Scrive n={topplista.totaltScrive} /></span>
            </div>
            {topplista.rader.map(([u, n], i) => {
              const plats = topplista.rader.findIndex(([, m]) => m === n); // lika antal = delad placering
              const klass = plats === 0 ? "guld" : plats === 1 ? "silver" : plats === 2 ? "brons" : "";
              return (
                <button type="button" key={u} onClick={() => setProfil(u)} title={`Öppna ${namnPa(u)}s profil`}
                  className={`d2dd__rad d2dd__rad--klick${klass ? ` d2dd__rad--${klass}` : ""}${u === minId ? " d2dd__rad--jag" : ""}`}>
                  <span className="d2dd__plats">{plats === 0 ? <Krona /> : plats <= 2 ? <Medalj /> : i + 1}</span>
                  <span className="d2dd__namn">{namnPa(u)}{u === minId && <span className="d2dd__du">du</span>}</span>
                  <span className="d2dd__antal">{n}<Scrive n={topplista.scrive.get(u) ?? 0} /></span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Hall of Fame */}
      {hall.rader.length > 0 && (
        <section className="d2dd__section">
          <h2 className="d2dd__rubrik"><span className="d2dd__guld"><Krona size={16} /></span> Hall of Fame — antal #1-platser</h2>
          <div className="d2dd__tabell">
            <div className="d2dd__tabell-rad d2dd__tabell-rad--huvud">
              <span>Säljare</span><span>Dagar</span><span>Månader</span>
            </div>
            {hall.rader.map((r) => (
              <div key={r.u} className={`d2dd__tabell-rad${r.u === minId ? " d2dd__tabell-rad--jag" : ""}`}>
                <span className="d2dd__tabell-namn">{namnPa(r.u)}</span>
                <span className="d2dd__gron">{r.dagar}</span>
                <span className="d2dd__guld">{r.manader}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Senaste aktivitet */}
      <section className="d2dd__panel">
        <button type="button" className="d2dd__panel-huvud" aria-expanded={visaAktivitet} onClick={() => setVisaAktivitet((v) => !v)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
          Senaste aktivitet
          <Chevron open={visaAktivitet} />
        </button>
        {visaAktivitet && (
          <ul className="d2dd__aktivitet">
            {aktivitet.length === 0 && <li className="d2dd__tom">Inga sälj registrerade ännu.</li>}
            {aktivitet.map((s, i) => (
              <li key={i}>
                <span className={`d2dd__plus${s.s ? " d2dd__plus--scrive" : ""}`}>+1</span>
                <span className="d2dd__akt-namn">{namnPa(s.u)}{s.s && <span className="d2dd__akt-scrive">Scrive</span>}{s.p && <span className="d2dd__akt-projekt">{s.p}</span>}</span>
                <span className="d2dd__akt-tid" title={s.d.toLocaleString("sv-SE")}>{relTid(s.d)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Statistik */}
      <section className="d2dd__panel">
        <button type="button" className="d2dd__panel-huvud" aria-expanded={visaStatistik} onClick={() => setVisaStatistik((v) => !v)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
          Statistik
          <Chevron open={visaStatistik} />
        </button>
        {visaStatistik && (
          <div className="d2dd__stat">
            <p className="d2dd__hint">Välj person(er) — klicka för att jämföra flera</p>
            <div className="d2dd__chips">
              {statSaljare.map(({ id }) => (
                <button key={id} type="button" className="d2dd__period" aria-pressed={valdaStat.includes(id)}
                  onClick={() => setValdaStat((v) => v.includes(id) ? v.filter((x) => x !== id) : [...v, id])}>
                  {namnPa(id)}
                </button>
              ))}
            </div>
            {statistik.length > 0 && (
              <div className="d2dd__stat-tabell" style={{ gridTemplateColumns: `minmax(110px, 1.2fr) repeat(${statistik.length}, minmax(70px, 1fr))` }}>
                <span />
                {statistik.map((s) => <span key={s.u} className="d2dd__stat-person">{namnPa(s.u)}</span>)}
                {([
                  ["Snitt / dag", (s: typeof statistik[number]) => <strong>{s.snitt.toFixed(2).replace(".", ",")}</strong>],
                  ["Längsta streak", (s: typeof statistik[number]) => <strong>{s.streak} d</strong>],
                  ["PB dag", (s: typeof statistik[number]) => s.pbDag ? <><strong>{s.pbDag.v}</strong><small>{s.pbDag.etikett}</small></> : "—"],
                  ["PB vecka", (s: typeof statistik[number]) => s.pbVecka ? <><strong>{s.pbVecka.v}</strong><small>{s.pbVecka.etikett}</small></> : "—"],
                  ["PB månad", (s: typeof statistik[number]) => s.pbManad ? <><strong>{s.pbManad.v}</strong><small>{s.pbManad.etikett}</small></> : "—"],
                ] as const).map(([etikett, cell]) => (
                  <div key={etikett} className="d2dd__stat-rad">
                    <span className="d2dd__stat-etikett">{etikett}</span>
                    {statistik.map((s) => <span key={s.u} className="d2dd__stat-varde">{cell(s)}</span>)}
                  </div>
                ))}
              </div>
            )}
            <p className="d2dd__fot">
              Scrive-signeringar räknas som sälj. Snitt per arbetsdag från första säljet. Streak = vardagar i rad med minst ett sälj; helger bryter inte, och sälj på en helgdag räknas som +1.
            </p>
          </div>
        )}
      </section>

      {data.utanTid > 0 && (
        <p className="d2dd__fot d2dd__fot--sist">
          {data.utanTid} adresser importerades som redan sålda utan säljdatum och ingår inte i topplistorna.
        </p>
      )}
    </div>
  );
}
