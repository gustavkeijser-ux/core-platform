import { useEffect, useState } from "react";
import type { ObjectDef, RecordRow, RelatedRecord, TimelineEntry } from "@/lib/data";
import { getRecord, DataError } from "@/lib/data";
import { formatValue } from "@/lib/fields";
import { StatusPill } from "./StatusPill";
import { Timeline } from "./Timeline";
import { QuickLog } from "./QuickLog";
import { RelationPicker } from "./RelationPicker";
import { RecordDrawer } from "./RecordDrawer";
import { UserBadge } from "@/lib/users";

type Props = {
  recordId: string;
  objectDefFor: (type: string) => ObjectDef | undefined;
  onBack: () => void;
  onNavigate: (id: string) => void;
};

export function RecordDetailPage({ recordId, objectDefFor, onBack, onNavigate }: Props) {
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [related, setRelated] = useState<RelatedRecord[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getRecord(recordId);
      setRecord(res.record);
      setRelated(res.related);
      setTimeline(res.timeline);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta posten.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [recordId]);

  if (loading) return <div className="page"><div className="empty-state">Laddar…</div></div>;
  if (error || !record) return <div className="page"><div className="empty-state">{error ?? "Posten hittades inte."}</div></div>;

  const objectDef = objectDefFor(record.object_type);
  if (!objectDef) return <div className="page"><div className="empty-state">Okänd objekttyp.</div></div>;

  return (
    <div className="page">
      <button className="back-link" onClick={onBack}>← Tillbaka till {objectDef.labelPlural.toLowerCase()}</button>

      <div className="detail-header">
        <div>
          <h2>{record.title ?? "Namnlös post"}</h2>
          <div style={{ marginTop: "8px" }}>
            <StatusPill status={record.status} def={objectDef.statuses.find((s) => s.key === record.status)} />
          </div>
        </div>
        <div className="detail-header__actions">
          {objectDef.can.update && (
            <button className="btn btn--ghost" onClick={() => setEditing(true)}>Redigera</button>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="card">
            <div className="section-title">Fält</div>
            <dl className="field-list">
              {objectDef.fields.map((f) => (
                <div key={f.key} className={RENDER_WIDE(f) ? "field-list__wide" : undefined}>
                  <dt>{f.label}</dt>
                  <dd>{f.fieldType === "user"
                    ? <UserBadge id={record.data[f.key] as string} />
                    : (formatValue(f, record.data[f.key]) || "—")}</dd>
                </div>
              ))}
              <div>
                <dt>Ägare</dt>
                <dd><UserBadge id={record.owner_user_id} /></dd>
              </div>
            </dl>
          </div>

          <div className="card">
            <div className="section-title">Tidslinje</div>
            <QuickLog recordId={record.id} onLogged={load} />
            <Timeline entries={timeline} />
          </div>
        </div>

        <div className="card">
          <div className="section-title">Relationer</div>
          <RelationPicker
            recordId={record.id}
            objectDef={objectDef}
            related={related}
            onNavigate={onNavigate}
            onChanged={load}
          />
        </div>
      </div>

      {editing && (
        <RecordDrawer
          objectDef={objectDef}
          record={record}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </div>
  );
}

function RENDER_WIDE(f: { fieldType: string }) {
  return f.fieldType === "long_text" || f.fieldType === "address" || f.fieldType === "json";
}
