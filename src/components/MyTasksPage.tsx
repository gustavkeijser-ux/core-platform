import { useCallback, useEffect, useState } from "react";
import {
  getMyTasks, completeTask, updateTask, DataError,
  type MyTasks, type MyTask, type MyTaskGroup,
} from "@/lib/data";

type Props = { onOpenRecord: (id: string) => void };

const GRUPPER: Array<{ key: MyTaskGroup; label: string; ton: string }> = [
  { key: "forsenade",  label: "Försenade",     ton: "late" },
  { key: "idag",       label: "Idag",          ton: "today" },
  { key: "veckan",     label: "Kommande vecka",ton: "soon" },
  { key: "senare",     label: "Senare",        ton: "" },
  { key: "utan_datum", label: "Utan datum",    ton: "" },
];

const PRIO_LABEL: Record<string, string> = {
  low: "Låg", normal: "Normal", high: "Hög", urgent: "Brådskande",
};

function datum(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
}

export function MyTasksPage({ onOpenRecord }: Props) {
  const [data, setData] = useState<MyTasks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await getMyTasks(false)); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte hämta uppgifterna."); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function klar(t: MyTask) {
    setBusy(t.id);
    try { await completeTask(t.id, true); await load(); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte spara."); }
    finally { setBusy(null); }
  }

  async function skjut(t: MyTask, dagar: number) {
    const bas = t.dueAt ? new Date(t.dueAt) : new Date();
    bas.setDate(bas.getDate() + dagar);
    try { await updateTask(t.id, { due_at: bas.toISOString() }); await load(); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte flytta datumet."); }
  }

  if (!data) return <div className="page"><div className="empty-state">Laddar…</div></div>;

  const { antal } = data;
  const tomt = antal.totalt === 0;

  return (
    <div className="page mytasks">
      {error && <div className="card"><div className="formfield__error">{error}</div></div>}

      <div className="mytasks__stats">
        <div className={`mytasks__stat${antal.forsenade > 0 ? " mytasks__stat--late" : ""}`}>
          <span className="mytasks__stat-n">{antal.forsenade}</span>
          <span className="mytasks__stat-l">Försenade</span>
        </div>
        <div className="mytasks__stat">
          <span className="mytasks__stat-n">{antal.idag}</span>
          <span className="mytasks__stat-l">Idag</span>
        </div>
        <div className="mytasks__stat">
          <span className="mytasks__stat-n">{antal.veckan}</span>
          <span className="mytasks__stat-l">Kommande vecka</span>
        </div>
        <div className="mytasks__stat">
          <span className="mytasks__stat-n">{antal.totalt}</span>
          <span className="mytasks__stat-l">Öppna totalt</span>
        </div>
      </div>

      {tomt && (
        <div className="card"><div className="empty-state">
          Inga öppna uppgifter tilldelade dig.
        </div></div>
      )}

      {GRUPPER.map((g) => {
        const poster = data.grupper[g.key];
        if (!poster || poster.length === 0) return null;
        return (
          <section key={g.key} className="mytasks__group">
            <h2 className={`mytasks__group-head${g.ton ? ` mytasks__group-head--${g.ton}` : ""}`}>
              {g.label}
              <span className="mytasks__group-n">{poster.length}</span>
            </h2>
            <div className="card" style={{ padding: 0 }}>
              <ul className="task-list">
                {poster.map((t) => (
                  <li key={t.id} className={`task${g.key === "forsenade" ? " task--late" : ""}`}>
                    <label className="task__check">
                      <input type="checkbox" checked={false} disabled={busy === t.id}
                             onChange={() => klar(t)} />
                    </label>
                    <div className="task__body">
                      <div className="task__top">
                        <span className="task__title">{t.title}</span>
                        {t.priority !== "normal" && (
                          <span className={`task__prio task__prio--${t.priority}`}>{PRIO_LABEL[t.priority]}</span>
                        )}
                        {t.createdSource === "checklist" && (
                          <span className="task__src">Checklista</span>
                        )}
                      </div>
                      {t.description && <p className="task__desc">{t.description}</p>}
                      <div className="task__meta">
                        <span className="task__due">{datum(t.dueAt)}</span>
                        {t.recordId && (
                          <button className="task__rec" onClick={() => onOpenRecord(t.recordId!)}>
                            {t.recordTitle ?? "Namnlös post"}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="task__actions">
                      <button className="btn btn--ghost btn--sm" onClick={() => skjut(t, 7)} title="Skjut en vecka">+7d</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        );
      })}
    </div>
  );
}
