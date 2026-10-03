import { useEffect, useState, useCallback, useMemo } from "react";
import type { ObjectDef, RecordRow, RelatedRecord, FieldDef, RelationDef } from "@/lib/data";
import { getRecord, createRecord, updateRecord, addRelation, pendingRequiredItems, DataError } from "@/lib/data";
import type { PendingItem } from "@/lib/data";
import { FieldInput } from "@/lib/fields";
import { StatusPill } from "./StatusPill";
import { RelationPicker } from "./RelationPicker";
import { UserBadge } from "@/lib/users";
import { CreateDealDialog } from "./CreateDealDialog";
import { FieldConfigPanel } from "./FieldConfigPanel";
import { CommunicationTab } from "./CommunicationTab";
import { ChecklistTab } from "./ChecklistTab";
import { TaskTab } from "./TaskTab";
import { LyftAffarTab } from "./LyftAffarTab";
import { DealFollowUp } from "./DealFollowUp";
import { FmoTab } from "./FmoTab";
import { TeliaLagenheterTab } from "./TeliaLagenheterTab";

/** Fält som styrs via egen UI på affärskortet, inte via det generiska formuläret. */
const DEAL_CUSTOM_FIELDS = new Set([
  "affarsstatus", "lyft_affar", "signeringssteg",
  // Sköts av uppföljningspanelen (DealFollowUp) högst upp på kortet.
  "nasta_steg", "nasta_steg_datum", "senaste_kontakt",
]);

const AFFARSSTATUS_KNAPPAR: Array<{ key: string; label: string }> = [
  { key: "avvakta", label: "Avvakta" },
  { key: "ej_aktuell", label: "Ej aktuell" },
  { key: "lyft_affar", label: "Lyft affär" },
];

const SIGNERINGS_KNAPPAR: Array<{ key: string; label: string }> = [
  { key: "skicka_for_sign", label: "Skicka för sign" },
  { key: "nej", label: "Nej" },
  { key: "avvakta", label: "Avvakta" },
];

type Props = {
  objectDef: ObjectDef;
  record?: RecordRow | null;
  recordId?: string;
  objectDefFor?: (type: string) => ObjectDef | undefined;
  onClose: () => void;
  onSaved: (row: RecordRow) => void;
  onNavigate?: (id: string) => void;
  onMetadataChanged?: () => void;
  /** "page" = posten som egen sida (brödsmulor, rubrik, flikar med antal,
   *  kort) som i förvaltarpanelen. "drawer" (standard) = panelen från höger,
   *  används för att skapa nya poster. */
  variant?: "drawer" | "page";
  /** Brödsmulans första led → objektets lista. */
  onOpenList?: (objectKey: string) => void;
  /** Administratörer kan svara på FMO-check direkt i affären. */
  isAdmin?: boolean;
};

const SVG_PROPS = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
/** Ikon i rubrikens ikonruta, per objekttyp. */
function ObjectIcon({ objectKey }: { objectKey: string }) {
  switch (objectKey) {
    case "deal": return <svg {...SVG_PROPS}><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>;
    case "property": case "d2d_fastighet": return <svg {...SVG_PROPS}><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M8 7.5h.01M12 7.5h.01M16 7.5h.01M8 11.5h.01M12 11.5h.01M16 11.5h.01M10 21v-4h4v4" /></svg>;
    case "d2d_lagenhet": return <svg {...SVG_PROPS}><path d="M3 21h18" /><path d="M6 21V8l6-4 6 4v13" /><rect x="10" y="13" width="4" height="8" /></svg>;
    case "contact": return <svg {...SVG_PROPS}><circle cx="12" cy="8" r="3.4" /><path d="M5 20c1.2-3.6 4-5.4 7-5.4s5.8 1.8 7 5.4" /></svg>;
    case "delivery": return <svg {...SVG_PROPS}><path d="M1 4h13v10H1z" /><path d="M14 8h4l3 3v3h-7" /><circle cx="5.5" cy="17.5" r="2" /><circle cx="17.5" cy="17.5" r="2" /></svg>;
    case "agreement": return <svg {...SVG_PROPS}><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v3h3" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="13" y2="16" /></svg>;
    case "case": return <svg {...SVG_PROPS}><path d="M4 4h16v12H8l-4 4z" /></svg>;
    default: return <svg {...SVG_PROPS}><path d="M4 7h16M4 12h16M4 17h10" /></svg>;
  }
}

