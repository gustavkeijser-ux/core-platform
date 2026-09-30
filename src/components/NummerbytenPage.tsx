import { useCallback, useEffect, useMemo, useState } from "react";
import type { RecordRow } from "@/lib/data";
import { listRecords, nummerbyteComplete, nummerbyteSetAdmin, nummerbyteSetStart, DataError } from "@/lib/data";
import { UserBadge, useTenantUsers } from "@/lib/users";
import { dagarTill, StartdatumVarning, type NummerRad } from "./MobilNummer";
import { rememberRow, useReturnToRow } from "@/lib/returnRow";

/**
 * Admin: alla nummerbyten/porteringar från D2D-försäljningar.
 * Öppna ärenden sorteras på senaste handläggningsdatum (mest akut överst)
 * och färgkodas. "Markera som genomförd" loggar vem/när/vilka nummer —
 * ärendet raderas aldrig utan flyttas till Historik.
 */

type Urgency = "red" | "orange" | "yellow" | "green";
const URGENCY: Record<Urgency, { dot: string; label: string }> = {
  red:    { dot: "🔴", label: "Deadline passerad" },
  orange: { dot: "🟠", label: "Deadline närmar sig" },
  yellow: { dot: "🟡", label: "Bör hanteras snart" },
  green:  { dot: "🟢", label: "Gott om tid" },
};

const d = (r: RecordRow, k: string) => (r.data as Record<string, unknown>)[k];
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function urgency(r: RecordRow): Urgency {
  const senast = dagarTill(str(d(r, "senast_datum")));
  const rek = dagarTill(str(d(r, "rek_datum")));
  if (senast !== null && senast < 0) return "red";
  if (senast !== null && senast <= 7) return "orange";
  if ((rek !== null && rek <= 0) || (senast !== null && senast <= 14)) return "yellow";
  return "green";
}

function fmt(v: unknown) {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s || "—";
  const [y, m, dd] = s.slice(0, 10).split("-");
  return `${dd}/${m}/${y}`;
}

function dagarText(v: unknown) {
  const n = dagarTill(str(v));
  if (n === null) return "—";
  if (n < 0) return `${-n} dagar sen`;
  if (n === 0) return "Idag";
  return `${n} dagar`;
}

function nummerRader(r: RecordRow): NummerRad[] {
  const v = d(r, "nummer");
  const rows = Array.isArray(v) ? (v as NummerRad[]) : [];
  return [...rows].sort((a, b) => (a.typ === "huvud" ? -1 : b.typ === "huvud" ? 1 : 0));
}

const SHAREPOINT_TEXT =
  "Innan du genomför porteringen: kontrollera i Telias SharePoint att ingen ånger eller annan avbeställning har kommit in. CRM markerar inte avbrutna försäljningar själv.";

