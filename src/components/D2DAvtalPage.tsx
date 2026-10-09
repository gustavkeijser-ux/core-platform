import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FieldDef } from "@/lib/data";
import { beraknaAvtal, loadPrislista, onPrislista, type Prislista } from "@/lib/d2dPris";
import { prisKategorier } from "./D2DAvtal";
import { FilterPills, SkeletonRows } from "./PageChrome";
import { ScriveOkopplade } from "./D2DScriveImport";

/* =============================================================================
   Door to door → Avtal. Tre flikar:
     • Scrive-avtal — avtal skickade för signering med Scrive (med PDF).
     • Sålda — lägenheter med status "Såld" i D2D, med tjänster och pris.
     • Totalt — sålda och signerade Scrive-avtal tillsammans: antal och
       summor per månad, totalt och per säljare.
   Period och projekt gäller för alla flikar.
   ========================================================================== */

type Avtal = {
  id: string; status: "skapas" | "vantar" | "signerat" | "avvisat" | "avbrutet" | "fel";
  leverans: "plats" | "skickat" | "manuell"; kundNamn: string | null; skapad: string; signerad: string | null;
  harPdf: boolean; fel: string | null; lagenhetId: string; adress: string | null; lgh: string | null;
  ort: string | null; fastighet: string | null; projekt: string | null; projektId: string | null;
  saljare: string | null; tjanster: string[]; manadSumma: number | null; engangSumma: number | null;
};
type Sald = {
  id: string; kundNamn: string | null; datum: string; adress: string | null; lgh: string | null; ort: string | null;
  fastighet: string | null; projekt: string | null; projektId: string | null; saljare: string | null;
  data: Record<string, unknown>;
};
type SaldRad = Sald & { tjanster: string[]; manadSumma: number; engangSumma: number };

const STATUS: Record<Avtal["status"], string> = {
  signerat: "Signerat", vantar: "Väntar på signatur", skapas: "Skapas", avvisat: "Avvisat",
  avbrutet: "Avbrutet", fel: "Fel",
};
type Flik = "scrive" | "salda" | "totalt";
type Filter = "signerat" | "vantar" | "ovriga" | "alla";
type Period = "30" | "ar" | "allt";

const datum = (s: string | null) => (s ? new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) : "–");
const kr = (n: number | null) => (n == null ? "–" : `${Math.round(n).toLocaleString("sv-SE")} kr`);
const titel = (s: string | null) => (s ? s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : "");
const sok = (q: string, v: Array<string | null>) => !q || v.some((x) => (x ?? "").toLowerCase().includes(q));

function periodFran(p: Period): string | null {
  const d = new Date();
  if (p === "30") { d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }
  if (p === "ar") return `${d.getFullYear()}-01-01`;
  return null;
}

