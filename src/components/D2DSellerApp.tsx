import { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getMetadata, listRecords, getRecord, updateRecord, createRecord, addRelation,
  type ObjectDef, type RecordRow, type RelatedRecord, type FieldDef,
  DataError,
} from "@/lib/data";
import { StatusPill } from "./StatusPill";
import { FieldInput } from "@/lib/fields";
import { ThemeToggle } from "@/lib/theme";

// =============================================================================
// Typer & hjälpfunktioner
// =============================================================================

type D2DView =
  | { kind: "fastigheter" }
  | { kind: "signerade" }
  | { kind: "aterkopplingar" }
  | { kind: "fastighet"; id: string }
  | { kind: "lagenhet"; id: string; fastighetId: string };

type KnockStatus = "ej_knackad" | "inte_hemma" | "aterkoppling" | "inte_intresserad" | "intresserad" | "sald" | "ovrigt";

const STATUS_CONFIG: Record<KnockStatus, { label: string; color: string; cssClass: string }> = {
  ej_knackad:       { label: "Ej knackad",       color: "var(--hue-slate)",  cssClass: "d2d-status--slate" },
  inte_hemma:       { label: "Inte hemma",       color: "var(--hue-blue)",   cssClass: "d2d-status--blue" },
  aterkoppling:     { label: "Återkoppling",     color: "var(--hue-amber)",  cssClass: "d2d-status--amber" },
  inte_intresserad: { label: "Inte intresserad", color: "var(--hue-red)",    cssClass: "d2d-status--red" },
  intresserad:      { label: "Intresserad",      color: "var(--hue-green)",  cssClass: "d2d-status--green" },
  sald:             { label: "Såld",             color: "var(--hue-green)",  cssClass: "d2d-status--green-solid" },
  ovrigt:           { label: "Övrigt",           color: "var(--hue-slate)",  cssClass: "d2d-status--slate" },
};

const SECTION_LABELS: Record<string, string> = {
  knackning: "Knackning",
  kunddata: "Kunddata",
  forsaljning: "Försäljning",
};

// =============================================================================
// Fastighetslista
// =============================================================================

