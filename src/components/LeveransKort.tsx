import "@/styles/leverans.css";
import type { ObjectDef, RecordRow } from "@/lib/data";
import { StatusPill } from "./StatusPill";

/**
 * Kortvy för leveranser (objekttyp `delivery`): ett kort per leverans med
 * status, adress, lägenheter/portar, leveransmånad, kundklar, Telias LPL,
 * projektledare och hur många aviseringar CE skickat (`ce_skickad_avi`, 0–3).
 */

const AVI_STEG = 3;
const manadFmt = new Intl.DateTimeFormat("sv-SE", { month: "short", year: "numeric" });
const datumFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });

function text(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

function datum(v: unknown, f: Intl.DateTimeFormat): string | null {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  return isNaN(d.getTime()) ? s : f.format(d).replace(".", "");
}

function initialer(namn: string) {
  return namn.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

function Person({ roll, namn }: { roll: string; namn: string }) {
  return (
    <div className="lev-kort__person">
      <span className={namn ? "lev-kort__avatar" : "lev-kort__avatar lev-kort__avatar--tom"} aria-hidden="true">
        {namn ? initialer(namn) : "+"}
      </span>
      <span className="lev-kort__person-text">
        <span className="lev-kort__etikett">{roll}</span>
        <span className={namn ? "lev-kort__namn" : "lev-kort__namn lev-kort__tom"} title={namn || undefined}>
          {namn || "Ej tilldelad"}
        </span>
      </span>
    </div>
  );
}

function Siffra({ etikett, varde, stor }: { etikett: string; varde: string | null; stor?: boolean }) {
  return (
    <div className="lev-kort__siffra">
      <span className="lev-kort__etikett">{etikett}</span>
      <span className={[stor ? "lev-kort__varde lev-kort__varde--stor" : "lev-kort__varde", varde ? "" : "lev-kort__tom"].join(" ")}>
        {varde ?? "–"}
      </span>
    </div>
  );
}

type Props = {
  objectDef: ObjectDef;
  items: RecordRow[];
  loading: boolean;
  onOpen: (id: string) => void;
  onDelete?: (id: string, e: React.MouseEvent) => void;
  returnRow: (id: string) => Record<string, string>;
};

export function LeveransKort({ objectDef, items, loading, onOpen, onDelete, returnRow }: Props) {
  return (
    <div className={`lev-kort-grid${loading ? " is-loading" : ""}`}>
      {items.map((r) => {
        const d = r.data;
        const ort = text(d.ort);
        const postort = [text(d.postnummer), ort].filter(Boolean).join(" ");
        const gata = text(d.adress);
        // Adressfältet innehåller ibland redan postnummer och ort.
        const adress = gata && postort && gata.includes(ort) ? gata : [gata, postort].filter(Boolean).join(", ");
        const agare = [text(d.fastighetsagare) || text(d.bolagsnamn), text(d.orgnr)].filter(Boolean).join(" · ");
        const avi = Math.max(0, Math.min(AVI_STEG, Number(d.ce_skickad_avi) || 0));
        const titel = r.title ?? (text(d.name) || text(d.fastighetsbeteckning) || "Namnlös leverans");

        return (
          <article
            key={r.id}
            className="lev-kort"
            {...returnRow(r.id)}
            role="button"
            tabIndex={0}
            aria-label={`Öppna ${titel}`}
            onClick={() => onOpen(r.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r.id); } }}
          >
            <div className="lev-kort__topp">
              <StatusPill status={r.status} def={objectDef.statuses.find((s) => s.key === r.status)} />
              {onDelete && (
                <button
                  type="button"
                  className="lev-kort__ta-bort"
                  aria-label={`Ta bort ${titel}`}
                  title="Ta bort"
                  onClick={(e) => { e.stopPropagation(); onDelete(r.id, e); }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
                  </svg>
                </button>
              )}
            </div>

            <div className="lev-kort__huvud">
              <h3 className="lev-kort__titel">{titel}</h3>
              {adress && (
                <p className="lev-kort__adress">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" />
                  </svg>
                  {adress}
                </p>
              )}
              {agare && <p className="lev-kort__agare">{agare}</p>}
            </div>

            <div className="lev-kort__siffror">
              <Siffra etikett="Lgh" varde={text(d.lagenheter) || null} stor />
              <Siffra etikett="Portar" varde={text(d.portar) || null} stor />
              <Siffra etikett="Lev.månad" varde={datum(d.leveransmanad, manadFmt)} />
              <Siffra etikett="Kundklar" varde={datum(d.kundklar, datumFmt)} />
            </div>

            <div className="lev-kort__personer">
              <Person roll="Telia LPL" namn={text(d.responsible_lpl)} />
              <Person roll="Projektledare" namn={text(d.projektledare)} />
            </div>

            <div className="lev-kort__avi">
              <div className="lev-kort__avi-rubrik">
                <span>Avisering</span>
                <span className="lev-kort__etikett">
                  {avi === 0 ? "Ingen skickad" : avi === AVI_STEG ? "Alla skickade" : `${avi} av ${AVI_STEG} skickade`}
                </span>
              </div>
              <ol className="lev-kort__avi-steg" aria-label={`${avi} av ${AVI_STEG} aviseringar skickade`}>
                {Array.from({ length: AVI_STEG }, (_, i) => (
                  <li key={i} className={i < avi ? "is-klar" : undefined}>
                    <span className="lev-kort__avi-stapel" />
                    <span className="lev-kort__avi-text">Avi {i + 1}</span>
                  </li>
                ))}
              </ol>
            </div>
          </article>
        );
      })}
    </div>
  );
}
