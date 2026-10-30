import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { skrivXlsx, laddaNed } from "@/lib/xlsxSkriv";
import { FilterPills, SkeletonRows } from "./PageChrome";
import {
  MATT, KATEGORI, UTREDNING, fmtVarde, fmtDiff, manadNamn, flyttaManad, dennaManad, adressText,
  lasOrderfil, gissaManad, byggExcel,
  type Nyckeltal, type Tal, type SaljareTal, type DiffLista, type DiffRad, type Kategori, type Utredning, type Matt,
} from "@/lib/d2dTeliaAvstamning";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Utfall → fliken Telia-avstämning (Gustav 30 okt).
     • Orderfilen: Telias orderfil (VT-exporten) laddas upp per månad och stäms av mot
       säljarnas sålda lägenheter (d2d_telia_orderfil_import → d2d_telia_avstamning_kor).
     • Nyckeltal: per säljare och för teamet — månaden, föregående månad och förändringen
       (d2d_nyckeltal_manad). Procenten räknas på totalerna.
     • Differenslista: allt som inte matchar, med utredningsstatus (d2d_telia_utred).
     • Excel: nyckeltal + differenslista.
   MinaNyckeltal = säljarens eget kort i D2D-sälj → Översikt.
   ========================================================================== */

export function useNyckeltal(manad: string) {
  const [data, setData] = useState<Nyckeltal | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [v, setV] = useState(0);
  useEffect(() => {
    let on = true;
    setData(null); setFel(null);
    supabase.rpc("d2d_nyckeltal_manad", { p_manad: `${manad}-01` }).then(({ data: d, error }) => {
      if (!on) return;
      if (error) setFel(error.message); else setData(d as Nyckeltal);
    });
    return () => { on = false; };
  }, [manad, v]);
  return { data, fel, uppdatera: () => setV((x) => x + 1) };
}

/** Ett nyckeltal: värdet nu, föregående månad och förändringen. */
function Varde({ m, nu, forra }: { m: Matt; nu: Tal | null; forra: Tal | null }) {
  const a = nu ? m.varde(nu) : null, b = forra ? m.varde(forra) : null;
  const diff = fmtDiff(a, b, m.typ);
  const ton = diff.startsWith("+") ? "tav__diff--upp" : diff.startsWith("−") ? "tav__diff--ner" : "";
  return (
    <span className="tav__varde">
      <b>{fmtVarde(a, m.typ)}</b>
      <small>{fmtVarde(b, m.typ)}{diff && <span className={`tav__diff ${ton}`}>{diff}</span>}</small>
    </span>
  );
}

function TeamTiles({ team, manad, forra }: { team: { nu: Tal | null; forra: Tal | null }; manad: string; forra: string }) {
  return (
    <div className="tav__tiles">
      {MATT.map((m) => (
        <div key={m.key} className="utf__tile tav__tile" title={m.forklaring}>
          <Varde m={m} nu={team.nu} forra={team.forra} />
          <span>{m.etikett}{m.key === "max" && team.nu?.max_kund ? ` · ${team.nu.max_kund}` : ""}</span>
        </div>
      ))}
      <div className="tav__tiles-fot">Stort tal = {manadNamn(manad)}, litet tal = {manadNamn(forra)} och förändringen (antal, eller procentenheter för procent).</div>
    </div>
  );
}

