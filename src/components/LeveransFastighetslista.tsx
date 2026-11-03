import "@/styles/leverans.css";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { updateRecord, DataError, type RecordFilter } from "@/lib/data";

/**
 * Leveransöversikten → "Alla fastigheter": en rad per fastighet i projektplanen
 * med Koncernmoder, direktägande bolag, ort, fastighet, hushåll, FS/SC-portar,
 * FBL, Kundklar (CE-datum redigerbart, Telias datum under), Telias status,
 * vad som ska levereras, befintlig KO/koax/kabel-TV, LPL, entreprenör
 * (projektledare) och TeliaNow (CS).
 * Data: RPC:n leverans_fastighetslista (samma behörighet, sök och filter som listan).
 */

export type FastighetRad = {
  id: string;
  status: string | null;
  kund_id: string | null;
  kund: string | null;
  kund_kopplad: boolean;
  bolag: string | null;
  ort: string | null;
  fastighet: string | null;
  adress: string | null;
  hushall: number | string | null;
  fs_portar: number | string | null;
  sc_portar: number | string | null;
  fbl: string | null;
  kundklar: string | null;
  kundklar_ce: string | null;
  telia_status: string | null;
  leverans: string | null;
  bef_ko: string | null;
  avtalstid_ko: string | null;
  bef_koax: string | null;
  ktv_avtal: string | null;
  lpl: string | null;
  entreprenor: string | null;
  projektledare: string | null;
  telianow_cs: string | null;
};

export async function hamtaFastighetslista(search: string | undefined, filters: RecordFilter[]): Promise<FastighetRad[]> {
  const { data, error } = await supabase.rpc("leverans_fastighetslista" as never, {
    p_search: search ?? null,
    p_filters: filters,
  } as never);
  if (error) throw new Error("Kunde inte hämta fastigheterna.");
  return (data as unknown as FastighetRad[]) ?? [];
}

const datumFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });
function datum(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  return Number.isNaN(d.getTime()) ? s : datumFmt.format(d);
}
function tal(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
const tom = <span className="lev-fl__tom">–</span>;

type Kol = {
  key: string;
  label: string;
  /** Värde att sortera på. */
  sort: (r: FastighetRad) => string | number | null;
  num?: boolean;
};

const KOLUMNER: Kol[] = [
  { key: "kund", label: "Koncernmoder", sort: (r) => r.kund },
  { key: "bolag", label: "Direktägande bolag", sort: (r) => r.bolag },
  { key: "ort", label: "Ort", sort: (r) => r.ort },
  { key: "fastighet", label: "Fastighet", sort: (r) => r.fastighet },
  { key: "hushall", label: "Hushåll", sort: (r) => tal(r.hushall), num: true },
  { key: "fs", label: "FS-portar", sort: (r) => tal(r.fs_portar), num: true },
  { key: "sc", label: "SC", sort: (r) => tal(r.sc_portar), num: true },
  { key: "fbl", label: "FBL", sort: (r) => r.fbl },
  { key: "kundklar", label: "Kundklar", sort: (r) => r.kundklar_ce ?? r.kundklar },
  { key: "telia", label: "Status Telia", sort: (r) => r.telia_status },
  { key: "leverans", label: "Ska levereras", sort: (r) => r.leverans },
  { key: "ko", label: "Befintlig KO", sort: (r) => r.bef_ko },
  { key: "koax", label: "Befintlig koax", sort: (r) => r.bef_koax },
  { key: "ktv", label: "Befintlig kabel-TV", sort: (r) => r.ktv_avtal },
  { key: "lpl", label: "LPL", sort: (r) => r.lpl },
  { key: "entr", label: "Entreprenör (projektledare)", sort: (r) => r.entreprenor },
  { key: "cs", label: "TeliaNow (CS)", sort: (r) => r.telianow_cs },
];

const jamfor = new Intl.Collator("sv", { numeric: true, sensitivity: "base" });

export function LeveransFastighetslista({
  rader, loading, onOpen, onKundklarSparad, kanAndra,
}: {
  rader: FastighetRad[];
  loading: boolean;
  onOpen: (id: string) => void;
  /** Anropas efter att Kundklar CE sparats (raden uppdateras lokalt). */
  onKundklarSparad: (id: string, varde: string | null) => void;
  kanAndra: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [sparar, setSparar] = useState<string | null>(null);

  const sorterade = useMemo(() => {
    if (!sort) return rader;
    const kol = KOLUMNER.find((k) => k.key === sort.key);
    if (!kol) return rader;
    return [...rader].sort((a, b) => {
      const va = kol.sort(a), vb = kol.sort(b);
      // Tomma värden alltid sist.
      if (va === null || va === "") return vb === null || vb === "" ? 0 : 1;
      if (vb === null || vb === "") return -1;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : jamfor.compare(String(va), String(vb));
      return c * sort.dir;
    });
  }, [rader, sort]);

  const summa = useMemo(() => {
    let hushall = 0, fs = 0, sc = 0;
    for (const r of rader) { hushall += tal(r.hushall) ?? 0; fs += tal(r.fs_portar) ?? 0; sc += tal(r.sc_portar) ?? 0; }
    return { hushall, fs, sc };
  }, [rader]);

  function vandSort(key: string) {
    setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null));
  }

  async function sparaKundklar(r: FastighetRad, varde: string) {
    const nytt = varde || null;
    if (nytt === (r.kundklar_ce ?? null)) return;
    setSparar(r.id);
    try {
      await updateRecord(r.id, { kundklar_ce: nytt });
      onKundklarSparad(r.id, nytt);
    } catch (e) {
      alert(e instanceof DataError ? e.message : "Kunde inte spara kundklardatum.");
    } finally {
      setSparar(null);
    }
  }

  const tf = new Intl.NumberFormat("sv-SE");

  return (
    <div className={"card lev-fl" + (loading ? " is-loading" : "")}>
      <div className="lev-fl__summa">
        <span><b>{tf.format(rader.length)}</b> fastigheter</span>
        <span><b>{tf.format(summa.hushall)}</b> hushåll</span>
        <span><b>{tf.format(summa.fs)}</b> FS-portar</span>
        <span><b>{tf.format(summa.sc)}</b> SC-portar</span>
      </div>
      <div className="lev-fl__scroll">
        <table className="lev-fl__tabell">
          <thead>
            <tr>
              {KOLUMNER.map((k) => (
                <th key={k.key} className={k.num ? "lev-fl__num" : undefined}
                  aria-sort={sort?.key === k.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  <button type="button" className="lev-fl__th" onClick={() => vandSort(k.key)}>
                    {k.label}
                    {sort?.key === k.key && <span aria-hidden>{sort.dir === 1 ? " ↑" : " ↓"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorterade.map((r) => (
              <tr key={r.id} data-row-id={r.id}>
                <td data-label="Koncernmoder" className="lev-fl__kund">
                  {r.kund ? <span className={r.kund_kopplad ? undefined : "lev-fl__okopplad"} title={r.kund_kopplad ? undefined : "Ingen Kund kopplad – fastighetsägare enligt projektplanen"}>{r.kund}</span> : tom}
                </td>
                <td data-label="Direktägande bolag">{r.bolag ?? tom}</td>
                <td data-label="Ort">{r.ort ?? tom}</td>
                <td data-label="Fastighet" className="lev-fl__fastighet"><div>
                  <button type="button" className="lev-fl__lank" onClick={() => onOpen(r.id)}>{r.fastighet ?? "Utan beteckning"}</button>
                  {r.adress && <span className="lev-fl__under">{r.adress}</span>}
                </div></td>
                <td data-label="Hushåll" className="lev-fl__num">{tal(r.hushall) ?? tom}</td>
                <td data-label="FS-portar" className="lev-fl__num">{tal(r.fs_portar) ?? tom}</td>
                <td data-label="SC" className="lev-fl__num">{tal(r.sc_portar) ?? tom}</td>
                <td data-label="FBL" className="lev-fl__datum">{datum(r.fbl) ?? tom}</td>
                <td data-label="Kundklar" className="lev-fl__kundklar"><div>
                  {kanAndra ? (
                    <input
                      type="date"
                      className="input input--sm lev-fl__datuminput"
                      defaultValue={r.kundklar_ce ?? ""}
                      key={(r.kundklar_ce ?? "") + r.id}
                      disabled={sparar === r.id}
                      aria-label={`Kundklar CE för ${r.fastighet ?? "fastigheten"}`}
                      onBlur={(e) => void sparaKundklar(r, e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    />
                  ) : (datum(r.kundklar_ce) ?? (r.kundklar ? null : tom))}
                  {r.kundklar && (
                    <span className={"lev-fl__under" + (r.kundklar_ce && r.kundklar_ce !== r.kundklar ? " lev-fl__avvik" : "")}>
                      Telia: {datum(r.kundklar)}
                    </span>
                  )}
                </div></td>
                <td data-label="Status Telia">{r.telia_status ? <span className="lev-fl__status">{r.telia_status}</span> : tom}</td>
                <td data-label="Ska levereras">{r.leverans ?? tom}</td>
                <td data-label="Befintlig KO"><div>
                  {r.bef_ko ?? (r.avtalstid_ko ? null : tom)}
                  {r.avtalstid_ko && <span className="lev-fl__under">Avtal t.o.m. {datum(r.avtalstid_ko)}</span>}
                </div></td>
                <td data-label="Befintlig koax">{r.bef_koax ?? tom}</td>
                <td data-label="Befintlig kabel-TV">
                  {r.ktv_avtal ? <div>Avtal t.o.m. {datum(r.ktv_avtal)}</div> : tom}
                </td>
                <td data-label="LPL">{r.lpl ?? tom}</td>
                <td data-label="Entreprenör (projektledare)">
                  {r.entreprenor || r.projektledare
                    ? <div>{r.entreprenor ?? "–"}{r.projektledare && <span className="lev-fl__pl"> ({r.projektledare})</span>}</div>
                    : tom}
                </td>
                <td data-label="TeliaNow (CS)" className="lev-fl__cs">{r.telianow_cs ?? tom}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