/** Sektionsrubriker */
const SECTION_LABELS: Record<string, string> = {
  status_salj: "Status sälj",
  kontaktinfo: "Kontaktinfo och övrigt",
  affarsinformation: "Affärsinformation",
  affarsdelning: "Affärsdelning",
  // Affärskort (SÄLJ) — nya sektioner
  grunduppgifter: "Grunduppgifter",
  dublett: "Dublettkontroll",
  avslut: "Avslut",
  // D2D-fastighet
  grundinfo: "Grundinfo",
  nat_tv: "Nät & TV",
  installation: "Installation & tillträde",
  ovrigt: "Övrigt",
  // D2D-lägenhet
  knackning: "Knackning",
  kunddata: "Kunddata",
  forsaljning: "Försäljning",
  ai: "AI-data",
  salt: "Sålda tjänster",
  // Leverans
  kund: "Kund och bolag",
  fastighet: "Fastighet och läge",
  omfattning: "Omfattning",
  befintligt: "Befintliga avtal och leverantörer",
  tidplan: "Status och tidplan",
  identifierare: "Nummer och referenser",
  teknik: "Teknik och nät",
  resurser: "Resurser",
  uppfoljning: "Uppföljning",
};

type FieldGroup = { section: string | null; label: string | null; fields: FieldDef[] };

function groupFieldsBySections(fields: FieldDef[]): FieldGroup[] {
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
  return groups;
}

// ── Flikdefinitioner ─────────────────────────────────────────────────────────

type TabDef = { key: string; label: string; objectType?: string };

const BASE_TABS: TabDef[] = [
  { key: "oversikt",        label: "Översikt" },
  { key: "checklista",      label: "Checklista" },
  { key: "fastigheter",     label: "Fastigheter",     objectType: "property" },
  { key: "leveranser",      label: "Leveranser",       objectType: "delivery" },
  { key: "kontaktpersoner", label: "Kontaktpersoner", objectType: "contact" },
  { key: "att_gora",        label: "Att göra" },
  { key: "dokument",        label: "Kommunikation" },
  { key: "arenden",         label: "Ärenden",          objectType: "ticket" },
  { key: "affarer",         label: "Affärer",          objectType: "deal" },
];

/** D2D-flikar som läggs till dynamiskt om CRM-objektet har en inkommande D2D-relation */
const D2D_EXTRA_TABS: Record<string, TabDef> = {
  d2d_fastighet: { key: "d2d_fastigheter", label: "D2D-fastigheter", objectType: "d2d_fastighet" },
  d2d_projekt:   { key: "d2d_projekt",     label: "D2D-projekt",     objectType: "d2d_projekt" },
};

/** Bygg flikar dynamiskt: basflikar + eventuella D2D-flikar beroende på inkommande relationer */
function buildTabs(objectDef: ObjectDef): TabDef[] {
  const tabs = [...BASE_TABS];

  // Lyft affär hör bara till affärskortet — egen flik, ingen relationstyp.
  if (objectDef.key === "deal") {
    const idx = tabs.findIndex((t) => t.key === "checklista");
    tabs.splice(idx >= 0 ? idx + 1 : 1, 0, { key: "lyft_affar_flik", label: "Lyft affär" }, { key: "fmo_flik", label: "FMO-check" });
  }

  // Lägenheter enligt Telias adresslista (kopplas vid import av projektplanen).
  if (["delivery", "koncernmoder", "direktagt_bolag"].includes(objectDef.key)) {
    const idx = tabs.findIndex((t) => t.key === "att_gora");
    tabs.splice(idx >= 0 ? idx : tabs.length, 0, { key: "telia_lgh", label: "Lägenheter" });
  }

  const seen = new Set<string>();
  for (const rel of objectDef.relations.incoming) {
    const extra = D2D_EXTRA_TABS[rel.fromObject];
    if (extra && !seen.has(extra.key)) {
      seen.add(extra.key);
      // Infoga före "att_gora"
      const idx = tabs.findIndex((t) => t.key === "att_gora");
      tabs.splice(idx >= 0 ? idx : tabs.length, 0, extra);
    }
  }
  return tabs;
}

// ── Snabbskapa + auto-koppla ─────────────────────────────────────────────────

