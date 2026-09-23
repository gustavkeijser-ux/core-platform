import { useState } from "react";
import type { ObjectDef, RelatedRecord } from "@/lib/data";
import { addRelation, removeRelation, listRecords, DataError } from "@/lib/data";

type Props = {
  recordId: string;
  objectDef: ObjectDef;
  related: RelatedRecord[];
  onNavigate: (id: string) => void;
  onChanged: () => void;
};

/**
 * En relationstyp per grupp: befintliga kopplingar plus en sökruta för att
 * lägga till en ny. Sökningen går mot `records` med RLS, så bara poster
 * användaren får läsa dyker upp som förslag.
 */
function RelationGroup({
  recordId, forward, objectDef, related, onNavigate, onChanged,
}: Props & { forward: boolean }) {
  const defs = forward ? objectDef.relations.outgoing : objectDef.relations.incoming;
  return (
    <>
      {defs.map((def) => {
        const items = related.filter(
          (r) => r.relType === def.relType && r.direction === (forward ? "outgoing" : "incoming")
        );
        const label = forward ? def.labelForward : def.labelReverse;
        const targetType = forward ? def.toObject : def.fromObject;
        return (
          <RelationGroupBody
            key={def.relType + forward}
            recordId={recordId}
            relType={def.relType}
            label={label}
            targetType={targetType}
            forward={forward}
            items={items}
            onNavigate={onNavigate}
            onChanged={onChanged}
          />
        );
      })}
    </>
  );
}

function RelationGroupBody({
  recordId, relType, label, targetType, forward, items, onNavigate, onChanged,
}: {
  recordId: string; relType: string; label: string; targetType: string; forward: boolean;
  items: RelatedRecord[]; onNavigate: (id: string) => void; onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<{ id: string; title: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(q: string) {
    setQuery(q);
    if (q.length < 2) { setOptions([]); return; }
    const { items: found } = await listRecords({ objectType: targetType, search: q, limit: 8 });
    setOptions(found.map((r) => ({ id: r.id, title: r.title })));
  }

  async function pick(id: string) {
    setBusy(true);
    setError(null);
    try {
      if (forward) await addRelation(recordId, relType, id);
      else await addRelation(id, relType, recordId);
      setQuery("");
      setOptions([]);
      onChanged();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte koppla posten.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(otherId: string) {
    setBusy(true);
    try {
      if (forward) await removeRelation(recordId, relType, otherId);
      else await removeRelation(otherId, relType, recordId);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relation-group">
      <div className="relation-group__label">{label}</div>
      {items.map((r) => (
        <div className="relation-row" key={r.record.id + r.relType}>
          <div className="relation-row__main">
            <span className="relation-row__title" onClick={() => onNavigate(r.record.id)}>
              {r.record.title ?? "Namnlös post"}
            </span>
            <span className="relation-row__meta">{r.record.status ?? ""}</span>
          </div>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => unlink(r.record.id)}>
            Ta bort
          </button>
        </div>
      ))}
      <div className="picker">
        <input
          className="input"
          placeholder={`Sök och koppla…`}
          value={query}
          onChange={(e) => search(e.target.value)}
        />
      </div>
      {options.length > 0 && (
        <div className="card" style={{ padding: "8px", marginTop: "8px" }}>
          {options.map((o) => (
            <div
              key={o.id}
              className="relation-row"
              style={{ cursor: "pointer" }}
              onClick={() => pick(o.id)}
            >
              <span>{o.title ?? "Namnlös post"}</span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="formfield__error">{error}</div>}
    </div>
  );
}

export function RelationPicker(props: Props) {
  const hasAny = props.objectDef.relations.outgoing.length > 0
    || props.objectDef.relations.incoming.length > 0;
  if (!hasAny) return <div className="empty-state">Inga relationer definierade för {props.objectDef.labelSingular}.</div>;
  return (
    <div>
      <RelationGroup {...props} forward={true} />
      <RelationGroup {...props} forward={false} />
    </div>
  );
}
