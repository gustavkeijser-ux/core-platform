import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { ObjectDef, RecordRow } from "@/lib/data";
import { useTenantUsers } from "@/lib/users";
import {
  LagenhetTabell, FastighetProgress, LagenhetForm,
  STATUS_CONFIG, ALLA_STATUS_ORDNING, jamforLagenheter, type KnockStatus,
} from "./D2DSellerApp";
import "@/styles/d2d.css";

/* =============================================================================
   D2D-sälj → Projekt → Alla lägenheter.
   En tabell över lägenheterna (alla säljare ser alla)
   med filter på projekt, ort, fastighet, (admin) säljare, status och fritext.
   Klick på en rad fäller ut kortet: namn, telefon och kommentar skrivs direkt,
   Inte hemma/knackningar och status sätts direkt. Väljs Såld eller Signera
   med Scrive öppnas lägenheten i ett fönster där tjänster och kunduppgifter
   fylls i. Allt sparas på samma post som CRM:ets Door to door → Lägenheter
   (tabellvyn) läser, så de visar alltid samma sak.
   ========================================================================== */

const ALLA = "alla";
const UTAN_PROJEKT = "utan";
const UTAN_SALJARE = "utan";
const SIDA = 150;
const SEL = "id,object_type,data,status,owner_user_id,title,created_at,updated_at";

type Underlag = {
  lagenheter: RecordRow[];
  fastFor: Map<string, string>;          // lägenhet → fastighet
  fastigheter: Map<string, RecordRow>;
  projektFor: Map<string, string>;       // fastighet → projekt
  projekt: Map<string, RecordRow>;
};

/** Allt i ett anrop (d2d_alla_lagenheter): lägenheterna med de fält listan
 *  behöver och fastighets-id, fastigheterna och projekten. Tidigare hämtades
 *  lägenheter, relationer, fastigheter och projekt sida för sida genom RLS —
 *  många sekunder med ~10 000 lägenheter. Kortet (Såld/Scrive) hämtar hela
 *  posten när det öppnas. Återkopplingar som tillhör en annan säljare
 *  filtreras bort i databasen (admin ser alla). */
async function hamtaUnderlag(): Promise<Underlag> {
  const { data, error } = await supabase.rpc("d2d_alla_lagenheter");
  if (error) throw new Error(error.message);
  const svar = (data ?? {}) as {
    lagenheter?: Array<RecordRow & { fastighet_id: string | null }>;
    fastigheter?: Array<RecordRow & { projekt_id: string | null }>;
    projekt?: RecordRow[];
  };
  const fastigheter = new Map((svar.fastigheter ?? []).map((f) => [f.id, f as RecordRow]));
  const projekt = new Map((svar.projekt ?? []).map((p) => [p.id, p]));
  const fastFor = new Map<string, string>();
  const lagenheter: RecordRow[] = [];
  for (const l of svar.lagenheter ?? []) {
    lagenheter.push({ ...l, object_type: "d2d_lagenhet" } as RecordRow);
    if (l.fastighet_id && fastigheter.has(l.fastighet_id)) fastFor.set(l.id, l.fastighet_id);
  }
  const projektFor = new Map<string, string>();
  for (const f of svar.fastigheter ?? []) if (f.projekt_id && projekt.has(f.projekt_id)) projektFor.set(f.id, f.projekt_id);
  return { lagenheter: lagenheter.sort(jamforLagenheter), fastFor, fastigheter, projektFor, projekt };
}

