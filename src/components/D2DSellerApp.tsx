import { useEffect, useState, useCallback, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getMetadata, listRecords, getRecord, updateRecord, createRecord, addRelation,
  type ObjectDef, type RecordRow, type RelatedRecord, type FieldDef,
  DataError,
} from "@/lib/data";
import { StatusPill } from "./StatusPill";
import { FieldInput } from "@/lib/fields";
import { ThemeToggle, useTheme } from "@/lib/theme";
import { brandCssVars } from "@/lib/color";

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

// Statusar som INTE ska visas som egna bubblor i statusväljaren högst upp —
// "Intresserad" är för löst definierat för att vara en egen slutstatus
// (jfr "Såld"), så den plockas bort ur väljaren men finns kvar i
// STATUS_CONFIG eftersom befintliga poster kan ha statusen satt sedan innan.
const HIDDEN_STATUS_PICKS = new Set<KnockStatus>(["intresserad"]);

// Anledningar säljaren kan välja mellan när en lägenhet markeras
// "Inte intresserad" — låter statistiken brytas ner senare i CRM:et.
const EJ_INTRESSERAD_REASONS: Array<{ key: string; label: string }> = [
  { key: "for_gammal",         label: "För gammal" },
  { key: "bindningstid",       label: "Bindningstid" },
  { key: "flyttar",            label: "Flyttar" },
  { key: "saknar_behov",       label: "Saknar behov" },
  { key: "dalig_ekonomi",      label: "Dålig ekonomi" },
  { key: "vill_inte_ha_fiber", label: "Vill inte ha fiber" },
];

/** Fullständig adress för en lägenhetspost — gatunamn, gatunummer och
 *  lägenhetsnummer tillsammans, t.ex. "Storgatan 12, lgh 14A". Används
 *  överallt en lägenhet visas i säljarvyn så säljaren aldrig behöver gissa
 *  vilken dörr en rad i en lista syftar på. Faller tillbaka till bara
 *  lägenhetsnumret om adressfälten saknas (t.ex. äldre poster). */
