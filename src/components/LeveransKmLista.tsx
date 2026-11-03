import "@/styles/leverans.css";
import { useEffect, useMemo, useState } from "react";
import type { ObjectDef } from "@/lib/data";
import { loadListState, saveListState } from "@/lib/returnRow";
import { getUserName, useTenantUsers } from "@/lib/users";
import { type AgareGrupp, gruppNyckel, stegFor, stegFarg, snittFmt, KLAR, VILANDE, Roll, Siffra } from "./LeveransAgareKort";
import {
  type FastighetRad, type Kol, type Sort, type Filter,
  KolumnMeny, FilterIkon, TOMT, jamforSort, aviLage, klara, punkter,
} from "./LeveransFastighetslista";

/**
 * Leveransöversikten → Koncernmoder: en rad per koncernmoder (Kund) med en
 * summering av fastigheterna i projektplanen — antal, hushåll, portar, snittsteg,
 * Telia LPL, CE-leveransansvarig, projektledare, avisering (Avi 1 ska alltid gå ut
 * först, sedan 2 och 3), kundklar och checklista. Klick öppnar koncernmoderns
 * fastigheter i samma tabell som "Alla fastigheter".
 * Filter per rubrik som i Excel. Data: grupperna från leverans_agare_oversikt
 * (även koncernmödrar med bara en Leveransöversikt-post) + fastighetsraderna från
 * leverans_fastighetslista (samma sök och filter).
 */

type Avi = { a1: number; a2: number; a3: number; klara: number; fel: number };

export type KmRad = {
  nyckel: string;
  g: AgareGrupp;
  namn: string;
  antal: number;
  hushall: number;
  fs: number;
  sc: number;
  steg: number | "vilande" | null;
  lpl: string[];
  ce: string[];
  /** Projektledare enligt projektplanen (kolumnen efter Entreprenör). */
  pl: string[];
  avi: Avi;
  kkMin: string | null;
  kkMax: string | null;
  chkKlar: number;
  chkTot: number;
  /** Antal fastigheter per status (för statusstapeln). */
  status: { key: string | null; n: number }[];
};

const tal = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const unika = (v: (string | null | undefined)[]) =>
  [...new Set(v.map((x) => (x ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "sv"));

const datumFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });
function datum(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  return Number.isNaN(d.getTime()) ? s : datumFmt.format(d);
}

/** Värst aviseringsläge för koncernmodern (för filter och sortering). */
function aviVarst(a: Avi): { text: string; ordning: number } {
  if (a.a1) return { text: "Avi 1 saknas", ordning: 1 };
  if (a.a2) return { text: "Avi 2 saknas", ordning: 2 };
  if (a.a3) return { text: "Avi 3 saknas", ordning: 3 };
  if (a.klara) return { text: "Alla aviserade", ordning: 4 };
  return { text: "", ordning: 9 };
}

const stegText = (s: KmRad["steg"]) =>
  s === null ? "" : s === "vilande" ? "Vilande" : s >= KLAR ? "Klar" : `Snitt ${snittFmt.format(s)}`;

