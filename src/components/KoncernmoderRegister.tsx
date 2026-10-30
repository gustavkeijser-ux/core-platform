import { useEffect, useMemo, useState } from "react";
import "@/styles/salj.css";
import type { ObjectDef } from "@/lib/data";
import { kmRegister, kmDelaUt, listFastighetssaljare, kundtypLabel, type KmFilter, type KmRad, type KmRegister, type Saljare } from "@/lib/salj";
import { getUserName, useTenantUsers } from "@/lib/users";
import { TopbarActions, SearchField, PlusIcon, FilterPills, Pager, EmptyState, SkeletonRows } from "./PageChrome";
import { RecordDrawer } from "./RecordDrawer";
import { navigate } from "@/lib/route";
import { supabase } from "@/lib/data";

/* =============================================================================
   Koncernmödrar – registret (mockup, skärm 1). Här läses kunder in,
   kompletteras och delas ut till säljare. Utdelningen sätter säljare,
   mötesbokare och affärsdelning på koncernmodern och skapar/flyttar affären
   (km_dela_ut → km_till_affar). Kunder med kontaktbegränsning eller
   markerade som icke säljbara går inte att dela ut.
   ========================================================================== */

const FILTER: Array<{ key: KmFilter; label: string }> = [
  { key: "alla", label: "Alla" },
  { key: "ej_utdelade", label: "Ej utdelade" },
  { key: "utdelade", label: "Utdelade" },
  { key: "saknar_fastigheter", label: "Saknar fastigheter" },
  { key: "saknar_orgnr", label: "Saknar org.nr" },
  { key: "icke_saljbara", label: "Icke säljbara" },
];
const DELNING = [
  { key: 100, label: "100 / 0" }, { key: 80, label: "80 / 20" }, { key: 70, label: "70 / 30" }, { key: 50, label: "50 / 50" },
];
const SIDA = 50;

function Kvalitet({ rad }: { rad: KmRad }) {
  if (rad.icke_saljbar) return <span className="salj-pill salj-pill--grey">Icke säljbar</span>;
  if (rad.begransning) return <span className="salj-pill salj-pill--warn" title={rad.begransning}>Kontaktbegränsning</span>;
  if (rad.kvalitet === "komplett") return <span className="salj-pill salj-pill--ok">Komplett</span>;
  if (rad.kvalitet === "saknar_fastigheter") return <span className="salj-pill salj-pill--warn">Saknar fastigheter</span>;
  return <span className="salj-pill salj-pill--warn">Saknar org.nr</span>;
}

