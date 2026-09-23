import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listRecords, getRecord, createRecord, updateRecord, addRelation, removeRelation,
  listSellers, d2dImportAddresses, d2dSetAssignment, d2dApproveProject,
  type RecordRow, type SellerOption, DataError,
} from "@/lib/data";
import { StatusPill } from "./StatusPill";

// =============================================================================
// Adressradsformulär — matchar exakt fälten som d2d_import_addresses tar emot
// =============================================================================

type AddrRow = {
  lagenhetsnummer: string; postort: string; postnummer: string;
  fastighetsbeteckning: string; portkod: string; gatunamn: string; gatnr: string;
  ingang: string; alias: string; punktid: string; klass: string; cpe_model: string;
  installationsdatum: string; befintlig_fiber: string; befintlig_koax: string;
  koax_avslutsdatum: string; befintligt_kanalpaket: string; nytt_kanalpaket: string;
};

const EMPTY_ADDR_ROW: AddrRow = {
  lagenhetsnummer: "", postort: "", postnummer: "", fastighetsbeteckning: "",
  portkod: "", gatunamn: "", gatnr: "", ingang: "", alias: "", punktid: "",
  klass: "", cpe_model: "", installationsdatum: "", befintlig_fiber: "",
  befintlig_koax: "", koax_avslutsdatum: "", befintligt_kanalpaket: "", nytt_kanalpaket: "",
};

const ADDR_COLUMNS: Array<{ key: keyof AddrRow; label: string }> = [
  { key: "lagenhetsnummer", label: "Lägenhetsnr" },
  { key: "gatunamn", label: "Gatunamn" },
  { key: "gatnr", label: "Gatnr" },
  { key: "ingang", label: "Ingång" },
  { key: "postnummer", label: "Postnr" },
  { key: "postort", label: "Postort" },
  { key: "fastighetsbeteckning", label: "Fastighetsbeteckning" },
  { key: "portkod", label: "Portkod" },
  { key: "alias", label: "Alias" },
  { key: "punktid", label: "PunktID" },
  { key: "klass", label: "Klass" },
  { key: "cpe_model", label: "CPE Model" },
  { key: "installationsdatum", label: "Installationsdatum" },
  { key: "befintlig_fiber", label: "Befintlig fiber" },
  { key: "befintlig_koax", label: "Befintlig koax" },
  { key: "koax_avslutsdatum", label: "Avslutsdatum koax" },
  { key: "befintligt_kanalpaket", label: "Befintligt kanalpaket" },
  { key: "nytt_kanalpaket", label: "Nytt kanalpaket" },
];

