import "@/styles/leverans.css";
import { supabase } from "@/integrations/supabase/client";
import type { ObjectDef, RecordFilter } from "@/lib/data";

/**
 * Översta nivån i Leveransöversikten: ett kort per Kund (koncernmoder) med
 * Kundens Leveransöversikt-post (säljare, produkt, såld, nya portar, Bef Telia,
 * CE-ansvarig, checklista, kommentar) och siffror från projektplanen
 * (fastigheter, lägenheter, statusfördelning, Telia LPL, entreprenör).
 * Data: RPC:n leverans_agare_oversikt (samma behörighet, sök och filter som listan).
 */

/** Nyckel för leveranser utan kopplad Kund. */
export const INGEN_AGARE = "__ingen__";

export type AgarePost = {
  name?: string; avtalsparter?: string; saljare?: string; ce_ansvarig?: string; produkt?: string;
  sald?: string; nya_portar?: number; bef_telia?: number; kommentar?: string; driftsatt?: string;
  [key: string]: unknown;
};

export type AgareGrupp = {
  kund_id: string | null;
  kund: string | null;
  antal: number;
  lgh: number;
  portar: number;
  status: { key: string | null; n: number }[];
  lpl: string[];
  entreprenor: string[];
  post_id: string | null;
  post_status: string | null;
  post: AgarePost;
};

/** Checklistan i Leveransöversikt-posten, i arbetsordning. */
export const CHECKLISTA: { key: string; label: string }[] = [
  { key: "kontaktade", label: "Kontaktade" },
  { key: "uppsagning_bef", label: "Uppsägning bef. leverantör" },
  { key: "projektfil", label: "Projektfil" },
  { key: "adresslista", label: "Adresslista" },
  { key: "projekthemsida", label: "Projekthemsida" },
  { key: "avi_1", label: "Avi 1" },
  { key: "avi_2", label: "Avi 2" },
  { key: "avi_3", label: "Avi 3" },
  { key: "leveransdatum", label: "Leveransdatum" },
  { key: "torrinstallation", label: "Torrinstallation" },
  { key: "uppsagningar", label: "Uppsägningar" },
  { key: "bekraftad_projektplan", label: "Bekräftad projektplan" },
  { key: "forvaltningsdokument", label: "Förvaltningsdokument" },
  { key: "bommar", label: "Bommar" },
  { key: "avlamnad_leverans", label: "Avlämnad leverans" },
  { key: "levererad", label: "Levererad" },
];

export async function hamtaAgareOversikt(search: string | undefined, filters: RecordFilter[]): Promise<AgareGrupp[]> {
  const { data, error } = await supabase.rpc("leverans_agare_oversikt" as never, {
    p_search: search ?? null,
    p_filters: filters,
  } as never);
  if (error) throw new Error("Kunde inte hämta Leveransöversikten.");
  return (data as unknown as AgareGrupp[]) ?? [];
}

/** Nyckel som identifierar ett kort (sparas i listans läge). */
export function gruppNyckel(g: AgareGrupp): string {
  return g.kund_id ?? (g.post_id ? `post:${g.post_id}` : INGEN_AGARE);
}

/** Filtret som visar ett korts leveranser. */
export function agareFilter(nyckel: string): RecordFilter {
  if (nyckel === INGEN_AGARE) return { field: "fastighetsagare", op: "empty" };
  // Post utan Kund har inga leveranser: filtrera på postens id (ger noll träffar).
  const id = nyckel.startsWith("post:") ? nyckel.slice(5) : nyckel;
  return { field: "__related", op: "eq", value: id };
}

const talFmt = new Intl.NumberFormat("sv-SE");
const datumFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });

function datum(s?: string) {
  if (!s) return null;
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  return isNaN(d.getTime()) ? s : datumFmt.format(d).replace(".", "");
}

