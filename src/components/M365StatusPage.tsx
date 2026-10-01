import { useCallback, useEffect, useState } from "react";
import { DataError } from "@/lib/data";
import { type MailAccountStatus, fmtDateTime, mailIntegrationStatus, relTime, triggerMailSync } from "@/lib/cases";
import { useMailSettings, SignatureEditor } from "./MailSignature";

/**
 * Admin: driftstatus för Microsoft 365-kopplingen (hyresgast@connectestate.se).
 * 🟢 synkar normalt · 🟡 senaste körningen fick fel / släpar · 🔴 ingen lyckad synk på länge · ⚪ ej kopplad
 */
export function M365StatusPage() {
  const [rows, setRows] = useState<MailAccountStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [sig, setSig] = useMailSettings();

  const load = useCallback(async () => {
    try { setRows(await mailIntegrationStatus()); setError(null); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte hämta status."); }
  }, []);
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(t); }, [load]);

  async function syncNow() {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await triggerMailSync() as { results?: Array<{ status: string; imported?: number }> };
      const first = r?.results?.[0];
      setSyncMsg(first?.status === "not_configured" ? "Microsoft 365 är inte kopplat ännu."
        : first?.status === "busy" ? "En synk pågår redan."
        : first?.status === "ok" ? `Klart — ${first.imported ?? 0} nya meddelanden.` : "Synken körde med fel, se nedan.");
      await load();
    } catch (e) {
      setSyncMsg(e instanceof DataError ? e.message : "Kunde inte starta synken.");
    } finally { setSyncing(false); }
  }

  if (error) return <div className="page"><div className="card"><div className="empty-state">{error}</div></div></div>;
  if (!rows) return <div className="page"><div className="empty-state">Laddar…</div></div>;

  return (
    <div className="page m365">
      <div className="card m365__card">
        <div className="m365__head">
          <div>
            <div className="m365__title">E-postsignatur</div>
            <div className="m365__mailbox">Gäller alla svar som skickas från ärendehanteringen</div>
          </div>
        </div>
        {sig ? <SignatureEditor settings={sig} onSaved={setSig} /> : <div className="empty-state">Laddar…</div>}
      </div>
      {rows.length === 0 && <div className="card"><div className="empty-state">Ingen brevlåda är konfigurerad.</div></div>}
      {rows.map((a) => {
        const notConfigured = a.lastRun?.status === "not_configured";
        const lastOkAgeMin = a.lastOkRun ? (Date.now() - new Date(a.lastOkRun).getTime()) / 60000 : Infinity;
        const state = notConfigured ? "off"
          : lastOkAgeMin > 15 ? "down"
          : a.lastRun?.status === "error" || a.retryQueue > 0 || a.failedProcessing > 0 ? "warn" : "ok";
        const label = { ok: "Ansluten", warn: "Ansluten med varningar", down: "Ingen lyckad synk på över 15 min", off: "Inte kopplad ännu" }[state];
        const dot = { ok: "🟢", warn: "🟡", down: "🔴", off: "⚪" }[state];
        return (
          <div className="card m365__card" key={a.id}>
            <div className="m365__head">
              <div>
                <div className="m365__title">Microsoft 365</div>
                <div className="m365__mailbox">{a.mailbox}</div>
              </div>
              <div className={`m365__state m365__state--${state}`}><span aria-hidden>{dot}</span> {label}</div>
            </div>

            <dl className="m365__facts">
              <div><dt>Senaste lyckade synk</dt><dd>{a.lastOkRun ? `${fmtDateTime(a.lastOkRun, { withYear: true })} (${relTime(a.lastOkRun)})` : "—"}</dd></div>
              <div><dt>Senaste körning</dt><dd>{a.lastRun ? `${fmtDateTime(a.lastRun.started_at)} · ${a.lastRun.status}` : "—"}</dd></div>
              <div><dt>Importerade meddelanden</dt><dd>{a.imported}</dd></div>
              <div><dt>Ärenden från e-post</dt><dd>{a.casesFromEmail}</dd></div>
              <div><dt>Körningar senaste 24 h</dt><dd>{a.runs24h} ({a.errors24h} med fel)</dd></div>
              <div><dt>Väntar på omförsök</dt><dd>{a.retryQueue + a.failedProcessing}</dd></div>
              <div><dt>Svar som inte skickats</dt><dd>{a.failedSends}</dd></div>
              <div><dt>Importerar mejl från</dt><dd>{fmtDateTime(a.importFrom, { withYear: true })}</dd></div>
            </dl>

            {a.folders.length > 0 && (
              <table className="m365__folders">
                <thead><tr><th>Mapp</th><th>Senast OK</th><th>Importerade</th><th>Fel i rad</th></tr></thead>
                <tbody>
                  {a.folders.map((f) => (
                    <tr key={f.folder}>
                      <td>{f.folder === "inbox" ? "Inkorg" : f.folder === "sentitems" ? "Skickat" : f.folder}</td>
                      <td>{fmtDateTime(f.lastSuccessAt)}</td>
                      <td>{f.messagesImported}</td>
                      <td>{f.consecutiveFailures}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {(a.lastError || notConfigured) && (
              <div className="m365__error">
                <div className="label">Senaste fel</div>
                <div>{notConfigured ? a.lastRun?.error : a.lastError?.error}</div>
                {!notConfigured && a.lastError && <div className="ink-faint">{fmtDateTime(a.lastError.at, { withYear: true })}</div>}
              </div>
            )}

            <div className="m365__actions">
              {syncMsg && <span className="ink-faint">{syncMsg}</span>}
              <button className="btn btn--ghost btn--sm" disabled={syncing} onClick={() => void syncNow()}>{syncing ? "Synkar…" : "Synka nu"}</button>
            </div>
            <p className="ink-faint m365__note">Synken körs automatiskt varje minut. Samma mejl importeras aldrig två gånger. Tillfälliga fel hos Microsoft försöks igen automatiskt.</p>
          </div>
        );
      })}
    </div>
  );
}
