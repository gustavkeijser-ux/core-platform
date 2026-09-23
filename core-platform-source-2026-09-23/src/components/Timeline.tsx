import type { TimelineEntry } from "@/lib/data";
import { UserBadge } from "@/lib/users";

const LABELS: Record<string, (e: TimelineEntry) => string> = {
  field_change: (e) => e.body ?? "Fält ändrades",
  status_change: (e) => e.body ?? "Status ändrades",
  relation_change: (e) => e.body ?? "Relation ändrades",
  record_created: () => "Posten skapades",
};

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <div className="empty-state">Ingen aktivitet ännu.</div>;
  }
  return (
    <div className="timeline">
      {entries.map((e) => (
        <div className="timeline-item" key={e.id}>
          <div className="timeline-item__dot" />
          <div>
            <div className="timeline-item__body">
              {(LABELS[e.type] ?? ((x: TimelineEntry) => x.body ?? x.type))(e)}
            </div>
            <div className="timeline-item__meta">
              {e.actorKind === "agent" ? "AI-agent" : <UserBadge id={e.actorUserId} />}
              {" · "}
              {new Date(e.occurredAt).toLocaleString("sv-SE", {
                day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
