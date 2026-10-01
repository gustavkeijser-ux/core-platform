import { useEffect, useState } from "react";
import { rememberRow, useReturnToRow } from "@/lib/returnRow";
import type { DashboardSummary } from "@/lib/data";
import { getDashboardSummary, DataError } from "@/lib/data";
import { type CaseSummary, type CaseListItem, getCaseSummary, listCases } from "@/lib/cases";
import type { ObjectDef } from "@/lib/data";
import { navigate } from "@/lib/route";
import { StatusPill } from "./StatusPill";

type Props = {
  /** Finns när användaren får se ärenden. */
  onOpenCases?: (filter: string) => void;
  onOpenObject: (key: string) => void;
  onOpenRecord: (id: string) => void;
  onOpenCase?: (id: string) => void;
  objects?: ObjectDef[];
};

/* ── KPI-rutor: ikon i tonad ruta, stort tal, etikett (som förvaltarpanelen) */
const KPI_ORDER = ["deal", "property", "delivery", "case", "koncernmoder", "direktagt_bolag", "d2d_lagenhet", "contact", "agreement"];
const KPI_HUE: Record<string, string> = {
  deal: "var(--brand)", property: "var(--hue-blue)", delivery: "var(--hue-violet)", case: "var(--hue-amber)",
  koncernmoder: "var(--hue-green)", direktagt_bolag: "var(--hue-sky)", d2d_lagenhet: "var(--hue-orange)",
  contact: "var(--hue-indigo)", agreement: "var(--hue-slate)",
};
const ICON_PATHS: Record<string, JSX.Element> = {
  deal: <><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></>,
  property: <><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M8 7.5h.01M12 7.5h.01M16 7.5h.01M8 11.5h.01M12 11.5h.01M16 11.5h.01M10 21v-4h4v4" /></>,
  delivery: <><path d="M1 4h13v10H1z" /><path d="M14 8h4l3 3v3h-7" /><circle cx="5.5" cy="17.5" r="2" /><circle cx="17.5" cy="17.5" r="2" /></>,
  case: <path d="M4 4h16v12H8l-4 4z" />,
  koncernmoder: <><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 21v-6h6v6" /></>,
  direktagt_bolag: <><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /></>,
  d2d_lagenhet: <><path d="M3 21h18" /><path d="M6 21V8l6-4 6 4v13" /><rect x="10" y="13" width="4" height="8" /></>,
  contact: <><circle cx="12" cy="8" r="3.4" /><path d="M5 20c1.2-3.6 4-5.4 7-5.4s5.8 1.8 7 5.4" /></>,
  agreement: <><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v3h3" /><line x1="9" y1="12" x2="15" y2="12" /></>,
};
function Ikon({ k, size = 18 }: { k: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[k] ?? <path d="M4 7h16M4 12h16M4 17h10" />}
    </svg>
  );
}

function formatCurrency(value: number, code: string) {
  return new Intl.NumberFormat("sv-SE", { style: "currency", currency: code, maximumFractionDigits: 0 }).format(value);
}

function formatNumber(n: number) {
  return new Intl.NumberFormat("sv-SE").format(n);
}

function relativeDue(iso: string) {
  const diffMs = new Date(iso).getTime() - Date.now();
  const days = Math.round(diffMs / 86400000);
  if (days < 0) return "Försenad";
  if (days === 0) return "Idag";
  if (days === 1) return "Imorgon";
  return `Om ${days} dagar`;
}

function dueUrgency(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const days = Math.round(diffMs / 86400000);
  if (days < 0) return "var(--hue-red)";
  if (days <= 1) return "var(--hue-amber)";
  return "var(--ink-muted)";
}

/* ── Mini donut-diagram (SVG) ─────────────────────────────────────────── */

type Slice = { label: string; count: number; color: string };