function QuickCreateForm({
  objectType,
  parentRecordId,
  parentObjectType,
  relations,
  onCreated,
  onCancel,
}: {
  objectType: string;
  parentRecordId: string;
  parentObjectType: string;
  relations: { outgoing: RelationDef[]; incoming: RelationDef[] };
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hitta rätt relation att auto-koppla
  // Scenariot: vi skapar en "property" och vill koppla till "koncernmoder"
  // Relationen är property → koncernmoder (from=property, to=koncernmoder)
  // Det matchar incoming på koncernmoder-sidan
  function findRelType(): { relType: string; forward: boolean } | null {
    // Kolla incoming (t.ex. property_of: property→koncernmoder, sett från koncernmoder)
    for (const rel of relations.incoming) {
      if (rel.fromObject === objectType) {
        return { relType: rel.relType, forward: true }; // addRelation(newRecord, relType, parent)
      }
    }
    // Kolla outgoing
    for (const rel of relations.outgoing) {
      if (rel.toObject === objectType) {
        return { relType: rel.relType, forward: false }; // addRelation(parent, relType, newRecord)
      }
    }
    return null;
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const row = await createRecord(objectType, { name: name.trim() });
      // Auto-koppla
      const link = findRelType();
      if (link) {
        if (link.forward) {
          await addRelation(row.id, link.relType, parentRecordId);
        } else {
          await addRelation(parentRecordId, link.relType, row.id);
        }
      }
      onCreated();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte skapa posten.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="quick-create">
      <div className="quick-create__row">
        <input
          className="input"
          placeholder="Namn…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          autoFocus
        />
        <button className="btn btn--brand btn--sm" onClick={handleCreate} disabled={saving || !name.trim()}>
          {saving ? "Skapar…" : "Skapa"}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={saving}>
          Avbryt
        </button>
      </div>
      {error && <div className="formfield__error">{error}</div>}
    </div>
  );
}

// ── Relationsflik med lista + skapa ny ───────────────────────────────────────

function RelationTab({
  related,
  objectType,
  parentRecordId,
  parentObjectType,
  relations,
  onNavigate,
  onRelationsChanged,
}: {
  related: RelatedRecord[];
  objectType: string;
  parentRecordId: string;
  parentObjectType: string;
  relations: { outgoing: RelationDef[]; incoming: RelationDef[] };
  onNavigate: (id: string) => void;
  onRelationsChanged: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const items = related.filter((r) => r.record.objectType === objectType);

  return (
    <div className="relation-tab">
      <div className="relation-tab__header">
        <span className="relation-tab__count">{items.length} post{items.length !== 1 ? "er" : ""}</span>
      </div>

      {items.length === 0 && !showCreate && (
        <div className="empty-state">Inga poster kopplade ännu.</div>
      )}

      <div className="related-list">
        {items.map((r) => (
          <div className="related-list__item" key={r.record.id + r.relType}>
            <div className="related-list__main" onClick={() => onNavigate(r.record.id)}>
              <span className="related-list__title">{r.record.title ?? "Namnlös post"}</span>
              {r.record.status && <StatusPill status={r.record.status} />}
            </div>
            {r.label && <span className="related-list__meta">{r.label}</span>}
          </div>
        ))}
      </div>

      {showCreate && (
        <QuickCreateForm
          objectType={objectType}
          parentRecordId={parentRecordId}
          parentObjectType={parentObjectType}
          relations={relations}
          onCreated={() => { setShowCreate(false); onRelationsChanged(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="tab-bottom-action">
        <button
          className="btn btn--brand btn--sm"
          onClick={() => setShowCreate(true)}
          disabled={showCreate}
        >
          + Skapa ny
        </button>
      </div>
    </div>
  );
}

/* Uppgiftsfliken bor i TaskTab. */

/* Dokument- och kommunikationsfliken bor i CommunicationTab. */

// ── Huvud-komponent ──────────────────────────────────────────────────────────

export function RecordDrawer({ objectDef: objectDefProp, record: recordProp, recordId, objectDefFor, onClose, onSaved, onNavigate, onMetadataChanged, variant = "drawer", onOpenList, isAdmin }: Props) {
  const isPage = variant === "page";
  const isCreate = !recordProp && !recordId;

  // ── Laddning av post via ID
  const [loadedRecord, setLoadedRecord] = useState<RecordRow | null>(null);
  const [related, setRelated] = useState<RelatedRecord[]>([]);
  const [fetchLoading, setFetchLoading] = useState(!!recordId);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const record = recordProp ?? loadedRecord;
  const resolvedDef = record && objectDefFor ? (objectDefFor(record.object_type) ?? objectDefProp) : objectDefProp;

  const loadRecord = useCallback(async () => {
    if (!recordId) return;
    setFetchLoading(true);
    setFetchError(null);
    try {
      const res = await getRecord(recordId);
      setLoadedRecord(res.record);
      setRelated(res.related);
      setData({ ...res.record.data });
      setStatus(res.record.status);
      setDirty(false);
    } catch (e) {
      setFetchError(e instanceof DataError ? e.message : "Kunde inte hämta posten.");
    } finally {
      setFetchLoading(false);
    }
  }, [recordId]);

  useEffect(() => { loadRecord(); }, [loadRecord]);

  // ── Redigeringsstate
  const [data, setData] = useState<Record<string, unknown>>(() => ({ ...(recordProp?.data ?? {}) }));
  const [status, setStatus] = useState<string | null>(recordProp?.status ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // ── Flikar (dynamiska beroende på objekttyp)
  const tabs = useMemo(() => buildTabs(resolvedDef), [resolvedDef]);
  const [activeTab, setActiveTab] = useState<string>("oversikt");

  // ── Skapa affär-dialog (koncernmoder)
  const [showDealDialog, setShowDealDialog] = useState(false);
  const isKoncernmoder = resolvedDef.key === "koncernmoder";

  // ── Fältkonfigurator
  const [showFieldConfig, setShowFieldConfig] = useState(false);

  // ── Checklistor: statusordning + varning för obligatoriska punkter
  // get_metadata levererar statusar i sort_order, så indexet ÄR ordningen.
  const statusSort = useMemo(() => {
    const m: Record<string, number> = {};
    resolvedDef.statuses.forEach((s, i) => { m[s.key] = i; });
    return m;
  }, [resolvedDef.statuses]);

  const [pending, setPending] = useState<PendingItem[] | null>(null);

  const set = (key: string) => (value: unknown) => {
    setData((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setSaveOk(false);
  };

  const changeStatus = (value: string | null) => {
    setStatus(value);
    setDirty(true);
    setSaveOk(false);
  };

  /**
   * Spara. Vid statusbyte på befintlig post kollar vi först om det finns
   * obligatoriska checklistepunkter kvar i faser på eller före den nya
   * statusen. Finns det det visar vi en varning — men släpper fram.
   */
  async function save() {
    const statusChanged = !isCreate && record && status !== record.status;
    if (statusChanged && pending === null) {
      try {
        const left = await pendingRequiredItems(record!.id, status);
        if (left.length > 0) {
          setPending(left);   // öppnar varningsdialogen; den anropar save() igen
          return;
        }
      } catch {
        /* kan inte läsa checklistan — låt sparningen gå igenom ändå */
      }
    }
    setPending(null);

    setSaving(true);
    setError(null);
    setSaveOk(false);
    try {
      if (isCreate) {
        const row = await createRecord(resolvedDef.key, data, status);
        onSaved(row);
        return;
      }
      const row = await updateRecord(record!.id, data, status);
      setLoadedRecord(row);
      setData({ ...row.data });
      setStatus(row.status);
      setDirty(false);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 3000);
      onSaved(row);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Något gick fel. Försök igen.");
    } finally {
      setSaving(false);
    }
  }

  // ── Relationer: reload
  async function reloadRelations() {
    if (!record) return;
    try {
      const res = await getRecord(record.id);
      setRelated(res.related);
    } catch { /* tyst */ }
  }

  // ── Sektionsgruppering (filtrera dolda fält)
  const isDeal = resolvedDef.key === "deal";
  const visibleFields = useMemo(
    () => resolvedDef.fields.filter((f) => f.visibility !== "hidden" && !(isDeal && DEAL_CUSTOM_FIELDS.has(f.key))),
    [resolvedDef.fields, isDeal]
  );
  const fieldGroups = useMemo(() => groupFieldsBySections(visibleFields), [visibleFields]);
  const hasSections = fieldGroups.some((g) => g.section !== null);

  // ── Affärskort: Avvakta / Ej aktuell / Lyft affär
  const [affarsstatusSaving, setAffarsstatusSaving] = useState(false);

  /**
   * Avvakta/Ej aktuell sparas direkt — det är snabbknappar, inte formulärfält.
   *
   * Skriver INTE över hela `data` med serversvaret: knapparna ligger på
   * samma flik som det redigerbara formuläret, så om användaren har
   * osparade ändringar i andra fält när hen klickar en snabbknapp ska de
   * ändringarna finnas kvar. Vi mergar bara in det fält vi faktiskt
   * skickade, och rör inte `dirty` — eventuella andra osparade fält är
   * fortfarande osparade.
   */
  async function quickSetAffarsstatus(value: string) {
    if (!record) return;
    const next = data.affarsstatus === value ? null : value;
    setAffarsstatusSaving(true);
    try {
      const row = await updateRecord(record.id, { affarsstatus: next });
      setLoadedRecord(row);
      setData((d) => ({ ...d, affarsstatus: row.data.affarsstatus }));
      onSaved(row);
    } catch {
      /* tyst — status ändras helt enkelt inte */
    } finally {
      setAffarsstatusSaving(false);
    }
  }

  // ── Signeringsprocess: en egen liten process, skild från affärsstatus.
  // "Starta ny signering" sätter första steget; knapparna byter steg;
  // "Avsluta" nollställer. FMO är en genväg som sätter huvudstatusen direkt
  // till "Inväntar svar från FMO" (samma statusnyckel som redan finns i
  // SÄLJ-flödet) — det finns ingen egen koppling mot något signerings-
  // eller FMO-system ännu, det här är bara statusspårning i kortet.
  /** Samma princip som quickSetAffarsstatus: merga bara in de fält vi skickade. */
  async function quickSetPatch(patch: Record<string, unknown>) {
    if (!record) return;
    setAffarsstatusSaving(true);
    try {
      const row = await updateRecord(record.id, patch);
      setLoadedRecord(row);
      setData((d) => {
        const merged = { ...d };
        for (const key of Object.keys(patch)) merged[key] = row.data[key];
        return merged;
      });
      onSaved(row);
    } catch {
      /* tyst */
    } finally {
      setAffarsstatusSaving(false);
    }
  }

  /** Efter FMO-åtgärder: läs om posten (status kan ha ändrats) och kopplingarna. */
  async function reloadAfterFmo() {
    if (!record) return;
    try {
      const res = await getRecord(record.id);
      setRelated(res.related);
      setLoadedRecord(res.record);
      setStatus(res.record.status);
      onSaved(res.record);
    } catch { /* tyst */ }
  }

  // ── Flikinnehåll
  function renderTabContent() {
    // Översikt = redigerbart formulär (samma som Skapa ny)
    if (activeTab === "oversikt" || isCreate) {
      return (
        <div className="drawer__main">
          {/* Leverans skapad från affär men saknas i projektplanen > 15 dagar */}
          {resolvedDef.key === "delivery" && record?.data?.projektplan_varning === true && (
            <div className="projektplan-varning" role="alert">
              <strong>Saknas i projektplanen.</strong> Fastigheten skapades från en såld affär
              {typeof record.data.fran_affar_datum === "string" ? ` ${record.data.fran_affar_datum}` : ""} för mer än 15 dagar sedan
              men finns inte med i projektplanen ännu.
            </div>
          )}

          {/* Affärskort: logga aktivitet + nästa steg, alltid överst */}
          {isDeal && !isCreate && record && (
            <DealFollowUp
              record={record}
              statuses={resolvedDef.statuses}
              onRecord={(row) => {
                // Merga bara in uppföljningsfälten — osparade ändringar i
                // formuläret nedanför ska ligga kvar.
                setLoadedRecord(row);
                setData((d) => ({
                  ...d,
                  nasta_steg: row.data.nasta_steg,
                  nasta_steg_datum: row.data.nasta_steg_datum,
                  senaste_kontakt: row.data.senaste_kontakt,
                }));
                onSaved(row);
              }}
            />
          )}

          {/* Affärskort: snabbknappar */}
          {isDeal && !isCreate && record && (
            <div className="affarsstatus-row">
              {AFFARSSTATUS_KNAPPAR.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  className={`btn btn--sm ${data.affarsstatus === k.key ? "btn--aktiv" : "btn--ghost"}`}
                  disabled={affarsstatusSaving}
                  onClick={() => {
                    quickSetAffarsstatus(k.key);
                    if (k.key === "lyft_affar") setActiveTab("lyft_affar_flik");
                  }}
                >
                  {k.label}
                </button>
              ))}
            </div>
          )}

          {/* Affärskort: signeringsprocess + FMO */}
          {isDeal && !isCreate && record && (
            <div className="card" style={{ marginBottom: "var(--sp-5)", padding: "var(--sp-4)" }}>
              <div className="affarsstatus-row" style={{ marginBottom: "var(--sp-3)", flexWrap: "wrap" }}>
                {SIGNERINGS_KNAPPAR.map((k) => (
                  <button
                    key={k.key}
                    type="button"
                    className={`btn btn--sm ${data.signeringssteg === k.key ? "btn--aktiv" : "btn--ghost"}`}
                    disabled={affarsstatusSaving}
                    onClick={() => quickSetPatch({ signeringssteg: data.signeringssteg === k.key ? null : k.key })}
                  >
                    {k.label}
                  </button>
                ))}
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => setActiveTab("fmo_flik")}
                  title="Välj vilka fastigheter som ska skickas på FMO-check"
                >
                  FMO-check
                </button>
              </div>
              {!data.signeringssteg ? (
                <p className="formfield__help" style={{ margin: 0 }}>
                  Inte del av en signeringsprocess. Ingen e-signeringstjänst är kopplad till Core Platform
                  ännu — knapparna ovan är bara statusspårning tills vidare.
                </p>
              ) : (
                <p className="formfield__help" style={{ margin: 0 }}>
                  Signeringssteg: {SIGNERINGS_KNAPPAR.find((k) => k.key === data.signeringssteg)?.label}
                </p>
              )}
            </div>
          )}

          {/* Status */}
          {resolvedDef.statuses.length > 0 && (
            <div className="formfield" style={{ marginBottom: "20px" }}>
              <label className="label" htmlFor="f-status">Status</label>
              <select
                id="f-status"
                className="input"
                value={status ?? ""}
                onChange={(e) => changeStatus(e.target.value || null)}
              >
                {resolvedDef.statuses.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Fält */}
          {hasSections ? (
            fieldGroups.map((group, gi) => (
              <div key={group.section ?? gi} className={`form-section${isPage ? " card" : ""}`}>
                {group.label && (
                  <div className="form-section__header">
                    <span className="form-section__title">{group.label}</span>
                  </div>
                )}
                <div className="form-grid">
                  {group.fields.map((f) => (
                    <FieldInput key={f.key} field={f} value={data[f.key]} onChange={set(f.key)} />
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="form-grid">
              {resolvedDef.fields.map((f) => (
                <FieldInput key={f.key} field={f} value={data[f.key]} onChange={set(f.key)} />
              ))}
            </div>
          )}

          {/* Ägare */}
          {record?.owner_user_id && !isPage && (
            <div className="detail-owner">
              <span className="detail-owner__label">Ägare</span>
              <UserBadge id={record.owner_user_id} />
            </div>
          )}

          {/* Snabbåtgärder */}
          {!isCreate && isKoncernmoder && record && (
            <div className="drawer__actions">
              <button
                className="btn btn--brand"
                onClick={() => setShowDealDialog(true)}
              >
                + Skapa affär
              </button>
            </div>
          )}

          {/* Fel + Spara */}
          {error && <div className="formfield__error" style={{ marginTop: "16px" }}>{error}</div>}

          <div className="detail-save-row">
            {!isCreate && (
              <button className="btn btn--ghost" onClick={onClose}>{isPage ? "Tillbaka" : "Stäng"}</button>
            )}
            {isCreate && (
              <button className="btn btn--ghost" onClick={onClose} disabled={saving}>Avbryt</button>
            )}
            <button
              className="btn btn--brand"
              onClick={save}
              disabled={saving || (!isCreate && !dirty)}
            >
              {saving ? "Sparar…" : "Spara"}
            </button>
            {saveOk && <span className="detail-save-ok">✓ Sparat</span>}
            {dirty && !saving && !isCreate && <span className="detail-save-hint">Osparade ändringar</span>}
          </div>
        </div>
      );
    }

    // Relationsflikar
    const tabDef = tabs.find((t) => t.key === activeTab);
    if (tabDef?.objectType && record) {
      return (
        <RelationTab
          related={related}
          objectType={tabDef.objectType}
          parentRecordId={record.id}
          parentObjectType={resolvedDef.key}
          relations={resolvedDef.relations}
          onNavigate={onNavigate ?? (() => {})}
          onRelationsChanged={reloadRelations}
        />
      );
    }

    // Checklista
    if (activeTab === "checklista" && record) {
      return (
        <ChecklistTab
          recordId={record.id}
          currentStatus={status}
          statusSort={statusSort}
        />
      );
    }

    // Lyft affär
    if (activeTab === "lyft_affar_flik" && record && isDeal) {
      return (
        <LyftAffarTab
          deal={record}
          related={related}
          onSaved={(row) => {
            // Lyft affär-flikens Spara-knapp skickar bara { lyft_affar },
            // så vi mergar bara in det fältet — annars skulle osparade
            // ändringar på Översikt-fliken kunna försvinna tyst.
            setLoadedRecord(row);
            setData((d) => ({ ...d, lyft_affar: row.data.lyft_affar }));
            onSaved(row);
          }}
          onRelationsChanged={reloadRelations}
        />
      );
    }

    // FMO-check
    if (activeTab === "fmo_flik" && record && isDeal) {
      return <FmoTab deal={record} related={related} kanSvara={!!isAdmin} onChanged={reloadAfterFmo} />;
    }

    // Lägenheter (Telias adresslista)
    if (activeTab === "telia_lgh" && record) return <TeliaLagenheterTab recordId={record.id} />;

    // Att göra
    if (activeTab === "att_gora" && record) return <TaskTab recordId={record.id} />;

    // Kommunikation & dokument
    if (activeTab === "dokument" && record) {
      return <CommunicationTab recordId={record.id} />;
    }

    return null;
  }

  const tabCount = (t: TabDef) => t.objectType ? related.filter((r) => r.record.objectType === t.objectType).length : null;
  const statusDef = resolvedDef.statuses.find((x) => x.key === (record?.status ?? null));
  const updated = record ? new Date(record.updated_at).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) : "";

  /** Kopplade objekt i högerkolumnen (sidvarianten): upp till fyra per typ. */
  const relatedGroups = useMemo(() => {
    const g = new Map<string, RelatedRecord[]>();
    for (const r of related) {
      const k = r.record.objectType;
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(r);
    }
    return [...g.entries()];
  }, [related]);

  const configBtn = !isCreate && (
    <button
      className="btn btn--ghost btn--sm drawer__config-btn"
      onClick={() => setShowFieldConfig(true)}
      title="Konfigurera fält"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="2" />
        <path d="M13.7 10a1.2 1.2 0 00.2 1.3l.04.04a1.44 1.44 0 11-2.04 2.04l-.04-.04a1.2 1.2 0 00-1.3-.2 1.2 1.2 0 00-.72 1.1v.12a1.44 1.44 0 11-2.88 0v-.06a1.2 1.2 0 00-.78-1.1 1.2 1.2 0 00-1.3.2l-.04.04a1.44 1.44 0 11-2.04-2.04l.04-.04a1.2 1.2 0 00.2-1.3 1.2 1.2 0 00-1.1-.72h-.12a1.44 1.44 0 110-2.88h.06a1.2 1.2 0 001.1-.78 1.2 1.2 0 00-.2-1.3l-.04-.04A1.44 1.44 0 114.8 2.24l.04.04a1.2 1.2 0 001.3.2h.06a1.2 1.2 0 00.72-1.1V1.28a1.44 1.44 0 112.88 0v.06a1.2 1.2 0 00.72 1.1 1.2 1.2 0 001.3-.2l.04-.04a1.44 1.44 0 112.04 2.04l-.04.04a1.2 1.2 0 00-.2 1.3v.06a1.2 1.2 0 001.1.72h.12a1.44 1.44 0 110 2.88h-.06a1.2 1.2 0 00-1.1.72z" />
      </svg>
      {isPage && <span className="btn__label">Anpassa fält</span>}
    </button>
  );

  const tabBar = !isCreate && !fetchLoading && !fetchError && (
    <div className="tab-bar">
      {tabs.map((tab) => {
        const n = tabCount(tab);
        return (
          <button
            key={tab.key}
            className={`tab-bar__tab${activeTab === tab.key ? " tab-bar__tab--active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            {n != null && n > 0 && <span className="tab-bar__count">{n}</span>}
          </button>
        );
      })}
    </div>
  );

  const dialogs = (
    <>
      {/* Skapa affär-dialog */}
      {showDealDialog && record && (
        <CreateDealDialog
          koncernmoderId={record.id}
          koncernmoderName={record.title ?? "Namnlös"}
          properties={related.filter((r) => r.record.objectType === "property")}
          onCreated={(dealId) => {
            setShowDealDialog(false);
            reloadRelations();
            if (onNavigate) onNavigate(dealId);
          }}
          onCancel={() => setShowDealDialog(false)}
        />
      )}

      {/* Varning: obligatoriska checklistepunkter kvar vid statusbyte */}
      {pending && pending.length > 0 && (
        <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && setPending(null)}>
          <div className="warn-dialog">
            <div className="warn-dialog__head">
              <span className="warn-dialog__icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 2.5L18.5 17.5H1.5L10 2.5z" />
                  <line x1="10" y1="8" x2="10" y2="12" />
                  <circle cx="10" cy="14.5" r=".7" fill="currentColor" stroke="none" />
                </svg>
              </span>
              <h3>
                {pending.length} obligatorisk{pending.length === 1 ? " punkt" : "a punkter"} är inte avbockad{pending.length === 1 ? "" : "e"}
              </h3>
            </div>

            <ul className="warn-dialog__list">
              {pending.map((p) => (
                <li key={p.id}>
                  <span className="warn-dialog__label">{p.label}</span>
                  <span className="warn-dialog__where">{p.checklist}</span>
                </li>
              ))}
            </ul>

            <p className="warn-dialog__note">
              Du kan gå vidare ändå — punkterna finns kvar på checklistan.
            </p>

            <div className="warn-dialog__actions">
              <button className="btn btn--ghost" onClick={() => setPending(null)}>
                Avbryt
              </button>
              <button className="btn btn--brand" onClick={() => { void save(); }}>
                Gå vidare ändå
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Fältkonfigurator */}
      {showFieldConfig && (
        <FieldConfigPanel
          objectType={resolvedDef.key}
          objectLabel={resolvedDef.labelPlural}
          fields={resolvedDef.fields}
          onClose={() => setShowFieldConfig(false)}
          onChanged={() => { if (onMetadataChanged) onMetadataChanged(); }}
        />
      )}
    </>
  );

  if (isPage) {
    const main = renderTabContent();
    return (
      <div className="page record-page">
        <nav className="crumbs" aria-label="Brödsmulor">
          <button className="crumbs__link" onClick={() => (onOpenList ? onOpenList(resolvedDef.key) : onClose())}>
            {resolvedDef.labelPlural}
          </button>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          <span className="crumbs__current">{record?.title ?? (fetchLoading ? "…" : "Namnlös post")}</span>
        </nav>

        <div className="record-head">
          <div className="record-head__icon"><ObjectIcon objectKey={resolvedDef.key} /></div>
          <div className="record-head__text">
            <div className="record-head__title-row">
              <h1>{record?.title ?? (fetchLoading ? "Laddar…" : "Namnlös post")}</h1>
              {record?.status && <StatusPill status={record.status} def={statusDef} />}
              {dirty && <span className="drawer__unsaved-dot" title="Osparade ändringar" />}
            </div>
            <div className="record-head__sub">
              {resolvedDef.labelSingular}{updated && ` · Uppdaterad ${updated}`}
            </div>
          </div>
          <div className="record-head__actions">
            {configBtn}
            {activeTab === "oversikt" && !fetchLoading && !fetchError && (
              <button className="btn btn--brand" onClick={save} disabled={saving || !dirty}>
                {saving ? "Sparar…" : saveOk ? "✓ Sparat" : "Spara"}
              </button>
            )}
          </div>
        </div>

        {tabBar}

        {fetchLoading && <div className="card"><div className="skeleton" role="status"><div className="skeleton__row"><span className="skeleton__bar" style={{ width: "60%" }} /></div><div className="skeleton__row"><span className="skeleton__bar" style={{ width: "80%" }} /></div><div className="skeleton__row"><span className="skeleton__bar" style={{ width: "45%" }} /></div></div></div>}
        {fetchError && <div className="card"><div className="empty-state">{fetchError}</div></div>}

        {!fetchLoading && !fetchError && (activeTab === "oversikt" ? (
          <div className="record-page__grid">
            <div className="record-page__main">{main}</div>
            <aside className="record-page__side">
              <div className="card side-card">
                <div className="side-card__title">Ansvarig</div>
                {record?.owner_user_id
                  ? <div className="side-card__person"><UserBadge id={record.owner_user_id} /></div>
                  : <div className="side-card__empty">Ingen ansvarig</div>}
                <div className="side-card__meta">
                  Skapad {record ? new Date(record.created_at).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" }) : ""}
                </div>
              </div>
              {relatedGroups.map(([type, rows]) => {
                const def = objectDefFor?.(type);
                const tab = tabs.find((t) => t.objectType === type);
                return (
                  <div className="card side-card" key={type}>
                    <div className="side-card__title">
                      <span className="side-card__chip"><ObjectIcon objectKey={type} /></span>
                      {def?.labelPlural ?? type}
                      <span className="side-card__count">{rows.length}</span>
                    </div>
                    <div className="side-list">
                      {rows.slice(0, 4).map((r) => (
                        <button key={r.record.id + r.relType} className="side-list__item" onClick={() => onNavigate?.(r.record.id)}>
                          <span className="side-list__title">{r.record.title ?? "Namnlös post"}</span>
                          {r.record.status && (
                            <StatusPill status={r.record.status} def={def?.statuses.find((x) => x.key === r.record.status)} />
                          )}
                        </button>
                      ))}
                    </div>
                    {tab && rows.length > 4 && (
                      <button className="side-card__more" onClick={() => setActiveTab(tab.key)}>Visa alla {rows.length} →</button>
                    )}
                  </div>
                );
              })}
            </aside>
          </div>
        ) : (
          <div className="card record-page__tab">{main}</div>
        ))}

        {dialogs}
      </div>
    );
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer drawer--wide">
        {/* Header */}
        <div className="drawer__header">
          <h2>
            {isCreate
              ? `Ny ${resolvedDef.labelSingular.toLowerCase()}`
              : (record?.title ?? "Namnlös post")}
          </h2>
          {dirty && !isCreate && <span className="drawer__unsaved-dot" title="Osparade ändringar" />}
          {configBtn}
          <button className="close-btn" onClick={onClose} aria-label="Stäng">×</button>
        </div>

        {tabBar}

        {/* Laddning */}
        {fetchLoading && <div className="empty-state">Laddar…</div>}
        {fetchError && <div className="empty-state">{fetchError}</div>}

        {/* Flikinnehåll */}
        {!fetchLoading && !fetchError && (
          <div className="drawer__body drawer__body--tabs">
            {renderTabContent()}
          </div>
        )}
      </div>
      {dialogs}
    </div>
  );
}
