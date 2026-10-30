import { useEffect, useState } from "react";
import { supabase } from "@/lib/data";
import { navigate, readRoute } from "@/lib/route";

/**
 * Telias penetration (filen "ConnectEstate penetration ÅÅMMDD.xlsx", importeras under
 * Inställningar → Import). Visas som flik på koncernmodern och D2D-projektet och som
 * avsnitt i D2D Utfall: HC-viktad summering överst och en rad per fastighet under.
 * Allt räknas i databasen (penetration_for_post).
 */
export type PenSumma = {
  fastigheter: number; hc: number; matdatum: string | null;
  bb_telia: number | null; bb_tot: number | null; iptv_telia: number | null; iptv_tot: number | null;
};
export type PenRad = PenSumma & {
  fastighet: string; koncernmoder: string | null;
  delivery_id: string | null; property_id: string | null; d2d_fastighet_id: string | null;
  avtal: Array<{ avtalsnummer: string | null; typ: string | null; kollektiv_iptv: string | null; kollektiv_bb: string | null; hc: number | null }> | null;
};
export type PenSvar = { summa: PenSumma | null; rader: PenRad[] };

/** De fyra måtten, likvärdiga (Gustavs val). */
export const PEN_MATT: Array<[keyof PenSumma, string, string]> = [
  ["bb_telia", "BB Telia", "Bredband Telia"], ["bb_tot", "BB totalt", "Bredband totalt (alla operatörer)"],
  ["iptv_telia", "IPTV Telia", "TV Telia"], ["iptv_tot", "IPTV totalt", "TV totalt (alla operatörer)"],
];

export const pctStr = (v: number | null | undefined) =>
  v == null ? "–" : `${Number(v).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} %`;
export const datumStr = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) : null;

/** Summeringsrutor: hushåll + de fyra måtten. */
export function PenTiles({ s, small }: { s: PenSumma; small?: boolean }) {
  return (
    <div className={`pen__tiles${small ? " pen__tiles--small" : ""}`}>
      <div className="pen__tile"><b>{s.hc.toLocaleString("sv-SE")}</b><span>hushåll (HC)</span></div>
      {PEN_MATT.map(([k, lbl, titel]) => (
        <div key={k} className={`pen__tile${s[k] == null ? " pen__tile--tom" : ""}`} title={titel}>
          <b>{pctStr(s[k] as number | null)}</b><span>{lbl}</span>
        </div>
      ))}
    </div>
  );
}

/** Tabell med en rad per fastighet. Klick öppnar leveransen (eller fastigheten). */
export function PenTabell({ rader, medKoncern }: { rader: PenRad[]; medKoncern?: boolean }) {
  const oppna = (r: PenRad) => {
    const id = r.delivery_id ?? r.d2d_fastighet_id ?? r.property_id;
    if (id) navigate(readRoute().segs, { post: id });
  };
  return (
    <div className="rtable-scroll">
      <table className="rtable pen__tabell">
        <thead>
          <tr>
            <th>Fastighet</th>{medKoncern && <th>Koncernmoder</th>}<th className="pen__num">HC</th>
            {PEN_MATT.map(([k, lbl, titel]) => <th key={k} className="pen__num" title={titel}>{lbl}</th>)}
            <th>Avtal</th>
          </tr>
        </thead>
        <tbody>
          {rader.map((r) => (
            <tr key={r.fastighet} className={`rtable__row${r.delivery_id || r.d2d_fastighet_id || r.property_id ? " rtable__row--click" : ""}`}
              onClick={() => oppna(r)}>
              <td data-label="Fastighet" className="rtable__title">{r.fastighet}</td>
              {medKoncern && <td data-label="Koncernmoder">{r.koncernmoder ?? <span className="pen__sub">–</span>}</td>}
              <td data-label="HC" className="pen__num">{r.hc?.toLocaleString("sv-SE") ?? "–"}</td>
              {PEN_MATT.map(([k, lbl]) => <td key={k} data-label={lbl} className="pen__num">{pctStr(r[k] as number | null)}</td>)}
              <td data-label="Avtal" className="pen__avtal">
                {(r.avtal ?? []).map((a, i) => (
                  <span key={i} className="pen__chip" title={[a.typ, a.kollektiv_bb && `Kollektivt BB: ${a.kollektiv_bb}`, a.kollektiv_iptv && `Kollektiv TV: ${a.kollektiv_iptv}`].filter(Boolean).join(" · ")}>
                    {a.avtalsnummer ?? "–"}{a.typ ? <small> {a.typ.replace(/ ComOp$/, "")}</small> : null}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function usePenetration(recordId: string | null) {
  const [svar, setSvar] = useState<PenSvar | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  useEffect(() => {
    let avbruten = false;
    setSvar(null); setFel(null);
    if (!recordId) return;
    supabase.rpc("penetration_for_post", { p_id: recordId }).then(({ data, error }) => {
      if (avbruten) return;
      if (error) setFel(error.message); else setSvar(data as PenSvar);
    });
    return () => { avbruten = true; };
  }, [recordId]);
  return { svar, fel };
}

/** Fliken Penetration på koncernmodern och D2D-projektet. */
export function PenetrationTab({ recordId }: { recordId: string }) {
  const { svar, fel } = usePenetration(recordId);
  if (fel) return <div className="formfield__error">Kunde inte hämta penetrationen: {fel}</div>;
  if (!svar) return <div className="d2d-loading">Hämtar penetration…</div>;
  const s = svar.summa;
  if (!s || s.fastigheter === 0) {
    return (
      <div className="tlgh__tom">
        Ingen penetration från Telia är kopplad hit. Filen läses in under Inställningar → Import och
        matchas på kommun + fastighetsbeteckning mot leveranser, fastigheter och D2D-fastigheter.
      </div>
    );
  }
  return (
    <div className="pen">
      <PenTiles s={s} />
      <p className="pen__ingress">
        {s.fastigheter} {s.fastigheter === 1 ? "fastighet" : "fastigheter"} med penetration
        {s.matdatum && <> · mätt {datumStr(s.matdatum)}</>}. Summan är viktad med antal hushåll per fastighet.
      </p>
      <PenTabell rader={svar.rader} />
      <p className="tlgh__kalla">Källa: Telias penetrationsfil, ersätts vid varje import. Procenten gäller hushållen (HC) i Telias nät.</p>
    </div>
  );
}