function MiniDonut({ slices, total }: { slices: Slice[]; total: number }) {
  const SIZE = 64;
  const R = 24;
  const C = 2 * Math.PI * R;
  let offset = 0;

  if (total === 0) {
    return (
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--surface-sunk)" strokeWidth="8" />
      </svg>
    );
  }

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ transform: "rotate(-90deg)" }}>
      {slices.filter((s) => s.count > 0).map((s) => {
        const pct = s.count / total;
        const dash = pct * C;
        const el = (
          <circle
            key={s.label}
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none"
            stroke={s.color}
            strokeWidth="8"
            strokeDasharray={`${dash} ${C - dash}`}
            strokeDashoffset={-offset}
          >
            <title>{s.label}: {s.count}</title>
          </circle>
        );
        offset += dash;
        return el;
      })}
    </svg>
  );
}

export function DashboardPage({ onOpenObject, onOpenRecord, onOpenCases, onOpenCase, objects }: Props) {
  const [caseSummary, setCaseSummary] = useState<CaseSummary | null>(null);
  const [openCases, setOpenCases] = useState<CaseListItem[] | null>(null);
  useEffect(() => {
    if (!onOpenCases) return;
    getCaseSummary().then(setCaseSummary);
    listCases("open", "", 6).then((r) => setOpenCases(r.items)).catch(() => setOpenCases([]));
  }, [onOpenCases ? 1 : 0]);
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const returnRow = useReturnToRow("dashboard", !!data);
  const defFor = (k: string) => objects?.find((o) => o.key === k);

  useEffect(() => {
    getDashboardSummary()
      .then(setData)
      .catch((e) => setError(e instanceof DataError ? e.message : "Kunde inte hämta översikten."));
  }, []);

  if (error) return <div className="page"><div className="empty-state">{error}</div></div>;
  if (!data) return <div className="page"><div className="kpi-grid">{[0, 1, 2].map((i) => <div key={i} className="card kpi-tile kpi-tile--skeleton" />)}</div></div>;

  const kpis = KPI_ORDER
    .map((k) => data.objects.find((o) => o.key === k))
    .filter((o): o is DashboardSummary["objects"][number] => !!o && o.total > 0)
    .slice(0, 6);
  const caseStatuses = defFor("case")?.statuses ?? [];

  const quick: Array<{ key: string; label: string; hue: string; icon: JSX.Element; run: () => void }> = [
    ...(defFor("deal")?.can.create ? [{ key: "deal", label: "Ny affär", hue: "var(--brand)", icon: <Ikon k="deal" size={16} />, run: () => navigate(["list", "deal"], { ny: "1" }) }] : []),
    ...(onOpenCases ? [{ key: "case", label: "Gå till ärenden", hue: "var(--hue-amber)", icon: <Ikon k="case" size={16} />, run: () => onOpenCases("open") }] : []),
    { key: "tasks", label: "Mina uppgifter", hue: "var(--hue-green)", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 11l2.5 2.5L16 8" /></svg>, run: () => navigate(["tasks"]) },
    { key: "import", label: "Importera data", hue: "var(--hue-orange)", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" /></svg>, run: () => navigate(["import"]) },
  ];

  return (
    <div className="page dashboard">
      {/* Nyckeltal per modul */}
      <div className="kpi-grid">
        {kpis.map((o) => {
          const open = o.statuses.filter((st) => !defFor(o.key)?.statuses.find((x) => x.key === st.key)?.isTerminal).reduce((a, x) => a + x.count, 0);
          return (
            <button className="card kpi-tile" key={o.key} onClick={() => onOpenObject(o.key)} style={{ ["--tile" as string]: KPI_HUE[o.key] ?? "var(--brand)" }}>
              <span className="kpi-tile__icon"><Ikon k={o.key} /></span>
              <span className="kpi-tile__value">{formatNumber(o.total)}</span>
              <span className="kpi-tile__label">{o.labelPlural}</span>
              {o.pipeline && o.pipeline.openValue > 0
                ? <span className="kpi-tile__meta">{formatCurrency(o.pipeline.openValue, o.pipeline.code)} i öppna affärer</span>
                : o.statuses.length > 0 && open !== o.total
                  ? <span className="kpi-tile__meta">{formatNumber(open)} pågående</span>
                  : null}
            </button>
          );
        })}
      </div>

      {/* Små rutor: dagens ärenden och uppgifter */}
      {(caseSummary || data.tasksDueSoon.count > 0) && (
        <div className="mini-grid">
          {caseSummary && onOpenCases && (
            <>
              <button className="mini-tile" onClick={() => onOpenCases("new")}>
                <span className="mini-tile__chip mini-tile__chip--green">↓</span>
                <span><strong>{caseSummary.today.new}</strong><small>Nya ärenden</small></span>
              </button>
              <button className={`mini-tile${caseSummary.today.unassigned > 0 ? " mini-tile--alert" : ""}`} onClick={() => onOpenCases("unassigned")}>
                <span className="mini-tile__chip mini-tile__chip--amber">!</span>
                <span><strong>{caseSummary.today.unassigned}</strong><small>Otilldelade</small></span>
              </button>
              <button className={`mini-tile${caseSummary.today.overdue > 0 ? " mini-tile--alert" : ""}`} onClick={() => onOpenCases("overdue")}>
                <span className="mini-tile__chip mini-tile__chip--red">⏱</span>
                <span><strong>{caseSummary.today.overdue}</strong><small>Försenade</small></span>
              </button>
              <button className="mini-tile" onClick={() => onOpenCases("mine")}>
                <span className="mini-tile__chip mini-tile__chip--blue">◎</span>
                <span><strong>{caseSummary.mine.new + caseSummary.mine.inProgress + caseSummary.mine.waiting}</strong><small>Mina ärenden</small></span>
              </button>
            </>
          )}
          <button className="mini-tile" onClick={() => navigate(["tasks"])}>
            <span className="mini-tile__chip mini-tile__chip--teal">✓</span>
            <span><strong>{data.tasksDueSoon.count}</strong><small>Uppgifter inom 7 dagar</small></span>
          </button>
        </div>
      )}

      <div className="dashboard-grid">
        <div className="dashboard-grid__main">
          {openCases && openCases.length > 0 && onOpenCases && (
            <div className="card panel-card">
              <div className="panel-card__head">
                <h3>Pågående ärenden</h3>
                <button className="linklike" onClick={() => onOpenCases("open")}>Visa alla →</button>
              </div>
              <table className="rtable rtable--compact">
                <thead><tr><th>Ärende</th><th>Kund</th><th>Status</th></tr></thead>
                <tbody>
                  {openCases.map((c) => (
                    <tr key={c.id} className="rtable__row" onClick={() => onOpenCase?.(c.id)}>
                      <td data-label="Ärende">
                        <span className="row-with-chip">
                          <span className="row-chip"><Ikon k="case" size={14} /></span>
                          <span>
                            <span className="rtable__title">{c.title ?? "Ärende"}</span>
                            <span className="rtable__sub">{c.caseNumber}{c.categoryLabel ? ` · ${c.categoryLabel}` : ""}</span>
                          </span>
                        </span>
                      </td>
                      <td data-label="Kund">
                        <span>{c.kundEpost ?? "—"}</span>
                        {(c.fastighet || c.lagenhet) && <span className="rtable__sub">{[c.fastighet, c.lagenhet].filter(Boolean).join(" · ")}</span>}
                      </td>
                      <td data-label="Status"><StatusPill status={c.status} def={caseStatuses.find((x) => x.key === c.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card panel-card">
            <div className="panel-card__head"><h3>Senast uppdaterat</h3></div>
            {data.recent.length === 0 ? (
              <div className="empty-state">Ingen aktivitet ännu.</div>
            ) : (
              <div className="due-list">
                {data.recent.map((r) => (
                  <div className="due-row" key={r.recordId} {...returnRow("r:" + r.recordId)} onClick={() => { rememberRow("dashboard", "r:" + r.recordId); onOpenRecord(r.recordId); }} style={{ cursor: "pointer" }}>
                    <span className="row-with-chip">
                      <span className="row-chip" style={{ color: KPI_HUE[r.objectType] ?? "var(--brand)" }}><Ikon k={r.objectType} size={14} /></span>
                      <span>
                        <span className="due-row__title">{r.title ?? "Namnlös post"}</span>
                        <span className="due-row__meta">{r.objectLabel}</span>
                      </span>
                    </span>
                    <span className="due-row__right">
                      {r.status && <StatusPill status={r.status} def={defFor(r.objectType)?.statuses.find((x) => x.key === r.status)} />}
                      <span className="due-row__when">{new Date(r.updatedAt).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-grid__side">
          <div className="card panel-card">
            <div className="panel-card__head"><h3>Snabbåtgärder</h3></div>
            <div className="quick-actions">
              {quick.map((q) => (
                <button key={q.key} className="quick-action" onClick={q.run}>
                  <span className="quick-action__chip" style={{ ["--tile" as string]: q.hue }}>{q.icon}</span>
                  {q.label}
                </button>
              ))}
            </div>
          </div>

          <div className="card panel-card">
            <div className="panel-card__head">
              <h3>Uppgifter som förfaller</h3>
              {data.tasksDueSoon.items.length > 0 && <span className="count-badge">{data.tasksDueSoon.items.length}</span>}
            </div>
            <div className="panel-card__sub">Inom de närmaste 7 dagarna</div>
            {data.tasksDueSoon.items.length === 0 ? (
              <div className="empty-state">Inget att göra just nu.</div>
            ) : (
              <div className="due-list">
                {data.tasksDueSoon.items.map((t) => (
                  <div
                    className="due-row"
                    key={t.id}
                    {...returnRow("t:" + t.id)}
                    onClick={() => { if (t.recordId) { rememberRow("dashboard", "t:" + t.id); onOpenRecord(t.recordId); } }}
                    style={{ cursor: t.recordId ? "pointer" : "default" }}
                  >
                    <span className="row-with-chip">
                      <span className="due-dot" style={{ background: dueUrgency(t.dueAt) }} />
                      <span>
                        <span className="due-row__title">{t.title}</span>
                        {t.recordTitle && <span className="due-row__meta">{t.recordTitle}</span>}
                      </span>
                    </span>
                    <span className="due-row__when" style={{ color: dueUrgency(t.dueAt) }}>{relativeDue(t.dueAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Statusfördelning per modul */}
      <div className="section-title" style={{ marginTop: "var(--sp-6)" }}>Statusfördelning per modul</div>
      <div className="object-card-grid">
        {data.objects.filter((o) => o.total > 0).map((o) => {
          const slices: Slice[] = o.statuses
            .filter((st) => st.count > 0)
            .map((st) => ({
              label: st.label,
              count: st.count,
              color: st.color ? (st.color.startsWith("#") ? st.color : `var(--hue-${st.color})`) : "var(--border-strong)",
            }));
          return (
            <div className="card object-card" key={o.key} onClick={() => onOpenObject(o.key)}>
              <div className="object-card__header">
                <span className="object-card__title">{o.labelPlural}</span>
                <span className="object-card__total">{formatNumber(o.total)}</span>
              </div>
              {slices.length > 0 && (
                <div className="object-card__chart-row">
                  <MiniDonut slices={slices} total={o.total} />
                  <div className="object-card__legend">
                    {slices.slice(0, 4).map((x) => (
                      <div key={x.label} className="object-card__legend-item">
                        <span className="object-card__legend-dot" style={{ background: x.color }} />
                        <span className="object-card__legend-label">{x.label}</span>
                        <span className="object-card__legend-count">{x.count}</span>
                      </div>
                    ))}
                    {slices.length > 4 && (
                      <div className="object-card__legend-item">
                        <span className="object-card__legend-dot" style={{ background: "var(--ink-faint)" }} />
                        <span className="object-card__legend-label">Övriga</span>
                        <span className="object-card__legend-count">{slices.slice(4).reduce((a, x) => a + x.count, 0)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