export function KoncernmoderRegister({ objectDef, onOpenRecord, reloadKey }: {
  objectDef: ObjectDef;
  onOpenRecord: (id: string) => void;
  reloadKey?: number;
}) {
  const [filter, setFilter] = useState<KmFilter>("alla");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [res, setRes] = useState<KmRegister | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [valda, setValda] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [tick, setTick] = useState(0);

  // Utdelning
  const [saljare, setSaljare] = useState<Saljare[]>([]);
  const [valdSaljare, setValdSaljare] = useState("");
  const [valdMotesbokare, setValdMotesbokare] = useState("");
  const [delning, setDelning] = useState(100);
  const [delar, setDelar] = useState(false);
  const [resultat, setResultat] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  useTenantUsers(); // fyller namncachen för "Utdelad till"

  useEffect(() => {
    listFastighetssaljare().then(setSaljare).catch(() => setSaljare([]));
    supabase.auth.getSession().then(({ data }) => setMyId(data.session?.user.id ?? null));
  }, []);

  useEffect(() => {
    let on = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      kmRegister(filter, search, SIDA, page * SIDA)
        .then((r) => { if (on) { setRes(r); setLoading(false); } })
        .catch((e) => { if (on) { setError((e as Error).message); setLoading(false); } });
    }, search ? 250 : 0);
    return () => { on = false; clearTimeout(t); };
  }, [filter, search, page, tick, reloadKey]);

  const items = res?.items ?? [];
  const counts = res?.counts;
  const alla = useMemo(() => items.filter((r) => !r.icke_saljbar && !r.begransning), [items]);
  const allaValda = alla.length > 0 && alla.every((r) => valda.has(r.id));
  const vaxla = (id: string) => setValda((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const vaxlaAlla = () => setValda(allaValda ? new Set() : new Set(alla.map((r) => r.id)));

  async function delaUt() {
    if (!valdSaljare || valda.size === 0) return;
    setDelar(true); setResultat(null); setError(null);
    try {
      const r = await kmDelaUt([...valda], valdSaljare, valdMotesbokare || null, delning);
      const hopp = r.hoppade.length ? ` ${r.hoppade.length} hoppades över: ${r.hoppade.map((h) => `${h.namn} (${h.orsak})`).join(", ")}.` : "";
      setResultat(`${r.utdelade} ${r.utdelade === 1 ? "koncernmoder utdelad" : "koncernmödrar utdelade"} till ${getUserName(valdSaljare)} – affärerna ligger hos säljaren.${hopp}`);
      setValda(new Set());
      setTick((t) => t + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDelar(false);
    }
  }

  const oppnaKort = (id: string) => onOpenRecord(id);

  return (
    <div className="page salj-register">
      <TopbarActions>
        <SearchField value={search} onChange={(v) => { setSearch(v); setPage(0); }} placeholder="Sök koncernmoder eller org.nr" />
        <button className="btn btn--ghost" onClick={() => navigate(["installningar", "import"])} title="Importera kunder">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 1.5v7" /><path d="M5 6l3 3 3-3" /><path d="M2.5 11v2a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-2" /></svg>
          <span className="btn__label">Importera</span>
        </button>
        {objectDef.can.create && (
          <button className="btn btn--brand" onClick={() => setShowCreate(true)}><PlusIcon /><span className="btn__label">Ny koncernmoder</span></button>
        )}
      </TopbarActions>

      <div className="card salj-register__card">
        <FilterPills
          items={FILTER.map((f) => ({ key: f.key, label: f.label, count: counts?.[f.key] ?? null }))}
          active={filter}
          onSelect={(k) => { setFilter(k as KmFilter); setPage(0); setValda(new Set()); }}
        />

        {valda.size > 0 && (
          <div className="bulk-bar salj-delaut">
            <span className="bulk-bar__count">{valda.size} markerade · dela ut till</span>
            <label className="salj-delaut__falt">Säljare
              <select className="input" value={valdSaljare} onChange={(e) => setValdSaljare(e.target.value)}>
                <option value="">Välj säljare</option>
                {saljare.map((s) => <option key={s.id} value={s.id}>{s.id === myId ? "Du" : s.name}</option>)}
              </select>
            </label>
            <label className="salj-delaut__falt">Mötesbokare
              <select className="input" value={valdMotesbokare} onChange={(e) => setValdMotesbokare(e.target.value)}>
                <option value="">Ingen</option>
                {saljare.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="salj-delaut__falt">Affärsdelning
              <select className="input" value={delning} onChange={(e) => setDelning(Number(e.target.value))}>
                {DELNING.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </label>
            <button className="btn btn--sm salj-delaut__knapp" disabled={!valdSaljare || delar} onClick={() => void delaUt()}>
              {delar ? "Delar ut…" : "Dela ut och skapa affär"}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setValda(new Set())}>Avmarkera</button>
          </div>
        )}
        {resultat && <div className="salj-notis salj-notis--ok">{resultat}</div>}
        {error && <div className="formfield__error" style={{ margin: "0 var(--sp-3) var(--sp-3)" }}>{error}</div>}

        {loading && !res ? <SkeletonRows rows={8} /> : items.length === 0 ? (
          <EmptyState kind={search || filter !== "alla" ? "filtered" : "empty"} title="Inga koncernmödrar"
            text={search || filter !== "alla" ? "Prova ett annat filter eller en annan sökning." : "Importera kunder eller lägg till en koncernmoder."} />
        ) : (
          <div className={`rtable-scroll${loading ? " is-loading" : ""}`}>
            <table className="rtable rtable--compact salj-register__tabell">
              <thead>
                <tr>
                  <th className="salj-register__cb"><input type="checkbox" aria-label="Markera alla" checked={allaValda} onChange={vaxlaAlla} /></th>
                  <th>Koncernmoder</th>
                  <th>Org.nr</th>
                  <th>Kundtyp</th>
                  <th data-align="right">Fastigheter</th>
                  <th data-align="right">Lgh</th>
                  <th>Datakvalitet</th>
                  <th>Källa</th>
                  <th>Utdelad till</th>
                  <th>Affär</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const spärrad = r.icke_saljbar || !!r.begransning;
                  return (
                    <tr key={r.id} className={`rtable__row${valda.has(r.id) ? " rtable__row--selected" : ""}`}>
                      <td className="salj-register__cb" data-label="Markera">
                        <input type="checkbox" aria-label="Markera" checked={valda.has(r.id)} disabled={spärrad} onChange={() => vaxla(r.id)} />
                      </td>
                      <td data-label="Koncernmoder"><button className="linklike salj-register__namn" onClick={() => oppnaKort(r.id)}>{r.namn ?? "Namnlös"}</button></td>
                      <td data-label="Org.nr">{r.orgnr ?? "–"}</td>
                      <td data-label="Kundtyp">{r.kundtyp ? kundtypLabel(r.kundtyp) : "–"}</td>
                      <td data-align="right" data-label="Fastigheter">{r.fastigheter}</td>
                      <td data-align="right" data-label="Lgh">{r.lgh || "–"}</td>
                      <td data-label="Datakvalitet"><Kvalitet rad={r} /></td>
                      <td data-label="Källa">{r.kalla ?? "–"}</td>
                      <td data-label="Utdelad till">{r.saljare ? (r.saljare === myId ? "Du" : getUserName(r.saljare)) : <span className="salj-dim">Ej utdelad</span>}</td>
                      <td data-label="Affär">{r.deal ? <button className="linklike" onClick={() => onOpenRecord(r.deal!)}>Öppna affär</button> : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {res && res.total > SIDA && (
          <Pager page={page} pageSize={SIDA} total={res.total} unit="koncernmödrar" onPage={setPage} />
        )}
      </div>
      <p className="salj-fotnot">
        Kunder med kontaktbegränsning eller markerade som icke säljbara går inte att dela ut. En affär skapas automatiskt vid utdelning.
      </p>

      {showCreate && (
        <RecordDrawer
          objectDef={objectDef}
          onClose={() => setShowCreate(false)}
          onSaved={(row) => { setShowCreate(false); setTick((t) => t + 1); onOpenRecord(row.id); }}
        />
      )}
    </div>
  );
}
