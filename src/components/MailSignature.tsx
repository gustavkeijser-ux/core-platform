import { useEffect, useState } from "react";
import { DataError } from "@/lib/data";
import { type MailSettings, getMailSettings, setMailSignature, fmtDateTime } from "@/lib/cases";

/** Delad hämtning av signaturen (ärendevyn + inställningssidan). */
export function useMailSettings(): [MailSettings | null, (s: MailSettings) => void] {
  const [s, setS] = useState<MailSettings | null>(null);
  useEffect(() => { let on = true; getMailSettings().then((x) => { if (on) setS(x); }); return () => { on = false; }; }, []);
  return [s, setS];
}

/**
 * Redigera den gemensamma signaturen. Gäller alla svar som skickas från
 * ärendehanteringen, oavsett handläggare. {namn} och {e-post} byts mot den
 * som skickar svaret.
 */
export function SignatureEditor({ settings, onSaved, onCancel }: {
  settings: MailSettings; onSaved: (s: MailSettings) => void; onCancel?: () => void;
}) {
  const [v, setV] = useState(settings.signature);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setV(settings.signature), [settings.signature]);
  const dirty = v.trim() !== settings.signature.trim();

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const s = await setMailSignature(v);
      onSaved(s);
      setMsg({ ok: true, text: "Signaturen sparades." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof DataError ? e.message : "Kunde inte spara signaturen." });
    } finally { setBusy(false); }
  }

  return (
    <div className="sig-editor">
      <label className="label" htmlFor="sig-text">Signatur</label>
      <textarea
        id="sig-text"
        className="input input--area sig-editor__input"
        value={v}
        maxLength={2000}
        disabled={!settings.canEdit || busy}
        placeholder={"Med vänliga hälsningar\n{namn}\nConnectEstate Kundtjänst\n010-123 45 67 · hyresgast@connectestate.se"}
        onChange={(e) => setV(e.target.value)}
      />
      <p className="formfield__help">
        Läggs automatiskt till under alla svar som skickas till kunder. <code>{"{namn}"}</code> och <code>{"{e-post}"}</code> byts
        mot den som skickar svaret. Lämna tomt för ingen signatur.
      </p>
      {settings.canEdit ? (
        <div className="sig-editor__actions">
          {msg && <span className={msg.ok ? "detail-save-ok" : "formfield__error"}>{msg.ok ? "✓ " : ""}{msg.text}</span>}
          {settings.updatedAt && !msg && (
            <span className="ink-faint sig-editor__meta">Senast ändrad {fmtDateTime(settings.updatedAt, { withYear: true })}{settings.updatedBy ? ` av ${settings.updatedBy}` : ""}</span>
          )}
          {onCancel && <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>Stäng</button>}
          <button className="btn btn--brand btn--sm" onClick={() => void save()} disabled={busy || !dirty}>{busy ? "Sparar…" : "Spara signatur"}</button>
        </div>
      ) : (
        <p className="formfield__help">Bara administratörer kan ändra signaturen.</p>
      )}
    </div>
  );
}

/** Förhandsvisning under svarsrutan: så här slutar mejlet till kunden. */
export function SignaturePreview({ settings, onEdit }: { settings: MailSettings | null; onEdit?: () => void }) {
  if (!settings) return null;
  if (!settings.preview) {
    return settings.canEdit ? (
      <div className="sig-preview sig-preview--empty">
        Ingen signatur läggs till. <button className="linklike" onClick={onEdit}>Lägg till signatur</button>
      </div>
    ) : null;
  }
  return (
    <div className="sig-preview">
      <div className="sig-preview__head">
        <span>Signatur läggs till automatiskt</span>
        {settings.canEdit && onEdit && <button className="linklike" onClick={onEdit}>Ändra</button>}
      </div>
      <div className="sig-preview__text">{settings.preview}</div>
    </div>
  );
}
