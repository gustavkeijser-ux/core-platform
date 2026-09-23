import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { FieldDef, ObjectDef } from "@/lib/data";

type Props = {
  objectDef: ObjectDef;
  onClose: () => void;
  onChanged: () => void; // ladda om metadata
};

/** Fält som aldrig fungerar bra som kolumn */
const UNSUITABLE = new Set(["long_text", "json"]);

type Row = FieldDef & { _selected: boolean };

export function ColumnConfigPanel({ objectDef, onClose, onChanged }: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialt urval: explicit _column om någon är satt, annars heuristiken
  const [rows, setRows] = useState<Row[]>(() => {
    const usable = objectDef.fields.filter((f) => !UNSUITABLE.has(f.fieldType));
    const anyExplicit = usable.some((f) => f.options._column === true);

    const selectedKeys = anyExplicit
      ? new Set(usable.filter((f) => f.options._column === true).map((f) => f.key))
      : new Set(usable.slice(0, 3).map((f) => f.key));

    // Valda först (i sort_order), sedan övriga
    const chosen = usable.filter((f) => selectedKeys.has(f.key));
    const rest = usable.filter((f) => !selectedKeys.has(f.key));
    return [...chosen, ...rest].map((f) => ({ ...f, _selected: selectedKeys.has(f.key) }));
  });

  function toggle(index: number) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, _selected: !r._selected } : r)));
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= rows.length) return;
    const copy = [...rows];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    setRows(copy);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Skriv _column och _column_order på varje fält. options ersätts i sin
      // helhet av admin_update_field, så vi skickar med befintliga nycklar.
      let order = 0;
      for (const r of rows) {
        const nextOptions = { ...r.options, _column: r._selected };
        if (r._selected) {
          nextOptions._column_order = order;
          order += 1;
        } else {
          delete nextOptions._column_order;
        }

        const wasSelected = r.options._column === true;
        const wasOrder = r.options._column_order;
        const changed =
          wasSelected !== r._selected ||
          (r._selected && wasOrder !== nextOptions._column_order);
        if (!changed) continue;

        const { error: err } = await supabase.rpc("admin_update_field", {
          p_object_type: objectDef.key,
          p_key: r.key,
          p_updates: { options: nextOptions },
        });
        if (err) throw err;
      }
      onChanged();
      onClose();
    } catch (e: any) {
      setError(e.message ?? "Kunde inte spara kolumnerna.");
    } finally {
      setSaving(false);
    }
  }

  const selectedCount = rows.filter((r) => r._selected).length;

  return (
    <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="field-config">
        <div className="field-config__header">
          <h2>Kolumner — {objectDef.labelPlural}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Stäng">×</button>
        </div>

        <div className="field-config__body">
          <p className="field-config__hint">
            Kryssa i de fält som ska visas som kolumner i listan. Pilarna styr ordningen.
            Namn och status visas alltid först.
          </p>

          <div className="field-config__list">
            {rows.map((r, i) => (
              <div
                key={r.key}
                className={`field-config__row${r._selected ? "" : " field-config__row--hidden"}`}
              >
                <div className="field-config__arrows">
                  <button
                    className="field-config__arrow"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    title="Flytta upp"
                  >↑</button>
                  <button
                    className="field-config__arrow"
                    onClick={() => move(i, 1)}
                    disabled={i === rows.length - 1}
                    title="Flytta ner"
                  >↓</button>
                </div>

                <label className="field-config__check">
                  <input
                    type="checkbox"
                    checked={r._selected}
                    onChange={() => toggle(i)}
                  />
                </label>

                <div className="field-config__info">
                  <span className="field-config__label">{r.label}</span>
                  <span className="field-config__meta">{r.key} · {r.fieldType}</span>
                </div>
              </div>
            ))}
          </div>

          {rows.length === 0 && (
            <div className="empty-state">Inga fält som passar som kolumn.</div>
          )}
        </div>

        {error && <div className="formfield__error" style={{ padding: "0 20px" }}>{error}</div>}

        <div className="field-config__footer">
          <span className="field-config__count">{selectedCount} valda</span>
          <button className="btn btn--ghost" onClick={onClose} disabled={saving}>Avbryt</button>
          <button className="btn btn--brand" onClick={save} disabled={saving}>
            {saving ? "Sparar…" : "Spara kolumner"}
          </button>
        </div>
      </div>
    </div>
  );
}
