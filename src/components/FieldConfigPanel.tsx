import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FieldDef } from "@/lib/data";

type Choice = { key: string; label: string };

type Props = {
  objectType: string;
  objectLabel: string;
  fields: FieldDef[];
  onClose: () => void;
  onChanged: () => void; // signal to reload metadata
  /** "crm" (standard): Dölj döljer fältet överallt i CRM:et (visibility).
   *  "seller": Dölj döljer bara fältet för säljarna i D2D-säljarvyn
   *  (options.seller_hidden) — CRM:et visar det fortfarande. */
  mode?: "crm" | "seller";
  /** Sektioner nya fält kan placeras i (t.ex. Knackning/Kunddata). */
  sections?: Array<{ key: string; label: string }>;
};

// Måste matcha CHECK-constrainten field_definitions_type i databasen.
const FIELD_TYPES: Array<{ value: string; label: string }> = [
  { value: "text", label: "Text (en rad)" },
  { value: "long_text", label: "Lång text" },
  { value: "select", label: "Rullgardin (ett val)" },
  { value: "multi_select", label: "Flerval" },
  { value: "number", label: "Siffror" },
  { value: "currency", label: "Belopp (kr)" },
  { value: "percent", label: "Procent" },
  { value: "date", label: "Datum" },
  { value: "datetime", label: "Datum och tid" },
  { value: "boolean", label: "Ja/Nej" },
  { value: "phone", label: "Telefon" },
  { value: "email", label: "E-post" },
  { value: "url", label: "Webbadress" },
];

const typeLabel = (t: string) => FIELD_TYPES.find((x) => x.value === t)?.label ?? t;
const hasChoices = (t: string) => t === "select" || t === "multi_select";