export function D2DAvtalPage({ onOpenRecord, lagFields = [] }: { onOpenRecord: (id: string) => void; lagFields?: FieldDef[] }) {
  const [flik, setFlik] = useState<Flik>("scrive");
  const [avtal, setAvtal] = useState<Avtal[] | null>(null);
  const [salda, setSalda] = useState<Sald[] | null>(null);
  const [lista, setLista] = useState<Prislista | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("signerat");
  const [period, setPeriod] = useState<Period>("allt");
  const [projekt, setProjekt] = useState("");
  const [fritext, setFritext] = useState("");
  const [pdfFel, setPdfFel] = useState<string | null>(null);

  const ladda = useCallback(async () => {
    setFel(null);
    const fran = periodFran(period);
    const [a, s] = await Promise.all([
      supabase.rpc("d2d_avtal_lista", { p_fran: fran, p_till: null }),
      supabase.rpc("d2d_salda_lista", { p_fran: fran, p_till: null }),
    ]);
    if (a.error || s.error) { setFel((a.error ?? s.error)!.message); return; }
    setAvtal((a.data ?? []) as Avtal[]);
    setSalda((s.data ?? []) as Sald[]);
  }, [period]);
  useEffect(() => { setAvtal(null); setSalda(null); void ladda(); }, [ladda]);

  useEffect(() => {
    let on = true;
    loadPrislista().then((p) => { if (on) setLista(p); }).catch(() => { /* priser visas som – */ });
    const off = onPrislista((p) => setLista(p));
    return () => { on = false; off(); };
  }, []);

  // Sålda: tjänster och priser räknas som i avtalsförslaget i D2D-vyn.
  const soldFields = useMemo(() => prisKategorier(lagFields), [lagFields]);
  const saldRader = useMemo<SaldRad[]>(() => (salda ?? []).map((s) => {
    if (!lista || soldFields.length === 0) return { ...s, tjanster: [], manadSumma: 0, engangSumma: 0 };
    const b = beraknaAvtal(s.data, soldFields, lista);
    return { ...s, tjanster: b.manad.map((r) => r.label), manadSumma: b.totalKampanj, engangSumma: b.totalEngang };
  }), [salda, lista, soldFields]);

  const projektLista = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of avtal ?? []) if (a.projektId) m.set(a.projektId, a.projekt ?? "Namnlöst projekt");
    for (const s of salda ?? []) if (s.projektId) m.set(s.projektId, s.projekt ?? "Namnlöst projekt");
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "sv"));
  }, [avtal, salda]);

  const q = fritext.trim().toLowerCase();
  const avtalUrval = useMemo(() => (avtal ?? []).filter((a) => !projekt || a.projektId === projekt), [avtal, projekt]);
  const saldUrval = useMemo(() => saldRader.filter((s) => (!projekt || s.projektId === projekt)
    && sok(q, [s.kundNamn, s.adress, s.lgh, s.ort, s.fastighet, s.projekt, s.saljare])), [saldRader, projekt, q]);
  const signerade = useMemo(() => avtalUrval.filter((a) => a.status === "signerat"), [avtalUrval]);

  const antal = useMemo(() => ({
    signerat: signerade.length,
    vantar: avtalUrval.filter((a) => a.status === "vantar" || a.status === "skapas").length,
    ovriga: avtalUrval.filter((a) => ["avvisat", "avbrutet", "fel"].includes(a.status)).length,
    alla: avtalUrval.length,
  }), [avtalUrval, signerade]);

  const avtalLista = useMemo(() => avtalUrval.filter((a) => {
    if (filter === "signerat" && a.status !== "signerat") return false;
    if (filter === "vantar" && a.status !== "vantar" && a.status !== "skapas") return false;
    if (filter === "ovriga" && !["avvisat", "avbrutet", "fel"].includes(a.status)) return false;
    return sok(q, [a.kundNamn, a.adress, a.lgh, a.ort, a.fastighet, a.projekt, a.saljare]);
  }), [avtalUrval, filter, q]);

  const summa = (r: Array<{ manadSumma: number | null }>) => r.reduce((s, a) => s + (a.manadSumma ?? 0), 0);
  const scriveManad = summa(signerade);
  const saldManad = summa(saldUrval);

  // Totalt per säljare: sålda + signerade Scrive-avtal.
  const perSaljare = useMemo(() => {
    const m = new Map<string, { saljare: string; salda: number; saldKr: number; scrive: number; scriveKr: number }>();
    const rad = (n: string | null) => {
      const k = n ?? "Okänd säljare";
      if (!m.has(k)) m.set(k, { saljare: k, salda: 0, saldKr: 0, scrive: 0, scriveKr: 0 });
      return m.get(k)!;
    };
    for (const s of saldUrval) { const r = rad(s.saljare); r.salda++; r.saldKr += s.manadSumma; }
    for (const a of signerade) { const r = rad(a.saljare); r.scrive++; r.scriveKr += a.manadSumma ?? 0; }
    return [...m.values()].sort((a, b) => (b.salda + b.scrive) - (a.salda + a.scrive) || a.saljare.localeCompare(b.saljare, "sv"));
  }, [saldUrval, signerade]);

  async function oppnaPdf(a: Avtal) {
    setPdfFel(null);
    const flikFonster = window.open("", "_blank");   // öppnas direkt vid klicket (popup-skydd på mobilen)
    const { data, error } = await supabase.functions.invoke("scrive-sign", { body: { action: "pdf", avtalId: a.id } });
    const url = (data as { url?: string } | null)?.url;
    if (error || !url) { flikFonster?.close(); setPdfFel("Kunde inte hämta avtalet."); return; }
    if (flikFonster) flikFonster.location.href = url; else window.location.href = url;
  }

  const laddat = avtal && salda;
  const flikar: Array<[Flik, string, number | null]> = [
    ["scrive", "Scrive-avtal", avtal ? antal.alla : null],
    ["salda", "Sålda", salda ? saldUrval.length : null],
    ["totalt", "Totalt", laddat ? saldUrval.length + signerade.length : null],
  ];

  return (
    <div className="page utf d2davt">
      <div className="tab-bar d2davt__flikar" role="tablist">
        {flikar.map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={flik === k} className={`tab-bar__tab${flik === k ? " tab-bar__tab--active" : ""}`}
            onClick={() => setFlik(k)}>
            {label}{n != null && <span className="tab-bar__count">{n}</span>}
          </button>
        ))}
      </div>

      <div className="utf__filter">
        <FilterPills
          active={period}
          onSelect={(k) => setPeriod(k as Period)}
          items={[{ key: "30", label: "30 dagar" }, { key: "ar", label: "I år" }, { key: "allt", label: "Allt" }]}
        />
        {projektLista.length > 1 && (
          <select className="input input--sm" aria-label="Projekt" value={projekt} onChange={(e) => setProjekt(e.target.value)}>
            <option value="">Alla projekt</option>
            {projektLista.map(([id, namn]) => <option key={id} value={id}>{namn}</option>)}
          </select>
        )}
        {flik !== "totalt" && (
          <input className="input input--sm d2davt__sok" placeholder="Sök kund, adress, säljare…" value={fritext} onChange={(e) => setFritext(e.target.value)} />
        )}
      </div>

      {fel && <div className="formfield__error">{fel}</div>}
      {!laddat && !fel && <div className="card"><SkeletonRows rows={6} /></div>}

      {laddat && flik === "scrive" && (<>
        <div className="d2davt__tal">
          <div className="card"><b>{antal.signerat}</b><span>signerade</span></div>
          <div className="card"><b>{antal.vantar}</b><span>väntar på signatur</span></div>
          <div className="card"><b>{kr(scriveManad)}</b><span>per månad, signerade</span></div>
        </div>

        <section className="card utf__sek d2davt__okop">
          <ScriveOkopplade onKopplad={() => { void ladda(); }} />
        </section>

        <section className="card utf__sek">
          <div className="utf__sekhuvud">
            <h2>Scrive-avtal</h2>
            <FilterPills
              active={filter}
              onSelect={(k) => setFilter(k as Filter)}
              items={[
                { key: "signerat", label: "Signerade", count: antal.signerat },
                { key: "vantar", label: "Väntar", count: antal.vantar },
                { key: "ovriga", label: "Avbrutna", count: antal.ovriga },
                { key: "alla", label: "Alla", count: antal.alla },
              ]}
            />
          </div>
          {pdfFel && <div className="formfield__error">{pdfFel}</div>}
          {avtalLista.length === 0 ? (
            <p className="formfield__help">
              {avtal!.length === 0
                ? "Inga avtal ännu. När en säljare skickar ett avtal med Scrive i D2D-vyn hamnar det här."
                : "Inga avtal i det här urvalet."}
            </p>
          ) : (
            <div className="rtable-scroll">
              <table className="rtable utf__tabell">
                <thead>
                  <tr><th>Kund</th><th>Adress</th><th>Tjänster</th><th>Per månad</th><th>Säljare</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {avtalLista.map((a) => (
                    <tr key={a.id} className="rtable__row rtable__row--click" onClick={() => onOpenRecord(a.lagenhetId)}>
                      <td data-label="Kund" className="rtable__title">
                        <span>{a.kundNamn ?? "–"}<small className="utf__sub"> {datum(a.signerad ?? a.skapad)}</small></span>
                      </td>
                      <td data-label="Adress">
                        <span>{[a.adress && titel(a.adress), a.lgh && `lgh ${a.lgh}`].filter(Boolean).join(", ") || "–"}
                          <small className="utf__sub"> {[a.fastighet, titel(a.ort), a.projekt].filter(Boolean).join(" · ")}</small></span>
                      </td>
                      <td data-label="Tjänster"><span>{a.tjanster.join(", ") || "–"}</span></td>
                      <td data-label="Per månad" className="utf__num">{kr(a.manadSumma)}</td>
                      <td data-label="Säljare">{a.saljare ?? "–"}</td>
                      <td data-label="Status">
                        <span className={`d2d-scrive__status d2d-scrive__status--${a.status}`}>{STATUS[a.status]}</span>
                        {a.leverans === "skickat" && a.status === "vantar" && <small className="utf__sub"> skickat till kunden</small>}
                        {a.leverans === "manuell" && <small className="utf__sub"> gjort i Scrive</small>}
                      </td>
                      <td data-label="">
                        {a.harPdf && (
                          <button type="button" className="btn btn--ghost btn--sm"
                            onClick={(e) => { e.stopPropagation(); void oppnaPdf(a); }}>
                            PDF
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>)}

      {laddat && flik === "salda" && (<>
        <div className="d2davt__tal">
          <div className="card"><b>{saldUrval.length}</b><span>sålda</span></div>
          <div className="card"><b>{kr(saldManad)}</b><span>per månad (kampanj)</span></div>
          <div className="card"><b>{kr(saldUrval.reduce((s, r) => s + r.engangSumma, 0))}</b><span>engångskostnader</span></div>
        </div>

        <section className="card utf__sek">
          <div className="utf__sekhuvud"><h2>Sålda i D2D</h2></div>
          {saldUrval.length === 0 ? (
            <p className="formfield__help">Inga sålda i det här urvalet.</p>
          ) : (
            <div className="rtable-scroll">
              <table className="rtable utf__tabell">
                <thead>
                  <tr><th>Kund</th><th>Adress</th><th>Tjänster</th><th>Per månad</th><th>Säljare</th></tr>
                </thead>
                <tbody>
                  {saldUrval.map((s) => (
                    <tr key={s.id} className="rtable__row rtable__row--click" onClick={() => onOpenRecord(s.id)}>
                      <td data-label="Kund" className="rtable__title">
                        <span>{s.kundNamn ?? "–"}<small className="utf__sub"> {datum(s.datum)}</small></span>
                      </td>
                      <td data-label="Adress">
                        <span>{[s.adress && titel(s.adress), s.lgh && `lgh ${s.lgh}`].filter(Boolean).join(", ") || "–"}
                          <small className="utf__sub"> {[s.fastighet, titel(s.ort), s.projekt].filter(Boolean).join(" · ")}</small></span>
                      </td>
                      <td data-label="Tjänster"><span>{s.tjanster.join(", ") || "Ingen tjänst ifylld"}</span></td>
                      <td data-label="Per månad" className="utf__num">{s.tjanster.length ? kr(s.manadSumma) : "–"}</td>
                      <td data-label="Säljare">{s.saljare ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>)}

      {laddat && flik === "totalt" && (<>
        <div className="d2davt__tal d2davt__tal--fyra">
          <div className="card"><b>{saldUrval.length + signerade.length}</b><span>avtal totalt</span></div>
          <div className="card"><b>{kr(saldManad + scriveManad)}</b><span>per månad totalt</span></div>
          <div className="card"><b>{saldUrval.length}</b><span>sålda · {kr(saldManad)}/mån</span></div>
          <div className="card"><b>{signerade.length}</b><span>Scrive signerade · {kr(scriveManad)}/mån</span></div>
        </div>

        <section className="card utf__sek">
          <div className="utf__sekhuvud"><h2>Per säljare</h2></div>
          <p className="utf__ingress">Sålda i D2D och signerade Scrive-avtal. Summorna är kampanjpris per månad enligt prislistan.{antal.vantar > 0 ? ` ${antal.vantar} Scrive-avtal väntar fortfarande på signatur och räknas inte.` : ""}</p>
          {perSaljare.length === 0 ? (
            <p className="formfield__help">Inget i det här urvalet.</p>
          ) : (
            <div className="rtable-scroll">
              <table className="rtable utf__tabell">
                <thead>
                  <tr><th>Säljare</th><th>Sålda</th><th>Scrive</th><th>Totalt</th><th>Per månad</th></tr>
                </thead>
                <tbody>
                  {perSaljare.map((r) => (
                    <tr key={r.saljare} className="rtable__row">
                      <td data-label="Säljare" className="rtable__title">{r.saljare}</td>
                      <td data-label="Sålda" className="utf__num">{r.salda}<small className="utf__sub"> {kr(r.saldKr)}</small></td>
                      <td data-label="Scrive" className="utf__num">{r.scrive}<small className="utf__sub"> {kr(r.scriveKr)}</small></td>
                      <td data-label="Totalt" className="utf__num"><b>{r.salda + r.scrive}</b></td>
                      <td data-label="Per månad" className="utf__num"><b>{kr(r.saldKr + r.scriveKr)}</b></td>
                    </tr>
                  ))}
                  <tr className="rtable__row d2davt__summa">
                    <td data-label="Säljare" className="rtable__title">Summa</td>
                    <td data-label="Sålda" className="utf__num">{saldUrval.length}<small className="utf__sub"> {kr(saldManad)}</small></td>
                    <td data-label="Scrive" className="utf__num">{signerade.length}<small className="utf__sub"> {kr(scriveManad)}</small></td>
                    <td data-label="Totalt" className="utf__num"><b>{saldUrval.length + signerade.length}</b></td>
                    <td data-label="Per månad" className="utf__num"><b>{kr(saldManad + scriveManad)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      </>)}
    </div>
  );
}
