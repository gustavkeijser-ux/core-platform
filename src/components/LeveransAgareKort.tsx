import "@/styles/leverans.css";
import { supabase } from "@/integrations/supabase/client";
import type { ObjectDef, RecordFilter } from "@/lib/data";
import { useUserName } from "@/lib/users";

/**
 * Översta nivån i leveransernas kortvy: ett kort per fastighetsägare med
 * fastigheter per status, totalt antal lägenheter, Telia LPL, CE-ansvarig
 * och entreprenör. Klick öppnar ägarens leveranser (LeveransKort).
 * Data kommer från RPC:n leverans_agare_oversikt (samma behörighet, sök
 * och filter som listan).
 */

/** Värdet som betyder "leveranser utan fastighetsägare". */
export const INGEN_AGARE = "__ingen__";

export type AgareGrupp = {
  agare: string | null;
  antal: number;
  lgh: number;
  status: { key: string | null; n: number }[];
  lpl: string[];
  ce: string[];
  entreprenor: string[];
};

export async function hamtaAgareOversikt(search: string | undefined, filters: RecordFilter[]): Promise<AgareGrupp[]> {
  const { data, error } = await supabase.rpc("leverans_agare_oversikt" as never, {
    p_search: search ?? null,
    p_filters: filters,
  } as never);
  if (error) throw new Error("Kunde inte hämta fastighetsägarna.");
  return (data as unknown as AgareGrupp[]) ?? [];
}

/** Filtret som visar en ägares leveranser. */
export function agareFilter(agare: string): RecordFilter {
  return agare === INGEN_AGARE
    ? { field: "fastighetsagare", op: "empty" }
    : { field: "fastighetsagare", op: "eq", value: agare };
}

const lghFmt = new Intl.NumberFormat("sv-SE");

function initialer(namn: string) {
  return namn.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

function Namn({ id }: { id: string }) {
  return <>{useUserName(id)}</>;
}

function CeNamn({ id }: { id: string }) {
  const namn = useUserName(id);
  return <>{namn && namn !== "…" ? initialer(namn) : "·"}</>;
}

function Roll({ roll, varden, anvandare }: { roll: string; varden: string[]; anvandare?: boolean }) {
  const tom = varden.length === 0;
  const forsta = varden[0];
  return (
    <div className="lev-kort__person">
      <span className={tom ? "lev-kort__avatar lev-kort__avatar--tom" : "lev-kort__avatar"} aria-hidden="true">
        {tom ? "+" : anvandare ? <CeNamn id={forsta!} /> : initialer(forsta!)}
      </span>
      <span className="lev-kort__person-text">
        <span className="lev-kort__etikett">{roll}</span>
        <span className={tom ? "lev-kort__namn lev-kort__tom" : "lev-kort__namn"} title={!tom && !anvandare ? varden.join(", ") : undefined}>
          {tom
            ? "Ej tilldelad"
            : varden.map((v, i) => (
                <span key={v}>{i > 0 && ", "}{anvandare ? <Namn id={v} /> : v}</span>
              ))}
        </span>
      </span>
    </div>
  );
}

type Props = {
  objectDef: ObjectDef;
  grupper: AgareGrupp[];
  loading: boolean;
  onOpen: (agare: string) => void;
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
        const nyckel = g.agare ?? INGEN_AGARE;
        const titel = g.agare ?? "Ingen fastighetsägare";
        const statusar = [...g.status].sort((a, b) => ordning(a.key) - ordning(b.key));
        return (
          <article
            key={nyckel}
            className="lev-kort lev-agare"
            role="button"
            tabIndex={0}
            data-return-row={nyckel}
            aria-label={`Visa ${g.antal} fastigheter för ${titel}`}
            onClick={() => onOpen(nyckel)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(nyckel); } }}
          >
            <div className="lev-agare__huvud">
              <h3 className={g.agare ? "lev-kort__titel" : "lev-kort__titel lev-kort__tom"}>{titel}</h3>
              <svg className="lev-agare__pil" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </div>

            <div className="lev-kort__siffror lev-agare__siffror">
              <div className="lev-kort__siffra">
                <span className="lev-kort__etikett">Fastigheter</span>
                <span className="lev-kort__varde lev-kort__varde--stor">{g.antal}</span>
              </div>
              <div className="lev-kort__siffra">
                <span className="lev-kort__etikett">Lägenheter totalt</span>
                <span className={g.lgh ? "lev-kort__varde lev-kort__varde--stor" : "lev-kort__varde lev-kort__tom"}>
                  {g.lgh ? lghFmt.format(g.lgh) : "–"}
                </span>
              </div>
            </div>

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

            <div className="lev-agare__roller">
              <Roll roll="Telia LPL" varden={g.lpl} />
              <Roll roll="CE-ansvarig" varden={g.ce} anvandare />
              <Roll roll="Entreprenör" varden={g.entreprenor} />
            </div>
          </article>
        );
      })}
    </div>
  );
}
