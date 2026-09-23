import { useCallback, useEffect, useState } from "react";
import {
  syncRecordChecklists, getRecordChecklists, toggleChecklistItem, DataError,
  type Checklist, type ChecklistItem,
} from "@/lib/data";
import { UserBadge } from "@/lib/users";

type Props = {
  recordId: string;
  /** Postens nuvarande status — styr vilken fas som öppnas automatiskt */
  currentStatus: string | null;
  /** Statusordning, för att avgöra vad som är passerat respektive kommande */
  statusSort: Record<string, number>;
};

type Phase = "passed" | "current" | "upcoming" | "always";

function phaseOf(list: Checklist, currentStatus: string | null, statusSort: Record<string, number>): Phase {
  if (!list.statusKey) return "always";
  if (list.statusKey === currentStatus) return "current";
  const mine = statusSort[list.statusKey];
  const now = currentStatus ? statusSort[currentStatus] : undefined;
  if (mine == null || now == null) return "upcoming";
  return mine < now ? "passed" : "upcoming";
}

function Ring({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  const complete = total > 0 && done === total;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="cl__ring" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity=".2" />
      <circle
        cx="9" cy="9" r={r} fill="none"
        stroke={complete ? "var(--hue-green)" : "currentColor"}
        strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

function Row({ item, onToggle, busy }: {
  item: ChecklistItem;
  onToggle: (done: boolean) => void;
  busy: boolean;
}) {
  const done = !!item.doneAt;
  return (
    <li className={`cl-item${done ? " cl-item--done" : ""}`}>
      <label className="cl-item__check">
        <input
          type="checkbox"
          checked={done}
          disabled={busy}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </label>
      <div className="cl-item__body">
        <span className="cl-item__label">
          {item.label}
          {item.isRequired && (
            <span className="cl-item__req" title="Obligatorisk punkt">•</span>
          )}
        </span>
        {item.helpText && <span className="cl-item__help">{item.helpText}</span>}
        {done && item.doneBy && (
          <span className="cl-item__by">
            <UserBadge id={item.doneBy} />
            {item.doneAt && (
              <time>{new Date(item.doneAt).toLocaleDateString("sv-SE", {
                day: "numeric", month: "short",
              })}</time>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

export function ChecklistTab({ recordId, currentStatus, statusSort }: Props) {
  const [lists, setLists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busyItem, setBusyItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await syncRecordChecklists(recordId);
      const res = await getRecordChecklists(recordId);
      setLists(res);
      // Öppna den aktuella fasen och fasoberoende listor; övriga stängda.
      setOpen((prev) => {
        const next: Record<string, boolean> = { ...prev };
        for (const l of res) {
          if (next[l.id] === undefined) {
            const p = phaseOf(l, currentStatus, statusSort);
            next[l.id] = p === "current" || p === "always";
          }
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta checklistorna.");
    } finally {
      setLoading(false);
    }
  }, [recordId, currentStatus, statusSort]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [recordId]);

  async function toggle(item: ChecklistItem, done: boolean) {
    setBusyItem(item.id);
    // Optimistisk uppdatering — servern är sanningen, men listan ska kännas snabb
    setLists((prev) => prev.map((l) => ({
      ...l,
      items: l.items.map((it) =>
        it.id === item.id ? { ...it, doneAt: done ? new Date().toISOString() : null } : it
      ),
      done: l.items.some((it) => it.id === item.id)
        ? l.done + (done ? 1 : -1)
        : l.done,
    })));
    try {
      await toggleChecklistItem(item.id, done);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara punkten.");
      await load(); // rulla tillbaka mot servern
    } finally {
      setBusyItem(null);
    }
  }

  if (loading) return <div className="empty-state">Laddar…</div>;

  if (lists.length === 0) {
    return (
      <div className="empty-state">
        Inga checklistor är konfigurerade för den här objekttypen.
      </div>
    );
  }

  const totalAll = lists.reduce((n, l) => n + l.total, 0);
  const doneAll = lists.reduce((n, l) => n + l.done, 0);
  const requiredLeft = lists.reduce(
    (n, l) => n + l.items.filter((i) => i.isRequired && !i.doneAt).length, 0
  );

  return (
    <div className="cl">
      {error && <div className="formfield__error">{error}</div>}

      <div className="cl__summary">
        <span className="cl__summary-count">{doneAll} av {totalAll} avbockade</span>
        {requiredLeft > 0 && (
          <span className="cl__summary-req">
            {requiredLeft} obligatorisk{requiredLeft === 1 ? "" : "a"} kvar
          </span>
        )}
      </div>

      <div className="cl__phases">
        {lists.map((l) => {
          const phase = phaseOf(l, currentStatus, statusSort);
          const isOpen = !!open[l.id];
          const complete = l.total > 0 && l.done === l.total;
          return (
            <section key={l.id} className={`cl-phase cl-phase--${phase}`}>
              <button
                className="cl-phase__head"
                aria-expanded={isOpen}
                onClick={() => setOpen((p) => ({ ...p, [l.id]: !p[l.id] }))}
              >
                <span className="cl-phase__chevron" data-open={isOpen}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 2L6.5 5L3.5 8" />
                  </svg>
                </span>
                <Ring done={l.done} total={l.total} />
                <span className="cl-phase__name">{l.name}</span>
                {phase === "current" && <span className="cl-phase__tag cl-phase__tag--now">Pågår</span>}
                {phase === "passed" && !complete && (
                  <span className="cl-phase__tag cl-phase__tag--late">Passerad</span>
                )}
                <span className="cl-phase__count">{l.done}/{l.total}</span>
              </button>

              {isOpen && (
                <ul className="cl-items">
                  {l.items.map((it) => (
                    <Row
                      key={it.id}
                      item={it}
                      busy={busyItem === it.id}
                      onToggle={(d) => toggle(it, d)}
                    />
                  ))}
                  {l.items.length === 0 && (
                    <li className="cl-items__empty">Inga punkter i den här fasen.</li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
