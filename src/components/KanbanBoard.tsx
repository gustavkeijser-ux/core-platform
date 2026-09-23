import { useState } from "react";
import type { ObjectDef, RecordRow } from "@/lib/data";
import { updateRecord, DataError } from "@/lib/data";
import { formatValue } from "@/lib/fields";

type Props = {
  objectDef: ObjectDef;
  records: RecordRow[];
  onOpenRecord: (id: string) => void;
  onMoved: () => void;
};

/**
 * Kolumnerna är objektets status_definitions, i sort_order — samma metadata
 * som listvyns statusfilter använder. Fungerar för vilken objekttyp som
 * helst med statusar, inte specifikt "Affärer".
 */
export function KanbanBoard({ objectDef, records, onOpenRecord, onMoved }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  const currencyField = objectDef.fields.find((f) => f.fieldType === "currency");

  async function handleDrop(statusKey: string) {
    setDropTarget(null);
    if (!dragId) return;
    const rec = records.find((r) => r.id === dragId);
    setDragId(null);
    if (!rec || rec.status === statusKey) return;

    setMoving(rec.id);
    setError(null);
    try {
      await updateRecord(rec.id, undefined, statusKey);
      onMoved();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte flytta posten.");
    } finally {
      setMoving(null);
    }
  }

  return (
    <div>
      {error && <div className="formfield__error" style={{ marginBottom: "12px" }}>{error}</div>}
      <div className="kanban">
        {objectDef.statuses.map((s) => {
          const items = records.filter((r) => r.status === s.key);
          return (
            <div
              key={s.key}
              className="kanban-col"
              onDragOver={(e) => { e.preventDefault(); setDropTarget(s.key); }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={() => handleDrop(s.key)}
              style={dropTarget === s.key ? { background: "var(--brand-soft)" } : undefined}
            >
              <div className="kanban-col__header">
                <span className="kanban-col__dot" style={{ background: s.color ? `var(--hue-${s.color})` : "var(--hue-slate)" }} />
                {s.label}
                <span className="kanban-col__count">{items.length}</span>
              </div>
              <div className="kanban-col__body">
                {items.map((r) => (
                  <div
                    key={r.id}
                    className="kanban-card"
                    draggable
                    onDragStart={() => setDragId(r.id)}
                    onClick={() => onOpenRecord(r.id)}
                    style={moving === r.id ? { opacity: 0.5 } : undefined}
                  >
                    <div className="kanban-card__title">{r.title ?? "Namnlös post"}</div>
                    {currencyField && r.data[currencyField.key] != null && (
                      <div className="kanban-card__value">{formatValue(currencyField, r.data[currencyField.key])}</div>
                    )}
                  </div>
                ))}
                {items.length === 0 && <div className="kanban-col__empty">Tomt</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