function FastighetsLista({
  onOpen,
}: {
  onOpen: (id: string) => void;
}) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // RLS scopar redan d2d_lagenhet till säljarens egna rader (scope
        // "own" för rollen dörrsäljare), så det här visar bara fastigheter
        // där man faktiskt fått adresser tilldelade.
        const lagRes = await listRecords({ objectType: "d2d_lagenhet", limit: 2000 });
        const lagIds = lagRes.items.map((l) => l.id);
        if (lagIds.length === 0) { setItems([]); return; }

        const { data: rels } = await supabase
          .from("relationships")
          .select("to_record_id")
          .eq("rel_type", "d2d_lag_fastighet")
          .in("from_record_id", lagIds);

        const fastIds = Array.from(new Set((rels ?? []).map((r) => r.to_record_id as string)));
        if (fastIds.length === 0) { setItems([]); return; }

        const { data: fastData } = await supabase
          .from("records")
          .select("id,object_type,data,status,owner_user_id,title,created_at,updated_at")
          .in("id", fastIds)
          .order("title");
        setItems((fastData ?? []) as RecordRow[]);
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="d2d-loading">Laddar fastigheter…</div>;

  return (
    <div className="d2d-list">
      <div className="d2d-list__header">
        <h2>Mina fastigheter</h2>
        <span className="d2d-list__count">{items.length} st</span>
      </div>

      {items.length === 0 && (
        <div className="d2d-empty">Inga fastigheter tilldelade ännu.</div>
      )}

      {items.map((item) => {
        const data = item.data as Record<string, unknown>;
        return (
          <button key={item.id} className="d2d-card" onClick={() => onOpen(item.id)}>
            <div className="d2d-card__main">
              <span className="d2d-card__title">{item.title ?? "Namnlös"}</span>
              {!!data.fastighetsbeteckning && (
                <span className="d2d-card__sub">{String(data.fastighetsbeteckning)}</span>
              )}
            </div>
            <div className="d2d-card__meta">
              {!!data.antal_lagenheter && (
                <span className="d2d-card__badge">{String(data.antal_lagenheter)} lgh</span>
              )}
              <StatusPill status={item.status} />
            </div>
            <svg className="d2d-card__chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 4l4 4-4 4"/></svg>
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Fastighetsöversikt med knackvy (lägenhetslista)
// =============================================================================

function FastighetsDetalj({
  fastighetId,
  onBack,
  onOpenLagenhet,
}: {
  fastighetId: string;
  onBack: () => void;
  onOpenLagenhet: (id: string) => void;
}) {
  const [fastighet, setFastighet] = useState<RecordRow | null>(null);
  const [related, setRelated] = useState<RelatedRecord[]>([]);
  const [lagenheter, setLagenheter] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInfo, setShowInfo] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getRecord(fastighetId);
      setFastighet(res.record);
      setRelated(res.related);

      // Hämta lägenhet-IDn från relationer (d2d_lag_fastighet incoming)
      const lagIds = res.related
        .filter((r) => r.record.objectType === "d2d_lagenhet")
        .map((r) => r.record.id);

      if (lagIds.length > 0) {
        // Hämta alla lägenheter med data
        const { data: lagData } = await supabase
          .from("records")
          .select("id,object_type,data,status,owner_user_id,title,created_at,updated_at")
          .in("id", lagIds)
          .order("title");
        setLagenheter((lagData ?? []) as RecordRow[]);
      } else {
        setLagenheter([]);
      }
    } catch {
      // tyst
    } finally {
      setLoading(false);
    }
  }, [fastighetId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Knackprogress
  const stats = useMemo(() => {
    const s: Record<string, number> = {};
    for (const l of lagenheter) {
      const st = l.status ?? "ej_knackad";
      s[st] = (s[st] ?? 0) + 1;
    }
    return s;
  }, [lagenheter]);

  const total = lagenheter.length;
  const knocked = total - (stats.ej_knackad ?? 0);

  if (loading) return <div className="d2d-loading">Laddar…</div>;
  if (!fastighet) return <div className="d2d-empty">Fastigheten hittades inte.</div>;

  const data = fastighet.data as Record<string, unknown>;

  return (
    <div className="d2d-detail">
      {/* Topbar */}
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>{fastighet.title ?? "Fastighet"}</h2>
          {!!data.fastighetsbeteckning && (
            <span className="d2d-topbar__sub">{String(data.fastighetsbeteckning)}</span>
          )}
        </div>
        <button className="d2d-info-toggle" onClick={() => setShowInfo(!showInfo)}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="10" cy="10" r="7"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r=".8" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>

      {/* Viktig info (varning) */}
      {!!data.viktigt_info && (
        <div className="d2d-warning">
          <strong>Viktigt inför knackning</strong>
          <p>{String(data.viktigt_info)}</p>
        </div>
      )}

      {/* Info-panel (toggle) */}
      {showInfo && (
        <div className="d2d-info-panel">
          {!!data.portkod && <div className="d2d-info-row"><span className="d2d-info-label">Portkod</span><span>{String(data.portkod)}</span></div>}
          {!!data.forvaltare && <div className="d2d-info-row"><span className="d2d-info-label">Förvaltare</span><span>{String(data.forvaltare)}</span></div>}
          {!!data.fastighetsagare && <div className="d2d-info-row"><span className="d2d-info-label">Ägare</span><span>{String(data.fastighetsagare)}</span></div>}
          {!!data.befintligt_nat && <div className="d2d-info-row"><span className="d2d-info-label">Befintligt nät</span><span>{String(data.befintligt_nat)}</span></div>}
          {!!data.nuvarande_tv && <div className="d2d-info-row"><span className="d2d-info-label">Nuvarande TV</span><span>{String(data.nuvarande_tv)}</span></div>}
          {!!data.nytt_tv_installation && <div className="d2d-info-row"><span className="d2d-info-label">Nytt TV vid inst.</span><span>{String(data.nytt_tv_installation)}</span></div>}
          {!!data.tilltradesinstruktion && <div className="d2d-info-row"><span className="d2d-info-label">Tillträde</span><span>{String(data.tilltradesinstruktion)}</span></div>}
        </div>
      )}

      {/* Progress */}
      <div className="d2d-progress">
        <div className="d2d-progress__header">
          <span className="d2d-progress__label">Knackprogress</span>
          <span className="d2d-progress__numbers">{knocked}/{total}</span>
        </div>
        <div className="d2d-progress__bar">
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
            const count = stats[key] ?? 0;
            if (count === 0 || total === 0) return null;
            return (
              <div
                key={key}
                className="d2d-progress__segment"
                style={{ width: `${(count / total) * 100}%`, background: cfg.color }}
                title={`${cfg.label}: ${count}`}
              />
            );
          })}
        </div>
        <div className="d2d-progress__legend">
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
            const count = stats[key] ?? 0;
            if (count === 0) return null;
            return (
              <span key={key} className="d2d-progress__legend-item">
                <span className="d2d-progress__dot" style={{ background: cfg.color }} />
                {cfg.label} ({count})
              </span>
            );
          })}
        </div>
      </div>

      {/* Lägenhetslista */}
      <div className="d2d-lag-list">
        <div className="d2d-lag-list__header">
          <h3>Lägenheter</h3>
          <span>{total} st</span>
        </div>

        {lagenheter.length === 0 && (
          <div className="d2d-empty">Inga lägenheter registrerade.</div>
        )}

        {lagenheter.map((lag) => {
          const lagData = lag.data as Record<string, unknown>;
          const st = (lag.status ?? "ej_knackad") as KnockStatus;
          const cfg = STATUS_CONFIG[st] ?? STATUS_CONFIG.ej_knackad;
          return (
            <button
              key={lag.id}
              className={`d2d-lag-card ${cfg.cssClass}`}
              onClick={() => onOpenLagenhet(lag.id)}
            >
              <div className="d2d-lag-card__status-dot" style={{ background: cfg.color }} />
              <div className="d2d-lag-card__main">
                <span className="d2d-lag-card__title">{lag.title ?? "—"}</span>
                {!!lagData.kund_namn && (
                  <span className="d2d-lag-card__sub">{String(lagData.kund_namn)}</span>
                )}
                {!!lagData.kommentar && (
                  <span className="d2d-lag-card__comment">{String(lagData.kommentar).slice(0, 60)}{String(lagData.kommentar).length > 60 ? "…" : ""}</span>
                )}
              </div>
              <span className="d2d-lag-card__badge">{cfg.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Lägenhetformulär (knackvy)
// =============================================================================

function LagenhetForm({
  lagenhetId,
  fastighetId,
  objectDef,
  onBack,
}: {
  lagenhetId: string;
  fastighetId: string;
  objectDef: ObjectDef | undefined;
  onBack: () => void;
}) {
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await getRecord(lagenhetId);
        setRecord(res.record);
        setData({ ...res.record.data });
        setStatus(res.record.status);
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, [lagenhetId]);

  const set = (key: string) => (value: unknown) => {
    setData((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setSaveOk(false);
  };

  async function save() {
    if (!record) return;
    setSaving(true);
    setError(null);
    try {
      const row = await updateRecord(record.id, data, status);
      setRecord(row);
      setData({ ...row.data });
      setStatus(row.status);
      setDirty(false);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="d2d-loading">Laddar…</div>;
  if (!record) return <div className="d2d-empty">Lägenheten hittades inte.</div>;

  // Gruppera fält per sektion (dölj ai-sektionen)
  const fields = objectDef?.fields.filter((f) => f.options.section !== "ai") ?? [];

  type FieldGroup = { section: string | null; label: string | null; fields: FieldDef[] };
  const groups: FieldGroup[] = [];
  let current: FieldGroup | null = null;
  for (const f of fields) {
    const sec = f.options.section ?? null;
    if (!current || current.section !== sec) {
      current = { section: sec, label: sec ? (SECTION_LABELS[sec] ?? sec) : null, fields: [] };
      groups.push(current);
    }
    current.fields.push(f);
  }

  return (
    <div className="d2d-detail">
      {/* Topbar */}
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>Lgh {record.title ?? "—"}</h2>
        </div>
      </div>

      {/* Statusväljare — stora knappar */}
      <div className="d2d-status-picker">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <button
            key={key}
            className={`d2d-status-btn ${cfg.cssClass}${status === key ? " d2d-status-btn--active" : ""}`}
            onClick={() => { setStatus(key); setDirty(true); setSaveOk(false); }}
          >
            {cfg.label}
          </button>
        ))}
      </div>

      {/* Formulärfält */}
      <div className="d2d-form">
        {groups.map((group, gi) => (
          <div key={group.section ?? gi} className="d2d-form-section">
            {group.label && <h3 className="d2d-form-section__title">{group.label}</h3>}
            {group.fields.map((f) => (
              <FieldInput key={f.key} field={f} value={data[f.key]} onChange={set(f.key)} />
            ))}
          </div>
        ))}
      </div>

      {/* Spara */}
      {error && <div className="d2d-error">{error}</div>}
      <div className="d2d-save-bar">
        <button className="btn btn--brand d2d-save-btn" onClick={save} disabled={saving || !dirty}>
          {saving ? "Sparar…" : "Spara"}
        </button>
        {saveOk && <span className="d2d-save-ok">✓ Sparat</span>}
      </div>
    </div>
  );
}

// =============================================================================
// Signerade kunder (filtrerad vy)
// =============================================================================

function SigneradeLista({
  onOpenLagenhet,
}: {
  onOpenLagenhet: (id: string, fastighetId: string) => void;
}) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await listRecords({ objectType: "d2d_lagenhet", status: "sald", limit: 200 });
        setItems(res.items);
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="d2d-loading">Laddar…</div>;

  return (
    <div className="d2d-list">
      <div className="d2d-list__header">
        <h2>Signerade kunder</h2>
        <span className="d2d-list__count">{items.length} st</span>
      </div>

      {items.length === 0 && (
        <div className="d2d-empty">Inga signerade kunder ännu.</div>
      )}

      {items.map((item) => {
        const data = item.data as Record<string, unknown>;
        return (
          <button key={item.id} className="d2d-card d2d-card--signed" onClick={() => onOpenLagenhet(item.id, "")}>
            <div className="d2d-card__main">
              <span className="d2d-card__title">Lgh {item.title ?? "—"}</span>
              {!!data.kund_namn && <span className="d2d-card__sub">{String(data.kund_namn)}</span>}
              {!!data.produkt && <span className="d2d-card__meta-text">{String(data.produkt)}</span>}
            </div>
            {!!data.sald_datum && <span className="d2d-card__date">{String(data.sald_datum)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Återkopplingslista
// =============================================================================

function AterkopplingarLista({
  onOpenLagenhet,
}: {
  onOpenLagenhet: (id: string, fastighetId: string) => void;
}) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await listRecords({ objectType: "d2d_lagenhet", status: "aterkoppling", limit: 200 });
        setItems(res.items);
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="d2d-loading">Laddar…</div>;

  return (
    <div className="d2d-list">
      <div className="d2d-list__header">
        <h2>Återkopplingar</h2>
        <span className="d2d-list__count">{items.length} st</span>
      </div>

      {items.length === 0 && (
        <div className="d2d-empty">Inga återkopplingar att visa.</div>
      )}

      {items.map((item) => {
        const data = item.data as Record<string, unknown>;
        return (
          <button key={item.id} className="d2d-card d2d-card--callback" onClick={() => onOpenLagenhet(item.id, "")}>
            <div className="d2d-card__main">
              <span className="d2d-card__title">Lgh {item.title ?? "—"}</span>
              {!!data.kund_namn && <span className="d2d-card__sub">{String(data.kund_namn)}</span>}
              {!!data.kommentar && (
                <span className="d2d-card__comment">{String(data.kommentar).slice(0, 80)}{String(data.kommentar).length > 80 ? "…" : ""}</span>
              )}
            </div>
            {!!data.aterkoppling_datum && <span className="d2d-card__date">{String(data.aterkoppling_datum)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Huvudkomponent — D2D Seller App
// =============================================================================

export function D2DSellerApp({ onExitD2D }: { onExitD2D?: () => void }) {
  const [view, setView] = useState<D2DView>({ kind: "fastigheter" });
  const [objects, setObjects] = useState<ObjectDef[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMetadata()
      .then((res) => setObjects(res.objects))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const lagDef = objects.find((o) => o.key === "d2d_lagenhet");

  // ── Navigering
  const navTab = view.kind === "signerade" ? "signerade" : view.kind === "aterkopplingar" ? "aterkopplingar" : "fastigheter";

  function renderContent() {
    switch (view.kind) {
      case "fastigheter":
        return <FastighetsLista onOpen={(id) => setView({ kind: "fastighet", id })} />;

      case "fastighet":
        return (
          <FastighetsDetalj
            fastighetId={view.id}
            onBack={() => setView({ kind: "fastigheter" })}
            onOpenLagenhet={(id) => setView({ kind: "lagenhet", id, fastighetId: view.id })}
          />
        );

      case "lagenhet":
        return (
          <LagenhetForm
            lagenhetId={view.id}
            fastighetId={view.fastighetId}
            objectDef={lagDef}
            onBack={() => {
              if (view.fastighetId) {
                setView({ kind: "fastighet", id: view.fastighetId });
              } else {
                setView({ kind: "fastigheter" });
              }
            }}
          />
        );

      case "signerade":
        return (
          <SigneradeLista
            onOpenLagenhet={(id, fId) => setView({ kind: "lagenhet", id, fastighetId: fId })}
          />
        );

      case "aterkopplingar":
        return (
          <AterkopplingarLista
            onOpenLagenhet={(id, fId) => setView({ kind: "lagenhet", id, fastighetId: fId })}
          />
        );
    }
  }

  if (loading) return <div className="d2d-loading">Laddar D2D…</div>;

  // Är vi i en detaljvy? Visa inte bottom-nav
  const inDetail = view.kind === "fastighet" || view.kind === "lagenhet";

  return (
    <div className="d2d-app">
      {/* Top header */}
      <div className="d2d-header">
        <div className="d2d-header__brand">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 8l7-5 7 5v8a1 1 0 01-1 1H4a1 1 0 01-1-1V8z"/>
            <path d="M8 17V11h4v6"/>
          </svg>
          Door 2 Door
        </div>
        <div className="d2d-header__actions">
          <ThemeToggle />
          {onExitD2D && (
            <button className="btn btn--ghost btn--sm" onClick={onExitD2D}>CRM</button>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => supabase.auth.signOut()}>Logga ut</button>
        </div>
      </div>

      {/* Innehåll */}
      <div className="d2d-content">
        {renderContent()}
      </div>

      {/* Bottom nav (döljs i detaljvy) */}
      {!inDetail && (
        <nav className="d2d-bottom-nav">
          <button
            className={`d2d-nav-btn${navTab === "fastigheter" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "fastigheter" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="14" height="14" rx="2"/>
              <line x1="3" y1="10" x2="17" y2="10"/>
              <line x1="10" y1="3" x2="10" y2="17"/>
            </svg>
            Fastigheter
          </button>
          <button
            className={`d2d-nav-btn${navTab === "signerade" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "signerade" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M5 10l3 3 7-7"/>
            </svg>
            Signerade
          </button>
          <button
            className={`d2d-nav-btn${navTab === "aterkopplingar" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "aterkopplingar" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 10a7 7 0 0114 0"/>
              <path d="M3 10l3-3m-3 3l3 3"/>
            </svg>
            Återkoppling
          </button>
        </nav>
      )}
    </div>
  );
}
