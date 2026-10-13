import { useEffect, useRef, useState } from "react";
import "@/styles/leaddesk.css";
import { createRecord, DataError } from "@/lib/data";
import { normaliseraTelefon, visaTelefon } from "@/lib/phone";
import {
  useTalk, laddaTalkConfig, sparaTalkConfig, registreraRam, registreraNavigering,
  hanteraTalkMeddelande, vaxlaTalk, stangTalk, oppnaTalk, rensaVarning, rensaSamtal,
  valjPost, kopplaSamtal, hamtaSenasteSamtal, tomKo, ringUpp, kanRinga,
  type SparatSamtal, type TalkConfig,
} from "@/lib/leaddesk";

/* =============================================================================
   LeadDesk Talk — telefonpanelen. Monteras EN gång i App.tsx (även i D2D-läget)
   så att iframen och ett pågående samtal överlever sidbyten.
   ========================================================================== */

const PhoneIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
  </svg>
);

function tid(iso: string) {
  const d = new Date(iso);
  const idag = new Date().toDateString() === d.toDateString();
  return idag
    ? d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

const FAS_TEXT = {
  begart: "Samtalet är skickat till Talk…",
  ringer: "Ringer",
  kopplat: "Pågående samtal",
  avslutat: "Samtalet är avslutat — sparas när Talk är klar",
  sparat: "Samtalet är sparat",
  fel: "Problem",
} as const;

export function TalkDock({ onOpenRecord, currentRecordId, d2d }: {
  onOpenRecord: (id: string) => void;
  currentRecordId: string | null;
  /** I D2D-läget visas knappen bara om telefonen redan är startad. */
  d2d?: boolean;
}) {
  const t = useTalk();
  const ramRef = useRef<HTMLIFrameElement>(null);
  const [senaste, setSenaste] = useState<SparatSamtal[] | null>(null);
  const [namn, setNamn] = useState("");
  const [skapar, setSkapar] = useState(false);
  const [lokaltFel, setLokaltFel] = useState<string | null>(null);

  // Inställningar en gång.
  useEffect(() => { void laddaTalkConfig(); }, []);

  // Navigering för skärmpop — senaste värdena via ref.
  const navRef = useRef({ onOpenRecord, currentRecordId });
  navRef.current = { onOpenRecord, currentRecordId };
  useEffect(() => {
    registreraNavigering((id) => navRef.current.onOpenRecord(id), () => navRef.current.currentRecordId);
  }, []);

  // Bara meddelanden från den konfigurerade origin OCH vår egen iframe.
  const origin = t.cfg?.origin ?? null;
  useEffect(() => {
    if (!origin) return;
    const lyssna = (e: MessageEvent) => {
      if (e.origin !== origin || !ramRef.current || e.source !== ramRef.current.contentWindow) return;
      hanteraTalkMeddelande(e.data);
    };
    window.addEventListener("message", lyssna);
    return () => window.removeEventListener("message", lyssna);
  }, [origin]);

  // Esc stänger panelen (samtalet fortsätter).
  useEffect(() => {
    if (!t.oppen) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") stangTalk(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [t.oppen]);

  // Senaste samtal: när panelen öppnas och när ett samtal sparats.
  useEffect(() => {
    if (!t.oppen || !t.cfg?.aktiv) return;
    const hamta = () => hamtaSenasteSamtal(15).then(setSenaste).catch(() => setSenaste([]));
    hamta();
    window.addEventListener("leaddesk:samtal-sparat", hamta);
    return () => window.removeEventListener("leaddesk:samtal-sparat", hamta);
  }, [t.oppen, t.cfg?.aktiv]);

  // Återförsök för samtal som inte kunde sparas.
  useEffect(() => {
    if (!t.koLangd) return;
    const i = window.setInterval(() => void tomKo(), 60_000);
    return () => window.clearInterval(i);
  }, [t.koLangd]);

  // Nytt samtal → nollställ formuläret för okänt nummer.
  const samtalNyckel = t.samtal ? `${t.samtal.callId}:${t.samtal.nummer}` : "";
  useEffect(() => { setNamn(""); setLokaltFel(null); }, [samtalNyckel]);

  if (!t.cfg?.aktiv) return null;
  if (d2d && !t.laddad) return null;

  const status = t.samtal && (t.samtal.fas === "ringer" || t.samtal.fas === "kopplat") ? "samtal"
    : t.inloggad ? "redo" : "ut";
  // Med autocall=false startar agenten samtalet själv — påstå inte att det ringer.
  const fasText = (f: keyof typeof FAS_TEXT) =>
    f === "begart" && !t.cfg?.autocall ? "Numret är ifyllt i Talk — starta samtalet där" : FAS_TEXT[f];
  const statusText = status === "samtal" ? fasText(t.samtal!.fas)
    : status === "redo" ? "Redo att ringa" : t.laddad ? "Logga in i LeadDesk Talk" : "Inte startad";

  async function skapaKontakt() {
    const s = t.samtal;
    if (!s?.nummer || !namn.trim()) return;
    setSkapar(true); setLokaltFel(null);
    try {
      const rad = await createRecord("contact", { name: namn.trim(), phone: visaTelefon(s.nummer) });
      valjPost({ id: rad.id, title: namn.trim() });
      onOpenRecord(rad.id);
    } catch (e) {
      setLokaltFel(e instanceof DataError ? e.message : "Kunde inte skapa kontakten.");
    } finally { setSkapar(false); }
  }

  async function kopplaTillOppen(c: SparatSamtal) {
    if (!currentRecordId) return;
    try {
      await kopplaSamtal(c.id, currentRecordId);
      setSenaste(await hamtaSenasteSamtal(15));
    } catch (e) {
      setLokaltFel(e instanceof Error ? e.message : "Kunde inte koppla samtalet.");
    }
  }

  const s = t.samtal;
  return (
    <>
      <button
        className={`ldt-fab ldt-fab--${status}${d2d ? " ldt-fab--d2d" : ""}`}
        aria-pressed={t.oppen}
        onClick={vaxlaTalk}
        title={statusText}
      >
        <span className="ldt-fab__icon"><PhoneIcon /></span>
        <span className="ldt-fab__text">Telefon</span>
        <span className="ldt-dot" aria-hidden="true" />
      </button>

      {t.oppen && <div className="ldt-scrim" onClick={stangTalk} />}
      <section className={`ldt-panel${t.oppen ? " ldt-panel--open" : ""}`} role="dialog" aria-label="LeadDesk Talk" aria-hidden={!t.oppen}>
        <header className="ldt-panel__head">
          <span className={`ldt-panel__avatar ldt-panel__avatar--${status}`}><PhoneIcon size={18} /></span>
          <div className="ldt-panel__titles">
            <div className="ldt-panel__title">Telefon</div>
            <div className="ldt-panel__sub"><span className={`ldt-dot ldt-dot--${status}`} />{statusText}</div>
          </div>
          <button className="ldt-iconbtn" onClick={stangTalk} aria-label="Stäng telefonpanelen" title="Stäng (samtalet fortsätter)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className="ldt-panel__body">
          {t.varning && (
            <div className="ldt-varning" role="alert">
              <span>{t.varning}</span>
              <button className="ldt-lank" onClick={rensaVarning}>OK</button>
            </div>
          )}
          {t.koLangd > 0 && (
            <div className="ldt-info">{t.koLangd === 1 ? "Ett samtal" : `${t.koLangd} samtal`} väntar på att sparas — försöker igen varje minut.</div>
          )}

          {s && (
            <div className={`ldt-samtal ldt-samtal--${s.fas}`}>
              <div className="ldt-samtal__rad">
                <span className="ldt-samtal__riktning">{s.direction === "in" ? "Inkommande" : "Utgående"}</span>
                <span className="ldt-samtal__fas">{fasText(s.fas)}</span>
              </div>
              <div className="ldt-samtal__nummer">{visaTelefon(s.nummer) || "Okänt nummer"}</div>

              {s.recordId ? (
                <div className="ldt-samtal__post">
                  <span>Kopplas till <strong>{s.recordTitle || "posten"}</strong></span>
                  {currentRecordId !== s.recordId && (
                    <button className="btn btn--ghost btn--sm" onClick={() => onOpenRecord(s.recordId!)}>Öppna</button>
                  )}
                </div>
              ) : s.traffar === null ? (
                <div className="ldt-samtal__hint">Söker numret i CRM:et…</div>
              ) : s.traffar.length > 1 ? (
                <div className="ldt-traffar">
                  <div className="ldt-samtal__hint">Numret finns på {s.traffar.length} poster — välj vilken samtalet gäller:</div>
                  {s.traffar.slice(0, 8).map((tr) => (
                    <div key={tr.id} className="ldt-traff">
                      <div className="ldt-traff__text">
                        <div className="ldt-traff__titel">{tr.title || tr.objectLabel}</div>
                        <div className="ldt-traff__meta">{tr.objectLabel} · {tr.fieldLabel}</div>
                      </div>
                      <button className="btn btn--brand btn--sm" onClick={() => { valjPost({ id: tr.id, title: tr.title || tr.objectLabel }); onOpenRecord(tr.id); }}>Välj</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ldt-okant">
                  <div className="ldt-samtal__hint">Numret finns inte i CRM:et. Samtalet sparas ändå.</div>
                  {s.nummer && (
                    <div className="ldt-okant__form">
                      <input
                        className="input" placeholder="Namn på ny kontakt" value={namn}
                        onChange={(e) => setNamn(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void skapaKontakt(); }}
                        aria-label="Namn på ny kontakt"
                      />
                      <button className="btn btn--brand btn--sm" disabled={!namn.trim() || skapar} onClick={() => void skapaKontakt()}>
                        {skapar ? "Skapar…" : "Skapa kontakt"}
                      </button>
                    </div>
                  )}
                  {currentRecordId && (
                    <button className="ldt-lank" onClick={() => valjPost({ id: currentRecordId, title: "posten du har öppen" })}>
                      Koppla till posten du har öppen
                    </button>
                  )}
                </div>
              )}
              {(s.felmeddelande || lokaltFel) && <div className="ldt-fel">{s.felmeddelande || lokaltFel}</div>}
              {(s.fas === "sparat" || s.fas === "fel") && (
                <button className="ldt-lank ldt-samtal__klar" onClick={rensaSamtal}>Klar</button>
              )}
            </div>
          )}

          <div className="ldt-ram">
            {t.laddad && t.cfg.loginUrl ? (
              <iframe
                ref={ramRef}
                key={t.cfg.loginUrl}
                className="ldt-ram__iframe"
                title="LeadDesk Talk"
                src={t.cfg.loginUrl}
                allow="microphone *"
                onLoad={() => registreraRam(ramRef.current?.contentWindow ?? null)}
              />
            ) : (
              <div className="ldt-ram__start">
                <PhoneIcon size={28} />
                <p>Starta LeadDesk Talk och logga in för att ringa och ta emot samtal i CRM:et.</p>
                <button className="btn btn--brand" onClick={oppnaTalk}>Starta telefonen</button>
              </div>
            )}
          </div>

          {senaste && senaste.length > 0 && (
            <details className="ldt-senaste">
              <summary>Senaste samtal</summary>
              <ul>
                {senaste.map((c) => (
                  <li key={c.id} className="ldt-senaste__rad">
                    <div className="ldt-senaste__topp">
                      <span className={`ldt-pil ldt-pil--${c.direction}`} aria-label={c.direction === "inbound" ? "Inkommande" : "Utgående"}>
                        {c.direction === "inbound" ? "↙" : "↗"}
                      </span>
                      <span className="ldt-senaste__nr">{visaTelefon(c.remote) || "Okänt"}</span>
                      <span className="ldt-senaste__tid">{tid(c.occurredAt)}</span>
                    </div>
                    <div className="ldt-senaste__meta">
                      {c.answered === false ? "Obesvarat" : c.duration != null ? `${Math.floor(c.duration / 60)} min ${c.duration % 60} s` : ""}
                      {c.reason ? ` · ${c.reason}` : ""}
                    </div>
                    {c.comment && <div className="ldt-senaste__kommentar">{c.comment}</div>}
                    <div className="ldt-senaste__poster">
                      {c.poster.map((p) => (
                        <button key={p.id} className="ldt-lank" onClick={() => onOpenRecord(p.id)}>{p.title || "Öppna post"}</button>
                      ))}
                      {c.poster.length === 0 && currentRecordId && (c.egen) && (
                        <button className="ldt-lank" onClick={() => void kopplaTillOppen(c)}>Koppla till öppen post</button>
                      )}
                      {c.poster.length === 0 && !currentRecordId && <span className="ldt-senaste__okopplad">Ej kopplat</span>}
                      {c.recordUrl && /^https:\/\//.test(c.recordUrl) && (
                        <a className="ldt-lank" href={c.recordUrl} target="_blank" rel="noopener noreferrer">Inspelning</a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </section>
    </>
  );
}

/** Liten ringknapp bredvid ett telefonfält. Syns bara när Talk är inställt. */
export function RingKnapp({ nummer, recordId, namn }: { nummer: unknown; recordId?: string | null; namn?: string | null }) {
  const t = useTalk();
  if (!t.cfg?.aktiv) return null;
  const nr = normaliseraTelefon(nummer, t.cfg.standardland);
  const kan = !!nr && kanRinga();
  const titel = !nr ? "Ange ett telefonnummer" : t.inloggad ? `Ring ${visaTelefon(nr)} med LeadDesk` : "Logga in i LeadDesk Talk för att ringa";
  return (
    <button
      type="button"
      className={`ldt-ring${t.inloggad ? "" : " ldt-ring--ut"}`}
      disabled={!kan}
      title={titel}
      aria-label={titel}
      onClick={() => ringUpp(nr, { recordId: recordId ?? null, namn: namn ?? null })}
    >
      <PhoneIcon size={15} />
    </button>
  );
}

/* ─── Inställningar → LeadDesk (admin) ─────────────────────────────────────── */
export function LeadDeskSettings() {
  const t = useTalk();
  const [f, setF] = useState<TalkConfig | null>(null);
  const [url, setUrl] = useState("");
  const [sparar, setSparar] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { void laddaTalkConfig(); }, []);
  useEffect(() => {
    if (t.cfg && !f) { setF(t.cfg); setUrl(t.cfg.loginUrl ?? ""); }
  }, [t.cfg, f]);

  let origin: string | null = null;
  let urlFel: string | null = null;
  if (url.trim()) {
    try {
      const u = new URL(url.trim());
      if (u.protocol !== "https:") urlFel = "Adressen måste börja med https://";
      else if (!/(^|\.)leaddesk\.com$/.test(u.hostname)) urlFel = "Adressen måste ligga under leaddesk.com";
      else origin = u.origin;
    } catch { urlFel = "Ogiltig adress"; }
  }

  async function spara() {
    if (!f || urlFel) return;
    setSparar(true); setMsg(null);
    try {
      const cfg = await sparaTalkConfig({ ...f, loginUrl: url.trim() || null });
      if (cfg) { setF(cfg); setUrl(cfg.loginUrl ?? ""); }
      setMsg({ ok: true, text: "Sparat." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Kunde inte spara." });
    } finally { setSparar(false); }
  }

  if (!f) return <div className="card">{t.cfgFel ?? "Laddar…"}</div>;
  const set = <K extends keyof TalkConfig>(k: K, v: TalkConfig[K]) => setF({ ...f, [k]: v });

  return (
    <div className="card ldt-set">
      <div className="settings-section">
        <div className="section-title">LeadDesk Talk</div>
        <p className="ldt-set__ingress">
          Telefonpanelen i CRM:et (knappen Telefon nere till höger). Logga in i LeadDesk i webbläsaren och
          kopiera <strong>exakt</strong> adressen som står i adressfältet efter inloggningen — den avgör zonen
          (NOR, QED, CEU, CE2) och är den enda adress CRM:et pratar med.
        </p>

        <label className="label" htmlFor="ldt-url">Inloggningsadress</label>
        <input id="ldt-url" className="input" placeholder="https://login-….leaddesk.com/" value={url}
          onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="off" />
        <div className={urlFel ? "formfield__error" : "formfield__help"}>
          {urlFel ?? (origin ? `Godkänd origin: ${origin}` : "Tom = telefonen är avstängd för alla.")}
        </div>
      </div>

      <div className="settings-section">
        <div className="section-title">Klick för att ringa</div>
        <div className="ldt-set__val">
          <label className="ldt-set__radio">
            <input type="radio" name="ldt-auto" checked={f.autocall} onChange={() => set("autocall", true)} />
            <span><strong>Ring direkt</strong> — ringknappen startar samtalet i Talk omedelbart.</span>
          </label>
          <label className="ldt-set__radio">
            <input type="radio" name="ldt-auto" checked={!f.autocall} onChange={() => set("autocall", false)} />
            <span><strong>Agenten bekräftar</strong> — numret fylls i Talk och agenten trycker ring själv.</span>
          </label>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-title">Öppna posten automatiskt (skärmpop)</div>
        <label className="ldt-set__check">
          <input type="checkbox" checked={f.skarmpopIn} onChange={(e) => set("skarmpopIn", e.target.checked)} />
          Inkommande samtal
        </label>
        <label className="ldt-set__check">
          <input type="checkbox" checked={f.skarmpopUt} onChange={(e) => set("skarmpopUt", e.target.checked)} />
          Utgående samtal
        </label>
        <p className="formfield__help">Numret matchas mot alla telefonfält (kontakter, kunder, bolag, affärer, ärenden, lägenheter …). En träff öppnas direkt; flera träffar visas som val i panelen; okänt nummer ger "Skapa kontakt".</p>
      </div>

      <div className="settings-section ldt-set__rad">
        <div>
          <label className="label" htmlFor="ldt-land">Standardland för nummer</label>
          <select id="ldt-land" className="input" value={f.standardland} onChange={(e) => set("standardland", e.target.value)}>
            <option value="SE">Sverige (+46)</option>
            <option value="FI">Finland (+358)</option>
            <option value="NO">Norge (+47)</option>
            <option value="DK">Danmark (+45)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ldt-tz">Tidszon för LeadDesks tider</label>
          <input id="ldt-tz" className="input" value={f.tidszon} onChange={(e) => set("tidszon", e.target.value)} />
        </div>
      </div>

      <div className="ldt-set__fot">
        {msg && <span className={msg.ok ? "ldt-set__ok" : "formfield__error"}>{msg.text}</span>}
        <button className="btn btn--brand" disabled={sparar || !!urlFel} onClick={() => void spara()}>
          {sparar ? "Sparar…" : "Spara"}
        </button>
      </div>
    </div>
  );
}