function initialer(namn: string) {
  return namn.split(/[\s/|,]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

function Roll({ roll, varden }: { roll: string; varden: string[] }) {
  const tom = varden.length === 0;
  return (
    <div className="lev-kort__person">
      <span className={tom ? "lev-kort__avatar lev-kort__avatar--tom" : "lev-kort__avatar"} aria-hidden="true">
        {tom ? "+" : initialer(varden[0]!)}
      </span>
      <span className="lev-kort__person-text">
        <span className="lev-kort__etikett">{roll}</span>
        <span className={tom ? "lev-kort__namn lev-kort__tom" : "lev-kort__namn"} title={tom ? undefined : varden.join(", ")}>
          {tom ? "Ej tilldelad" : varden.join(", ")}
        </span>
      </span>
    </div>
  );
}

function Siffra({ etikett, varde }: { etikett: string; varde: number | null | undefined }) {
  const har = varde !== null && varde !== undefined && varde !== 0;
  return (
    <div className="lev-kort__siffra">
      <span className="lev-kort__etikett">{etikett}</span>
      <span className={har ? "lev-kort__varde lev-kort__varde--stor" : "lev-kort__varde lev-kort__tom"}>
        {har ? talFmt.format(varde!) : "–"}
      </span>
    </div>
  );
}

type Props = {
  objectDef: ObjectDef;
  grupper: AgareGrupp[];
  loading: boolean;
  onOpen: (g: AgareGrupp) => void;
};

export function LeveransAgareKort({ objectDef, grupper, loading, onOpen }: Props) {
  const statusDef = (key: string | null) => objectDef.statuses.find((s) => s.key === key);
  const ordning = (key: string | null) => { const i = objectDef.statuses.findIndex((s) => s.key === key); return i < 0 ? 9999 : i; };
  const farg = (key: string | null, reserv: string) => {
    const c = statusDef(key)?.color;
    return c ? (c.startsWith("#") ? c : `var(--hue-${c})`) : reserv;
  };

  return (
    <div className={`lev-kort-grid${loading ? " is-loading" : ""}`}>
      {grupper.map((g) => {
        const nyckel = gruppNyckel(g);
        const p = g.post ?? {};
        const titel = g.kund ?? "Ingen kund kopplad";
        const avslutad = g.post_status === "avslutad";
        const statusar = [...g.status].sort((a, b) => ordning(a.key) - ordning(b.key));
        const klara = CHECKLISTA.filter((c) => p[c.key] === true);
        const saknas = CHECKLISTA.filter((c) => p[c.key] !== true);
        const avtalsparter = (p.avtalsparter ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
        const meta = [p.saljare && `Säljare: ${p.saljare}`, p.produkt, p.sald && `Såld ${datum(p.sald)}`].filter(Boolean);
        return (
          <article
            key={nyckel}
            className={`lev-kort lev-agare${avslutad ? " lev-agare--avslutad" : ""}`}
            role="button"
            tabIndex={0}
            data-return-row={nyckel}
            aria-label={`Visa ${titel}`}
            onClick={() => onOpen(g)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(g); } }}
          >
            <div className="lev-agare__huvud">
              <div className="lev-agare__namnblock">
                <h3 className={g.kund ? "lev-kort__titel" : "lev-kort__titel lev-kort__tom"}>{titel}</h3>
                {avtalsparter.length > 0 && (
                  <p className="lev-kort__agare" title={avtalsparter.join(", ")}>Avtalsparter: {avtalsparter.join(", ")}</p>
                )}
              </div>
              {g.post_status && (
                <span className={`lev-agare__poststatus${avslutad ? " is-avslutad" : ""}`}>{avslutad ? "Avslutad" : "Pågående"}</span>
              )}
            </div>
            {meta.length > 0 && <p className="lev-agare__meta">{meta.join(" · ")}</p>}

            <div className="lev-kort__siffror lev-agare__siffror">
              <Siffra etikett="Fastigheter" varde={g.antal} />
              <Siffra etikett="Nya portar" varde={p.nya_portar ?? g.portar} />
              <Siffra etikett="Lgh totalt" varde={g.lgh} />
              <Siffra etikett="Bef Telia" varde={p.bef_telia} />
            </div>

            {g.antal > 0 && (
              <div className="lev-agare__status">
                <div className="lev-agare__stapel" aria-hidden="true">
                  {statusar.map((s) => (
                    <span key={s.key ?? "-"} style={{ flexGrow: s.n, background: farg(s.key, "var(--neutral-soft)") }} />
                  ))}
                </div>
                <ul className="lev-agare__statuslista">
                  {statusar.map((s) => (
                    <li key={s.key ?? "-"}>
                      <span className="lev-agare__prick" style={{ background: farg(s.key, "var(--ink-ghost)") }} />
                      <span className="lev-agare__statusnamn">{statusDef(s.key)?.label ?? "Ingen status"}</span>
                      <span className="lev-agare__antal">{s.n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {g.post_id && (
              <div className="lev-agare__checklista">
                <div className="lev-agare__checkrubrik">
                  <span>Checklista</span>
                  <span className="lev-kort__etikett">{klara.length} av {CHECKLISTA.length}</span>
                </div>
                <div className="lev-agare__checkstapel" aria-hidden="true">
                  {CHECKLISTA.map((c) => <span key={c.key} className={p[c.key] === true ? "is-klar" : undefined} title={c.label} />)}
                </div>
                {saknas.length > 0 && !avslutad && (
                  <p className="lev-agare__nasta">Nästa: {saknas.slice(0, 3).map((c) => c.label).join(", ")}{saknas.length > 3 ? ` +${saknas.length - 3}` : ""}</p>
                )}
              </div>
            )}

            <div className="lev-agare__roller">
              <Roll roll="Telia LPL" varden={g.lpl} />
              <Roll roll="CE-ansvarig" varden={p.ce_ansvarig ? [p.ce_ansvarig] : []} />
              <Roll roll="Entreprenör" varden={g.entreprenor} />
            </div>

            {p.kommentar && <p className="lev-agare__kommentar" title={p.kommentar}>{p.kommentar}</p>}
          </article>
        );
      })}
    </div>
  );
}
