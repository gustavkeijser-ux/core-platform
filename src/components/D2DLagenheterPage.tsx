import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getMetadata, type ObjectDef, type RecordRow } from "@/lib/data";
import { useTenantUsers } from "@/lib/users";
import { useRoute, navigate } from "@/lib/route";
import { ObjectListPage } from "./ObjectListPage";
import { EmptyState, SearchField, TopbarActions } from "./PageChrome";
import {
  LagenhetTabell, FastighetProgress, LagenhetForm,
  STATUS_CONFIG, ALLA_STATUS_ORDNING, jamforLagenheter, type KnockStatus,
} from "./D2DSellerApp";
import { Fyrverkeri } from "./D2DFyrverkeri";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Lägenheter.
   Uppbyggd som "Alla adresser" i D2D-sälj, men med alla lägenheter i
   systemet: filter på projekt, ort, fastighet, säljare och status, en
   progressbar och samma lägenhetskort som säljaren har — namn, telefon och
   kommentar skrivs direkt i kortet, Inte hemma och −/+ knackningar. Klick
   på raden (eller "Öppna lägenheten") öppnar säljarens lägenhetsvy här i
   CRM:et (`?lgh=<id>`), där status sätts och försäljningen fylls i precis
   som i säljarappen. "Tabellvy" (`?vy=tabell`) är den vanliga listan med
   markera/byt säljare och CSV-export.
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