function SaljarTabell({ saljare, onOpenRecord }: { saljare: SaljareTal[]; onOpenRecord?: (id: string) => void }) {
  return (
    <div className="rtable-scroll">
      <table className="rtable utf__tabell tav__tabell">
        <thead><tr><th>Säljare</th>{MATT.map((m) => <th key={m.key} title={m.forklaring}>{m.kort}</th>)}</tr></thead>
        <tbody>
          {saljare.map((s) => (
            <tr key={s.id ?? "ingen"} className="rtable__row">
              <td className="rtable__title" data-label="Säljare">{s.namn}</td>
              {MATT.map((m) => (
                <td key={m.key} data-label={m.kort} className="utf__num">
                  <span className="tav__cell">
                    <Varde m={m} nu={s.nu} forra={s.forra} />
                    {m.key === "max" && s.nu?.max_lagenhet && (
                      <button type="button" className="tav__kund" title="Öppna lägenheten" onClick={() => onOpenRecord?.(s.nu!.max_lagenhet!)}>{s.nu.max_kund ?? "okänd kund"}</button>
                    )}
                  </span>
                </td>
              ))}
            </tr>
          ))}
          {!saljare.length && <tr><td colSpan={MATT.length + 1} className="utf__tom-rad">Inga sålda kunder eller kontakter i månaden.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ── Orderfilen ──────────────────────────────────────────────────────────────
function Orderfil({ manad, fil, onKlar }: { manad: string; fil: DiffLista["fil"]; onKlar: () => void }) {
  const [valdFil, setValdFil] = useState<File | null>(null);
  const [filManad, setFilManad] = useState(manad);
  const [antal, setAntal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => { setFilManad(manad); }, [manad]);

  async function valj(f: File | null) {
    setValdFil(f); setFel(null); setInfo(null); setAntal(null);
    if (!f) return;
    try {
      const rader = await lasOrderfil(f);
      setAntal(rader.length);
      const g = gissaManad(rader);
      if (g) setFilManad(g);
    } catch (e) { setFel(e instanceof Error ? e.message : String(e)); }
  }
  async function lasIn() {
    if (!valdFil) return;
    setBusy(true); setFel(null); setInfo(null);
    try {
      const rader = await lasOrderfil(valdFil);
      const { data, error } = await supabase.rpc("d2d_telia_orderfil_import", { p_manad: `${filManad}-01`, p_rader: rader, p_filnamn: valdFil.name });
      if (error) throw new Error(error.message);
      const r = data as { rader: number; ordrar: number };
      setInfo(`${r.rader} rader, ${r.ordrar} ordrar inlästa för ${manadNamn(filManad)}. Avstämningen är omräknad.`);
      setValdFil(null); setAntal(null);
      onKlar();
    } catch (e) { setFel(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return (
    <section className="card utf__sek tav__fil">
      <div className="utf__sekhuvud">
        <h2>Telias orderfil</h2>
        {fil ? (
          <span className="tav__filinfo">{manadNamn(manad)}: <b>{fil.filNamn ?? "fil"}</b> · {fil.ordrar} ordrar ({fil.rader} rader) · inläst {new Date(fil.laddadAt).toLocaleDateString("sv-SE")}{fil.laddadAv ? ` av ${fil.laddadAv}` : ""}</span>
        ) : (
          <span className="tav__filinfo tav__filinfo--saknas">Ingen orderfil inläst för {manadNamn(manad)}.</span>
        )}
      </div>
      <div className="tav__filrad">
        <label className="utf__rapport-fil">
          <span>Orderfil (VT-export: xlsx, csv eller text)</span>
          <input type="file" accept=".xlsx,.csv,.txt,.tsv" onChange={(e) => valj(e.target.files?.[0] ?? null)} />
        </label>
        <label className="tav__manadval">
          <span>Filen avser</span>
          <input type="month" className="input input--sm" value={filManad} onChange={(e) => setFilManad(e.target.value)} />
        </label>
        <button type="button" className="btn btn--brand" disabled={!valdFil || busy || !!fel} onClick={lasIn}>
          {busy ? "Läser in…" : "Läs in och stäm av"}
        </button>
      </div>
      <small className="formfield__help">
        {antal != null ? `${antal} rader i filen. ` : ""}
        En ny fil för samma månad ersätter den gamla. Matchning: gatuadress + lägenhetsnummer, Telias orderdatum får ligga upp till 30 dagar efter säljdatumet. Personnummer i filen läses inte in.
      </small>
      {fel && <div className="formfield__error">{fel}</div>}
      {info && <div className="tav__ok">{info}</div>}
    </section>
  );
}

// ── Differenslistan ─────────────────────────────────────────────────────────
const KAT_PILLS: Array<{ key: string; label: string }> = [
  { key: "diff", label: "Alla avvikelser" }, { key: "endast_saljare", label: "Endast säljare" }, { key: "endast_telia", label: "Endast Telia" },
  { key: "avvikande", label: "Avvikande" }, { key: "matchad", label: "Matchade" },
];

function Utred({ rad, kan, onSpara }: { rad: DiffRad; kan: boolean; onSpara: (id: string, status: Utredning, kommentar: string) => Promise<void> }) {
  const [status, setStatus] = useState<Utredning>(rad.utredning);
  const [kommentar, setKommentar] = useState(rad.utredningKommentar ?? "");
  useEffect(() => { setStatus(rad.utredning); setKommentar(rad.utredningKommentar ?? ""); }, [rad.utredning, rad.utredningKommentar]);
  if (!kan) return <span className={`status-pill tav__utr tav__utr--${status}`}>{UTREDNING[status]}</span>;
  return (
    <div className="tav__utred">
      <select className={`input input--sm tav__utr--${status}`} value={status} aria-label="Utredning"
        onChange={(e) => { const s = e.target.value as Utredning; setStatus(s); void onSpara(rad.id, s, kommentar); }}>
        {(Object.keys(UTREDNING) as Utredning[]).map((k) => <option key={k} value={k}>{UTREDNING[k]}</option>)}
      </select>
      <input className="input input--sm" placeholder="Kommentar" value={kommentar} aria-label="Kommentar"
        onChange={(e) => setKommentar(e.target.value)}
        onBlur={() => { if (kommentar !== (rad.utredningKommentar ?? "")) void onSpara(rad.id, status, kommentar); }} />
      {rad.utreddAv && status !== "oppen" && <small className="formfield__help">{rad.utreddAv}{rad.utreddAt ? ` · ${new Date(rad.utreddAt).toLocaleDateString("sv-SE")}` : ""}</small>}
    </div>
  );
}

function Differenslista({ lista, onOpenRecord, onAndrad }: { lista: DiffLista; onOpenRecord?: (id: string) => void; onAndrad: (r: DiffRad) => void }) {
  const [kat, setKat] = useState("diff");
  const [utr, setUtr] = useState<"oppen" | "alla" | "utredd">("oppen");
  const [saljare, setSaljare] = useState("");
  const [sok, setSok] = useState("");
  const [fel, setFel] = useState<string | null>(null);

  const saljareVal = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of lista.rader) if (r.saljareId && r.saljare) m.set(r.saljareId, r.saljare);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "sv"));
  }, [lista]);
  const antal = useMemo(() => {
    const n: Record<string, number> = { diff: 0 };
    for (const r of lista.rader) { n[r.kategori] = (n[r.kategori] ?? 0) + 1; if (r.kategori !== "matchad") n.diff++; }
    return n;
  }, [lista]);
  const rader = useMemo(() => {
    const q = sok.trim().toLowerCase();
    return lista.rader.filter((r) =>
      (kat === "diff" ? r.kategori !== "matchad" : r.kategori === kat)
      && (utr === "alla" || (utr === "oppen" ? r.utredning === "oppen" : r.utredning !== "oppen"))
      && (!saljare || r.saljareId === saljare)
      && (!q || [adressText(r), r.lgh, r.ort, r.kund, r.ordernummer, r.saljare, r.teliaAdress, r.avvikelse].some((x) => (x ?? "").toLowerCase().includes(q))));
  }, [lista, kat, utr, saljare, sok]);

  const spara = useCallback(async (id: string, status: Utredning, kommentar: string) => {
    setFel(null);
    const { error } = await supabase.rpc("d2d_telia_utred", { p_id: id, p_status: status, p_kommentar: kommentar || null });
    if (error) { setFel(error.message); return; }
    const r = lista.rader.find((x) => x.id === id);
    if (r) onAndrad({ ...r, utredning: status, utredningKommentar: kommentar || null });
  }, [lista, onAndrad]);

  return (
    <section className="card utf__sek tav__diff-sek">
      <div className="utf__sekhuvud">
        <h2>Differenslista <span className="utf__snitt">{manadNamn(lista.manad)}</span></h2>
        <span className="utf__snitt">{antal.matchad ?? 0} matchade · {antal.endast_saljare ?? 0} endast säljare · {antal.endast_telia ?? 0} endast Telia · {antal.avvikande ?? 0} avvikande</span>
      </div>
      <div className="utf__filter">
        <FilterPills active={kat} onSelect={setKat} items={KAT_PILLS.map((p) => ({ ...p, count: antal[p.key] ?? 0 }))} />
        <FilterPills active={utr} onSelect={(k) => setUtr(k as typeof utr)} items={[{ key: "oppen", label: "Öppna" }, { key: "utredd", label: "Utredda" }, { key: "alla", label: "Alla" }]} />
        <select className="input input--sm" aria-label="Säljare" value={saljare} onChange={(e) => setSaljare(e.target.value)}>
          <option value="">Alla säljare</option>
          {saljareVal.map(([id, namn]) => <option key={id} value={id}>{namn}</option>)}
        </select>
        <input className="input input--sm tav__sok" placeholder="Sök adress, kund, ordernummer…" value={sok} onChange={(e) => setSok(e.target.value)} />
      </div>
      {fel && <div className="formfield__error">{fel}</div>}
      {!lista.fil && <p className="utf__ingress">Ingen orderfil är inläst för månaden — alla sålda kunder ligger som "Endast säljare" tills filen läses in.</p>}
      <div className="rtable-scroll">
        <table className="rtable utf__tabell tav__difftabell">
          <thead><tr><th>Säljare</th><th>Adress</th><th>Lgh</th><th>Kund</th><th>Tjänst enligt säljare</th><th>Tjänst enligt Telia</th><th>Kategori</th><th>Utredning</th></tr></thead>
          <tbody>
            {rader.map((r) => (
              <tr key={r.id} className="rtable__row">
                <td data-label="Säljare"><span className="tav__cell">{r.saljare ?? (r.kategori === "endast_telia" ? <span className="tav__dim">Telia: {r.csr ?? "–"}</span> : "–")}</span></td>
                <td data-label="Adress" className="rtable__title">
                  <span className="tav__cell">
                    <span>{r.lagenhetId ? <button type="button" className="tav__lank" onClick={() => onOpenRecord?.(r.lagenhetId!)}>{adressText(r)}</button> : adressText(r)}{r.ort && <span className="tav__dim"> · {r.ort}</span>}</span>
                    {r.teliaAdress && r.lagenhetId && <span className="tav__dim">Telia: {r.teliaAdress}</span>}
                  </span>
                </td>
                <td data-label="Lgh">{r.lgh ?? "–"}</td>
                <td data-label="Kund"><span className="tav__cell">{r.kund ?? "–"}{r.saldDatum && <span className="tav__dim">såld {r.saldDatum}</span>}</span></td>
                <td data-label="Tjänst enligt säljare">{r.tjansterSaljare || (r.lagenhetId ? "–" : "")}</td>
                <td data-label="Tjänst enligt Telia"><span className="tav__cell">{r.tjansterTelia || (r.ordernummer ? "–" : "")}{r.ordernummer && <span className="tav__dim">order {r.ordernummer}{r.orderstatus ? ` · ${r.orderstatus}` : ""}{r.orderDatum ? ` · ${r.orderDatum}` : ""}</span>}</span></td>
                <td data-label="Kategori">
                  <span className="tav__cell">
                    <span className={`status-pill tav__kat tav__kat--${r.kategori}`}>{KATEGORI[r.kategori]}</span>
                    {r.avvikelse && <span className="tav__avvikelse">{r.avvikelse}</span>}
                  </span>
                </td>
                <td data-label="Utredning"><Utred rad={r} kan={lista.kanUtreda} onSpara={spara} /></td>
              </tr>
            ))}
            {!rader.length && <tr><td colSpan={8} className="utf__tom-rad">Inget att visa med de här filtren.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Fliken i Utfall ─────────────────────────────────────────────────────────
export function D2DTeliaAvstamning({ onOpenRecord, startManad }: { onOpenRecord?: (id: string) => void; startManad?: string | null }) {
  const [manad, setManad] = useState(() => (startManad && /^\d{4}-\d{2}$/.test(startManad) ? startManad : dennaManad()));
  const { data: n, fel: nFel, uppdatera } = useNyckeltal(manad);
  const [lista, setLista] = useState<DiffLista | null>(null);
  const [lFel, setLFel] = useState<string | null>(null);
  const [lv, setLv] = useState(0);
  const [raknar, setRaknar] = useState(false);

  useEffect(() => {
    let on = true;
    setLista(null); setLFel(null);
    supabase.rpc("d2d_telia_avstamning_lista", { p_manad: `${manad}-01` }).then(({ data, error }) => {
      if (!on) return;
      if (error) setLFel(error.message); else setLista(data as DiffLista);
    });
    return () => { on = false; };
  }, [manad, lv]);
  const omladda = useCallback(() => { setLv((x) => x + 1); uppdatera(); }, [uppdatera]);

  async function raknaOm() {
    setRaknar(true);
    const { error } = await supabase.rpc("d2d_telia_avstamning_kor", { p_manad: `${manad}-01` });
    setRaknar(false);
    if (error) setLFel(error.message); else omladda();
  }
  function excel() {
    if (!n) return;
    laddaNed(skrivXlsx(byggExcel(n, lista)), `Telia-avstamning_${manad}.xlsx`);
  }

  return (
    <div className="tav">
      <div className="utf__filter tav__topp">
        <div className="tav__manad">
          <button type="button" className="btn btn--sm btn--ghost" aria-label="Föregående månad" onClick={() => setManad(flyttaManad(manad, -1))}>‹</button>
          <input type="month" className="input input--sm" value={manad} max={dennaManad()} aria-label="Månad" onChange={(e) => e.target.value && setManad(e.target.value)} />
          <button type="button" className="btn btn--sm btn--ghost" aria-label="Nästa månad" disabled={manad >= dennaManad()} onClick={() => setManad(flyttaManad(manad, 1))}>›</button>
          <strong className="tav__manadnamn">{manadNamn(manad)}</strong>
        </div>
        <span className="utf__snitt">jämförs med {manadNamn(flyttaManad(manad, -1))}</span>
        <button type="button" className="btn btn--sm btn--ghost" disabled={raknar || !lista} onClick={raknaOm} title="Räkna om avstämningen mot de inlästa filerna">{raknar ? "Räknar…" : "Räkna om"}</button>
        <button type="button" className="btn btn--sm btn--brand" disabled={!n} onClick={excel}>Excel</button>
      </div>

      {lista !== null && lista.kanUtreda && <Orderfil manad={manad} fil={lista.fil} onKlar={omladda} />}

      {nFel && <div className="formfield__error">{nFel}</div>}
      {!n && !nFel && <div className="card"><SkeletonRows rows={4} /></div>}
      {n?.team && (
        <section className="card utf__sek">
          <h2>Teamet <span className="utf__snitt">{manadNamn(n.manad)}</span></h2>
          <TeamTiles team={n.team} manad={n.manad} forra={n.forra} />
        </section>
      )}
      {n && (
        <section className="card utf__sek">
          <h2>Per säljare</h2>
          <p className="utf__ingress">Stort tal = {manadNamn(n.manad)}, litet tal = {manadNamn(n.forra)} och förändringen. Hitrate räknas på loggade kontakter (statusbyten och knackningar); matchning mot Telia är andelen sålda kunder som finns i orderfilen med samma tjänster.</p>
          <SaljarTabell saljare={n.saljare} onOpenRecord={onOpenRecord} />
        </section>
      )}

      {lFel && <div className="formfield__error">{lFel}</div>}
      {!lista && !lFel && <div className="card"><SkeletonRows rows={4} /></div>}
      {lista && (
        <Differenslista lista={lista} onOpenRecord={onOpenRecord}
          onAndrad={(r) => setLista((l) => l && { ...l, rader: l.rader.map((x) => (x.id === r.id ? r : x)) })} />
      )}
    </div>
  );
}

// ── Säljarens kort i D2D-sälj → Översikt ───────────────────────────────────
export function MinaNyckeltal({ minId }: { minId: string | null }) {
  const manad = dennaManad();
  const { data: n } = useNyckeltal(manad);
  const mig = n?.saljare.find((s) => s.id === minId);
  if (!n || !mig || (!mig.nu && !mig.forra)) return null;
  return (
    <section className="d2dd__section tav__mina">
      <h2 className="d2dd__rubrik">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 19V5M4 19h16M8 15l4-5 3 3 5-6" /></svg>
        Mina nyckeltal — {manadNamn(n.manad)}
      </h2>
      <div className="tav__tiles tav__tiles--mina">
        {MATT.map((m) => (
          <div key={m.key} className="d2dd__kpi tav__kpi" title={m.forklaring}>
            <Varde m={m} nu={mig.nu} forra={mig.forra} />
            <span className="d2dd__kpi-etikett">{m.etikett}{m.key === "max" && mig.nu?.max_kund ? ` · ${mig.nu.max_kund}` : ""}</span>
          </div>
        ))}
      </div>
      <p className="d2dd__scrive-hint">Litet tal = {manadNamn(n.forra)} och förändringen. Hitrate = andel av dina loggade kontakter; matchning = andel av dina sålda som finns i Telias orderfil.</p>
    </section>
  );
}