const KOLUMNER: Kol<KmRad>[] = [
  { key: "namn", label: "Koncernmoder", sort: (r) => r.namn, varde: (r) => r.namn },
  { key: "antal", label: "Fastigheter", sort: (r) => r.antal, varde: (r) => String(r.antal), num: true },
  { key: "hushall", label: "Hushåll", sort: (r) => r.hushall, varde: (r) => String(r.hushall), num: true },
  { key: "fs", label: "FS-portar", sort: (r) => r.fs, varde: (r) => String(r.fs), num: true },
  { key: "sc", label: "SC", sort: (r) => r.sc, varde: (r) => String(r.sc), num: true },
  { key: "steg", label: "Status", sort: (r) => (r.steg === null ? null : r.steg === "vilande" ? -1 : r.steg), varde: (r) => stegText(r.steg) },
  { key: "lpl", label: "Telia LPL", sort: (r) => r.lpl.join(", "), varde: (r) => r.lpl.join(", ") },
  { key: "ce", label: "CE-leveransansvarig", sort: (r) => r.ce.map(getUserName).join(", "), varde: (r) => r.ce.map(getUserName).join(", ") },
  { key: "pl", label: "Projektledare", sort: (r) => r.pl.join(", "), varde: (r) => r.pl.join(", ") },
  { key: "avi", label: "Avisering", sort: (r) => { const v = aviVarst(r.avi); return v.ordning === 9 ? null : v.ordning * 10000 - (r.avi.a1 + r.avi.a2 + r.avi.a3); }, varde: (r) => aviVarst(r.avi).text },
  { key: "kk", label: "Kundklar", sort: (r) => r.kkMin, varde: (r) => (r.kkMin ? (r.kkMin === r.kkMax ? datum(r.kkMin) : `${datum(r.kkMin)} – ${datum(r.kkMax)}`) : "") },
  { key: "chk", label: "Checklista", sort: (r) => (r.chkTot ? r.chkKlar / r.chkTot : null), varde: (r) => (r.chkTot ? `${Math.round((r.chkKlar / r.chkTot) * 100)} %` : ""), num: true },
];

const FILTER_NYCKEL = "lev-km:kolumnfilter";
const tf = new Intl.NumberFormat("sv-SE");


