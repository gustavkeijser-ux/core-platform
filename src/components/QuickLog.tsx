import { useState } from "react";
import { addQuickActivity, DataError } from "@/lib/data";

type Props = { recordId: string; onLogged: () => void };

const TYPES: Array<{ key: "note" | "call" | "meeting"; label: string }> = [
  { key: "note", label: "Anteckning" },
  { key: "call", label: "Samtal" },
  { key: "meeting", label: "Möte" },
];

/**
 * Snabbloggning direkt på posten, som i Lime/Salesforce — ingen navigering
 * till ett formulär. Skriver via add_quick_activity, som fortfarande går
 * igenom samma behörighetskontroll som all annan skrivning.
 */
export function QuickLog({ recordId, onLogged }: Props) {
  const [type, setType] = useState<"note" | "call" | "meeting">("note");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await addQuickActivity(recordId, type, body);
      setBody("");
      onLogged();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte logga.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="quick-log">
      <div className="quick-log__types">
        {TYPES.map((t) => (
          <button
            key={t.key}
            className="chip"
            aria-pressed={type === t.key}
            onClick={() => setType(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <textarea
        className="input input--area quick-log__input"
        placeholder="Skriv en snabb anteckning…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      {error && <div className="formfield__error">{error}</div>}
      <div className="quick-log__actions">
        <span className="formfield__help">Cmd/Ctrl+Enter för att logga</span>
        <button className="btn btn--brand btn--sm" onClick={submit} disabled={saving || !body.trim()}>
          {saving ? "Loggar…" : "Logga"}
        </button>
      </div>
    </div>
  );
}
