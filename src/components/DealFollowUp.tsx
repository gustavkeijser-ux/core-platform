import { useEffect, useState } from "react";
import type { RecordRow, StatusDef, TimelineEntry } from "@/lib/data";
import { addQuickActivity, getRecord, setNextStep, DataError } from "@/lib/data";
import { parseDateValue } from "@/lib/fields";
import { UserBadge } from "@/lib/users";

/**
 * Affärens uppföljningspanel — det säljaren jobbar i hela dagen:
 *   1. Logga vad som hände (samtal, inget svar, möte, mejl, anteckning).
 *   2. Bestäm nästa steg + datum. För öppna affärer krävs ett datum när ett
 *      samtal/möte/mejl loggas, så ingen affär blir liggande utan plan.
 *   3. Se de senaste aktiviteterna direkt under.
 * Nästa steg blir också en uppgift i "Mina uppgifter" (set_next_step).
 */

type LogType = "call" | "no_answer" | "meeting" | "email" | "note";

const LOG_TYPES: Array<{ key: LogType; label: string }> = [
  { key: "call", label: "Samtal" },
  { key: "no_answer", label: "Inget svar" },
  { key: "meeting", label: "Möte" },
  { key: "email", label: "Mejl" },
  { key: "note", label: "Anteckning" },
];

const MANUAL_TYPES = new Set(["call", "meeting", "email", "note"]);
const TYPE_LABEL: Record<string, string> = { call: "Samtal", meeting: "Möte", email: "Mejl", note: "Anteckning" };

const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
/** Nästa vardag (hoppar över lördag/söndag). */
const nextWeekday = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return isoDate(d);
};

const QUICK_DATES: Array<{ label: string; value: () => string }> = [
  { label: "Imorgon", value: () => nextWeekday(1) },
  { label: "Om 3 dagar", value: () => nextWeekday(3) },
  { label: "Nästa vecka", value: () => nextWeekday(7) },
  { label: "Om 2 veckor", value: () => nextWeekday(14) },
  { label: "Om en månad", value: () => nextWeekday(30) },
];

function dueState(date: string | null): "overdue" | "today" | "future" | null {
  if (!date) return null;
  const today = isoDate(new Date());
  return date < today ? "overdue" : date === today ? "today" : "future";
}

function formatDate(date: string) {
  return parseDateValue(date)?.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" }) ?? date;
}

function relativeTime(v: unknown) {
  const d = parseDateValue(v);
  if (!d) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "idag";
  if (days === 1) return "igår";
  if (days < 30) return `${days} dagar sedan`;
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
}

