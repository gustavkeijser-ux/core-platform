import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { ObjectDef, RecordFilter, StatusDef } from "@/lib/data";
import { useTenantUsers } from "@/lib/users";
import { useRoute, navigate } from "@/lib/route";
import type { StatusCounts } from "@/lib/statusCounts";
import { ObjectListPage } from "./ObjectListPage";
import { EmptyState, SkeletonRows, TopbarActions } from "./PageChrome";

/* =============================================================================
   Door to door → Lägenheter.
   Först en översikt: ett kort per projekt med antal lägenheter per status och
   vilka säljare som har dem. Klick på ett projekt → bara de lägenheterna
   (vanliga listan, med filter, markera och byt säljare). "Visa alla
   lägenheter" → alla projekt i samma lista.
   ========================================================================== */

type Projekt = {
  id: string | null; title: string; projektStatus: string | null;
  total: number; fastigheter: number; utanSaljare: number;
  statusar: Record<string, number>;
  saljare: Array<{ id: string; antal: number }>;
};

const ALLA = "alla";

const hue = (s?: StatusDef) =>
  !s?.color ? "var(--ink-faint)" : s.color.startsWith("#") ? s.color : `var(--hue-${s.color})`;

export function D2DLagenheterPage({ objectDef, projektDef, onOpenRecord, onMetadataChanged, reloadKey }: {
  objectDef: ObjectDef;
  projektDef?: ObjectDef;
  onOpenRecord: (id: string) => void;
  onMetadataChanged?: () => void;
  reloadKey?: number;
}) {
  const route = useRoute();
  const valt = route.query.get("projekt");
  const [data, setData] = useState<Projekt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const users = useTenantUsers();
  const namn = useMemo(() => new Map(users.map((u) => [u.id, u.name])), [users]);

  const load = useCallback(async () => {
    const { data: d, error: err } = await supabase.rpc("d2d_lagenhet_oversikt");
    if (err) { setError(err.message); return; }
    setData((d ?? []) as Projekt[]); setError(null);
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);

  // Ändringar i listan (status, säljare) → räkna om, men högst en gång per sekund.
  const t = useRef<number | null>(null);
  const reloadSoon = useCallback(() => {
    if (t.current) window.clearTimeout(t.current);
    t.current = window.setTimeout(() => { void load(); }, 800);
  }, [load]);
  useEffect(() => () => { if (t.current) window.clearTimeout(t.current); }, []);

  const statuses = objectDef.statuses;
  const statusFor = (k: string) => statuses.find((s) => s.key === k);
  const order = (rec: Record<string, number>) => [
    ...statuses.filter((s) => (rec[s.key] ?? 0) > 0).map((s) => ({ key: s.key, n: rec[s.key], def: s as StatusDef | undefined })),
    ...Object.entries(rec).filter(([k, n]) => n > 0 && !statusFor(k)).map(([k, n]) => ({ key: k, n, def: undefined })),
  ];

  const summa = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let total = 0, utan = 0;
    for (const p of data ?? []) {
      total += p.total; utan += p.utanSaljare;
      for (const [k, n] of Object.entries(p.statusar)) byStatus[k] = (byStatus[k] ?? 0) + n;
    }
    return { total, utan, byStatus };
  }, [data]);

  const open = (id: string) => navigate(["list", objectDef.key], { projekt: id });
  const back = () => navigate(["list", objectDef.key]);

  // ── Lägenheterna i ett projekt (eller alla) ─────────────────────────
  if (valt) {
    const p = valt === ALLA ? null : data?.find((x) => x.id === valt);
    const counts: StatusCounts | null = valt === ALLA
      ? (data ? { total: summa.total, byStatus: summa.byStatus } : null)
      : p ? { total: p.total, byStatus: p.statusar } : null;
    const baseFilters: RecordFilter[] = valt === ALLA ? [] : [{ field: "__related", op: "eq", value: valt }];
    return (
      <ObjectListPage
        key={valt}
        objectDef={objectDef}
        onOpenRecord={onOpenRecord}
        onMetadataChanged={onMetadataChanged}
        reloadKey={reloadKey}
        baseFilters={baseFilters}
        stateKeySuffix={`:${valt}`}
        countsOverride={counts}
        onDataChanged={reloadSoon}
        banner={
          <div className="d2dov-crumb">
            <button type="button" className="btn btn--ghost btn--sm" onClick={back}>← Alla projekt</button>
            <span className="d2dov-crumb__title">
              {valt === ALLA ? "Alla lägenheter" : p?.title ?? (data ? "Okänt projekt" : "…")}
            </span>
            {p && <span className="d2dov-crumb__meta">{p.fastigheter} fastigheter · {p.total} lägenheter
              {p.utanSaljare > 0 && <> · <span className="d2dov-warn">{p.utanSaljare} utan säljare</span></>}</span>}
          </div>
        }
      />
    );
  }

  // ── Översikt per projekt ─────────────────────────────────────────────
  const projektStatus = (k: string | null) => projektDef?.statuses.find((s) => s.key === k);
  const pos = (k: string) => summa.byStatus[k] ?? 0;
  const besokta = summa.total - pos("ej_knackad");

  return (
    <div className="page d2dov">
      <TopbarActions>
        <button type="button" className="btn btn--brand" onClick={() => open(ALLA)} disabled={!data || data.length === 0}>
          Visa alla lägenheter
        </button>
      </TopbarActions>

      {error && (
        <div className="card">
          <EmptyState kind="error" title="Kunde inte hämta översikten" text={error}
            action={<button className="btn btn--danger btn--sm" onClick={() => void load()}>Försök igen</button>} />
        </div>
      )}

      {!error && data == null && <div className="card"><SkeletonRows rows={4} /></div>}

      {data && data.length === 0 && (
        <div className="card">
          <EmptyState title="Inga lägenheter än" text="Lägenheter dyker upp här när ett D2D-projekt har fått adresser." />
        </div>
      )}

      {data && data.length > 0 && (
        <>
          <div className="d2dov-kpis">
            <div className="card d2dov-kpi"><div className="d2dov-kpi__label">Lägenheter</div><div className="d2dov-kpi__value">{summa.total}</div></div>
            <div className="card d2dov-kpi"><div className="d2dov-kpi__label">Knackade</div><div className="d2dov-kpi__value">{besokta}<small> / {summa.total}</small></div></div>
            <div className="card d2dov-kpi"><div className="d2dov-kpi__label">Intresserade</div><div className="d2dov-kpi__value" style={{ color: "var(--hue-green)" }}>{pos("intresserad")}</div></div>
            <div className="card d2dov-kpi"><div className="d2dov-kpi__label">Sålda</div><div className="d2dov-kpi__value" style={{ color: "var(--hue-green)" }}>{pos("sald")}</div></div>
            <div className="card d2dov-kpi"><div className="d2dov-kpi__label">Utan säljare</div><div className={`d2dov-kpi__value${summa.utan ? " d2dov-warn" : ""}`}>{summa.utan}</div></div>
          </div>

          <div className="d2dov-head">
            <h2>Projekt</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => open(ALLA)}>Visa alla lägenheter →</button>
          </div>

          <div className="d2dov-grid">
            {data.map((p) => {
              const st = order(p.statusar);
              const knackade = p.total - (p.statusar.ej_knackad ?? 0);
              const ps = projektStatus(p.projektStatus);
              const clickable = !!p.id;
              const body = (
                <>
                  <div className="d2dov-card__top">
                    <div className="d2dov-card__title">{p.title}</div>
                    {ps && <span className="d2dov-chip" style={{ ["--c" as string]: hue(ps) }}>{ps.label}</span>}
                  </div>
                  <div className="d2dov-card__meta">
                    {p.id ? `${p.fastigheter} fastigheter · ` : ""}<strong>{p.total}</strong> lägenheter · {knackade} knackade
                    {p.total > 0 && <> ({Math.round(knackade * 100 / p.total)} %)</>}
                  </div>

                  <div className="d2dov-bar" role="img" aria-label={st.map((s) => `${s.def?.label ?? s.key} ${s.n}`).join(", ")}>
                    {st.map((s) => (
                      <span key={s.key} style={{ flexGrow: s.n, background: hue(s.def) }} title={`${s.def?.label ?? s.key}: ${s.n}`} />
                    ))}
                  </div>

                  <ul className="d2dov-legend">
                    {st.map((s) => (
                      <li key={s.key}>
                        <span className="d2dov-dot" style={{ background: hue(s.def) }} />
                        <span className="d2dov-legend__label">{s.def?.label ?? s.key}</span>
                        <span className="d2dov-legend__n">{s.n}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="d2dov-sellers">
                    {p.saljare.map((s) => (
                      <span key={s.id} className="d2dov-seller">{namn.get(s.id) ?? "…"} <b>{s.antal}</b></span>
                    ))}
                    {p.utanSaljare > 0 && <span className="d2dov-seller d2dov-seller--none">Utan säljare <b>{p.utanSaljare}</b></span>}
                  </div>
                  {!clickable && <div className="d2dov-note">Lägenheter som inte hör till något projekt. Finns med under Visa alla lägenheter.</div>}
                </>
              );
              return clickable ? (
                <button key={p.id} type="button" className="card d2dov-card" onClick={() => open(p.id!)}>
                  {body}
                  <span className="d2dov-card__go">Visa lägenheterna →</span>
                </button>
              ) : (
                <div key="__none" className="card d2dov-card d2dov-card--static">{body}</div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
