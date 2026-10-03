import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { FilterPills, SkeletonRows } from "./PageChrome";

/* =============================================================================
   Door to door → Avtal. Alla avtal som skickats för signering med Scrive från
   D2D-vyn: signerade (med PDF), väntande och avbrutna. Signerade avtal läggs
   här automatiskt när kunden signerat med BankID.
   ========================================================================== */

type Avtal = {
  id: string; status: "skapas" | "vantar" | "signerat" | "avvisat" | "avbrutet" | "fel";
  leverans: "plats" | "skickat"; kundNamn: string | null; skapad: string; signerad: string | null;
  harPdf: boolean; fel: string | null; lagenhetId: string; adress: string | null; lgh: string | null;
  ort: string | null; fastighet: string | null; projekt: string | null; projektId: string | null;
  saljare: string | null; tjanster: string[]; manadSumma: number | null; engangSumma: number | null;
};

const STATUS: Record<Avtal["status"], string> = {
  signerat: "Signerat", vantar: "Väntar på signatur", skapas: "Skapas", avvisat: "Avvisat",
  avbrutet: "Avbrutet", fel: "Fel",
};
type Filter = "signerat" | "vantar" | "ovriga" | "alla";
type Period = "30" | "ar" | "allt";

const datum = (s: string | null) => (s ? new Date(s).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) : "–");
const kr = (n: number | null) => (n == null ? "–" : `${Math.round(n).toLocaleString("sv-SE")} kr`);
const titel = (s: string | null) => (s ? s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : "");

function periodFran(p: Period): string | null {
  const d = new Date();
  if (p === "30") { d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }
  if (p === "ar") return `${d.getFullYear()}-01-01`;
  return null;
}

export function D2DAvtalPage({ onOpenRecord }: { onOpenRecord: (id: string) => void }) {
  const [avtal, setAvtal] = useState<Avtal[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("signerat");
  const [period, setPeriod] = useState<Period>("allt");
  const [projekt, setProjekt] = useState("");
  const [sok, setSok] = useState("");
  const [pdfFel, setPdfFel] = useState<string | null>(null);

  const ladda = useCallback(async () => {
    setFel(null);
    const { data, error } = await supabase.rpc("d2d_avtal_lista", { p_fran: periodFran(period), p_till: null });
    if (error) setFel(error.message); else setAvtal((data ?? []) as Avtal[]);
  }, [period]);
  useEffect(() => { setAvtal(null); void ladda(); }, [ladda]);

  const projektLista = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of avtal ?? []) if (a.projektId) m.set(a.projektId, a.projekt ?? "Namnlöst projekt");
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "sv"));
  }, [avtal]);

  const urval = useMemo(() => (avtal ?? []).filter((a) => !projekt || a.projektId === projekt), [avtal, projekt]);
  const antal = useMemo(() => ({
    signerat: urval.filter((a) => a.status === "signerat").length,
    vantar: urval.filter((a) => a.status === "vantar" || a.status === "skapas").length,
    ovriga: urval.filter((a) => ["avvisat", "avbrutet", "fel"].includes(a.status)).length,
    alla: urval.length,
  }), [urval]);

  const lista = useMemo(() => {
    const q = sok.trim().toLowerCase();
    return urval.filter((a) => {
      if (filter === "signerat" && a.status !== "signerat") return false;
      if (filter === "vantar" && a.status !== "vantar" && a.status !== "skapas") return false;
      if (filter === "ovriga" && !["avvisat", "avbrutet", "fel"].includes(a.status)) return false;
      if (!q) return true;
      return [a.kundNamn, a.adress, a.lgh, a.ort, a.fastighet, a.projekt, a.saljare]
        .some((v) => (v ?? "").toLowerCase().includes(q));
    });
  }, [urval, filter, sok]);

  const manadTotal = useMemo(() => urval.filter((a) => a.status === "signerat")
    .reduce((s, a) => s + (a.manadSumma ?? 0), 0), [urval]);

  async function oppnaPdf(a: Avtal) {
    setPdfFel(null);
    const flik = window.open("", "_blank");   // öppnas direkt vid klicket (popup-skydd på mobilen)
    const { data, error } = await supabase.functions.invoke("scrive-sign", { body: { action: "pdf", avtalId: a.id } });
    const url = (data as { url?: string } | null)?.url;
    if (error || !url) { flik?.close(); setPdfFel("Kunde inte hämta avtalet."); return; }
    if (flik) flik.location.href = url; else window.location.href = url;
  }

  return (
    <div className="page utf d2davt">
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
        <input className="input input--sm d2davt__sok" placeholder="Sök kund, adress, säljare…" value={sok} onChange={(e) => setSok(e.target.value)} />
      </div>

      {fel && <div className="formfield__error">{fel}</div>}
      {!avtal && !fel && <div className="card"><SkeletonRows rows={6} /></div>}

      {avtal && (<>
        <div className="d2davt__tal">
          <div className="card"><b>{antal.signerat}</b><span>signerade</span></div>
          <div className="card"><b>{antal.vantar}</b><span>väntar på signatur</span></div>
          <div className="card"><b>{kr(manadTotal)}</b><span>per månad, signerade</span></div>
        </div>

        <section className="card utf__sek">
          <div className="utf__sekhuvud">
            <h2>Avtal</h2>
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
          {lista.length === 0 ? (
            <p className="formfield__help">
              {avtal.length === 0
                ? "Inga avtal ännu. När en säljare signerar med Scrive i D2D-vyn hamnar avtalet här."
                : "Inga avtal i det här urvalet."}
            </p>
          ) : (
            <div className="rtable-scroll">
              <table className="rtable utf__tabell">
                <thead>
                  <tr><th>Kund</th><th>Adress</th><th>Tjänster</th><th>Per månad</th><th>Säljare</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {lista.map((a) => (
                    <tr key={a.id} className="rtable__row rtable__row--click" onClick={() => onOpenRecord(a.lagenhetId)}>
                      <td data-label="Kund" className="rtable__title">
                        <span>{a.kundNamn ?? "–"}<small className="utf__sub"> {datum(a.signerad ?? a.skapad)}</small></span>
                      </td>
                      <td data-label="Adress">
                        <span>{[a.adress && titel(a.adress), a.lgh && `lgh ${a.lgh}`].filter(Boolean).join(", ") || "–"}
                          <small className="utf__sub"> {[a.fastighet, titel(a.ort), a.projekt].filter(Boolean).join(" · ")}</small></span>
                      </td>
                      <td data-label="Tjänster"><span>{a.tjanster.join(", ") || "–"}</span></td>
                      <td data-label="Per månad">{kr(a.manadSumma)}</td>
                      <td data-label="Säljare">{a.saljare ?? "–"}</td>
                      <td data-label="Status">
                        <span className={`d2d-scrive__status d2d-scrive__status--${a.status}`}>{STATUS[a.status]}</span>
                        {a.leverans === "skickat" && a.status === "vantar" && <small className="utf__sub"> skickat till kunden</small>}
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
    </div>
  );
}
