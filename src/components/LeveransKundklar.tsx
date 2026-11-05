import "@/styles/leverans.css";
import { useRef, useState } from "react";
import { updateRecord } from "@/lib/data";
import { lasXlsx } from "@/lib/xlsx";
import { laddaNed, skrivXlsx, type Cell } from "@/lib/xlsxSkriv";
import type { FastighetRad } from "./LeveransFastighetslista";

/**
 * Exportera/Importera i Leveransöversikten (Gustav 5 nov): filen har bara
 * Koncernmoder, Direktägande bolag, Fastighet och Kundklar, och samma fil går att
 * läsa in igen. Kundklar i filen är det datum som visas (CE:s Kundklar CE, annars
 * Telias). Vid import sparas ändrade datum i kundklar_ce (som projektplan-importen
 * aldrig rör); fastigheten hittas på Fastighet, och vid dubbletter även på
 * Koncernmoder och Direktägande bolag. Tomma datum i filen ändrar ingenting.
 */

export const KUNDKLAR_KOLUMNER = ["Koncernmoder", "Direktägande bolag", "Fastighet", "Kundklar"] as const;

const kundklarFor = (r: FastighetRad) => r.kundklar_ce || r.kundklar || "";
const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** "2026-11-20", "20/11/2026", "20.11.2026", "2026-11-20 00:00", Excel-serienummer → "2026-11-20". */
export function tolkaDatum(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let t = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (t) { y = +t[1]; m = +t[2]; d = +t[3]; }
  else if ((t = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/))) { d = +t[1]; m = +t[2]; y = +t[3]; }
  else if ((t = s.match(/^(\d{8})$/))) { y = +s.slice(0, 4); m = +s.slice(4, 6); d = +s.slice(6, 8); }
  else if (/^\d{5}(\.\d+)?$/.test(s)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 86400000);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function exporteraKundklar(rader: FastighetRad[], namn = "Leveransöversikt") {
  const data: Cell[][] = [[...KUNDKLAR_KOLUMNER]];
  rader.forEach((r) => data.push([r.kund ?? "", r.bolag ?? "", r.fastighet ?? "", kundklarFor(r)]));
  const stamp = new Date().toISOString().slice(0, 10);
  laddaNed(skrivXlsx([{ namn: "Kundklar", rader: data, bredd: [36, 36, 26, 14] }]), `${namn} kundklar ${stamp}.xlsx`);
}

type Andring = { rad: FastighetRad; fore: string; ny: string };
type Resultat = {
  andringar: Andring[];
  oforandrade: number;
  tomma: number;
  hittasInte: string[];
  flera: string[];
  ogiltiga: string[];
};

function hittaRader(alla: FastighetRad[], filRader: string[][]): Resultat | string {
  const rubrik = (filRader[0] ?? []).map((h) => norm(String(h ?? "")));
  const kol = (namn: string) => rubrik.indexOf(norm(namn));
  const iF = kol("Fastighet"), iK = kol("Kundklar"), iKm = kol("Koncernmoder"), iB = kol("Direktägande bolag");
  if (iF < 0 || iK < 0) return "Filen saknar kolumnerna Fastighet och Kundklar. Använd en fil från Exportera.";

  const perFastighet = new Map<string, FastighetRad[]>();
  alla.forEach((r) => {
    const k = norm(r.fastighet);
    if (!k) return;
    if (!perFastighet.has(k)) perFastighet.set(k, []);
    perFastighet.get(k)!.push(r);
  });

  const res: Resultat = { andringar: [], oforandrade: 0, tomma: 0, hittasInte: [], flera: [], ogiltiga: [] };
  const sedda = new Set<string>();
  for (const rad of filRader.slice(1)) {
    const cell = (i: number) => (i >= 0 ? String(rad?.[i] ?? "").trim() : "");
    const fast = cell(iF);
    if (!fast) continue;
    let kand = perFastighet.get(norm(fast)) ?? [];
    if (kand.length > 1 && iKm >= 0) { const f = kand.filter((r) => norm(r.kund) === norm(cell(iKm))); if (f.length) kand = f; }
    if (kand.length > 1 && iB >= 0) { const f = kand.filter((r) => norm(r.bolag) === norm(cell(iB))); if (f.length) kand = f; }
    if (!kand.length) { res.hittasInte.push(fast); continue; }
    if (kand.length > 1) { res.flera.push(fast); continue; }
    const r = kand[0];
    if (sedda.has(r.id)) continue;
    sedda.add(r.id);
    const ratt = cell(iK);
    if (!ratt) { res.tomma++; continue; }
    const ny = tolkaDatum(ratt);
    if (!ny) { res.ogiltiga.push(`${fast} (${ratt})`); continue; }
    const fore = kundklarFor(r);
    if (fore === ny) { res.oforandrade++; continue; }
    res.andringar.push({ rad: r, fore, ny });
  }
  return res;
}

