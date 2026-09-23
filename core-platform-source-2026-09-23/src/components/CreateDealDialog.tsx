import { useState } from "react";
import { createRecord, addRelation, DataError } from "@/lib/data";
import type { RelatedRecord } from "@/lib/data";

type Props = {
  koncernmoderId: string;
  koncernmoderName: string;
  /** Alla fastigheter kopplade till denna koncernmoder */
  properties: RelatedRecord[];
  onCreated: (dealId: string) => void;
  onCancel: () => void;
};

export function CreateDealDialog({
  koncernmoderId,
  koncernmoderName,
  properties,
  onCreated,
  onCancel,
}: Props) {
  const [name, setName] = useState(`Affär – ${koncernmoderName}`);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(properties.map((p) => p.record.id))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === properties.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(properties.map((p) => p.record.id)));
    }
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // 1. Skapa affären
      const deal = await createRecord("deal", { name: name.trim() });

      // 2. Koppla till koncernmoder
      await addRelation(deal.id, "deal_for", koncernmoderId);

      // 3. Koppla valda fastigheter
      for (const propId of selected) {
        await addRelation(deal.id, "deal_property", propId);
      }

      onCreated(deal.id);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte skapa affären.");
      setSaving(false);
    }
  }

  const allSelected = selected.size === properties.length;
  const noneSelected = selected.size === 0;

  return (
    <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && !saving && onCancel()}>
      <div className="deal-dialog">
        <div className="deal-dialog__header">
          <h2>Skapa affär</h2>
          <button className="close-btn" onClick={onCancel} disabled={saving} aria-label="Stäng">×</button>
        </div>

        <div className="deal-dialog__body">
          {/* Affärsnamn */}
          <div className="formfield">
            <label className="label" htmlFor="deal-name">Namn på affären</label>
            <input
              id="deal-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="formfield" style={{ marginTop: "4px", marginBottom: "4px" }}>
            <span className="label">Koncernmoder</span>
            <span className="deal-dialog__km-name">{koncernmoderName}</span>
          </div>

          {/* Fastighetslista */}
          {properties.length > 0 && (
            <div className="deal-dialog__props">
              <div className="deal-dialog__props-header">
                <span className="label">Fastigheter ({selected.size} av {properties.length})</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={toggleAll}
                >
                  {allSelected ? "Avmarkera alla" : "Markera alla"}
                </button>
              </div>
              <div className="deal-dialog__props-list">
                {properties.map((p) => (
                  <label key={p.record.id} className="deal-dialog__prop-row">
                    <input
                      type="checkbox"
                      checked={selected.has(p.record.id)}
                      onChange={() => toggle(p.record.id)}
                    />
                    <span className="deal-dialog__prop-name">
                      {p.record.title ?? "Namnlös fastighet"}
                    </span>
                    {p.record.status && (
                      <span className="deal-dialog__prop-status">{p.record.status}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {properties.length === 0 && (
            <div className="empty-state" style={{ margin: "12px 0" }}>
              Inga fastigheter kopplade till denna koncernmoder.
            </div>
          )}

          {error && <div className="formfield__error">{error}</div>}
        </div>

        <div className="deal-dialog__footer">
          <button className="btn btn--ghost" onClick={onCancel} disabled={saving}>Avbryt</button>
          <button
            className="btn btn--brand"
            onClick={handleCreate}
            disabled={saving || !name.trim()}
          >
            {saving ? "Skapar…" : `Skapa affär${noneSelected ? "" : ` med ${selected.size} fastighet${selected.size !== 1 ? "er" : ""}`}`}
          </button>
        </div>
      </div>
    </div>
  );
}