/** Nyckel av en etikett: gemener, å/ä/ö → a/a/o, bara a-z0-9_. */
function autoKey(label: string) {
  return label
    .toLowerCase()
    .replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

/** Textrader → val. Behåller befintliga nycklar för oförändrade etiketter så
 *  redan sparade värden inte tappar sin koppling. */
function parseChoices(text: string, existing: Choice[] = []): Choice[] {
  const used = new Set<string>();
  const out: Choice[] = [];
  for (const raw of text.split("\n")) {
    const label = raw.trim();
    if (!label) continue;
    const prev = existing.find((c) => c.label === label);
    let key = prev?.key ?? (autoKey(label) || "val");
    let n = 2;
    while (used.has(key)) key = `${prev?.key ?? autoKey(label)}_${n++}`;
    used.add(key);
    out.push({ key, label });
  }
  return out;
}

// Fält som bär systemet och inte får tas bort.
const PROTECTED = (f: FieldDef) => f.key === "name" || f.isRequired;

export function FieldConfigPanel({
  objectType, objectLabel, fields, onClose, onChanged, mode = "crm", sections,
}: Props) {
  const isHidden = (f: FieldDef) =>
    mode === "seller" ? !!f.options.seller_hidden : f.visibility === "hidden";

  const [localFields, setLocalFields] = useState<FieldDef[]>([...fields]);
  const [hiddenMap, setHiddenMap] = useState<Record<string, boolean>>(
    () => Object.fromEntries(fields.map((f) => [f.key, isHidden(f)])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Nytt fält
  const [showAdd, setShowAdd] = useState(false);
  const [nfLabel, setNfLabel] = useState("");
  const [nfKey, setNfKey] = useState("");
  const [nfType, setNfType] = useState("text");
  const [nfChoices, setNfChoices] = useState("");
  const [nfSection, setNfSection] = useState(sections?.[0]?.key ?? "");

  // Redigera befintligt fält (etikett + val)
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editChoices, setEditChoices] = useState("");

  const flash = (msg: string) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(null), 2000); };

  function moveField(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= localFields.length) return;
    const copy = [...localFields];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    setLocalFields(copy);
  }

  async function deleteField(field: FieldDef) {
    if (!confirm(`Vill du verkligen ta bort fältet "${field.label}"? Redan sparad data raderas inte, men fältet visas inte längre.`)) return;
    setSaving(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc("admin_delete_field", { p_object_type: objectType, p_key: field.key });
      if (err) throw err;
      setLocalFields((prev) => prev.filter((f) => f.key !== field.key));
      flash(`"${field.label}" borttaget`);
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte ta bort fältet.");
    } finally {
      setSaving(false);
    }
  }

  async function addField() {
    const key = autoKey(nfKey || nfLabel);
    const label = nfLabel.trim();
    if (!key || !label) return;
    if (localFields.some((f) => f.key === key)) { setError(`Det finns redan ett fält med nyckeln "${key}".`); return; }
    const choices = hasChoices(nfType) ? parseChoices(nfChoices) : [];
    if (hasChoices(nfType) && choices.length === 0) { setError("Lägg till minst ett alternativ (ett per rad)."); return; }

    const options: FieldDef["options"] = {};
    if (nfSection) options.section = nfSection;
    if (choices.length) options.choices = choices;

    // Nya fält hamnar sist i den valda sektionen.
    const inSection = localFields.filter((f) => (f.options.section ?? "") === nfSection);
    const sortOrder = (inSection.length
      ? Math.max(...inSection.map((f) => f.sortOrder ?? 0))
      : Math.max(0, ...localFields.map((f) => f.sortOrder ?? 0))) + 5;

    setSaving(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc("admin_create_field", {
        p_object_type: objectType,
        p_key: key,
        p_label: label,
        p_field_type: nfType,
        p_options: options,
        p_sort_order: sortOrder,
      });
      if (err) throw err;
      const created: FieldDef = {
        key, label, fieldType: nfType as FieldDef["fieldType"], isRequired: false,
        helpText: null, sortOrder, options, visibility: "all",
      } as FieldDef;
      setLocalFields((prev) => [...prev, created].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
      setHiddenMap((m) => ({ ...m, [key]: false }));
      setNfLabel(""); setNfKey(""); setNfType("text"); setNfChoices("");
      setShowAdd(false);
      flash("Fält tillagt!");
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte lägga till fältet.");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(f: FieldDef) {
    setEditKey(f.key);
    setEditLabel(f.label);
    setEditChoices((f.options.choices ?? []).map((c) => c.label).join("\n"));
  }

  async function saveEdit(f: FieldDef) {
    const label = editLabel.trim();
    if (!label) return;
    const updates: Record<string, unknown> = { label };
    let options = f.options;
    if (hasChoices(f.fieldType)) {
      const choices = parseChoices(editChoices, f.options.choices ?? []);
      if (choices.length === 0) { setError("Ett rullgardinsfält behöver minst ett alternativ."); return; }
      options = { ...f.options, choices };
      updates.options = options;
    }
    setSaving(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc("admin_update_field", {
        p_object_type: objectType, p_key: f.key, p_updates: updates,
      });
      if (err) throw err;
      setLocalFields((prev) => prev.map((x) => (x.key === f.key ? { ...x, label, options } : x)));
      setEditKey(null);
      flash("Fält uppdaterat!");
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte spara fältet.");
    } finally {
      setSaving(false);
    }
  }

  async function saveAll() {
    setSaving(true);
    setError(null);
    try {
      const order = localFields.map((f, i) => ({ key: f.key, sort_order: (i + 1) * 10 }));
      const { error: err } = await supabase.rpc("admin_reorder_fields", { p_object_type: objectType, p_order: order });
      if (err) throw err;

      for (const f of localFields) {
        const hidden = !!hiddenMap[f.key];
        if (hidden === isHidden(f)) continue;
        const updates = mode === "seller"
          ? { options: { ...f.options, seller_hidden: hidden } }
          : { visibility: hidden ? "hidden" : "all" };
        const { error: e2 } = await supabase.rpc("admin_update_field", {
          p_object_type: objectType, p_key: f.key, p_updates: updates,
        });
        if (e2) throw e2;
      }

      flash("Sparat!");
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte spara.");
    } finally {
      setSaving(false);
    }
  }

  const sectionLabel = (key?: string) => sections?.find((s) => s.key === key)?.label ?? key;

  return (
    <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="field-config">
        <div className="field-config__header">
          <h2>Anpassa fält — {objectLabel}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Stäng">×</button>
        </div>

        <div className="field-config__body">
          {mode === "seller" && (
            <p className="field-config__hint">
              Välj vilka fält säljarna ser inne på en adress. Dolda fält finns kvar i CRM:et.
              Ändra ordning med pilarna och tryck Spara.
            </p>
          )}

          <div className="field-config__list">
            {localFields.map((f, i) => {
              const hidden = !!hiddenMap[f.key];
              const editing = editKey === f.key;
              return (
                <div key={f.key} className={`field-config__row${hidden ? " field-config__row--hidden" : ""}`}>
                  <div className="field-config__arrows">
                    <button className="field-config__arrow" onClick={() => moveField(i, -1)} disabled={i === 0} title="Flytta upp">↑</button>
                    <button className="field-config__arrow" onClick={() => moveField(i, 1)} disabled={i === localFields.length - 1} title="Flytta ner">↓</button>
                  </div>

                  {editing ? (
                    <div className="field-config__info field-config__edit">
                      <input className="input" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} autoFocus />
                      {hasChoices(f.fieldType) && (
                        <textarea
                          className="input input--area" rows={4}
                          placeholder="Ett alternativ per rad"
                          value={editChoices}
                          onChange={(e) => setEditChoices(e.target.value)}
                        />
                      )}
                      <div className="field-config__edit-actions">
                        <button className="btn btn--brand btn--sm" onClick={() => saveEdit(f)} disabled={saving || !editLabel.trim()}>Spara fält</button>
                        <button className="btn btn--ghost btn--sm" onClick={() => setEditKey(null)} disabled={saving}>Avbryt</button>
                      </div>
                    </div>
                  ) : (
                    <div className="field-config__info">
                      <span className="field-config__label">{f.label}</span>
                      <span className="field-config__meta">
                        {typeLabel(f.fieldType)}
                        {f.options.section ? ` · ${sectionLabel(f.options.section)}` : ""}
                        {hasChoices(f.fieldType) && f.options.choices?.length
                          ? ` · ${f.options.choices.map((c) => c.label).join(", ")}` : ""}
                      </span>
                    </div>
                  )}

                  {!editing && (
                    <div className="field-config__actions">
                      <button
                        className={`btn btn--ghost btn--sm${hidden ? " btn--muted" : ""}`}
                        onClick={() => setHiddenMap((m) => ({ ...m, [f.key]: !m[f.key] }))}
                        title={hidden ? "Visa fält" : "Dölj fält"}
                      >
                        {hidden ? "Dold" : "Synlig"}
                      </button>
                      <button className="btn btn--ghost btn--sm" onClick={() => startEdit(f)} disabled={saving} title="Byt namn / ändra alternativ">
                        Ändra
                      </button>
                      {!PROTECTED(f) && (
                        <button className="btn btn--ghost btn--sm btn--danger" onClick={() => deleteField(f)} disabled={saving} title="Ta bort fält">✕</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {localFields.length === 0 && <div className="empty-state">Inga fält konfigurerade.</div>}

          {showAdd ? (
            <div className="field-config__add-form">
              <div className="field-config__add-row">
                <div className="formfield" style={{ flex: 2, minWidth: 180 }}>
                  <label className="label">Namn på fältet</label>
                  <input
                    className="input" placeholder="t.ex. Antal personer i hushållet"
                    value={nfLabel}
                    onChange={(e) => {
                      const label = e.target.value;
                      if (!nfKey || nfKey === autoKey(nfLabel)) setNfKey(autoKey(label));
                      setNfLabel(label);
                    }}
                    autoFocus
                  />
                </div>
                <div className="formfield" style={{ flex: 1, minWidth: 160 }}>
                  <label className="label">Typ</label>
                  <select className="input" value={nfType} onChange={(e) => setNfType(e.target.value)}>
                    {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                {!!sections?.length && (
                  <div className="formfield" style={{ flex: 1, minWidth: 140 }}>
                    <label className="label">Sektion</label>
                    <select className="input" value={nfSection} onChange={(e) => setNfSection(e.target.value)}>
                      {sections.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {hasChoices(nfType) && (
                <div className="formfield" style={{ marginTop: 8 }}>
                  <label className="label">Alternativ — ett per rad</label>
                  <textarea
                    className="input input--area" rows={4}
                    placeholder={"Villa\nLägenhet\nRadhus"}
                    value={nfChoices}
                    onChange={(e) => setNfChoices(e.target.value)}
                  />
                </div>
              )}

              <details className="field-config__advanced">
                <summary>Avancerat</summary>
                <div className="formfield">
                  <label className="label">Teknisk nyckel</label>
                  <input className="input" value={nfKey} onChange={(e) => setNfKey(e.target.value)} placeholder="skapas automatiskt" />
                </div>
              </details>

              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button className="btn btn--brand btn--sm" onClick={addField} disabled={saving || !nfLabel.trim()}>
                  {saving ? "Lägger till…" : "Lägg till"}
                </button>
                <button className="btn btn--ghost btn--sm" onClick={() => setShowAdd(false)} disabled={saving}>Avbryt</button>
              </div>
            </div>
          ) : (
            <button className="btn btn--ghost btn--sm" onClick={() => setShowAdd(true)} style={{ marginTop: "8px" }}>
              + Lägg till fält
            </button>
          )}
        </div>

        {error && <div className="formfield__error" style={{ padding: "0 20px" }}>{error}</div>}
        {successMsg && <div className="field-config__success">{successMsg}</div>}

        <div className="field-config__footer">
          <button className="btn btn--ghost" onClick={onClose} disabled={saving}>Stäng</button>
          <button className="btn btn--brand" onClick={saveAll} disabled={saving}>
            {saving ? "Sparar…" : "Spara synlighet och ordning"}
          </button>
        </div>
      </div>
    </div>
  );
}
