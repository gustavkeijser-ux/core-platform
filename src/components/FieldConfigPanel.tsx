import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FieldDef } from "@/lib/data";

type Props = {
  objectType: string;
  objectLabel: string;
  fields: FieldDef[];
  onClose: () => void;
  onChanged: () => void; // signal to reload metadata
};

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Lång text" },
  { value: "number", label: "Nummer" },
  { value: "date", label: "Datum" },
  { value: "boolean", label: "Ja/Nej" },
  { value: "url", label: "URL" },
  { value: "email", label: "E-post" },
  { value: "phone", label: "Telefon" },
  { value: "select", label: "Välj (dropdown)" },
  { value: "user", label: "Användare" },
];

type NewField = {
  key: string;
  label: string;
  fieldType: string;
};

export function FieldConfigPanel({ objectType, objectLabel, fields, onClose, onChanged }: Props) {
  const [localFields, setLocalFields] = useState<FieldDef[]>([...fields]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Nytt fält-formulär
  const [showAdd, setShowAdd] = useState(false);
  const [newField, setNewField] = useState<NewField>({ key: "", label: "", fieldType: "text" });

  // Flytta fält upp/ner
  function moveField(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= localFields.length) return;
    const copy = [...localFields];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    setLocalFields(copy);
  }

  // Dölj/visa fält
  function toggleVisibility(index: number) {
    setLocalFields((prev) =>
      prev.map((f, i) =>
        i === index
          ? { ...f, options: { ...f.options, _hidden: !f.options._hidden } }
          : f
      )
    );
  }

  // Ta bort fält
  async function deleteField(field: FieldDef) {
    if (!confirm(`Vill du verkligen ta bort fältet "${field.label}"? Data i fältet försvinner inte men visas inte längre.`)) return;
    setSaving(true);
    setError(null);
    try {
      const { error: err } = await supabase.rpc("admin_delete_field", {
        p_object_type: objectType,
        p_key: field.key,
      });
      if (err) throw err;
      setLocalFields((prev) => prev.filter((f) => f.key !== field.key));
      setSuccessMsg(`"${field.label}" borttagen`);
      setTimeout(() => setSuccessMsg(null), 2000);
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte ta bort fältet.");
    } finally {
      setSaving(false);
    }
  }

  // Lägg till nytt fält
  async function addField() {
    if (!newField.key.trim() || !newField.label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const maxSort = localFields.length > 0
        ? Math.max(...localFields.map((_, i) => (i + 1) * 10))
        : 0;
      const { error: err } = await supabase.rpc("admin_create_field", {
        p_object_type: objectType,
        p_key: newField.key.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""),
        p_label: newField.label.trim(),
        p_field_type: newField.fieldType,
        p_sort_order: maxSort + 10,
      });
      if (err) throw err;

      // Lägg till lokalt
      setLocalFields((prev) => [
        ...prev,
        {
          key: newField.key.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""),
          label: newField.label.trim(),
          fieldType: newField.fieldType as any,
          isRequired: false,
          isUnique: false,
          helpText: null,
          // Samma ordning som skickades till databasen ovan, annars hamnar
          // fältet först i listan lokalt och sist efter nästa omladdning.
          sortOrder: maxSort + 10,
          options: {},
        },
      ]);
      setNewField({ key: "", label: "", fieldType: "text" });
      setShowAdd(false);
      setSuccessMsg("Fält tillagt!");
      setTimeout(() => setSuccessMsg(null), 2000);
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte lägga till fältet.");
    } finally {
      setSaving(false);
    }
  }

  // Spara ordning
  async function saveOrder() {
    setSaving(true);
    setError(null);
    try {
      const order = localFields.map((f, i) => ({ key: f.key, sort_order: (i + 1) * 10 }));
      const { error: err } = await supabase.rpc("admin_reorder_fields", {
        p_object_type: objectType,
        p_order: order,
      });
      if (err) throw err;

      // Dölj/visa — uppdatera visibility
      for (const f of localFields) {
        const hidden = !!f.options._hidden;
        const currentVis = fields.find((orig) => orig.key === f.key);
        const wasHidden = !!currentVis?.options._hidden;
        if (hidden !== wasHidden) {
          await supabase.rpc("admin_update_field", {
            p_object_type: objectType,
            p_key: f.key,
            p_updates: { visibility: hidden ? "hidden" : "all" },
          });
        }
      }

      setSuccessMsg("Sparad!");
      setTimeout(() => setSuccessMsg(null), 2000);
      onChanged();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte spara.");
    } finally {
      setSaving(false);
    }
  }

  // Auto-generera key från label
  function autoKey(label: string) {
    return label
      .toLowerCase()
      .replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o")
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 40);
  }

  return (
    <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="field-config">
        <div className="field-config__header">
          <h2>Konfigurera fält — {objectLabel}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Stäng">×</button>
        </div>

        <div className="field-config__body">
          <div className="field-config__list">
            {localFields.map((f, i) => {
              const isHidden = !!f.options._hidden;
              return (
                <div key={f.key} className={`field-config__row${isHidden ? " field-config__row--hidden" : ""}`}>
                  <div className="field-config__arrows">
                    <button
                      className="field-config__arrow"
                      onClick={() => moveField(i, -1)}
                      disabled={i === 0}
                      title="Flytta upp"
                    >↑</button>
                    <button
                      className="field-config__arrow"
                      onClick={() => moveField(i, 1)}
                      disabled={i === localFields.length - 1}
                      title="Flytta ner"
                    >↓</button>
                  </div>
                  <div className="field-config__info">
                    <span className="field-config__label">{f.label}</span>
                    <span className="field-config__meta">{f.key} · {f.fieldType}</span>
                  </div>
                  <div className="field-config__actions">
                    <button
                      className={`btn btn--ghost btn--sm${isHidden ? " btn--muted" : ""}`}
                      onClick={() => toggleVisibility(i)}
                      title={isHidden ? "Visa fält" : "Dölj fält"}
                    >
                      {isHidden ? "Dold" : "Synlig"}
                    </button>
                    <button
                      className="btn btn--ghost btn--sm btn--danger"
                      onClick={() => deleteField(f)}
                      disabled={saving}
                      title="Ta bort fält"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {localFields.length === 0 && (
            <div className="empty-state">Inga fält konfigurerade.</div>
          )}

          {/* Lägg till nytt fält */}
          {showAdd ? (
            <div className="field-config__add-form">
              <div className="field-config__add-row">
                <div className="formfield" style={{ flex: 1 }}>
                  <label className="label">Etikett</label>
                  <input
                    className="input"
                    placeholder="t.ex. Antal lägenheter"
                    value={newField.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      setNewField((prev) => ({
                        ...prev,
                        label,
                        key: prev.key === autoKey(prev.label) || prev.key === ""
                          ? autoKey(label)
                          : prev.key,
                      }));
                    }}
                    autoFocus
                  />
                </div>
                <div className="formfield" style={{ flex: 1 }}>
                  <label className="label">Nyckel</label>
                  <input
                    className="input"
                    placeholder="antal_lagenheter"
                    value={newField.key}
                    onChange={(e) => setNewField((prev) => ({ ...prev, key: e.target.value }))}
                  />
                </div>
                <div className="formfield" style={{ width: "140px" }}>
                  <label className="label">Typ</label>
                  <select
                    className="input"
                    value={newField.fieldType}
                    onChange={(e) => setNewField((prev) => ({ ...prev, fieldType: e.target.value }))}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button className="btn btn--brand btn--sm" onClick={addField} disabled={saving || !newField.label.trim() || !newField.key.trim()}>
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
          <button className="btn btn--brand" onClick={saveOrder} disabled={saving}>
            {saving ? "Sparar…" : "Spara ordning"}
          </button>
        </div>
      </div>
    </div>
  );
}