export function D2DAllaLagenheter({ minId, isAdmin, objectDef, onBack, onOpenLagenhet, onFieldsChanged }: {
  minId: string | null;
  isAdmin: boolean;
  objectDef: ObjectDef | undefined;
  onBack: () => void;
  onOpenLagenhet: (id: string) => void;
  onFieldsChanged?: () => void;
}) {
  const [u, setU] = useState<Underlag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const users = useTenantUsers();
  const namnFor = useMemo(() => new Map(users.map((x) => [x.id, x.name])), [users]);

  const [sok, setSok] = useState("");
  const [projekt, setProjekt] = useState(ALLA);
  const [ort, setOrt] = useState(ALLA);
  const [fastighet, setFastighet] = useState(ALLA);
  const [saljare, setSaljare] = useState(ALLA);
  const [status, setStatus] = useState<KnockStatus | typeof ALLA>(ALLA);
  /** Såld datum (data.sald_datum), ÅÅÅÅ-MM-DD. Tomt = ingen gräns. */
  const [fran, setFran] = useState("");
  const [till, setTill] = useState("");
  const [visaAntal, setVisaAntal] = useState(SIDA);
  /** Lägenhet som säljs just nu (fönstret med tjänster och kunduppgifter). */
  const [salj, setSalj] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!minId) return;
    try {
      setU(await hamtaUnderlag()); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte hämta lägenheterna.");
    }
  }, [minId, isAdmin]);
  useEffect(() => { void load(); }, [load]);

  const hamtaEn = useCallback(async (id: string) => {
    const { data } = await supabase.from("records").select(SEL).eq("id", id).maybeSingle();
    if (!data) return;
    setU((prev) => prev ? { ...prev, lagenheter: prev.lagenheter.map((l) => l.id === id ? (data as RecordRow) : l) } : prev);
  }, []);

  const setLagenheter: Dispatch<SetStateAction<RecordRow[]>> = useCallback((upd) => {
    setU((prev) => {
      if (!prev) return prev;
      const next = typeof upd === "function" ? upd(prev.lagenheter) : upd;
      const byId = new Map(next.map((l) => [l.id, l]));
      return { ...prev, lagenheter: prev.lagenheter.map((l) => byId.get(l.id) ?? l) };
    });
  }, []);

  // ── Hjälpare per lägenhet ────────────────────────────────────────────
  const fastAv = (l: RecordRow) => u?.fastigheter.get(u.fastFor.get(l.id) ?? "");
  const projektAv = (l: RecordRow) => { const fid = u?.fastFor.get(l.id); return (fid && u?.projektFor.get(fid)) || UTAN_PROJEKT; };
  const ortAv = (l: RecordRow) => {
    const d = l.data as Record<string, unknown>;
    const fd = (fastAv(l)?.data ?? {}) as Record<string, unknown>;
    return String(d.postort || fd.ort || fd.postort || "").trim();
  };
  const saljareAv = (l: RecordRow) => l.owner_user_id || String((l.data as Record<string, unknown>).saljare || "") || UTAN_SALJARE;
  const statusAv = (l: RecordRow): KnockStatus => {
    const st = (l.status ?? "ej_knackad") as KnockStatus;
    return STATUS_CONFIG[st] ? st : "ej_knackad";
  };
  const matcharSok = (l: RecordRow, q: string) => {
    const d = l.data as Record<string, unknown>;
    return [d.gatunamn, d.gatunummer, d.ingang, l.title, d.kund_namn, d.kund_telefon, d.kommentar, fastAv(l)?.title]
      .filter(Boolean).map(String).join(" ").toLowerCase().includes(q);
  };

  // ── Filter (bara val som finns kvar efter de andra filtren) ──────────
  const alla = u?.lagenheter ?? [];
  const q = sok.trim().toLowerCase();
  const sokta = q ? alla.filter((l) => matcharSok(l, q)) : alla;

  const projektVal = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of sokta) { const p = projektAv(l); m.set(p, (m.get(p) ?? 0) + 1); }
    const rader = Array.from(m.entries()).filter(([id]) => id !== UTAN_PROJEKT)
      .map(([id, n]) => ({ id, namn: u?.projekt.get(id)?.title ?? "Projekt", n }))
      .sort((a, b) => a.namn.localeCompare(b.namn, "sv", { numeric: true }));
    if (m.has(UTAN_PROJEKT)) rader.push({ id: UTAN_PROJEKT, namn: "Utan projekt", n: m.get(UTAN_PROJEKT)! });
    return rader;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u, sokta]);
  const iProjekt = sokta.filter((l) => projekt === ALLA || projektAv(l) === projekt);
  const orter = useMemo(() => Array.from(new Set(iProjekt.map(ortAv).filter(Boolean))).sort((a, b) => a.localeCompare(b, "sv")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [u, iProjekt.length, projekt]);
  const iOrt = iProjekt.filter((l) => ort === ALLA || ortAv(l) === ort);
  const fastVal = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of iOrt) { const f = fastAv(l); if (f) m.set(f.id, f.title ?? "Fastighet"); }
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1], "sv", { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u, iOrt.length, projekt, ort]);
  const iFast = iOrt.filter((l) => fastighet === ALLA || u?.fastFor.get(l.id) === fastighet);
  const saljareVal = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of iFast) { const s = saljareAv(l); m.set(s, (m.get(s) ?? 0) + 1); }
    const rader = Array.from(m.entries()).filter(([id]) => id !== UTAN_SALJARE)
      .map(([id, n]) => ({ id, namn: namnFor.get(id) ?? "…", n }))
      .sort((a, b) => a.namn.localeCompare(b.namn, "sv"));
    if (m.has(UTAN_SALJARE)) rader.push({ id: UTAN_SALJARE, namn: "Utan säljare", n: m.get(UTAN_SALJARE)! });
    return rader;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [u, iFast.length, projekt, ort, fastighet, namnFor]);
  const iSaljare = iFast.filter((l) => saljare === ALLA || saljareAv(l) === saljare);
  // Såld datum: med ett datumfilter visas bara lägenheter med säljdatum inom perioden.
  const harDatum = !!fran || !!till;
  const saldAv = (l: RecordRow) => String((l.data as Record<string, unknown>).sald_datum ?? "").slice(0, 10);
  const filtrerade = harDatum
    ? iSaljare.filter((l) => { const d = saldAv(l); return !!d && (!fran || d >= fran) && (!till || d <= till); })
    : iSaljare;
  const valjFran = (v: string) => { setFran(v); if (v && (!till || till < v)) setTill(v); };
  const snabb = (namn: string) => {
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const idag = new Date(); idag.setHours(0, 0, 0, 0);
    const dag = (n: number) => { const d = new Date(idag); d.setDate(d.getDate() + n); return d; };
    const veckodag = (idag.getDay() + 6) % 7;   // måndag = 0
    const p: Record<string, [Date, Date]> = {
      idag: [idag, idag],
      igar: [dag(-1), dag(-1)],
      vecka: [dag(-veckodag), idag],
      forraVecka: [dag(-veckodag - 7), dag(-veckodag - 1)],
      manad: [new Date(idag.getFullYear(), idag.getMonth(), 1), idag],
      forraManad: [new Date(idag.getFullYear(), idag.getMonth() - 1, 1), new Date(idag.getFullYear(), idag.getMonth(), 0)],
    };
    const [a, b] = p[namn];
    setFran(iso(a)); setTill(iso(b));
  };

  const antal: Partial<Record<KnockStatus, number>> = {};
  for (const l of filtrerade) { const k = statusAv(l); antal[k] = (antal[k] ?? 0) + 1; }
  const visade = filtrerade.filter((l) => status === ALLA || statusAv(l) === status);
  const synliga = visade.slice(0, visaAntal);
  useEffect(() => { setVisaAntal(SIDA); }, [sok, projekt, ort, fastighet, saljare, status, fran, till]);

  const rensa = () => { setSok(""); setProjekt(ALLA); setOrt(ALLA); setFastighet(ALLA); setSaljare(ALLA); setStatus(ALLA); setFran(""); setTill(""); };
  const harFilter = !!q || projekt !== ALLA || ort !== ALLA || fastighet !== ALLA || saljare !== ALLA || status !== ALLA || harDatum;

  const stangSalj = () => {
    const id = salj;
    setSalj(null);
    if (id) void hamtaEn(id);
  };

  return (
    <div className="d2d-detail d2d-allalgh">
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack} aria-label="Tillbaka till projekt">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>Alla lägenheter</h2>
          <span className="d2d-topbar__sub">{u ? `${alla.length} ${alla.length === 1 ? "lägenhet" : "lägenheter"}` : "Laddar…"}</span>
        </div>
      </div>

      {error && (
        <div className="d2d-empty">
          Kunde inte hämta lägenheterna. <button type="button" className="linklike" onClick={() => void load()}>Försök igen</button>
        </div>
      )}
      {!error && !u && <div className="d2d-loading">Laddar lägenheter…</div>}

      {u && (
        <>
          <div className="d2d-alla__filter d2d-allalgh__filter">
            <input className="input d2d-allalgh__sok" type="search" value={sok} onChange={(e) => setSok(e.target.value)}
              placeholder="Sök adress, namn, telefon, kommentar…" aria-label="Sök" />
            <div className="d2d-alla__val d2d-allalgh__val--admin">
              <label>
                <span>Projekt</span>
                <select className="input" value={projekt} onChange={(e) => { setProjekt(e.target.value); setOrt(ALLA); setFastighet(ALLA); }}>
                  <option value={ALLA}>Alla projekt</option>
                  {projektVal.map((p) => <option key={p.id} value={p.id}>{p.namn} ({p.n})</option>)}
                </select>
              </label>
              <label>
                <span>Ort</span>
                <select className="input" value={ort} onChange={(e) => { setOrt(e.target.value); setFastighet(ALLA); }}>
                  <option value={ALLA}>Alla orter</option>
                  {orter.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
              <label>
                <span>Fastighet</span>
                <select className="input" value={fastighet} onChange={(e) => setFastighet(e.target.value)}>
                  <option value={ALLA}>Alla fastigheter</option>
                  {fastVal.map(([id, namn]) => <option key={id} value={id}>{namn}</option>)}
                </select>
              </label>
              <label>
                <span>Säljare</span>
                <select className="input" value={saljare} onChange={(e) => setSaljare(e.target.value)}>
                  <option value={ALLA}>Alla säljare</option>
                  {saljareVal.map((s) => <option key={s.id} value={s.id}>{s.namn} ({s.n})</option>)}
                </select>
              </label>
            </div>
            {/* Såld datum: en dag (samma Från och Till), en period eller snabbval. */}
            <div className="d2d-allalgh__datum" role="group" aria-label="Filtrera på såld datum">
              <div className="d2d-alla__val d2d-allalgh__datum-val">
                <label>
                  <span>Såld från</span>
                  <input className="input" type="date" value={fran} max={till || undefined} onChange={(e) => valjFran(e.target.value)} />
                </label>
                <label>
                  <span>Såld till</span>
                  <input className="input" type="date" value={till} min={fran || undefined} onChange={(e) => setTill(e.target.value)} />
                </label>
              </div>
              <div className="d2d-allalgh__datum-snabb">
                {([["idag", "Idag"], ["igar", "Igår"], ["vecka", "Denna vecka"], ["forraVecka", "Förra veckan"], ["manad", "Denna månad"], ["forraManad", "Förra månaden"]] as const).map(([k, t]) => (
                  <button key={k} type="button" className="d2d-reason-chip" onClick={() => snabb(k)}>{t}</button>
                ))}
                {harDatum && <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setFran(""); setTill(""); }}>Alla datum</button>}
              </div>
            </div>
            <div className="d2d-status-picker d2d-alla__status" role="group" aria-label="Filtrera på status">
              <button type="button" className={`d2d-status-btn${status === ALLA ? " d2d-status-btn--active" : ""}`} onClick={() => setStatus(ALLA)}>
                Alla {filtrerade.length}
              </button>
              {ALLA_STATUS_ORDNING.filter((k) => (antal[k] ?? 0) > 0).map((k) => (
                <button key={k} type="button"
                  className={`d2d-status-btn ${STATUS_CONFIG[k].cssClass}${status === k ? " d2d-status-btn--active" : ""}`}
                  onClick={() => setStatus(status === k ? ALLA : k)}>
                  {STATUS_CONFIG[k].label} {antal[k]}
                </button>
              ))}
              {harFilter && <button type="button" className="btn btn--ghost btn--sm d2d-allalgh__rensa" onClick={rensa}>Rensa filter</button>}
            </div>
          </div>

          <div className="d2d-lag-list">
            <div className="d2d-lag-list__header">
              <h3>Lägenheter</h3>
              <span>{visade.length === alla.length ? `${visade.length} st` : `${visade.length} av ${alla.length} st`}</span>
            </div>
            <FastighetProgress lagenheter={filtrerade} />
            {alla.length === 0 && <div className="d2d-empty">Inga lägenheter än.</div>}
            {alla.length > 0 && visade.length === 0 && <div className="d2d-empty">Inga lägenheter matchar filtret.</div>}
            <p className="d2d-allalgh__hint">Tryck på en lägenhet för att fylla i namn, telefon, kommentar och status.</p>

            <LagenhetTabell
              lagenheter={synliga}
              setLagenheter={setLagenheter}
              isAdmin={isAdmin}
              fastData={{}}
              listKey="alla"
              ready={!!u}
              onOpenLagenhet={onOpenLagenhet}
              medKommentar
              expanderbar
              onSalj={setSalj}
              visaSaljare
              kanAndra={(l) => isAdmin || (l as RecordRow & { kan_andra?: boolean }).kan_andra !== false}
              fastighetNamn={(id) => {
                const l = alla.find((x) => x.id === id);
                if (!l) return "";
                const p = projektAv(l);
                return [fastAv(l)?.title, ortAv(l), p !== UTAN_PROJEKT ? u.projekt.get(p)?.title : null].filter(Boolean).join(" · ");
              }}
            />
            {visade.length > synliga.length && (
              <div className="d2d-allalgh__mer">
                <button type="button" className="btn btn--ghost" onClick={() => setVisaAntal((n) => n + SIDA)}>
                  Visa fler ({visade.length - synliga.length} till)
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Såld / Signera med Scrive: lägenheten i ett fönster — tjänster och kunduppgifter. */}
      {salj && (
        <div className="d2d-modal" role="dialog" aria-modal="true" aria-label="Försäljning"
          onClick={(e) => { if (e.target === e.currentTarget) stangSalj(); }}>
          <div className="d2d-modal__ruta">
            <LagenhetForm
              key={salj}
              lagenhetId={salj}
              fastighetId={u?.fastFor.get(salj) ?? ""}
              objectDef={objectDef}
              isAdmin={isAdmin}
              onFieldsChanged={onFieldsChanged}
              onBack={stangSalj}
            />
          </div>
        </div>
      )}
    </div>
  );
}