export function NummerbytenPage() {
  const [tab, setTab] = useState<"open" | "history">("open");
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<RecordRow | null>(null);
  const users = useTenantUsers();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statuses = tab === "open" ? ["oppen"] : ["genomford", "makulerad"];
      const res = await listRecords({
        objectType: "nummerbyte",
        filters: [{ field: "__status", op: "in", value: statuses }],
        sort: tab === "open" ? { field: "senast_datum", dir: "asc" } : { field: "updated_at", dir: "desc" },
        limit: 200,
      });
      setItems(res.items);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta nummerbyten.");
    } finally {
      setLoading(false);
    }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => {
    if (tab !== "open") return items;
    const rank: Record<Urgency, number> = { red: 0, orange: 1, yellow: 2, green: 3 };
    return [...items].sort((a, b) =>
      rank[urgency(a)] - rank[urgency(b)]
      || str(d(a, "senast_datum")).localeCompare(str(d(b, "senast_datum"))));
  }, [items, tab]);

  const counts = useMemo(() => {
    const c: Record<Urgency, number> = { red: 0, orange: 0, yellow: 0, green: 0 };
    if (tab === "open") items.forEach((r) => { c[urgency(r)]++; });
    return c;
  }, [items, tab]);

  const listKey = `nummerbyten:${tab}`;
  const returnRow = useReturnToRow(listKey, !loading);

  async function run(fn: () => Promise<void>) {
    try { await fn(); await load(); }
    catch (e) { alert(e instanceof DataError ? e.message : "Något gick fel."); }
  }

  const AdminSelect = ({ r }: { r: RecordRow }) => (
    <select
      className="input nb-admin"
      value={str(d(r, "ansvarig_admin"))}
      aria-label="Ansvarig admin"
      onChange={(e) => run(() => nummerbyteSetAdmin(r.id, e.target.value || null))}
    >
      <option value="">Ej tilldelad</option>
      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );

  const StartInput = ({ r }: { r: RecordRow }) => (
    <input
      className="input nb-start"
      type="date"
      aria-label="Startdatum"
      defaultValue={str(d(r, "startdatum")).slice(0, 10)}
      onBlur={(e) => {
        const v = e.target.value;
        if (v && v !== str(d(r, "startdatum")).slice(0, 10)) {
          if (confirm("Ändra startdatum? Handläggningsdatumen räknas om automatiskt.")) {
            void run(() => nummerbyteSetStart(r.id, v));
          } else {
            e.target.value = str(d(r, "startdatum")).slice(0, 10);
          }
        }
      }}
    />
  );

  return (
    <div className="page nb-page">
      <div className="nb-head">
        <div className="view-toggle">
          <button className="view-toggle__btn" aria-current={tab === "open"} onClick={() => setTab("open")}>Öppna</button>
          <button className="view-toggle__btn" aria-current={tab === "history"} onClick={() => setTab("history")}>Historik</button>
        </div>
        {tab === "open" && (
          <div className="nb-counts">
            {(Object.keys(URGENCY) as Urgency[]).map((u) => (
              <span key={u} className="nb-count" title={URGENCY[u].label}>{URGENCY[u].dot} {counts[u]} <span className="nb-count__label">{URGENCY[u].label}</span></span>
            ))}
          </div>
        )}
      </div>

      {tab === "open" && <div className="nb-sharepoint">⚠️ {SHAREPOINT_TEXT}</div>}

      {error && <div className="card"><div className="empty-state">{error}</div></div>}
      {loading && <div className="card"><div className="empty-state">Laddar…</div></div>}
      {!loading && !error && sorted.length === 0 && (
        <div className="card"><div className="empty-state">
          {tab === "open" ? "Inga öppna nummerbyten." : "Ingen historik ännu."}
        </div></div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="nb-list">
          {sorted.map((r) => {
            const u = urgency(r);
            const nr = nummerRader(r);
            const done = r.status === "genomford";
            return (
              <article
                key={r.id}
                {...returnRow(r.id)}
                className={`card nb-card${tab === "open" ? ` nb-card--${u}` : ""}`}
                onClick={() => rememberRow(listKey, r.id)}
              >
                <header className="nb-card__head">
                  <div className="nb-card__who">
                    {tab === "open" && <span className="nb-card__dot" title={URGENCY[u].label}>{URGENCY[u].dot}</span>}
                    <div>
                      <h3 className="nb-card__kund">{str(d(r, "kund")) || "—"}</h3>
                      <div className="nb-card__adress">{str(d(r, "adress")) || "—"}</div>
                    </div>
                  </div>
                  <div className="nb-card__status">
                    <span className={`nb-status nb-status--${r.status}`}>
                      {r.status === "oppen" ? URGENCY[u].label : done ? "Genomförd" : "Makulerad"}
                    </span>
                  </div>
                </header>

                <dl className="nb-facts">
                  <div><dt>Säljare</dt><dd><UserBadge id={str(d(r, "saljare")) || null} /></dd></div>
                  <div><dt>Signeringsdatum</dt><dd>{fmt(d(r, "signeringsdatum"))}</dd></div>
                  <div><dt>Startdatum</dt><dd>{tab === "open" ? <StartInput r={r} /> : fmt(d(r, "startdatum"))}</dd></div>
                  <div><dt>Rekommenderad hantering</dt><dd>{fmt(d(r, "rek_datum"))}</dd></div>
                  <div><dt>Senaste hantering</dt><dd className={tab === "open" && u === "red" ? "nb-late" : undefined}>{fmt(d(r, "senast_datum"))}</dd></div>
                  {tab === "open" && <div><dt>Dagar kvar</dt><dd><strong>{dagarText(d(r, "senast_datum"))}</strong></dd></div>}
                  <div><dt>Ansvarig admin</dt><dd>{tab === "open" ? <AdminSelect r={r} /> : <UserBadge id={str(d(r, "ansvarig_admin")) || null} />}</dd></div>
                </dl>
                {tab === "open" && str(d(r, "startdatum")) && <StartdatumVarning datum={str(d(r, "startdatum")).slice(0, 10)} />}

                <div className="nb-numbers">
                  <table className="nb-table">
                    <thead>
                      <tr><th>Typ</th><th>Tillfälligt nummer</th><th>Ska ersättas med</th><th>Står på numret idag</th></tr>
                    </thead>
                    <tbody>
                      {nr.map((n, i) => (
                        <tr key={i}>
                          <td data-label="Typ">{n.typ === "huvud" ? <span className="mnr-badge">Huvudnummer</span> : "Extraanvändare"}</td>
                          <td data-label="Tillfälligt nummer" className="nb-mono">{n.tillfalligt || "—"}</td>
                          <td data-label="Ska ersättas med" className="nb-mono"><strong>{n.riktigt || "—"}</strong></td>
                          <td data-label="Står på numret idag">{n.agare || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {tab === "open" ? (
                  <div className="nb-actions">
                    <button className="btn btn--brand" onClick={(e) => { e.stopPropagation(); setConfirmFor(r); }}>
                      Markera som genomförd
                    </button>
                  </div>
                ) : (
                  <p className="nb-done">
                    {done ? (
                      <>Genomförd av <strong><UserBadge id={str(d(r, "genomford_av")) || null} /></strong>{" "}
                        {str(d(r, "genomford_at")) && new Date(str(d(r, "genomford_at"))).toLocaleString("sv-SE", {
                          day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
                        })}</>
                    ) : (str(d(r, "kommentar")) || "Makulerad")}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {confirmFor && (
        <ConfirmDialog
          r={confirmFor}
          onClose={() => setConfirmFor(null)}
          onConfirm={() => run(async () => { await nummerbyteComplete(confirmFor.id); setConfirmFor(null); })}
        />
      )}
    </div>
  );
}

function ConfirmDialog({ r, onClose, onConfirm }: { r: RecordRow; onClose: () => void; onConfirm: () => void }) {
  const [sharepoint, setSharepoint] = useState(false);
  const [telia, setTelia] = useState(false);
  const nr = nummerRader(r);
  return (
    <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nb-dialog" role="dialog" aria-modal="true" aria-label="Markera som genomförd">
        <h2>Markera som genomförd</h2>
        <p className="nb-dialog__kund"><strong>{str(d(r, "kund"))}</strong> · {str(d(r, "adress"))}</p>
        <ul className="nb-dialog__nums">
          {nr.map((n, i) => (
            <li key={i}>{n.typ === "huvud" ? "Huvudnummer" : "Extraanvändare"}: {n.tillfalligt} → <strong>{n.riktigt}</strong></li>
          ))}
        </ul>
        <label className="nb-check">
          <input type="checkbox" checked={sharepoint} onChange={(e) => setSharepoint(e.target.checked)} />
          <span>Jag har kontrollerat i Telias SharePoint att ingen ånger eller avbeställning har kommit in.</span>
        </label>
        <label className="nb-check">
          <input type="checkbox" checked={telia} onChange={(e) => setTelia(e.target.checked)} />
          <span>Jag bekräftar att nummerbytet/porteringen har genomförts i Telias beställningsportal.</span>
        </label>
        <div className="nb-dialog__actions">
          <button className="btn btn--ghost" onClick={onClose}>Avbryt</button>
          <button className="btn btn--brand" disabled={!sharepoint || !telia} onClick={onConfirm}>Bekräfta</button>
        </div>
      </div>
    </div>
  );
}