export function DealFollowUp({
  record,
  statuses,
  onRecord,
}: {
  record: RecordRow;
  statuses: StatusDef[];
  onRecord: (row: RecordRow) => void;
}) {
  const d = record.data as Record<string, unknown>;
  const currentText = (d.nasta_steg as string | null) ?? "";
  const currentDate = (d.nasta_steg_datum as string | null) ?? "";
  const isOpen = !statuses.find((s) => s.key === record.status)?.isTerminal;

  const [type, setType] = useState<LogType>("call");
  const [body, setBody] = useState("");
  const [stepText, setStepText] = useState(currentText);
  const [stepDate, setStepDate] = useState(currentDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  // Ny post (eller nästa steg ändrat någon annanstans) → synka fälten.
  useEffect(() => { setStepText(currentText); setStepDate(currentDate); }, [record.id, currentText, currentDate]);

  const loadTimeline = async () => {
    try {
      const res = await getRecord(record.id);
      setTimeline(res.timeline.filter((e) => MANUAL_TYPES.has(e.type)).slice(0, 6));
      return res.record;
    } catch { return null; }
  };
  useEffect(() => { void loadTimeline(); /* eslint-disable-next-line */ }, [record.id]);

  const stepChanged = stepText.trim() !== currentText.trim() || stepDate !== currentDate;
  const hasLog = type === "no_answer" || body.trim() !== "";
  // Kontaktaktiviteter på öppna affärer kräver ett nästa steg med datum.
  const needsStep = isOpen && hasLog && type !== "note" && !stepDate;
  const canSubmit = !saving && (hasLog || stepChanged) && !needsStep;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (hasLog) {
        const actType = type === "no_answer" ? "call" : type;
        const text = type === "no_answer"
          ? (body.trim() ? `Inget svar – ${body.trim()}` : "Inget svar")
          : body.trim();
        await addQuickActivity(record.id, actType, text);
      }
      if (stepChanged || hasLog) {
        await setNextStep(record.id, stepText.trim() || null, stepDate || null);
      }
      const fresh = await loadTimeline();
      if (fresh) onRecord(fresh);
      setBody("");
      setSavedMsg(hasLog ? "Loggat" : "Nästa steg sparat");
      setTimeout(() => setSavedMsg(null), 2500);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara.");
    } finally {
      setSaving(false);
    }
  }

  const due = dueState(currentDate || null);
  const senaste = relativeTime(d.senaste_kontakt);

  return (
    <section className="followup" aria-label="Uppföljning">
      {/* Läget just nu */}
      <div className="followup__status">
        <div className={`followup__next${due ? ` followup__next--${due}` : " followup__next--none"}`}>
          <span className="followup__next-label">Nästa steg</span>
          {currentDate ? (
            <span className="followup__next-value">
              <strong>{due === "overdue" ? "Försenat · " : due === "today" ? "Idag · " : ""}{formatDate(currentDate)}</strong>
              {currentText && <span> — {currentText}</span>}
            </span>
          ) : (
            <span className="followup__next-value">{isOpen ? "Inget planerat" : "—"}</span>
          )}
        </div>
        <div className="followup__meta">
          <span>Senaste kontakt: <strong>{senaste ?? "aldrig"}</strong></span>
        </div>
      </div>

      {/* Logga */}
      <div className="followup__log">
        <div className="chips" role="group" aria-label="Typ av aktivitet">
          {LOG_TYPES.map((t) => (
            <button key={t.key} type="button" className="chip" aria-pressed={type === t.key} onClick={() => setType(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <textarea
          className="input input--area followup__input"
          placeholder={type === "no_answer" ? "Valfri kommentar (t.ex. \"röstbrevlåda\")" : "Vad hände? Vad sa kunden?"}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }}
        />

        <div className="followup__step">
          <label className="label" htmlFor={`ns-${record.id}`}>Nästa steg</label>
          <div className="followup__step-row">
            <input
              id={`ns-${record.id}`}
              className="input"
              placeholder="T.ex. Ring upp och boka möte"
              value={stepText}
              onChange={(e) => setStepText(e.target.value)}
            />
            <input
              className="input followup__date"
              type="date"
              aria-label="Datum för nästa steg"
              value={stepDate}
              onChange={(e) => setStepDate(e.target.value)}
            />
          </div>
          <div className="chips followup__quick">
            {QUICK_DATES.map((q) => {
              const v = q.value();
              return (
                <button key={q.label} type="button" className="chip" aria-pressed={stepDate === v} onClick={() => setStepDate(v)}>
                  {q.label}
                </button>
              );
            })}
            {stepDate && (
              <button type="button" className="chip" onClick={() => { setStepDate(""); setStepText(""); }}>
                Rensa
              </button>
            )}
          </div>
        </div>

        {error && <div className="formfield__error">{error}</div>}
        <div className="followup__actions">
          <span className="formfield__help">
            {needsStep ? "Välj ett datum för nästa steg innan du loggar." : "Cmd/Ctrl+Enter för att spara"}
          </span>
          {savedMsg && <span className="detail-save-ok">✓ {savedMsg}</span>}
          <button className="btn btn--brand" onClick={() => void submit()} disabled={!canSubmit}>
            {saving ? "Sparar…" : hasLog ? "Logga" : "Spara nästa steg"}
          </button>
        </div>
      </div>

      {/* Senaste aktiviteter */}
      {timeline.length > 0 && (
        <ol className="followup__history">
          {timeline.map((e) => (
            <li key={e.id} className="followup__item">
              <span className={`followup__type followup__type--${e.type}`}>{TYPE_LABEL[e.type] ?? e.type}</span>
              <div className="followup__item-body">
                <p>{e.body}</p>
                <span className="followup__item-meta">
                  <UserBadge id={e.actorUserId} /> · {new Date(e.occurredAt).toLocaleString("sv-SE", {
                    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                  })}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
