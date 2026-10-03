import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/data";

/**
 * Lägenheter enligt Telias adresslista (bladet Adresser i projektplanen),
 * kopplade till leveransen, koncernmodern eller det direktägda bolaget.
 * Grupperas per fastighet; varje fastighet kan fällas ut.
 */
type Lgh = {
  objektnummer: string; gata: string | null; gatunummer: string | null; ingang: string | null;
  lgh: string | null; postnummer: string | null; ort: string | null; fastighet: string | null;
  kategori: string | null; status: string | null; operator: string | null; telia_bb: boolean | null;
};

const STATUS: Record<string, string> = { Active: "Aktiv", DuringDeployment: "Under utbyggnad", Inactive: "Inaktiv" };
const KATEGORI: Record<string, string> = { MDU: "Lägenhet", SDU: "Småhus", FS: "Lokal", FTG: "Fastighetens" };

export function TeliaLagenheterTab({ recordId }: { recordId: string }) {
  const [rader, setRader] = useState<Lgh[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [sok, setSok] = useState("");

  useEffect(() => {
    let avbruten = false;
    setRader(null); setFel(null);
    supabase.rpc("telia_lagenheter_for", { p_record_id: recordId }).then(({ data, error }) => {
      if (avbruten) return;
      if (error) setFel(error.message); else setRader((data ?? []) as Lgh[]);
    });
    return () => { avbruten = true; };
  }, [recordId]);

  const filtrerade = useMemo(() => {
    if (!rader) return [];
    const q = sok.trim().toLowerCase();
    if (!q) return rader;
    return rader.filter((r) =>
      [r.fastighet, r.gata, r.gatunummer, r.lgh, r.ort, r.postnummer, r.operator]
        .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rader, sok]);

  const grupper = useMemo(() => {
    const m = new Map<string, Lgh[]>();
    for (const r of filtrerade) {
      const k = r.fastighet ?? "Utan fastighetsbeteckning";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()];
  }, [filtrerade]);

  if (fel) return <div className="formfield__error">Kunde inte hämta lägenheterna: {fel}</div>;
  if (!rader) return <div className="d2d-loading">Hämtar lägenheter…</div>;
  if (rader.length === 0) {
    return (
      <div className="tlgh__tom">
        Inga lägenheter i Telias adresslista är kopplade hit. Kopplingen görs på fastighetsbeteckning
        och ort, A-/KO-nr eller nätägarens namn vid varje import.
      </div>
    );
  }

  const bostader = rader.filter((r) => r.kategori === "MDU" || r.kategori === "SDU");
  const aktiva = rader.filter((r) => r.status === "Active").length;
  const utbyggnad = rader.filter((r) => r.status === "DuringDeployment").length;
  const teliaBb = rader.filter((r) => r.telia_bb).length;

  return (
    <div className="tlgh">
      <div className="tlgh__tal">
        <div><b>{rader.length}</b><span>anslutningar</span></div>
        <div><b>{bostader.length}</b><span>bostäder</span></div>
        <div><b>{aktiva}</b><span>aktiva</span></div>
        <div><b>{utbyggnad}</b><span>under utbyggnad</span></div>
        <div><b>{teliaBb}</b><span>har Telia Bredband</span></div>
      </div>

      <input
        className="input tlgh__sok" placeholder="Sök gata, lägenhet, fastighet…"
        value={sok} onChange={(e) => setSok(e.target.value)}
      />

      {grupper.map(([fastighet, lista]) => (
        <details key={fastighet} className="tlgh__grupp" open={grupper.length === 1}>
          <summary>
            <span className="tlgh__fastighet">{fastighet}</span>
            <span className="tlgh__antal">{lista.length} st · {lista[0]?.ort ?? ""}</span>
          </summary>
          <div className="tlgh__tabellwrap">
            <table className="tlgh__tabell">
              <thead>
                <tr><th>Adress</th><th>Lgh</th><th>Typ</th><th>Status</th><th>Operatör</th><th>Telia BB</th></tr>
              </thead>
              <tbody>
                {lista.map((r) => (
                  <tr key={r.objektnummer}>
                    <td>{[r.gata, r.gatunummer].filter(Boolean).join(" ")}{r.ingang ? ` ${r.ingang}` : ""}</td>
                    <td>{r.lgh ?? "–"}</td>
                    <td>{KATEGORI[r.kategori ?? ""] ?? r.kategori ?? "–"}</td>
                    <td>{STATUS[r.status ?? ""] ?? r.status ?? "–"}</td>
                    <td>{r.operator ?? "–"}</td>
                    <td>{r.telia_bb == null ? "–" : r.telia_bb ? "Ja" : "Nej"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      <p className="tlgh__kalla">Källa: Telias adresslista i projektplanen, uppdateras vid varje import.</p>
    </div>
  );
}
