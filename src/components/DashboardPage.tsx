import { useEffect, useState } from "react";
import type { DashboardSummary } from "@/lib/data";
import { getDashboardSummary, DataError } from "@/lib/data";

type Props = {
  onOpenObject: (key: string) => void;
  onOpenRecord: (id: string) => void;
};

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

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "God natt";
  if (h < 12) return "God morgon";
  if (h < 18) return "God eftermiddag";
  return "God kväll";
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

export function DashboardPage({ onOpenObject, onOpenRecord }: Props) {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashboardSummary()
      .then(setData)
      .catch((e) => setError(e instanceof DataError ? e.message : "Kunde inte hämta översikten."));
  }, []);

  if (error) return <div className="page"><div className="empty-state">{error}</div></div>;
  if (!data) return <div className="page"><div className="empty-state">Laddar…</div></div>;

  const withPipeline = data.objects.filter((o) => o.pipeline && o.pipeline.openValue > 0);
  const totalRecords = data.objects.reduce((s, o) => s + o.total, 0);

  return (
    <div className="page">
      {/* Välkomst */}
      <div className="dashboard-greeting">
        <h2>{greeting()}</h2>
        <p>
          {formatNumber(totalRecords)} poster totalt
          {data.tasksDueSoon.items.length > 0
            ? ` · ${data.tasksDueSoon.items.length} uppgifter att ta tag i`
            : ""}
        </p>
      </div>

      {/* KPI-rad */}
      {withPipeline.length > 0 && (
        <div className="kpi-row">
          {withPipeline.map((o) => (
            <div className="card kpi-card" key={o.key} onClick={() => onOpenObject(o.key)}>
              <div className="kpi-card__icon">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 12 5 6 9 9 15 2" />
                  <polyline points="11 2 15 2 15 6" />
                </svg>
              </div>
              <div>
                <div className="kpi-card__label">{o.pipeline!.fieldLabel} · {o.labelPlural}</div>
                <div className="kpi-card__value">{formatCurrency(o.pipeline!.openValue, o.pipeline!.code)}</div>
              </div>
            </div>
          ))}
          {/* Extra KPI: totalt antal poster */}
          <div className="card kpi-card kpi-card--muted">
            <div className="kpi-card__icon">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <line x1="5" y1="6" x2="11" y2="6" />
                <line x1="5" y1="10" x2="9" y2="10" />
              </svg>
            </div>
            <div>
              <div className="kpi-card__label">Totalt poster</div>
              <div className="kpi-card__value">{formatNumber(totalRecords)}</div>
            </div>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <div>
          <div className="section-title">Översikt per objekt</div>
          <div className="object-card-grid">
            {data.objects.map((o) => {
              const slices: Slice[] = o.statuses
                .filter((s) => s.count > 0)
                .map((s) => ({
                  label: s.label,
                  count: s.count,
                  color: s.color ? `var(--hue-${s.color})` : "var(--border-strong)",
                }));

              return (
                <div className="card object-card" key={o.key} onClick={() => onOpenObject(o.key)}>
                  <div className="object-card__header">
                    <span className="object-card__title">{o.labelPlural}</span>
                    <span className="object-card__total">{formatNumber(o.total)}</span>
                  </div>

                  {slices.length > 0 && o.total > 0 && (
                    <div className="object-card__chart-row">
                      <MiniDonut slices={slices} total={o.total} />
                      <div className="object-card__legend">
                        {slices.slice(0, 4).map((s) => (
                          <div key={s.label} className="object-card__legend-item">
                            <span className="object-card__legend-dot" style={{ background: s.color }} />
                            <span className="object-card__legend-label">{s.label}</span>
                            <span className="object-card__legend-count">{s.count}</span>
                          </div>
                        ))}
                        {slices.length > 4 && (
                          <div className="object-card__legend-item">
                            <span className="object-card__legend-dot" style={{ background: "var(--ink-faint)" }} />
                            <span className="object-card__legend-label">Övriga</span>
                            <span className="object-card__legend-count">
                              {slices.slice(4).reduce((s, x) => s + x.count, 0)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Fallback: statusbar om inga statuses men total > 0 */}
                  {slices.length === 0 && o.total > 0 && (
                    <div className="status-bar" style={{ marginTop: "var(--sp-4)" }}>
                      <div className="status-bar__segment" style={{ flexGrow: 1, background: "var(--brand-soft)" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div>
          {/* .section-title ligger utanför kortet, precis som "Översikt per
              objekt" till vänster — annars hamnar kortets egen padding
              ovanpå titeln och skjuter ner det här kortets överkant jämfört
              med kortraden till vänster. Båda kolumnerna ska starta i
              samma höjd. */}
          <div className="section-title">
            Uppgifter som förfaller inom 7 dagar
            {data.tasksDueSoon.items.length > 0 && (
              <span className="section-title__badge">{data.tasksDueSoon.items.length}</span>
            )}
          </div>
          <div className="card">
            {data.tasksDueSoon.items.length === 0 ? (
              <div className="empty-state">Inget att göra just nu.</div>
            ) : (
              <div className="due-list">
                {data.tasksDueSoon.items.map((t) => (
                  <div
                    className="due-row"
                    key={t.id}
                    onClick={() => t.recordId && onOpenRecord(t.recordId)}
                    style={{ cursor: t.recordId ? "pointer" : "default" }}
                  >
                    <div>
                      <div className="due-row__title">{t.title}</div>
                      {t.recordTitle && <div className="due-row__meta">{t.recordTitle}</div>}
                    </div>
                    <div className="due-row__when" style={{ color: dueUrgency(t.dueAt) }}>
                      {relativeDue(t.dueAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section-title" style={{ marginTop: "var(--sp-5)" }}>Senast uppdaterat</div>
          <div className="card">
            {data.recent.length === 0 ? (
              <div className="empty-state">Ingen aktivitet ännu.</div>
            ) : (
              <div className="due-list">
                {data.recent.map((r) => (
                  <div className="due-row" key={r.recordId} onClick={() => onOpenRecord(r.recordId)} style={{ cursor: "pointer" }}>
                    <div>
                      <div className="due-row__title">{r.title ?? "Namnlös post"}</div>
                      <div className="due-row__meta">{r.objectLabel}</div>
                    </div>
                    <div className="due-row__when">
                      {new Date(r.updatedAt).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
