import { useCallback, useEffect, useRef, useState } from "react";
import {
  getRecordCommunications, logCommunication, deleteCommunication,
  attachDocument, deleteDocumentLink, uploadDocument, documentUrl,
  DataError,
  type Communication, type DocumentRow, type CommChannel, type CommDirection,
} from "@/lib/data";

type Props = { recordId: string };

const CHANNELS: Array<{ key: CommChannel; label: string }> = [
  { key: "email", label: "Mejl" },
  { key: "call", label: "Samtal" },
  { key: "meeting", label: "Möte" },
  { key: "letter", label: "Brev" },
  { key: "sms", label: "SMS" },
];

const DIRECTIONS: Array<{ key: CommDirection; label: string }> = [
  { key: "outbound", label: "Utgående" },
  { key: "inbound", label: "Inkommande" },
  { key: "internal", label: "Internt" },
];

const CHANNEL_LABEL: Record<string, string> = {
  email: "Mejl", call: "Samtal", meeting: "Möte", letter: "Brev", sms: "SMS",
};
const DIRECTION_LABEL: Record<string, string> = {
  inbound: "Inkommande", outbound: "Utgående", internal: "Internt",
};

function ChannelIcon({ channel }: { channel: string }) {
  const common = {
    width: 15, height: 15, viewBox: "0 0 16 16", fill: "none",
    stroke: "currentColor", strokeWidth: 1.4,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (channel === "call") {
    return (
      <svg {...common}>
        <path d="M3 2h3l1.5 3.5-2 1.2a8 8 0 004 4l1.2-2L14 10v3a1 1 0 01-1 1A11 11 0 012 3a1 1 0 011-1z" />
      </svg>
    );
  }
  if (channel === "meeting") {
    return (
      <svg {...common}>
        <circle cx="5.5" cy="5" r="2" />
        <circle cx="11" cy="6" r="1.6" />
        <path d="M1.5 13c0-2.2 1.8-4 4-4s4 1.8 4 4" />
        <path d="M10.5 9.2c1.7.2 3 1.7 3 3.8" />
      </svg>
    );
  }
  if (channel === "sms") {
    return (
      <svg {...common}>
        <path d="M2 3h12a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 3V4a1 1 0 011-1z" />
      </svg>
    );
  }
  if (channel === "letter") {
    return (
      <svg {...common}>
        <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
        <path d="M1.5 5.5L8 9l6.5-3.5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M2 4.5L8 8.5l6-4" />
    </svg>
  );
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("sv-SE", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatBytes(n: number | null) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Lokalt datetime-format som <input type="datetime-local"> förstår */
function nowLocal() {
  const d = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CommunicationTab({ recordId }: Props) {
  const [comms, setComms] = useState<Communication[]>([]);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Loggformulär
  const [showLog, setShowLog] = useState(false);
  const [channel, setChannel] = useState<CommChannel>("email");
  const [direction, setDirection] = useState<CommDirection>("outbound");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [toAddress, setToAddress] = useState("");
  const [occurredAt, setOccurredAt] = useState(nowLocal);
  const [saving, setSaving] = useState(false);

  // Dokument
  const [uploading, setUploading] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [linkName, setLinkName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getRecordCommunications(recordId);
      setComms(res.communications ?? []);
      setDocs(res.documents ?? []);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta kommunikationen.");
    } finally {
      setLoading(false);
    }
  }, [recordId]);

  useEffect(() => { load(); }, [load]);

  function resetLogForm() {
    setSubject(""); setBody(""); setFromAddress(""); setToAddress("");
    setOccurredAt(nowLocal());
    setShowLog(false);
  }

  async function submitLog() {
    setSaving(true);
    setError(null);
    try {
      await logCommunication({
        recordId,
        channel,
        direction,
        subject: subject.trim() || undefined,
        body: body.trim() || undefined,
        fromAddress: fromAddress.trim() || undefined,
        toAddresses: toAddress.trim()
          ? toAddress.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : undefined,
      });
      resetLogForm();
      await load();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara loggposten.");
    } finally {
      setSaving(false);
    }
  }

  async function removeComm(id: string) {
    if (!confirm("Ta bort den här loggposten?")) return;
    try {
      await deleteCommunication(id);
      await load();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte ta bort loggposten.");
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadDocument(recordId, file);
      await load();
    } catch (err) {
      setError(err instanceof DataError ? err.message : "Kunde inte ladda upp filen.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submitLink() {
    if (!linkName.trim() || !linkUrl.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await attachDocument({ recordId, name: linkName.trim(), webUrl: linkUrl.trim() });
      setLinkName(""); setLinkUrl(""); setShowLink(false);
      await load();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte koppla länken.");
    } finally {
      setSaving(false);
    }
  }

  async function removeDoc(id: string) {
    if (!confirm("Ta bort dokumentet från posten?")) return;
    try {
      await deleteDocumentLink(id);
      await load();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte ta bort dokumentet.");
    }
  }

  async function openDoc(doc: DocumentRow) {
    try {
      const url = await documentUrl(doc);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte öppna dokumentet.");
    }
  }

  if (loading) return <div className="empty-state">Laddar…</div>;

  return (
    <div className="comm">
      {error && <div className="formfield__error">{error}</div>}

      {/* ── Dokument ────────────────────────────────────────── */}
      <section className="comm__section">
        <div className="comm__section-head">
          <h3>Dokument <span className="comm__count">{docs.length}</span></h3>
          <div className="comm__section-actions">
            <input
              ref={fileRef}
              type="file"
              onChange={onFilePicked}
              style={{ display: "none" }}
            />
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Laddar upp…" : "Ladda upp fil"}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => setShowLink((s) => !s)}
            >
              Lägg till länk
            </button>
          </div>
        </div>

        {showLink && (
          <div className="comm__form comm__form--inline">
            <input
              className="input"
              placeholder="Namn, t.ex. Fullmakt Brf Solgården"
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
            />
            <input
              className="input"
              placeholder="https://…"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
            />
            <button
              className="btn btn--brand btn--sm"
              onClick={submitLink}
              disabled={saving || !linkName.trim() || !linkUrl.trim()}
            >
              Koppla
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setShowLink(false)}>
              Avbryt
            </button>
          </div>
        )}

        {docs.length === 0 ? (
          <div className="empty-state empty-state--tight">Inga dokument kopplade.</div>
        ) : (
          <ul className="doc-list">
            {docs.map((d) => {
              const size = formatBytes(d.sizeBytes);
              const isLink = !!d.webUrl && /^https?:\/\//i.test(d.webUrl);
              return (
                <li key={d.id} className="doc">
                  <span className="doc__icon" aria-hidden="true">
                    {isLink ? (
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <path d="M6.5 9.5l3-3" />
                        <path d="M7 4.5l1.2-1.2a2.5 2.5 0 013.5 3.5L10.5 8" />
                        <path d="M9 11.5l-1.2 1.2a2.5 2.5 0 01-3.5-3.5L5.5 8" />
                      </svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 1.5h5l3.5 3.5v9a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1z" />
                        <path d="M9 1.5V5h3.5" />
                      </svg>
                    )}
                  </span>
                  <button className="doc__name" onClick={() => openDoc(d)} title="Öppna">
                    {d.name}
                  </button>
                  <span className="doc__meta">
                    {[isLink ? "Länk" : d.mimeType, size].filter(Boolean).join(" · ")}
                  </span>
                  <button
                    className="btn btn--ghost btn--sm btn--danger"
                    onClick={() => removeDoc(d.id)}
                    title="Ta bort"
                  >✕</button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Korrespondens ───────────────────────────────────── */}
      <section className="comm__section">
        <div className="comm__section-head">
          <h3>Korrespondens <span className="comm__count">{comms.length}</span></h3>
          <button
            className="btn btn--brand btn--sm"
            onClick={() => setShowLog((s) => !s)}
          >
            {showLog ? "Avbryt" : "+ Logga"}
          </button>
        </div>

        {showLog && (
          <div className="comm__form">
            <div className="comm__form-row">
              <div className="formfield">
                <label className="label">Kanal</label>
                <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as CommChannel)}>
                  {CHANNELS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <div className="formfield">
                <label className="label">Riktning</label>
                <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as CommDirection)}>
                  {DIRECTIONS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              </div>
              <div className="formfield">
                <label className="label">Tidpunkt</label>
                <input
                  className="input"
                  type="datetime-local"
                  value={occurredAt}
                  onChange={(e) => setOccurredAt(e.target.value)}
                />
              </div>
            </div>

            {channel === "email" && (
              <div className="comm__form-row">
                <div className="formfield">
                  <label className="label">Från</label>
                  <input
                    className="input"
                    placeholder="avsandare@exempel.se"
                    value={fromAddress}
                    onChange={(e) => setFromAddress(e.target.value)}
                  />
                </div>
                <div className="formfield">
                  <label className="label">Till</label>
                  <input
                    className="input"
                    placeholder="mottagare@exempel.se, flera med komma"
                    value={toAddress}
                    onChange={(e) => setToAddress(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="formfield">
              <label className="label">Ämne</label>
              <input
                className="input"
                placeholder={channel === "call" ? "Vad handlade samtalet om?" : "Ämnesrad"}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>

            <div className="formfield">
              <label className="label">Innehåll</label>
              <textarea
                className="input"
                rows={5}
                placeholder="Klistra in mejlet eller skriv en sammanfattning."
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>

            <div className="comm__form-footer">
              <button className="btn btn--ghost btn--sm" onClick={resetLogForm} disabled={saving}>
                Avbryt
              </button>
              <button
                className="btn btn--brand btn--sm"
                onClick={submitLog}
                disabled={saving || (!subject.trim() && !body.trim())}
              >
                {saving ? "Sparar…" : "Spara loggpost"}
              </button>
            </div>
          </div>
        )}

        {comms.length === 0 ? (
          <div className="empty-state empty-state--tight">
            Ingen korrespondens loggad ännu.
          </div>
        ) : (
          <ol className="comm-list">
            {comms.map((c) => (
              <li key={c.id} className={`comm-item comm-item--${c.direction}`}>
                <span className="comm-item__icon" aria-hidden="true">
                  <ChannelIcon channel={c.channel} />
                </span>
                <div className="comm-item__main">
                  <div className="comm-item__head">
                    <span className="comm-item__subject">
                      {c.subject ?? <em>Utan ämne</em>}
                    </span>
                    <span className="comm-item__tag">
                      {CHANNEL_LABEL[c.channel] ?? c.channel} · {DIRECTION_LABEL[c.direction] ?? c.direction}
                    </span>
                  </div>
                  {(c.fromAddress || c.toAddresses.length > 0) && (
                    <div className="comm-item__addr">
                      {c.fromAddress && <span>{c.fromAddress}</span>}
                      {c.toAddresses.length > 0 && <span>→ {c.toAddresses.join(", ")}</span>}
                    </div>
                  )}
                  {c.bodyText && <p className="comm-item__body">{c.bodyText}</p>}
                  <time className="comm-item__when">{formatWhen(c.occurredAt)}</time>
                </div>
                {c.provider === "manual" && (
                  <button
                    className="btn btn--ghost btn--sm btn--danger comm-item__del"
                    onClick={() => removeComm(c.id)}
                    title="Ta bort"
                  >✕</button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
