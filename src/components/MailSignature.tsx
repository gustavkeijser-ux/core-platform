import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { DataError } from "@/lib/data";
import { type MailSettings, getMailSettings, setMailSignature, fmtDateTime } from "@/lib/cases";

/** Delad hämtning av signaturen (ärendevyn + Microsoft 365-sidan). */
export function useMailSettings(): [MailSettings | null, (s: MailSettings) => void] {
  const [s, setS] = useState<MailSettings | null>(null);
  useEffect(() => { let on = true; getMailSettings().then((x) => { if (on) setS(x); }); return () => { on = false; }; }, []);
  return [s, setS];
}

/** Signaturens HTML så som mejlet visar den (städad: inga script/händelser). */
function SafeHtml({ html, className }: { html: string; className?: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(html, { ADD_ATTR: ["target"] }), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}

/**
 * Redigera den gemensamma signaturen. Gäller alla svar som skickas från
 * ärendehanteringen. Signaturen skrivs som HTML (logotyp, färger, länkar —
 * som i Outlook) med förhandsvisning bredvid. {namn} och {e-post} byts mot
 * den som skickar svaret. Bilder måste ligga på en publik adress.
 */
export function SignatureEditor({ settings, onSaved, onCancel }: {
  settings: MailSettings; onSaved: (s: MailSettings) => void; onCancel?: () => void;
}) {
  const [html, setHtml] = useState(settings.signatureHtml);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setHtml(settings.signatureHtml), [settings.signatureHtml]);
  const dirty = html.trim() !== settings.signatureHtml.trim();

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const s = await setMailSignature(settings.signature, html);
      onSaved(s);
      setMsg({ ok: true, text: "Signaturen sparades." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof DataError ? e.message : "Kunde inte spara signaturen." });
    } finally { setBusy(false); }
  }

  return (
    <div className="sig-editor">
      <div className="sig-editor__cols">
        <div className="sig-editor__col">
          <div className="label">Så här ser den ut i mejlet</div>
          <div className="sig-editor__preview">
            {html.trim() ? <SafeHtml html={html} /> : <span className="ink-faint">Ingen signatur.</span>}
          </div>
        </div>
        <div className="sig-editor__col">
          <label className="label" htmlFor="sig-html">HTML</label>
          <textarea
            id="sig-html"
            className="input input--area sig-editor__code"
            value={html}
            spellCheck={false}
            disabled={!settings.canEdit || busy}
            placeholder={'<p>Med vänliga hälsningar,<br><b>{namn}</b></p>'}
            onChange={(e) => setHtml(e.target.value)}
          />
        </div>
      </div>
      <p className="formfield__help">
        Läggs automatiskt till under alla svar som skickas till kunder. <code>{"{namn}"}</code> och <code>{"{e-post}"}</code> byts
        mot den som skickar svaret. Bilder måste ligga på en publik adress. Lämna tomt för ingen signatur.
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
  const hasHtml = !!settings.previewHtml;
  if (!hasHtml && !settings.preview) {
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
      {hasHtml
        ? <SafeHtml html={settings.previewHtml} className="sig-preview__html" />
        : <div className="sig-preview__text">{settings.preview}</div>}
    </div>
  );
}
