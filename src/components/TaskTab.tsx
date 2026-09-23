import { useCallback, useEffect, useState } from "react";
import {
  getRecordTasks, createTask, completeTask, deleteTask, updateTask, DataError,
  type Task, type TaskPriority,
} from "@/lib/data";
import { UserBadge } from "@/lib/users";

type Props = { recordId: string };

const PRIORITIES: Array<{ key: TaskPriority; label: string }> = [
  { key: "low", label: "Låg" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "Hög" },
  { key: "urgent", label: "Brådskande" },
];
const PRIO_LABEL: Record<string, string> = {
  low: "Låg", normal: "Normal", high: "Hög", urgent: "Brådskande",
};

/** Dagar kvar till förfall. Negativt = försenad. */
function daysLeft(iso: string) {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

function DueLabel({ iso, done }: { iso: string | null; done: boolean }) {
  if (!iso) return <span className="task__due task__due--none">Inget datum</span>;
  const n = daysLeft(iso);
  const datum = new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
  if (done) return <span className="task__due">{datum}</span>;
  let txt = datum, cls = "";
  if (n < 0)       { txt = `${datum} · ${Math.abs(n)} dag${Math.abs(n) === 1 ? "" : "ar"} sen`; cls = " task__due--late"; }
  else if (n === 0){ txt = `${datum} · idag`;    cls = " task__due--today"; }
  else if (n === 1){ txt = `${datum} · imorgon`; cls = " task__due--soon"; }
  else if (n <= 7) { txt = `${datum} · ${n} dagar`; cls = " task__due--soon"; }
  return <span className={`task__due${cls}`}>{txt}</span>;
}

/** Lokalt datetime-värde för <input type="date"> */
function dateInput(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function TaskTab({ recordId }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [prio, setPrio] = useState<TaskPriority>("normal");
  const [due, setDue] = useState(() => dateInput(7));
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await getRecordTasks(recordId));
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta uppgifterna.");
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createTask({
        recordId, title: title.trim(),
        description: desc.trim() || undefined,
        priority: prio,
        dueAt: due ? new Date(due + "T12:00:00").toISOString() : null,
      });
      setTitle(""); setDesc(""); setPrio("normal"); setDue(dateInput(7));
      setShowAdd(false);
      await load();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte skapa uppgiften.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(t: Task, done: boolean) {
    setBusy(t.id);
    setTasks((prev) => prev.map((x) =>
      x.id === t.id ? { ...x, completedAt: done ? new Date().toISOString() : null, overdue: done ? false : x.overdue } : x
    ));
    try { await completeTask(t.id, done); await load(); }
    catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara.");
      await load();
    } finally { setBusy(null); }
  }

  async function remove(t: Task) {
    if (!confirm(`Ta bort uppgiften "${t.title}"?`)) return;
    try { await deleteTask(t.id); await load(); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte ta bort."); }
  }

  async function bumpDue(t: Task, days: number) {
    const base = t.dueAt ? new Date(t.dueAt) : new Date();
    base.setDate(base.getDate() + days);
    try { await updateTask(t.id, { due_at: base.toISOString() }); await load(); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte flytta datumet."); }
  }

  if (loading) return <div className="empty-state">Laddar…</div>;

  const open = tasks.filter((t) => !t.completedAt);
  const done = tasks.filter((t) => t.completedAt);
  const late = open.filter((t) => t.overdue).length;

  return (
    <div className="tasks">
      {error && <div className="formfield__error">{error}</div>}

      <div className="tasks__head">
        <div className="tasks__summary">
          <span className="tasks__count">{open.length} öppna</span>
          {late > 0 && <span className="tasks__late">{late} försenade</span>}
        </div>
        <button className="btn btn--brand btn--sm" onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? "Avbryt" : "+ Ny uppgift"}
        </button>
      </div>

      {showAdd && (
        <div className="tasks__form">
          <div className="formfield">
            <label className="label">Rubrik</label>
            <input
              className="input" autoFocus
              placeholder="t.ex. Ring fastighetsskötaren om nyckeltillträde"
              value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) void add(); }}
            />
          </div>
          <div className="tasks__form-row">
            <div className="formfield">
              <label className="label">Förfaller</label>
              <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="formfield">
              <label className="label">Prioritet</label>
              <select className="input" value={prio} onChange={(e) => setPrio(e.target.value as TaskPriority)}>
                {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <div className="formfield">
            <label className="label">Beskrivning</label>
            <textarea
              className="input" rows={3} placeholder="Frivilligt"
              value={desc} onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          <div className="tasks__form-footer">
            <button className="btn btn--ghost btn--sm" onClick={() => setShowAdd(false)} disabled={saving}>Avbryt</button>
            <button className="btn btn--brand btn--sm" onClick={add} disabled={saving || !title.trim()}>
              {saving ? "Skapar…" : "Skapa uppgift"}
            </button>
          </div>
        </div>
      )}

      {open.length === 0 && !showAdd && (
        <div className="empty-state empty-state--tight">Inga öppna uppgifter.</div>
      )}

      {open.length > 0 && (
        <ul className="task-list">
          {open.map((t) => (
            <li key={t.id} className={`task${t.overdue ? " task--late" : ""}`}>
              <label className="task__check">
                <input
                  type="checkbox" checked={false} disabled={busy === t.id}
                  onChange={() => toggle(t, true)}
                />
              </label>
              <div className="task__body">
                <div className="task__top">
                  <span className="task__title">{t.title}</span>
                  {t.priority !== "normal" && (
                    <span className={`task__prio task__prio--${t.priority}`}>{PRIO_LABEL[t.priority]}</span>
                  )}
                  {t.createdSource === "checklist" && (
                    <span className="task__src" title="Skapad från checklistan">Checklista</span>
                  )}
                </div>
                {t.description && <p className="task__desc">{t.description}</p>}
                <div className="task__meta">
                  <DueLabel iso={t.dueAt} done={false} />
                  {t.assigneeUserId && (
                    <span className="task__who"><UserBadge id={t.assigneeUserId} /></span>
                  )}
                </div>
              </div>
              <div className="task__actions">
                <button className="btn btn--ghost btn--sm" onClick={() => bumpDue(t, 7)} title="Skjut en vecka">+7d</button>
                <button className="btn btn--ghost btn--sm btn--danger" onClick={() => remove(t)} title="Ta bort">✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <div className="tasks__done">
          <button className="tasks__done-toggle" onClick={() => setShowDone((s) => !s)}>
            {showDone ? "Dölj" : "Visa"} {done.length} klara
          </button>
          {showDone && (
            <ul className="task-list">
              {done.map((t) => (
                <li key={t.id} className="task task--done">
                  <label className="task__check">
                    <input type="checkbox" checked disabled={busy === t.id} onChange={() => toggle(t, false)} />
                  </label>
                  <div className="task__body">
                    <span className="task__title">{t.title}</span>
                    <div className="task__meta">
                      <DueLabel iso={t.dueAt} done />
                      {t.completedBy && <span className="task__who"><UserBadge id={t.completedBy} /></span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