function formatLagenhetAdress(data: Record<string, unknown>, title: string | null | undefined): string {
  const gatuadress = [data.gatunamn, data.gatunummer].filter(Boolean).join(" ");
  const medIngang = data.ingang
    ? `${gatuadress}${gatuadress ? ", " : ""}ingång ${String(data.ingang)}`
    : gatuadress;
  return medIngang ? `${medIngang}, lgh ${title ?? "—"}` : `Lgh ${title ?? "—"}`;
}

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

  const total = lagenheter.length;

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
      </div>

      {/* Viktig info (varning) */}
      {!!data.viktigt_info && (
        <div className="d2d-warning">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="d2d-warning__icon"><path d="M10 2.5l7 3.2v4c0 4.2-2.9 7.6-7 8.8-4.1-1.2-7-4.6-7-8.8v-4l7-3.2Z"/></svg>
          <div>
            <strong>Viktigt inför knackning</strong>
            <p>{String(data.viktigt_info)}</p>
          </div>
        </div>
      )}

      {/* Fastighetsinfo — ersätter den gamla knackprogress-stapeln. Detta är
          generella, ganska statiska fakta om fastighetens infrastruktur
          (sätts av projektledare/admin), inte adress-specifika värden —
          adresser kan avvika i praktiken men detta är utgångsläget. */}
      <div className="d2d-infobox">
        <div className="d2d-infobox__header">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="10" cy="10" r="7"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r=".8" fill="currentColor" stroke="none"/></svg>
          <span>Fastighetsinfo</span>
        </div>
        <div className="d2d-infobox__grid">
          {!!data.fastighetsagare && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Fastighetsägare</span><span>{String(data.fastighetsagare)}</span></div>}
          {!!data.portkod && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Portkod</span><span>{String(data.portkod)}</span></div>}
          {!!data.befintlig_fiber && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Befintlig fiber</span><span>{String(data.befintlig_fiber)}</span></div>}
          {!!data.befintlig_koax && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Befintlig koax</span><span>{String(data.befintlig_koax)}</span></div>}
          {!!data.avtalstid_koax && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Avslutsdatum koax</span><span>{String(data.avtalstid_koax)}</span></div>}
          {!!data.installationsdatum && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Installationsdatum</span><span>{String(data.installationsdatum)}</span></div>}
          {!!data.nuvarande_tv && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Befintligt kanalpaket</span><span>{String(data.nuvarande_tv)}</span></div>}
          {!!data.nytt_tv_installation && <div className="d2d-infobox__row"><span className="d2d-infobox__label">Nytt kanalpaket</span><span>{String(data.nytt_tv_installation)}</span></div>}
          {!data.fastighetsagare && !data.portkod && !data.befintlig_fiber && !data.befintlig_koax
            && !data.avtalstid_koax && !data.installationsdatum && !data.nuvarande_tv && !data.nytt_tv_installation && (
            <div className="d2d-infobox__empty">Ingen fastighetsinfo ifylld ännu.</div>
          )}
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
                <span className="d2d-lag-card__title">{formatLagenhetAdress(lagData, lag.title)}</span>
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

  // Adress-header — statisk text, inte redigerbar. Ger säljaren snabb
  // kontext om vilken lägenhet/adress hen faktiskt står i just nu. Rubriken
  // visar alltid fullständig adress: gatunamn, gatunummer OCH lägenhetsnummer
  // tillsammans, aldrig bara ett av dem.
  const fullAdress = formatLagenhetAdress(data, record.title);
  const ortRad = [data.postnummer, data.postort].filter(Boolean).join(" ");
  const headerUndertext = [
    ortRad || null,
    data.fastighetsbeteckning ? String(data.fastighetsbeteckning) : null,
  ].filter(Boolean).join(" · ");

  // Gruppera fält per sektion (dölj ai-sektionen samt de interna fälten för
  // "inte intresserad"-anledning, som hanteras av sitt eget UI nedan i
  // stället för att dyka upp som ett generiskt formulärfält).
  const fields = objectDef?.fields.filter((f) =>
    f.options.section !== "ai"
    && f.key !== "ej_intresserad_anledning"
    && f.key !== "ej_intresserad_bindningstid"
  ) ?? [];

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
      {/* Topbar — adress/lägenhet som statisk text, inte en redigerbar
          ruta, bara kontext om var säljaren står just nu. */}
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>{fullAdress}</h2>
          {!!headerUndertext && <span className="d2d-topbar__sub">{headerUndertext}</span>}
        </div>
      </div>

      {/* Statusväljare — stora knappar */}
      <div className="d2d-status-picker">
        {Object.entries(STATUS_CONFIG)
          .filter(([key]) => !HIDDEN_STATUS_PICKS.has(key as KnockStatus))
          .map(([key, cfg]) => (
            <button
              key={key}
              className={`d2d-status-btn ${cfg.cssClass}${status === key ? " d2d-status-btn--active" : ""}`}
              onClick={() => {
                setStatus(key);
                setDirty(true);
                setSaveOk(false);
              }}
            >
              {cfg.label}
            </button>
          ))}
      </div>

      {/* Anledning — visas så fort statusen är "Inte intresserad", så
          säljaren måste (eller i alla fall enkelt kan) ange varför. */}
      {status === "inte_intresserad" && (
        <div className="d2d-reason-panel">
          <span className="label">Anledning</span>
          <div className="d2d-reason-panel__chips">
            {EJ_INTRESSERAD_REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`d2d-reason-chip${data.ej_intresserad_anledning === r.key ? " d2d-reason-chip--active" : ""}`}
                onClick={() => set("ej_intresserad_anledning")(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {data.ej_intresserad_anledning === "bindningstid" && (
            <div className="d2d-reason-panel__date">
              <label htmlFor="ej-intresserad-bindningstid" className="label">
                Bindningstid löper ut
              </label>
              <input
                id="ej-intresserad-bindningstid"
                className="input"
                type="text"
                placeholder="ÅÅÅÅ-MM-DD, ÅÅÅÅ-MM eller ÅÅÅÅ"
                value={String(data.ej_intresserad_bindningstid ?? "")}
                onChange={(e) => set("ej_intresserad_bindningstid")(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

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
              <span className="d2d-card__title">{formatLagenhetAdress(data, item.title)}</span>
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
              <span className="d2d-card__title">{formatLagenhetAdress(data, item.title)}</span>
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
  const [brandColor, setBrandColor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const { theme } = useTheme();

  useEffect(() => {
    getMetadata()
      .then((res) => {
        setObjects(res.objects);
        setBrandColor(res.tenant?.brandColor ?? undefined);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Samma varumärkesfärg som resten av CRM:et (satt av admin i Inställningar
  // → Utseende) — annars föll D2D-säljarvyn tillbake på standardlila, vilket
  // stack ut mot resten av appen.
  const brandVars = brandColor ? brandCssVars(brandColor, theme === "light") : undefined;

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
    <div className="d2d-app" style={brandVars as CSSProperties}>
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