function AddressEditor({
  fastighetId, existingCount, onImported,
}: {
  fastighetId: string; existingCount: number; onImported: () => void;
}) {
  const [rows, setRows] = useState<AddrRow[]>([{ ...EMPTY_ADDR_ROW }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function setCell(i: number, key: keyof AddrRow, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }
  function addRow() { setRows((rs) => [...rs, { ...EMPTY_ADDR_ROW }]); }
  function removeRow(i: number) { setRows((rs) => rs.filter((_, idx) => idx !== i)); }

  async function save() {
    setSaving(true); setError(null); setOk(null);
    try {
      const nonEmpty = rows.filter((r) => Object.values(r).some((v) => v.trim() !== ""));
      if (nonEmpty.length === 0) { setError("Lägg till minst en rad."); return; }
      const res = await d2dImportAddresses(fastighetId, nonEmpty);
      setOk(`${res.imported} adress(er) sparade.`);
      setRows([{ ...EMPTY_ADDR_ROW }]);
      onImported();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara adresserna.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="d2dpb-addr">
      <div className="d2dpb-addr__header">
        <span>{existingCount} adress(er) redan inlagda</span>
      </div>
      <div className="d2dpb-addr__table-wrap">
        <table className="d2dpb-addr__table">
          <thead>
            <tr>
              {ADDR_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {ADDR_COLUMNS.map((c) => (
                  <td key={c.key}>
                    <input
                      className="d2dpb-addr__input"
                      value={row[c.key]}
                      onChange={(e) => setCell(i, c.key, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <button className="btn btn--ghost btn--sm" onClick={() => removeRow(i)} title="Ta bort rad">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="d2dpb-addr__actions">
        <button className="btn btn--ghost btn--sm" onClick={addRow}>+ Rad</button>
        <button className="btn btn--brand btn--sm" onClick={save} disabled={saving}>
          {saving ? "Sparar…" : "Spara adresser"}
        </button>
        {ok && <span className="d2d-save-ok">✓ {ok}</span>}
        {error && <span className="d2d-error">{error}</span>}
      </div>
    </div>
  );
}

// =============================================================================
// Säljartilldelning (procent)
// =============================================================================

type Assignment = { user_id: string; procent: number };

function AssignmentEditor({
  fastighetId, sellers, initial, onSaved,
}: {
  fastighetId: string; sellers: SellerOption[]; initial: Assignment[]; onSaved: () => void;
}) {
  const [rows, setRows] = useState<Assignment[]>(initial.length ? initial : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const sum = rows.reduce((s, r) => s + (Number(r.procent) || 0), 0);

  function addRow() {
    const unused = sellers.find((s) => !rows.some((r) => r.user_id === s.id));
    if (!unused) return;
    setRows((rs) => [...rs, { user_id: unused.id, procent: 0 }]);
  }
  function setRow(i: number, patch: Partial<Assignment>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true); setError(null); setOk(false);
    try {
      if (rows.length === 0) { setError("Lägg till minst en säljare."); return; }
      if (Math.abs(sum - 100) > 0.5) { setError(`Procentsatserna måste summera till 100 (nu ${sum}).`); return; }
      await d2dSetAssignment(fastighetId, rows.map((r) => ({ user_id: r.user_id, procent: Number(r.procent) })));
      setOk(true);
      onSaved();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara tilldelningen.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="d2dpb-assign">
      {rows.map((r, i) => (
        <div key={i} className="d2dpb-assign__row">
          <select
            className="input"
            value={r.user_id}
            onChange={(e) => setRow(i, { user_id: e.target.value })}
          >
            {sellers.map((s) => (
              <option key={s.id} value={s.id} disabled={rows.some((rr, idx) => idx !== i && rr.user_id === s.id)}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="number" min={0} max={100} step={1}
            value={r.procent}
            onChange={(e) => setRow(i, { procent: Number(e.target.value) })}
          />
          <span>%</span>
          <button className="btn btn--ghost btn--sm" onClick={() => removeRow(i)}>✕</button>
        </div>
      ))}
      <div className="d2dpb-assign__actions">
        <button className="btn btn--ghost btn--sm" onClick={addRow} disabled={rows.length >= sellers.length}>
          + Lägg till säljare
        </button>
        <span className={sum === 100 ? "d2d-save-ok" : "d2d-error"}>{sum} % av 100 %</span>
        <button className="btn btn--brand btn--sm" onClick={save} disabled={saving}>
          {saving ? "Sparar…" : "Spara tilldelning"}
        </button>
        {ok && <span className="d2d-save-ok">✓ Sparat</span>}
        {error && <span className="d2d-error">{error}</span>}
      </div>
      {sellers.length === 0 && (
        <div className="d2d-empty">Inga säljare med rollen "Dörrsäljare" finns ännu. Skapa användarkonton och tilldela rollen i Supabase Authentication.</div>
      )}
    </div>
  );
}

// =============================================================================
// Fastighetsrad i projektet
// =============================================================================

type FastRow = RecordRow & { _addrCount: number };

function FastighetRow({
  fastighet, sellers, onChanged, onRemove,
}: {
  fastighet: FastRow; sellers: SellerOption[]; onChanged: () => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState<"none" | "addresses" | "assign">("none");
  const [turordning, setTurordning] = useState(String((fastighet.data as Record<string, unknown>).turordning ?? ""));

  async function saveTurordning() {
    const n = turordning.trim() === "" ? null : Number(turordning);
    await updateRecord(fastighet.id, { turordning: n }).catch(() => {});
    onChanged();
  }

  const data = fastighet.data as Record<string, unknown>;
  const assignment = (data.saljartilldelning as Assignment[] | undefined) ?? [];

  return (
    <div className="d2dpb-fast">
      <div className="d2dpb-fast__main">
        <input
          className="input d2dpb-fast__turordning"
          type="number"
          value={turordning}
          onChange={(e) => setTurordning(e.target.value)}
          onBlur={saveTurordning}
          title="Turordning"
        />
        <div className="d2dpb-fast__title">
          <strong>{fastighet.title ?? "Namnlös"}</strong>
          {!!data.fastighetsbeteckning && <span className="d2d-card__sub"> · {String(data.fastighetsbeteckning)}</span>}
        </div>
        <span className="d2d-card__badge">{fastighet._addrCount} adress(er)</span>
        {assignment.length > 0 && (
          <span className="d2d-card__badge">{assignment.length} säljare</span>
        )}
        <StatusPill status={fastighet.status} />
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(open === "addresses" ? "none" : "addresses")}>
          Adresser
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(open === "assign" ? "none" : "assign")}>
          Tilldela säljare
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onRemove} title="Ta bort fastighet ur projektet">Ta bort</button>
      </div>

      {open === "addresses" && (
        <AddressEditor
          fastighetId={fastighet.id}
          existingCount={fastighet._addrCount}
          onImported={onChanged}
        />
      )}
      {open === "assign" && (
        <AssignmentEditor
          fastighetId={fastighet.id}
          sellers={sellers}
          initial={assignment}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

// =============================================================================
// Lägg till fastighet — sök leverans
// =============================================================================

function AddFastighetPicker({ projektId, turordningStart, onAdded }: {
  projektId: string; turordningStart: number; onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<RecordRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(q: string) {
    setQuery(q);
    if (q.trim().length < 2) { setOptions([]); return; }
    try {
      const res = await listRecords({ objectType: "delivery", search: q, limit: 10 });
      setOptions(res.items);
    } catch {
      setOptions([]);
    }
  }

  async function pick(delivery: RecordRow) {
    setBusy(true); setError(null);
    try {
      const full = await getRecord(delivery.id);
      const d = full.record.data as Record<string, unknown>;
      const propertyRel = full.related.find((r) => r.record.objectType === "property");

      const fastighetData: Record<string, unknown> = {
        turordning: turordningStart,
        fastighetsbeteckning: d.fastighetsbeteckning ?? null,
        fastighetsagare: d.fastighetsagare ?? null,
        befintligt_nat: d.befintlig_fiberleverantor ?? null,
        nuvarande_tv: d.kanalpaket ?? d.kanalpaket_projektplan ?? null,
        kabel_tv: d.befintlig_koax ?? null,
        avtalstid_koax: d.avtalstid_ko ?? null,
        kundklar_datum: d.kundklar ?? null,
      };
      const title = (d.adress as string) || full.record.title || "Fastighet";

      const row = await createRecord("d2d_fastighet", { ...fastighetData, name: title }, "ej_startad");
      await addRelation(row.id, "d2d_fast_projekt", projektId);
      if (propertyRel) {
        await addRelation(row.id, "d2d_fast_property", propertyRel.record.id);
      }
      setQuery(""); setOptions([]);
      onAdded();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte lägga till fastigheten.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="d2dpb-picker">
      <input
        className="input"
        placeholder="Sök leverans (adress, fastighetsbeteckning, kund)…"
        value={query}
        onChange={(e) => search(e.target.value)}
        disabled={busy}
      />
      {options.length > 0 && (
        <div className="card d2dpb-picker__options">
          {options.map((o) => {
            const od = o.data as Record<string, unknown>;
            return (
              <button key={o.id} className="d2dpb-picker__option" onClick={() => pick(o)} disabled={busy}>
                <strong>{o.title ?? String(od.adress ?? "Namnlös")}</strong>
                {!!od.fastighetsbeteckning && <span> · {String(od.fastighetsbeteckning)}</span>}
              </button>
            );
          })}
        </div>
      )}
      {error && <div className="d2d-error">{error}</div>}
    </div>
  );
}

// =============================================================================
// Projektdetalj
// =============================================================================

function ProjectDetail({ projektId, onBack }: { projektId: string; onBack: () => void }) {
  const [project, setProject] = useState<RecordRow | null>(null);
  const [fastigheter, setFastigheter] = useState<FastRow[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [approveMsg, setApproveMsg] = useState<string | null>(null);
  const [approveErr, setApproveErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [proj, sellerList] = await Promise.all([getRecord(projektId), listSellers()]);
      setProject(proj.record);
      setSellers(sellerList);

      const fastIds = proj.related
        .filter((r) => r.record.objectType === "d2d_fastighet")
        .map((r) => r.record.id);

      if (fastIds.length === 0) { setFastigheter([]); return; }

      const { data: fastData } = await supabase
        .from("records")
        .select("id,object_type,data,status,owner_user_id,title,created_at,updated_at")
        .in("id", fastIds);

      const { data: relCounts } = await supabase
        .from("relationships")
        .select("to_record_id")
        .eq("rel_type", "d2d_lag_fastighet")
        .in("to_record_id", fastIds);

      const counts = new Map<string, number>();
      for (const r of (relCounts ?? []) as Array<{ to_record_id: string }>) {
        counts.set(r.to_record_id, (counts.get(r.to_record_id) ?? 0) + 1);
      }

      const rows = ((fastData ?? []) as RecordRow[])
        .map((f) => ({ ...f, _addrCount: counts.get(f.id) ?? 0 }))
        .sort((a, b) => {
          const ta = Number((a.data as Record<string, unknown>).turordning ?? 999999);
          const tb = Number((b.data as Record<string, unknown>).turordning ?? 999999);
          return ta - tb;
        });
      setFastigheter(rows);
    } catch {
      // tyst
    } finally {
      setLoading(false);
    }
  }, [projektId]);

  useEffect(() => { load(); }, [load]);

  async function removeFastighet(id: string) {
    if (!confirm("Ta bort fastigheten ur projektet? Lägenheter/adresser tas inte bort.")) return;
    await removeRelation(id, "d2d_fast_projekt", projektId).catch(() => {});
    load();
  }

  async function approve() {
    setApproving(true); setApproveMsg(null); setApproveErr(null);
    try {
      const res = await d2dApproveProject(projektId);
      setApproveMsg(
        `Klart — ${res.distributed} adress(er) utdelade.` +
        (res.fastigheterUtanTilldelning > 0
          ? ` OBS: ${res.fastigheterUtanTilldelning} fastighet(er) saknade tilldelning och hoppades över.`
          : "")
      );
      load();
    } catch (e) {
      setApproveErr(e instanceof DataError ? e.message : "Kunde inte godkänna projektet.");
    } finally {
      setApproving(false);
    }
  }

  if (loading) return <div className="d2d-loading">Laddar projekt…</div>;
  if (!project) return <div className="d2d-empty">Projektet hittades inte.</div>;

  const data = project.data as Record<string, unknown>;

  return (
    <div className="d2dpb-detail">
      <div className="d2dpb-detail__header">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>← Alla projekt</button>
        <h2>{project.title ?? "Projekt"}</h2>
        <StatusPill status={project.status} />
      </div>
      {!!data.description && <p className="ink-faint">{String(data.description)}</p>}

      <div className="d2dpb-detail__section">
        <div className="d2dpb-detail__section-header">
          <h3>Fastigheter ({fastigheter.length})</h3>
        </div>
        {fastigheter.length === 0 && (
          <div className="d2d-empty">Inga fastigheter tillagda ännu. Sök upp en leverans nedan för att lägga till en.</div>
        )}
        {fastigheter.map((f) => (
          <FastighetRow
            key={f.id}
            fastighet={f}
            sellers={sellers}
            onChanged={load}
            onRemove={() => removeFastighet(f.id)}
          />
        ))}
        <AddFastighetPicker
          projektId={projektId}
          turordningStart={fastigheter.length + 1}
          onAdded={load}
        />
      </div>

      <div className="d2dpb-detail__approve">
        <button className="btn btn--brand" onClick={approve} disabled={approving || fastigheter.length === 0}>
          {approving ? "Godkänner…" : "Godkänn projekt och dela ut adresser"}
        </button>
        <p className="ink-faint">
          Delar ut adresserna till respektive säljare enligt tilldelad procentandel per fastighet,
          och gör dem synliga i säljarnas app.
        </p>
        {approveMsg && <div className="d2d-save-ok">✓ {approveMsg}</div>}
        {approveErr && <div className="d2d-error">{approveErr}</div>}
      </div>
    </div>
  );
}

// =============================================================================
// Projektlista
// =============================================================================

function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listRecords({ objectType: "d2d_projekt", limit: 200, sort: { field: "updated_at", dir: "desc" } });
      setItems(res.items);
    } catch {
      // tyst
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!newName.trim()) return;
    setError(null);
    try {
      const row = await createRecord("d2d_projekt", { name: newName.trim() }, "planering");
      setNewName(""); setCreating(false);
      await load();
      onOpen(row.id);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte skapa projektet.");
    }
  }

  if (loading) return <div className="d2d-loading">Laddar projekt…</div>;

  return (
    <div className="d2dpb-list">
      <div className="d2dpb-list__header">
        <h2>D2D-projekt</h2>
        <button className="btn btn--brand btn--sm" onClick={() => setCreating((c) => !c)}>
          {creating ? "Avbryt" : "+ Nytt projekt"}
        </button>
      </div>

      {creating && (
        <div className="d2dpb-list__new">
          <input
            className="input"
            placeholder="Projektnamn"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <button className="btn btn--brand btn--sm" onClick={create}>Skapa</button>
          {error && <span className="d2d-error">{error}</span>}
        </div>
      )}

      {items.length === 0 && <div className="d2d-empty">Inga D2D-projekt ännu.</div>}

      {items.map((item) => (
        <button key={item.id} className="d2d-card" onClick={() => onOpen(item.id)}>
          <div className="d2d-card__main">
            <span className="d2d-card__title">{item.title ?? "Namnlöst projekt"}</span>
          </div>
          <div className="d2d-card__meta">
            <StatusPill status={item.status} />
          </div>
          <svg className="d2d-card__chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 4l4 4-4 4"/></svg>
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// Huvudkomponent
// =============================================================================

export function D2DProjectBuilder() {
  const [view, setView] = useState<{ kind: "list" } | { kind: "project"; id: string }>({ kind: "list" });

  return (
    <div className="d2dpb">
      {view.kind === "list" && <ProjectList onOpen={(id) => setView({ kind: "project", id })} />}
      {view.kind === "project" && (
        <ProjectDetail projektId={view.id} onBack={() => setView({ kind: "list" })} />
      )}
    </div>
  );
}