export function LeveransKmLista({ objectDef, grupper, rader, loading, onOpen, onOpenPost }: {
  objectDef: ObjectDef;
  grupper: AgareGrupp[];
  rader: FastighetRad[];
  loading: boolean;
  onOpen: (g: AgareGrupp) => void;
  onOpenPost: (postId: string) => void;
}) {
  const users = useTenantUsers();
  const sparat = useMemo(() => loadListState<{ filter: Filter; sort: Sort }>(FILTER_NYCKEL), []);
  const [sort, setSort] = useState<Sort>(sparat.sort ?? null);
  const [filter, setFilter] = useState<Filter>(sparat.filter ?? {});
  const [meny, setMeny] = useState<{ kol: string; ankare: HTMLElement } | null>(null);
  useEffect(() => { saveListState(FILTER_NYCKEL, { filter, sort }); }, [filter, sort]);

  const kmRader = useMemo<KmRad[]>(() => {
    const etikett = (key: string | null) => objectDef.statuses.find((s) => s.key === key)?.label;
    const perKund = new Map<string, FastighetRad[]>();
    for (const r of rader) {
      const k = r.kund_id ?? "__ingen__";
      const l = perKund.get(k);
      if (l) l.push(r); else perKund.set(k, [r]);
    }
    return grupper.map((g) => {
      const fr = g.kund_id ? perKund.get(g.kund_id) ?? [] : g.post_id ? [] : perKund.get("__ingen__") ?? [];
      let summa = 0, n = 0, vil = 0;
      const avi: Avi = { a1: 0, a2: 0, a3: 0, klara: 0, fel: 0 };
      let chkKlar = 0, chkTot = 0;
      const kk: string[] = [];
      for (const r of fr) {
        const s = stegFor(etikett(r.status));
        if (s !== null) { if (s === VILANDE) vil++; else { summa += Math.min(s, KLAR); n++; } }
        const a = aviLage(r);
        if (a.harAvi) {
          if (a.nasta === 1) avi.a1++; else if (a.nasta === 2) avi.a2++; else if (a.nasta === 3) avi.a3++; else avi.klara++;
          if (a.felOrdning) avi.fel++;
        }
        chkKlar += klara(r); chkTot += punkter(r).length;
        const d = r.kundklar_ce ?? r.kundklar;
        if (d) kk.push(d);
      }
      kk.sort();
      const perStatus = new Map<string | null, number>();
      for (const r of fr) perStatus.set(r.status, (perStatus.get(r.status) ?? 0) + 1);
      return {
        nyckel: gruppNyckel(g),
        g,
        namn: g.kund ?? (fr[0]?.kund ? `${fr[0].kund} (ingen kund kopplad)` : "Ingen kund kopplad"),
        antal: fr.length,
        hushall: fr.reduce((x, r) => x + tal(r.hushall), 0),
        fs: fr.reduce((x, r) => x + tal(r.fs_portar), 0),
        sc: fr.reduce((x, r) => x + tal(r.sc_portar), 0),
        steg: n ? summa / n : vil ? "vilande" : null,
        lpl: unika(fr.map((r) => r.lpl)),
        ce: [...new Set(fr.flatMap((r) => r.ce_ansvariga ?? []))],
        pl: unika(fr.map((r) => r.projektledare)),
        avi,
        kkMin: kk[0] ?? null,
        kkMax: kk[kk.length - 1] ?? null,
        chkKlar, chkTot,
        status: [...perStatus.entries()].map(([key, n]) => ({ key, n })),
      };
    });
    // users: namnen i CE-kolumnen ritas om när användarna laddats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grupper, rader, objectDef, users]);

  const passar = (r: KmRad, utom?: string) => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === utom) continue;
      const kol = KOLUMNER.find((x) => x.key === k);
      if (kol && !v.includes(kol.varde(r))) return false;
    }
    return true;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filtrerade = useMemo(() => kmRader.filter((r) => passar(r)), [kmRader, filter]);
  const sorterade = useMemo(() => {
    if (!sort) return filtrerade;
    const kol = KOLUMNER.find((k) => k.key === sort.key);
    return kol ? [...filtrerade].sort(jamforSort(kol, sort.dir)) : filtrerade;
  }, [filtrerade, sort]);

  const summa = useMemo(() => {
    const s = { antal: 0, hushall: 0, a1: 0, a2: 0, a3: 0 };
    for (const r of filtrerade) { s.antal += r.antal; s.hushall += r.hushall; s.a1 += r.avi.a1; s.a2 += r.avi.a2; s.a3 += r.avi.a3; }
    return s;
  }, [filtrerade]);

  const aktiva = KOLUMNER.filter((k) => filter[k.key]);
  const sattFilter = (key: string, v: string[] | null) => setFilter((f) => {
    const n = { ...f }; if (v === null) delete n[key]; else n[key] = v; return n;
  });
  const menyKol = meny ? KOLUMNER.find((k) => k.key === meny.kol) : undefined;
  const visa = (v: string[]) => { const t = v.map((x) => x || TOMT); return t.length <= 2 ? t.join(", ") : `${t.slice(0, 2).join(", ")} +${t.length - 2}`; };

  const statusDef = (key: string | null) => objectDef.statuses.find((x) => x.key === key);
  const statusOrdning = (key: string | null) => { const i = objectDef.statuses.findIndex((x) => x.key === key); return i < 0 ? 9999 : i; };
  const statusFarg = (key: string | null, reserv: string) => {
    const c = statusDef(key)?.color;
    return c ? (c.startsWith("#") ? c : `var(--hue-${c})`) : reserv;
  };

  return (
    <div className={"lev-km" + (loading ? " is-loading" : "")}>
      <div className="card lev-fl lev-km__panel">
        <div className="lev-fl__summa">
          <span><b>{tf.format(filtrerade.length)}</b>{filtrerade.length !== kmRader.length && <> av {tf.format(kmRader.length)}</>} koncernmödrar</span>
          <span><b>{tf.format(summa.antal)}</b> fastigheter</span>
          <span><b>{tf.format(summa.hushall)}</b> hushåll</span>
          {summa.a1 + summa.a2 + summa.a3 > 0 && (
            <span>Saknar avisering: <b>{summa.a1}</b> Avi 1 · <b>{summa.a2}</b> Avi 2 · <b>{summa.a3}</b> Avi 3</span>
          )}
        </div>
        <div className="lev-km__verktyg" aria-label="Sortera och filtrera">
          <span className="lev-km__verktygsrubrik">Sortera / filtrera:</span>
          {KOLUMNER.map((k) => (
            <button key={k.key} type="button" className="chip" aria-pressed={!!filter[k.key] || sort?.key === k.key}
              aria-haspopup="dialog" aria-expanded={meny?.kol === k.key}
              onClick={(e) => setMeny(meny?.kol === k.key ? null : { kol: k.key, ankare: e.currentTarget })}>
              {filter[k.key] && <FilterIkon />} {k.label}{sort?.key === k.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
            </button>
          ))}
        </div>
        {aktiva.length > 0 && (
          <div className="lev-fl__aktiva">
            {aktiva.map((k) => (
              <span key={k.key} className="lev-fl__aktivt">
                <b>{k.label}:</b> {visa(filter[k.key])}
                <button type="button" aria-label={`Ta bort filtret på ${k.label}`} onClick={() => sattFilter(k.key, null)}>×</button>
              </span>
            ))}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFilter({})}>Rensa alla filter</button>
          </div>
        )}
      </div>

      <div className="lev-km-lista">
        {sorterade.map((r) => {
          const steg = r.steg;
          const ram = steg === null ? undefined : stegFarg(steg);
          const avslutad = r.g.post_status === "avslutad";
          const statusar = [...r.status].sort((a, b) => statusOrdning(a.key) - statusOrdning(b.key));
          const avtalsparter = String(r.g.post?.avtalsparter ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
          const harAvi = r.avi.a1 + r.avi.a2 + r.avi.a3 + r.avi.klara > 0;
          return (
            <article
              key={r.nyckel}
              className={"lev-kort lev-agare lev-km-kort" + (avslutad ? " lev-agare--avslutad" : "") + (ram ? " lev-agare--ram" : "")}
              style={ram ? ({ "--lev-ram": ram } as React.CSSProperties) : undefined}
              role="button"
              tabIndex={0}
              data-row-id={r.nyckel}
              aria-label={`Visa fastigheterna för ${r.namn}`}
              onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) onOpen(r.g); }}
              onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onOpen(r.g); } }}
            >
              <div className="lev-km-kort__namn">
                <h3 className={r.g.kund ? "lev-kort__titel" : "lev-kort__titel lev-kort__tom"}>{r.namn}</h3>
                {avtalsparter.length > 0 && <p className="lev-kort__agare" title={avtalsparter.join(", ")}>Avtalsparter: {avtalsparter.join(", ")}</p>}
                {(() => {
                  const p = r.g.post ?? {};
                  const del = [p.agare_namn && `Ägare: ${p.agare_namn}`, p.forvaltare_namn && `Förvaltare: ${p.forvaltare_namn}`].filter(Boolean) as string[];
                  return del.length ? <p className="lev-kort__agare lev-km-kort__kontakt" title={del.join(" · ")}>{del.join(" · ")}</p> : null;
                })()}
                <div className="lev-km-kort__etiketter">
                  {steg !== null && (
                    <span className="lev-agare__steg" title="Genomsnittligt steg för fastigheterna (avslutade = 9, vilande räknas inte)">
                      {steg === "vilande" ? "Vilande" : steg >= KLAR ? "Klar" : `Snitt ${snittFmt.format(steg)} av 9`}
                    </span>
                  )}
                  {r.g.post_status && <span className={`lev-agare__poststatus${avslutad ? " is-avslutad" : ""}`}>{avslutad ? "Avslutad" : "Pågående"}</span>}
                  {r.g.post_id && (
                    <button type="button" className="lev-fl__lank lev-km__postlank" onClick={() => onOpenPost(r.g.post_id!)}>Leveransöversikt</button>
                  )}
                </div>
              </div>

              <div className="lev-kort__siffror lev-agare__siffror lev-km-kort__siffror">
                <Siffra etikett="Fastigheter" varde={r.antal} />
                <Siffra etikett="Hushåll" varde={r.hushall} />
                <Siffra etikett="FS-portar" varde={r.fs} />
                <Siffra etikett="SC" varde={r.sc} />
              </div>

              <div className="lev-km-kort__avi">
                <span className="lev-kort__etikett">Avisering</span>
                {!harAvi ? <span className="lev-fl__tom">–</span> : (
                  <span className="lev-km__avi">
                    {r.avi.a1 > 0 && <span className="lev-fl__avipill is-avi1">Avi 1 saknas · {r.avi.a1}</span>}
                    {r.avi.a2 > 0 && <span className="lev-fl__avipill is-avi2">Avi 2 saknas · {r.avi.a2}</span>}
                    {r.avi.a3 > 0 && <span className="lev-fl__avipill is-avi3">Avi 3 saknas · {r.avi.a3}</span>}
                    {r.avi.a1 + r.avi.a2 + r.avi.a3 === 0 && <span className="lev-fl__avipill is-klar">Alla aviserade</span>}
                    {r.avi.fel > 0 && <span className="lev-fl__avifel" title="Fastigheter där en senare avi är ibockad fast en tidigare saknas. Avi 1 ska alltid gå ut först.">Fel ordning · {r.avi.fel}</span>}
                  </span>
                )}
              </div>

              <div className="lev-agare__roller lev-km-kort__roller">
                <Roll roll="Telia LPL" varden={r.lpl} />
                <Roll roll="CE-leveransansvarig" varden={r.ce.map(getUserName)} />
                <Roll roll="Projektledare" varden={r.pl} />
              </div>

              <div className="lev-km-kort__kk">
                <span className="lev-kort__etikett">Kundklar</span>
                <span className="lev-km-kort__kkvarde">
                  {r.kkMin ? (r.kkMin === r.kkMax ? datum(r.kkMin) : `${datum(r.kkMin)} – ${datum(r.kkMax)}`) : "–"}
                </span>
              </div>

              <div className="lev-km-kort__status">
                {r.antal > 0 ? (
                  <>
                    <div className="lev-agare__stapel" aria-hidden="true">
                      {statusar.map((x) => (
                        <span key={x.key ?? "-"} style={{ flexGrow: x.n, background: statusFarg(x.key, "var(--neutral-soft)") }} />
                      ))}
                    </div>
                    <ul className="lev-km-kort__statuslista">
                      {statusar.map((x) => (
                        <li key={x.key ?? "-"}>
                          <span className="lev-agare__prick" style={{ background: statusFarg(x.key, "var(--ink-ghost)") }} />
                          <span className="lev-km-kort__statusnamn">{statusDef(x.key)?.label ?? "Ingen status"}</span>
                          <span className="lev-agare__antal">{x.n}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : <span className="lev-kort__etikett">Inga fastigheter i projektplanen</span>}
              </div>

              <div className="lev-km-kort__chk">
                <span className="lev-kort__etikett">Checklista</span>
                {r.chkTot ? (
                  <span className="lev-km__chk">
                    <span className="lev-km__chkstapel" aria-hidden="true"><span style={{ width: `${(r.chkKlar / r.chkTot) * 100}%` }} /></span>
                    {r.chkKlar}/{r.chkTot}
                  </span>
                ) : <span className="lev-fl__tom">–</span>}
              </div>
            </article>
          );
        })}
        {sorterade.length === 0 && (
          <div className="card lev-km__ingen">
            Inga koncernmödrar matchar filtren. <button type="button" className="lev-fl__lank" onClick={() => setFilter({})}>Rensa alla filter</button>
          </div>
        )}
      </div>

      {meny && menyKol && (
        <KolumnMeny
          key={menyKol.key}
          kol={menyKol}
          rader={kmRader.filter((r) => passar(r, menyKol.key))}
          valda={filter[menyKol.key]}
          sort={sort}
          ankare={meny.ankare}
          onSort={setSort}
          onFilter={(v) => sattFilter(menyKol.key, v)}
          onStang={() => setMeny(null)}
        />
      )}
    </div>
  );
}