async function allaRader<T>(hamta: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const PAGE = 1000;
  const ut: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await hamta(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    ut.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return ut;
}

async function hamtaUnderlag(): Promise<Underlag> {
  const [lagenheter, lagRels, fast, fastRels, proj] = await Promise.all([
    allaRader<RecordRow>((a, b) => supabase.from("records").select(SEL).eq("object_type", "d2d_lagenhet").is("deleted_at", null).order("id").range(a, b)),
    allaRader<{ from_record_id: string; to_record_id: string }>((a, b) => supabase.from("relationships").select("from_record_id,to_record_id").eq("rel_type", "d2d_lag_fastighet").order("from_record_id").range(a, b)),
    allaRader<RecordRow>((a, b) => supabase.from("records").select(SEL).eq("object_type", "d2d_fastighet").is("deleted_at", null).order("id").range(a, b)),
    allaRader<{ from_record_id: string; to_record_id: string }>((a, b) => supabase.from("relationships").select("from_record_id,to_record_id").eq("rel_type", "d2d_fast_projekt").order("from_record_id").range(a, b)),
    allaRader<RecordRow>((a, b) => supabase.from("records").select(SEL).eq("object_type", "d2d_projekt").is("deleted_at", null).order("id").range(a, b)),
  ]);
  const fastigheter = new Map(fast.map((f) => [f.id, f]));
  const projekt = new Map(proj.map((p) => [p.id, p]));
  const fastFor = new Map<string, string>();
  for (const r of lagRels) if (fastigheter.has(r.to_record_id)) fastFor.set(r.from_record_id, r.to_record_id);
  const projektFor = new Map<string, string>();
  for (const r of fastRels) if (projekt.has(r.to_record_id)) projektFor.set(r.from_record_id, r.to_record_id);
  return { lagenheter: lagenheter.sort(jamforLagenheter), fastFor, fastigheter, projektFor, projekt };
}

export function D2DLagenheterPage({ objectDef, onOpenRecord, onMetadataChanged, reloadKey }: {
  objectDef: ObjectDef;
  projektDef?: ObjectDef;
  onOpenRecord: (id: string) => void;
  onMetadataChanged?: () => void;
  reloadKey?: number;
}) {
  const route = useRoute();
  const lghId = route.query.get("lgh");
  const tabell = route.query.get("vy") === "tabell";

  const [u, setU] = useState<Underlag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const users = useTenantUsers();
  const namnFor = useMemo(() => new Map(users.map((x) => [x.id, x.name])), [users]);

  const [sok, setSok] = useState("");
  const [projekt, setProjekt] = useState(ALLA);
  const [ort, setOrt] = useState(ALLA);
  const [fastighet, setFastighet] = useState(ALLA);
  const [saljare, setSaljare] = useState(ALLA);
  const [status, setStatus] = useState<KnockStatus | typeof ALLA>(ALLA);
  const [visaAntal, setVisaAntal] = useState(SIDA);

  const load = useCallback(async () => {
    try {
      const d = await hamtaUnderlag();
      setU(d); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kunde inte hämta lägenheterna.");
    }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);
  useEffect(() => { getMetadata().then((m) => setIsAdmin(!!m.isAdmin)).catch(() => {}); }, []);

  // Lägenhetsvyn ska börja högst upp (listan kan vara långt nedskrollad);
  // tillbaka till listan skrollar useReturnToRow till raden igen.
  useEffect(() => {
    if (lghId) document.querySelector(".app-shell__content")?.scrollTo({ top: 0 });
  }, [lghId]);

  // När lägenhetsvyn stängs: hämta om just den posten så status, namn,
  // kommentar och säljare i kortet stämmer utan att hela listan laddas om.
  const forraLgh = useRef<string | null>(null);
  useEffect(() => {
    const forra = forraLgh.current;
    forraLgh.current = lghId;
    if (lghId || !forra) return;
    void (async () => {
      const { data } = await supabase.from("records").select(SEL).eq("id", forra).maybeSingle();
      if (!data) return;
      setU((prev) => prev ? { ...prev, lagenheter: prev.lagenheter.map((l) => l.id === forra ? (data as RecordRow) : l) } : prev);
    })();
  }, [lghId]);

  const setLagenheter: Dispatch<SetStateAction<RecordRow[]>> = useCallback((upd) => {
    setU((prev) => {
      if (!prev) return prev;
      const next = typeof upd === "function" ? upd(prev.lagenheter) : upd;
      // Tabellen får bara de visade raderna — mappa tillbaka på hela listan.
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
    const text = [d.gatunamn, d.gatunummer, d.ingang, l.title, d.kund_namn, d.kund_telefon, d.kommentar, fastAv(l)?.title]
      .filter(Boolean).map(String).join(" ").toLowerCase();
    return text.includes(q);
  };

  // ── Filterval (bara det som finns i det som är kvar efter de andra filtren) ──
  const alla = u?.lagenheter ?? [];
  const q = sok.trim().toLowerCase();
  const sokta = q ? alla.filter((l) => matcharSok(l, q)) : alla;

  const projektVal = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of sokta) { const p = projektAv(l); m.set(p, (m.get(p) ?? 0) + 1); }
    const rader = Array.from(m.entries())
      .filter(([id]) => id !== UTAN_PROJEKT)
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
  const filtrerade = iFast.filter((l) => saljare === ALLA || saljareAv(l) === saljare);

  const antal: Partial<Record<KnockStatus, number>> = {};
  for (const l of filtrerade) { const k = statusAv(l); antal[k] = (antal[k] ?? 0) + 1; }
  const visade = filtrerade.filter((l) => status === ALLA || statusAv(l) === status);
  const synliga = visade.slice(0, visaAntal);

  // Nytt filter → börja om från början av listan.
  useEffect(() => { setVisaAntal(SIDA); }, [sok, projekt, ort, fastighet, saljare, status]);

  const oppna = (id: string) => navigate(["list", objectDef.key], { lgh: id });
  const stang = () => navigate(["list", objectDef.key]);

  // ── Tabellvyn (den vanliga listan: markera, byt säljare, CSV) ────────
  if (tabell) {
    return (
      <ObjectListPage
        key="tabell"
        objectDef={objectDef}
        onOpenRecord={onOpenRecord}
        onMetadataChanged={onMetadataChanged}
        reloadKey={reloadKey}
        stateKeySuffix=":tabell"
        banner={
          <div className="d2dov-crumb">
            <button type="button" className="btn btn--ghost btn--sm" onClick={stang}>← Lägenheter</button>
            <span className="d2dov-crumb__title">Tabellvy</span>
          </div>
        }
      />
    );
  }

  // ── Lägenheten (säljarens vy med status och försäljning) ─────────────
  if (lghId) {
    const fid = u?.fastFor.get(lghId) ?? "";
    return (
      <div className="page d2dlag d2dlag--form">
        <Fyrverkeri />
        <div className="d2d-detail">
          <LagenhetForm
            key={lghId}
            lagenhetId={lghId}
            fastighetId={fid}
            objectDef={objectDef}
            isAdmin={isAdmin}
            onFieldsChanged={onMetadataChanged}
            onBack={stang}
          />
        </div>
      </div>
    );
  }

  // ── Listan ───────────────────────────────────────────────────────────
  const rensa = () => { setSok(""); setProjekt(ALLA); setOrt(ALLA); setFastighet(ALLA); setSaljare(ALLA); setStatus(ALLA); };
  const harFilter = !!q || projekt !== ALLA || ort !== ALLA || fastighet !== ALLA || saljare !== ALLA || status !== ALLA;

  return (
    <div className="page d2dlag">
      <Fyrverkeri />
      <TopbarActions>
        <SearchField value={sok} onChange={setSok} placeholder="Sök adress, namn, telefon…" />
        <button type="button" className="btn btn--ghost btn--sm d2dlag__tabell" onClick={() => navigate(["list", objectDef.key], { vy: "tabell" })}>
          Tabellvy
        </button>
      </TopbarActions>

      {error && (
        <div className="card">
          <EmptyState kind="error" title="Kunde inte hämta lägenheterna" text={error}
            action={<button className="btn btn--danger btn--sm" onClick={() => void load()}>Försök igen</button>} />
        </div>
      )}

      {!error && !u && <div className="d2d-loading">Laddar lägenheter…</div>}

      {u && (
        <div className="d2d-detail">
          {/* Filter: projekt, ort, fastighet och säljare som val; status som bubblor. */}
          <div className="d2d-alla__filter d2dlag__filter">
            <div className="d2d-alla__val">
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
            <div className="d2d-status-picker d2d-alla__status" role="group" aria-label="Filtrera på status">
              <button type="button" className={`d2d-status-btn${status === ALLA ? " d2d-status-btn--active" : ""}`} onClick={() => setStatus(ALLA)}>
                Alla {filtrerade.length}
              </button>
              {ALLA_STATUS_ORDNING.filter((k) => (antal[k] ?? 0) > 0).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`d2d-status-btn ${STATUS_CONFIG[k].cssClass}${status === k ? " d2d-status-btn--active" : ""}`}
                  onClick={() => setStatus(status === k ? ALLA : k)}
                >
                  {STATUS_CONFIG[k].label} {antal[k]}
                </button>
              ))}
              {harFilter && (
                <button type="button" className="btn btn--ghost btn--sm d2dlag__rensa" onClick={rensa}>Rensa filter</button>
              )}
            </div>
          </div>

          <div className="d2d-lag-list">
            <div className="d2d-lag-list__header">
              <h3>Lägenheter</h3>
              <span>{visade.length === alla.length ? `${visade.length} st` : `${visade.length} av ${alla.length} st`}</span>
            </div>

            <FastighetProgress lagenheter={filtrerade} />

            {alla.length === 0 && <div className="d2d-empty">Inga lägenheter än. De dyker upp här när ett D2D-projekt har fått adresser.</div>}
            {alla.length > 0 && visade.length === 0 && <div className="d2d-empty">Inga lägenheter matchar filtret.</div>}

            <LagenhetTabell
              lagenheter={synliga}
              setLagenheter={setLagenheter}
              isAdmin={isAdmin}
              fastData={{}}
              listKey="crm-lagenheter"
              ready={!!u}
              onOpenLagenhet={oppna}
              medKommentar
              fastighetNamn={(id) => {
                const l = alla.find((x) => x.id === id);
                if (!l) return "";
                const p = projektAv(l);
                return [fastAv(l)?.title, ortAv(l), p !== UTAN_PROJEKT ? u.projekt.get(p)?.title : null].filter(Boolean).join(" · ");
              }}
            />

            {visade.length > synliga.length && (
              <div className="d2dlag__mer">
                <button type="button" className="btn btn--ghost" onClick={() => setVisaAntal((n) => n + SIDA)}>
                  Visa fler ({visade.length - synliga.length} till)
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