export function LeveransKundklarKnappar({ rader, alla, kanAndra, onRadAndrad, namn }: {
  /** Raderna som exporteras (som de visas). */
  rader: FastighetRad[];
  /** Raderna som en import får matcha mot (alla som är laddade). */
  alla: FastighetRad[];
  kanAndra: boolean;
  onRadAndrad: (id: string, andring: Partial<FastighetRad>) => void;
  namn?: string;
}) {
  const filRef = useRef<HTMLInputElement>(null);
  const [res, setRes] = useState<Resultat | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [sparar, setSparar] = useState<{ klara: number; fel: number } | null>(null);
  const [klar, setKlar] = useState<{ sparade: number; fel: number } | null>(null);

  async function lasFil(fil: File) {
    setFel(null); setKlar(null); setRes(null);
    try {
      let filRader: string[][];
      if (/\.csv$/i.test(fil.name)) {
        const text = (await fil.text()).replace(/^\uFEFF/, "");
        const sep = (text.split("\n")[0].match(/;/g)?.length ?? 0) >= (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
        filRader = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"')));
      } else {
        filRader = (await lasXlsx(fil)).rader.map((r) => Array.from(r ?? [], (c) => String(c ?? "")));
      }
      const r = hittaRader(alla, filRader);
      if (typeof r === "string") setFel(r); else setRes(r);
    } catch {
      setFel("Filen gick inte att läsa. Använd en Excel-fil (.xlsx) från Exportera.");
    }
  }

  async function spara() {
    if (!res) return;
    let klara = 0, felN = 0;
    setSparar({ klara, fel: felN });
    const lista = res.andringar;
    for (let i = 0; i < lista.length; i += 6) {
      await Promise.all(lista.slice(i, i + 6).map(async (a) => {
        try {
          await updateRecord(a.rad.id, { kundklar_ce: a.ny });
          onRadAndrad(a.rad.id, { kundklar_ce: a.ny });
          klara++;
        } catch { felN++; }
      }));
      setSparar({ klara, fel: felN });
    }
    setSparar(null);
    setRes(null);
    setKlar({ sparade: klara, fel: felN });
  }

  const tf = new Intl.NumberFormat("sv-SE");
  const stang = () => { if (!sparar) { setRes(null); setFel(null); setKlar(null); } };
  const visa = res || fel || klar;

  return (
    <>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => exporteraKundklar(rader, namn)} disabled={!rader.length}
        title="Koncernmoder, direktägande bolag, fastighet och kundklar – filen kan läsas in igen med Importera">
        Exportera ({tf.format(rader.length)})
      </button>
      {kanAndra && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => filRef.current?.click()} title="Läs in kundklardatum från en exporterad fil">
          Importera
        </button>
      )}
      <input ref={filRef} type="file" hidden accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void lasFil(f); }} />

      {visa && (
        <div className="lev-avi" role="dialog" aria-modal="true" aria-label="Importera kundklar" onMouseDown={(e) => { if (e.target === e.currentTarget) stang(); }}>
          <div className="lev-avi__ruta lev-kki">
            <header className="lev-avi__huvud">
              <div>
                <h2>Importera kundklar</h2>
                <p className="lev-avi__tips">Ändrade datum sparas i Kundklar CE. Projektplan-importen rör aldrig det fältet.</p>
              </div>
              <button type="button" className="close-btn" aria-label="Stäng" onClick={stang} disabled={!!sparar}>×</button>
            </header>
            <div className="lev-avi__kropp">
              {fel && <p className="lev-avi__fel">{fel}</p>}
              {klar && (
                <p>
                  <b>{tf.format(klar.sparade)}</b> kundklardatum sparades.
                  {klar.fel > 0 && <span className="lev-avi__fel"> {tf.format(klar.fel)} gick inte att spara – försök igen.</span>}
                </p>
              )}
              {res && (
                <>
                  <ul className="lev-kki__summa">
                    <li><b>{tf.format(res.andringar.length)}</b> får nytt datum</li>
                    <li><b>{tf.format(res.oforandrade)}</b> oförändrade</li>
                    {res.tomma > 0 && <li><b>{tf.format(res.tomma)}</b> utan datum i filen (ändras inte)</li>}
                    {res.hittasInte.length > 0 && <li className="is-varning"><b>{tf.format(res.hittasInte.length)}</b> hittades inte</li>}
                    {res.flera.length > 0 && <li className="is-varning"><b>{tf.format(res.flera.length)}</b> matchar flera fastigheter</li>}
                    {res.ogiltiga.length > 0 && <li className="is-varning"><b>{tf.format(res.ogiltiga.length)}</b> ogiltigt datum</li>}
                  </ul>
                  {res.andringar.length > 0 && (
                    <div className="lev-kki__tabell">
                      <table>
                        <thead><tr><th>Fastighet</th><th>Koncernmoder</th><th>Nu</th><th>Nytt</th></tr></thead>
                        <tbody>
                          {res.andringar.slice(0, 300).map((a) => (
                            <tr key={a.rad.id}><td>{a.rad.fastighet}</td><td>{a.rad.kund}</td><td>{a.fore || "–"}</td><td><b>{a.ny}</b></td></tr>
                          ))}
                        </tbody>
                      </table>
                      {res.andringar.length > 300 && <p className="lev-avi__tips">Visar 300 av {tf.format(res.andringar.length)}.</p>}
                    </div>
                  )}
                  {[["Hittades inte", res.hittasInte], ["Matchar flera fastigheter", res.flera], ["Ogiltigt datum", res.ogiltiga]].map(([t, l]) =>
                    (l as string[]).length > 0 && (
                      <p key={t as string} className="lev-avi__varning"><b>{t as string}:</b> {(l as string[]).slice(0, 12).join(", ")}{(l as string[]).length > 12 ? ` +${(l as string[]).length - 12}` : ""}</p>
                    ))}
                </>
              )}
              <footer className="lev-avi__fot">
                <span>{sparar ? `Sparar… ${tf.format(sparar.klara)}/${tf.format(res?.andringar.length ?? 0)}` : ""}</span>
                <button type="button" className="btn btn--ghost" onClick={stang} disabled={!!sparar}>{res ? "Avbryt" : "Stäng"}</button>
                {res && (
                  <button type="button" className="btn btn--brand" disabled={!res.andringar.length || !!sparar} onClick={() => void spara()}>
                    Spara {tf.format(res.andringar.length)} ändringar
                  </button>
                )}
              </footer>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
