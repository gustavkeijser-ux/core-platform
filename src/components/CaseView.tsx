import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { StatusDef } from "@/lib/data";
import { DataError } from "@/lib/data";
import {
  type CaseAttachment, type CaseCategory, type CaseDetail, type CaseMessage,
  PRIORITIES, SLA_META, SOURCE_LABEL,
  assignableUsers, attachmentUrl, caseAddNote, caseCategories, caseLink, caseReply, caseSet,
  caseSetCustomerEmail, fmtDateTime, formatBytes, getCase, getMessageHtml, relTime, searchLinkTargets, sendQueued,
} from "@/lib/cases";
import { StatusPill } from "./StatusPill";
import { PriorityTag } from "./CasesPage";
import { UserBadge, useUserName } from "@/lib/users";
import { supabase } from "@/integrations/supabase/client";

/**
 * Ett ärende. Byggd för att en handläggare inom 3 sekunder ska se:
 * vem kunden är, vad det gäller, vilken fastighet/lägenhet, vad som hänt,
 * vem som äger ärendet, vad vi väntar på och vad nästa steg är.
 * Konversationen står i centrum; interna kommentarer syns tydligt som
 * interna och kan aldrig skickas till kunden.
 */

type Props = { caseId: string; statuses: StatusDef[]; onBack: () => void; onOpenCase: (id: string) => void };

type TimelineItem =
  | { kind: "msg"; at: string; msg: CaseMessage }
  | { kind: "event"; at: string; id: string; body: string; actor: string | null; actorKind: string };

type CaseTab = "overview" | "conv";
const TAB_KEY = "ce.case.tab";

export function CaseView({ caseId, statuses, onBack, onOpenCase }: Props) {
  const [d, setD] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [cats, setCats] = useState<CaseCategory[]>([]);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  // Flikar: Översikt och Konversation. Senast valda flik minns under sessionen.
  const [tab, setTabState] = useState<CaseTab>(() => {
    try { return sessionStorage.getItem(TAB_KEY) === "conv" ? "conv" : "overview"; } catch { return "overview"; }
  });
  const setTab = useCallback((t: CaseTab) => {
    setTabState(t);
    try { sessionStorage.setItem(TAB_KEY, t); } catch { /* privat läge */ }
  }, []);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)); }, []);
  useEffect(() => { assignableUsers().then(setUsers); caseCategories().then(setCats); }, []);

  const load = useCallback(async () => {
    try { setD(await getCase(caseId)); setError(null); }
    catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte hämta ärendet."); }
  }, [caseId]);
  useEffect(() => { setD(null); void load(); }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  // Första gången ärendet visas: se till att senaste meddelandet syns, men
  // bara om det ligger utanför skärmen ("nearest" rör inte sidan annars).
  // Görs en gång per ärende — automatisk uppdatering var 30:e s scrollar aldrig.
  // Konversationsfliken: ärendehuvudet och svarsrutan står still, bara
  // tråden scrollar. Sidan får exakt den höjd som ryms i fönstret.
  const rootRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const loaded = d != null;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (tab !== "conv") { el.style.height = ""; return; }
    const scroller = el.closest(".app-shell__content") as HTMLElement | null;
    const fit = () => {
      if (scroller) scroller.scrollTop = 0;
      const top = el.getBoundingClientRect().top;
      el.style.height = `${Math.max(360, window.innerHeight - top)}px`;
      const over = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
      if (over > 0) el.style.height = `${Math.max(360, window.innerHeight - top - over)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => { window.removeEventListener("resize", fit); el.style.height = ""; };
  }, [tab, loaded]);

  // Tråden börjar längst ner (senaste meddelandet). Nya meddelanden följs bara
  // om man redan står längst ner — automatisk uppdatering rycker aldrig.
  const scrolled = useRef<string | null>(null);
  useLayoutEffect(() => {
    const t = threadRef.current;
    if (!d || tab !== "conv" || !t) return;
    if (scrolled.current !== caseId || nearBottom.current) {
      scrolled.current = caseId;
      t.scrollTop = t.scrollHeight;
    }
  }, [d, caseId, tab]);
  useEffect(() => { if (tab !== "conv") scrolled.current = null; }, [tab]);

  /** Gå till svarsrutan: byt till Konversation, scrolla dit och sätt markören där. */
  const focusComposer = useCallback(() => {
    setTab("conv");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      composerRef.current?.focus({ preventScroll: true });
    }));
  }, [setTab]);

  // Tangentbord: r = svara, i = intern kommentar, Esc = tillbaka
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "r") { e.preventDefault(); setMode("reply"); focusComposer(); }
      else if (e.key === "i") { e.preventDefault(); setMode("note"); focusComposer(); }
      else if (e.key === "Escape") { e.preventDefault(); onBack(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, focusComposer]);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try { await fn(); await load(); }
    catch (e) { setActionError(e instanceof DataError ? e.message : "Något gick fel."); }
  }

  const statusDef = useMemo(() => new Map(statuses.map((s) => [s.key, s])), [statuses]);

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!d) return [];
    const items: TimelineItem[] = [
      ...d.messages.map((m) => ({ kind: "msg" as const, at: m.occurredAt, msg: m })),
      ...d.events.map((e) => ({
        kind: "event" as const, at: e.occurredAt, id: e.id, body: e.body ?? "", actor: e.actorUserId, actorKind: e.actorKind,
      })),
    ];
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }, [d]);

  if (error) return <div className="page"><div className="card"><div className="empty-state">{error}</div></div></div>;
  if (!d) return <div className="page"><div className="empty-state">Laddar ärendet…</div></div>;

  const c = d.case;
  const data = c.data;
  const lagenhet = d.related.find((r) => r.relType === "case_lagenhet");
  const fastighet = d.related.find((r) => r.relType === "case_property");
  const lastEmail = [...d.messages].reverse().find((m) => m.channel === "email");
  const lastMsg = d.messages.length ? [...d.messages].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt))[d.messages.length - 1] : undefined;
  const lastMsgId = lastMsg?.id;
  const closed = c.status === "resolved" || c.status === "closed";
  const firstDue = data.first_response_due_at as string | undefined;
  const resDue = data.resolution_due_at as string | undefined;
  const failedSends = d.messages.filter((m) => m.direction === "outbound" && (m.sendStatus === "failed" || m.sendStatus === "pending"));

  // Nästa åtgärd — en mening, med den viktigaste knappen.
  let next: { text: string; tone: "action" | "wait" | "done" | "alert"; cta?: { label: string; run: () => void } } ;
  if (failedSends.length > 0) {
    next = { text: "Ett svar har inte skickats till kunden.", tone: "alert" };
  } else if (!c.owner_user_id && !closed) {
    next = { text: "Ingen äger ärendet ännu.", tone: "action",
      cta: me ? { label: "Tilldela mig", run: () => void act(() => caseSet(c.id, { ansvarig: me })) } : undefined };
  } else if (!closed && lastEmail?.direction === "inbound") {
    const due = !data.first_response_at ? firstDue : resDue;
    next = { text: `Svara kunden${due ? ` — ${!data.first_response_at ? "första svar" : "lösning"} senast ${fmtDateTime(due)} (${relTime(due)})` : ""}.`,
      tone: "action", cta: { label: "Svara", run: () => { setMode("reply"); focusComposer(); } } };
  } else if (c.status === "waiting_customer") {
    next = { text: `Väntar på kundens svar sedan ${fmtDateTime(lastEmail?.occurredAt)}.`, tone: "wait" };
  } else if (c.status === "waiting_internal") {
    next = { text: "Väntar på internt svar — följ upp med kollegan.", tone: "wait" };
  } else if (c.status === "waiting_contractor") {
    next = { text: "Väntar på entreprenören — följ upp om inget hänt.", tone: "wait" };
  } else if (c.status === "resolved") {
    next = { text: "Löst. Stäng ärendet när kunden bekräftat (svarar kunden öppnas det igen).", tone: "done",
      cta: { label: "Stäng", run: () => void act(() => caseSet(c.id, { status: "closed" })) } };
  } else if (c.status === "closed") {
    next = { text: "Stängt. Svarar kunden skapas ett nytt ärende som länkas hit.", tone: "done" };
  } else {
    next = { text: "Hantera ärendet och sätt status när du väntar på någon eller när det är löst.", tone: "action" };
  }

  return (
    <div className={`page case${tab === "conv" ? " case--conv" : ""}`} ref={rootRef}>
      <div className="case__head card">
        <div className="case__crumbs">
          <button className="btn btn--ghost btn--sm" onClick={onBack} aria-label="Tillbaka till ärenden">← Ärenden</button>
          <span className="case__nr">{data.case_number}</span>
          <span className="case__src">{SOURCE_LABEL[data.channel as string] ?? "—"}</span>
          {data.reopened_from && (
            <button className="btn btn--ghost btn--sm" onClick={() => onOpenCase(data.reopened_from)}>Fortsättning på tidigare ärende →</button>
          )}
        </div>
        <h2 className="case__title">{data.name || "(Inget ämne)"}</h2>

        {/* De sju frågorna, på en rad */}
        <div className="case__facts">
          <Fact label="Kund">
            {data.kund_epost ? <a href={`mailto:${data.kund_epost}`}>{data.kund_epost}</a> : <span className="ink-faint">Okänd</span>}
          </Fact>
          <Fact label="Gäller">
            {d.categoryLabel ? <>{d.categoryLabel}{d.subcategoryLabel ? ` · ${d.subcategoryLabel}` : ""}</> : <span className="ink-faint">Ingen kategori</span>}
          </Fact>
          <Fact label="Fastighet / lägenhet">
            {fastighet || lagenhet
              ? <>{fastighet?.title ?? ""}{fastighet && lagenhet ? " · " : ""}{lagenhet ? data.lagenhet_namn ?? lagenhet.title : ""}</>
              : <span className="ink-faint">Ej kopplad</span>}
          </Fact>
          <Fact label="Ansvarig">
            {c.owner_user_id ? <UserBadge id={c.owner_user_id} /> : <span className="case__unassigned">Ej tilldelad</span>}
          </Fact>
          <Fact label="Status">
            <StatusPill status={c.status} def={statusDef.get(c.status)} /> <PriorityTag p={data.priority ?? "normal"} />
          </Fact>
          <Fact label="Deadline">
            <SlaLine label="Svar" state={d.sla.firstResponse} due={firstDue} doneAt={data.first_response_at} />
            <SlaLine label="Lösning" state={d.sla.resolution} due={resDue} doneAt={data.resolved_at} />
          </Fact>
        </div>

        <div className={`case__next case__next--${next.tone}`}>
          <span className="case__next-label">Nästa steg</span>
          <span className="case__next-text">{next.text}</span>
          {next.cta && d.canUpdate && <button className="btn btn--brand btn--sm" onClick={next.cta.run}>{next.cta.label}</button>}
        </div>
        {actionError && <div className="formfield__error">{actionError}</div>}
      </div>

      <div className="tab-bar case__tabs" role="tablist">
        <button role="tab" aria-selected={tab === "overview"} className={`tab-bar__tab${tab === "overview" ? " tab-bar__tab--active" : ""}`}
          onClick={() => setTab("overview")}>Översikt</button>
        <button role="tab" aria-selected={tab === "conv"} className={`tab-bar__tab${tab === "conv" ? " tab-bar__tab--active" : ""}`}
          onClick={() => setTab("conv")}>
          Konversation{d.messages.length > 0 && <span className="tab-bar__count">{d.messages.length}</span>}
        </button>
      </div>

      {tab === "overview" ? (
        <div className="case__overview">
          <div className="card case__panel case__latest">
            <div className="case__panel-title">Senaste meddelandet</div>
            {lastMsg ? (
              <>
                <div className="case__latest-head">
                  <span className="tl__who">{lastMsg.channel === "internal_note" ? "Intern kommentar" : lastMsg.direction === "inbound" ? `Hyresgäst · ${lastMsg.from ?? ""}` : "ConnectEstate"}</span>
                  <span className="tl__when">{fmtDateTime(lastMsg.occurredAt)}</span>
                </div>
                <div className="tl__body case__latest-body">{tidyBody(lastMsg.bodyText) || "(Tomt meddelande)"}</div>
              </>
            ) : <div className="ink-faint">Inga meddelanden ännu.</div>}
            <div className="case__latest-actions">
              <button className="btn btn--ghost btn--sm" onClick={() => setTab("conv")}>Öppna konversationen ({d.messages.length})</button>
              {d.canUpdate && <button className="btn btn--brand btn--sm" onClick={() => { setMode("reply"); focusComposer(); }}>Svara</button>}
            </div>
          </div>
          <div className="card case__panel">
            <div className="case__panel-title">Hantera</div>
            <label className="label" htmlFor="cs-status">Status</label>
            <select id="cs-status" className="input" value={c.status} disabled={!d.canUpdate}
              onChange={(e) => void act(() => caseSet(c.id, { status: e.target.value }))}>
              {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>

            <label className="label">Prioritet</label>
            <div className="chips">
              {PRIORITIES.map((p) => (
                <button key={p.key} className={`chip chip--prio-${p.key}`} disabled={!d.canUpdate}
                  aria-pressed={(data.priority ?? "normal") === p.key}
                  onClick={() => void act(() => caseSet(c.id, { priority: p.key }))}>{p.label}</button>
              ))}
            </div>

            <label className="label" htmlFor="cs-owner">Ansvarig</label>
            <div className="case__owner">
              <select id="cs-owner" className="input" value={c.owner_user_id ?? ""} disabled={!d.canUpdate}
                onChange={(e) => void act(() => caseSet(c.id, e.target.value ? { ansvarig: e.target.value } : { unassign: true }))}>
                <option value="">Ej tilldelad</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              {me && c.owner_user_id !== me && d.canUpdate && (
                <button className="btn btn--ghost btn--sm" onClick={() => void act(() => caseSet(c.id, { ansvarig: me }))}>Mig</button>
              )}
            </div>

            <label className="label" htmlFor="cs-cat">Kategori</label>
            <select id="cs-cat" className="input" value={data.category ?? ""} disabled={!d.canUpdate}
              onChange={(e) => e.target.value && void act(() => caseSet(c.id, { category: e.target.value }))}>
              <option value="">Välj kategori…</option>
              {cats.filter((x) => !x.parent_key).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
            {data.category && (
              <select className="input" value={data.subcategory ?? ""} disabled={!d.canUpdate} aria-label="Underkategori"
                onChange={(e) => e.target.value && void act(() => caseSet(c.id, { subcategory: e.target.value }))}>
                <option value="">Välj underkategori…</option>
                {cats.filter((x) => x.parent_key === data.category).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            )}
          </div>

          <div className="card case__panel">
            <div className="case__panel-title">Kund & plats</div>
            <EmailEditor value={data.kund_epost ?? ""} disabled={!d.canUpdate}
              onSave={(v) => act(() => caseSetCustomerEmail(c.id, v))} />
            <LinkPicker label="Lägenhet" type="d2d_lagenhet" current={lagenhet ? (data.lagenhet_namn ?? lagenhet.title) : null}
              disabled={!d.canUpdate} onPick={(id) => act(() => caseLink(c.id, "case_lagenhet", id))} />
            <LinkPicker label="Fastighet" type="property" current={fastighet?.title ?? null}
              disabled={!d.canUpdate} onPick={(id) => act(() => caseLink(c.id, "case_property", id))} />
          </div>

          {d.otherCases.length > 0 && (
            <div className="card case__panel">
              <div className="case__panel-title">Tidigare ärenden från kunden</div>
              <ul className="case__others">
                {d.otherCases.slice(0, 8).map((o) => (
                  <li key={o.id}>
                    <button className="linklike" onClick={() => onOpenCase(o.id)}>
                      <span className="case__nr">{o.caseNumber}</span> {o.title}
                    </button>
                    <StatusPill status={o.status} def={statusDef.get(o.status)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card case__panel case__meta">
            <div><span>Skapat</span><span>{fmtDateTime(c.created_at, { withYear: true })}</span></div>
            <div><span>Första svar</span><span>{data.first_response_at ? fmtDateTime(data.first_response_at) : "—"}</span></div>
            <div><span>Löst</span><span>{data.resolved_at ? fmtDateTime(data.resolved_at) : "—"}</span></div>
            <div><span>Brevlåda</span><span>{data.mailbox ?? "—"}</span></div>
            <p className="ink-faint case__keys">Tangentbord: <kbd>r</kbd> svara · <kbd>i</kbd> intern kommentar · <kbd>Esc</kbd> tillbaka</p>
          </div>
        </div>
      ) : (
        <section className="case__conv" aria-label="Konversation">
          <div className="case__thread" ref={threadRef} onScroll={(e) => {
            const t = e.currentTarget;
            nearBottom.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
          }}>
          <ol className="tl">
            {timeline.map((it) => it.kind === "event"
              ? <li key={`e${it.id}`} className="tl__event"><span>{it.body}</span> · <EventActor id={it.actor} kind={it.actorKind} /> · {fmtDateTime(it.at)}</li>
              : <MessageItem key={it.msg.id} m={it.msg} latest={it.msg.id === lastMsgId} onRetry={() => void act(async () => {
                  const r = await sendQueued(it.msg.id);
                  if (!r.sent) throw new DataError("unknown", r.message ?? "Kunde inte skicka.");
                })} />)}
          </ol>
          </div>
          {d.canUpdate && (
            <Composer
              ref={composerRef}
              mode={mode}
              setMode={setMode}
              canReply={!!data.kund_epost}
              onReply={async (text, nextStatus) => {
                const r = await caseReply(c.id, text, nextStatus);
                await load();
                return r;
              }}
              onNote={async (text) => { await caseAddNote(c.id, text); await load(); }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="case__fact">
      <span className="case__fact-label">{label}</span>
      <span className="case__fact-value">{children}</span>
    </div>
  );
}

function SlaLine({ label, state, due, doneAt }: { label: string; state: keyof typeof SLA_META | null; due?: string; doneAt?: string }) {
  if (!state || !due) return null;
  const meta = SLA_META[state];
  return (
    <span className={`sla sla--${meta.cls} case__sla`} title={`${label} senast ${fmtDateTime(due)}`}>
      <span aria-hidden>{meta.dot}</span> {label}: {doneAt ? fmtDateTime(doneAt) : relTime(due)}
    </span>
  );
}

function EventActor({ id, kind }: { id: string | null; kind: string }) {
  const name = useUserName(id);
  if (id) return <>{name}</>;
  return <>{kind === "integration" ? "Microsoft 365" : "Systemet"}</>;
}

/** Mejltext från HTML-mejl har ofta tiotals tomrader (en per <p>/<div>).
 *  Tryck ihop dem till högst en tomrad så tråden går att läsa utan att scrolla. */
function tidyBody(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CLAMP_LINES = 14;

/** Meddelandetext. Långa meddelanden visas förkortade med "Visa hela";
 *  det senaste meddelandet visas alltid helt. */
function MessageBody({ text, defaultOpen }: { text: string | null | undefined; defaultOpen: boolean }) {
  const body = useMemo(() => tidyBody(text), [text]);
  const long = body.split("\n").length > CLAMP_LINES + 4 || body.length > 1400;
  const [open, setOpen] = useState(defaultOpen);
  if (!body) return <div className="tl__body"><span className="ink-faint">(Tomt meddelande)</span></div>;
  const clamped = long && !open;
  return (
    <>
      <div className={`tl__body${clamped ? " tl__body--clamped" : ""}`}>{body}</div>
      {long && (
        <button className="linklike tl__more" onClick={() => setOpen((v) => !v)}>
          {open ? "Visa mindre" : "Visa hela meddelandet"}
        </button>
      )}
    </>
  );
}

function MessageItem({ m, onRetry, latest = false }: { m: CaseMessage; onRetry: () => void; latest?: boolean }) {
  const author = useUserName(m.authorUserId);
  const [html, setHtml] = useState<string | null>(null);
  const [showHtml, setShowHtml] = useState(false);
  const [images, setImages] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isNote = m.channel === "internal_note";
  const inbound = m.direction === "inbound";

  async function toggleHtml() {
    if (!showHtml && html == null) {
      try { setHtml(await getMessageHtml(m.id)); } catch { setErr("Kunde inte visa mejlet."); return; }
    }
    setShowHtml((v) => !v);
  }

  const who = isNote ? `Intern kommentar · ${author}` : inbound ? `Hyresgäst · ${m.from ?? ""}` : `ConnectEstate · ${m.authorUserId ? author : (m.from ?? "")}`;

  return (
    <li className={`tl__msg tl__msg--${isNote ? "note" : inbound ? "in" : "out"}`}>
      <div className="tl__head">
        <span className="tl__who">{who}</span>
        <span className="tl__when">{fmtDateTime(m.occurredAt)}</span>
      </div>
      {isNote && <div className="tl__note-flag">Syns bara internt — skickas aldrig till kunden</div>}
      {!isNote && m.subject && <div className="tl__subject">{m.subject}</div>}
      {!isNote && !inbound && m.to?.length > 0 && <div className="tl__to ink-faint">Till: {m.to.join(", ")}</div>}
      <MessageBody text={m.bodyText} defaultOpen={latest} />

      {m.attachments.length > 0 && (
        <ul className="tl__atts">
          {m.attachments.map((a) => <AttachmentChip key={a.id} a={a} />)}
        </ul>
      )}

      {m.hasHtml && (
        <div className="tl__html">
          <button className="linklike" onClick={() => void toggleHtml()}>{showHtml ? "Dölj originalmejlet" : "Visa hela originalmejlet"}</button>
          {showHtml && html != null && (
            <>
              {!images && <button className="linklike tl__img-btn" onClick={() => setImages(true)}>Visa bilder</button>}
              <SafeHtml html={html} allowImages={images} />
            </>
          )}
          {err && <div className="formfield__error">{err}</div>}
        </div>
      )}

      {!inbound && !isNote && m.sendStatus && m.sendStatus !== "sent" && (
        <div className={`tl__send tl__send--${m.sendStatus}`}>
          {m.sendStatus === "failed" || m.sendStatus === "pending"
            ? <>Inte skickat{m.sendError ? ` — ${m.sendError}` : ""}. <button className="linklike" onClick={onRetry}>Försök igen</button></>
            : "Skickas…"}
        </div>
      )}
    </li>
  );
}

/** Mejlets HTML: rensad med DOMPurify och visad i en isolerad ram utan
 *  skript. Externa bilder (spårningspixlar) blockeras tills man ber om dem. */
function SafeHtml({ html, allowImages }: { html: string; allowImages: boolean }) {
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "button"], FORBID_ATTR: ["style"] });
  const csp = `default-src 'none'; img-src data: cid:${allowImages ? " https:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#222;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${clean}</body></html>`;
  // Ramen får samma höjd som mejlet, så sidan scrollar som vanligt i stället
  // för att mushjulet fastnar inne i ramen. allow-same-origin behövs för att
  // kunna mäta höjden; skript är fortfarande avstängda (ingen allow-scripts).
  const fit = (f: HTMLIFrameElement) => {
    const h = f.contentDocument?.documentElement.scrollHeight;
    if (h) f.style.height = `${Math.min(h + 2, 4000)}px`;
  };
  return (
    <iframe className="tl__frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc}
      title="Originalmejl" scrolling="no" onLoad={(e) => {
        const f = e.currentTarget;
        fit(f);
        // Bilder som laddas in efteråt ändrar höjden.
        f.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => fit(f)));
      }} />
  );
}

function AttachmentChip({ a }: { a: CaseAttachment }) {
  const [busy, setBusy] = useState(false);
  const ext = (a.name.split(".").pop() ?? "").toUpperCase().slice(0, 5);
  async function download() {
    if (a.blockedReason || !a.storagePath) return;
    setBusy(true);
    try { window.location.href = await attachmentUrl(a); } finally { setBusy(false); }
  }
  return (
    <li>
      <button className={`att${a.blockedReason ? " att--blocked" : ""}`} onClick={() => void download()} disabled={busy || !!a.blockedReason}
        title={a.blockedReason ?? `Ladda ned ${a.name}`}>
        <span className="att__ext">{ext || "FIL"}</span>
        <span className="att__name">{a.name}</span>
        <span className="att__meta">
          {[a.mimeType, formatBytes(a.sizeBytes), a.sender, a.receivedAt ? fmtDateTime(a.receivedAt) : null].filter(Boolean).join(" · ")}
        </span>
        {a.blockedReason && <span className="att__blocked">{a.blockedReason}</span>}
      </button>
    </li>
  );
}

type ComposerProps = {
  mode: "reply" | "note"; setMode: (m: "reply" | "note") => void; canReply: boolean;
  onReply: (text: string, nextStatus: string | null) => Promise<{ sent: boolean; message?: string }>;
  onNote: (text: string) => Promise<void>;
};

const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer({ mode, setMode, canReply, onReply, onNote }, ref) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const reply = mode === "reply";

  async function submit(nextStatus: string | null = null) {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setMsg(null);
    try {
      if (reply) {
        const r = await onReply(t, nextStatus);
        setMsg(r.sent ? { ok: true, text: "Svaret skickades." } : { ok: false, text: r.message ?? "Svaret är sparat men inte skickat." });
      } else {
        await onNote(t);
        setMsg({ ok: true, text: "Kommentaren sparades." });
      }
      setText("");
    } catch (e) {
      setMsg({ ok: false, text: e instanceof DataError ? e.message : "Något gick fel." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`composer composer--${mode}`}>
      <div className="composer__tabs" role="tablist">
        <button role="tab" aria-selected={reply} className="composer__tab" onClick={() => setMode("reply")} disabled={!canReply}
          title={canReply ? "Svara kunden via hyresgast@connectestate.se" : "Ärendet saknar kundens e-post"}>Svara kund</button>
        <button role="tab" aria-selected={!reply} className="composer__tab" onClick={() => setMode("note")}>Intern kommentar</button>
      </div>
      {!reply && <div className="composer__note-flag">Intern — syns bara för er, skickas aldrig till kunden</div>}
      <textarea
        ref={ref}
        className="input input--area composer__input"
        placeholder={reply ? "Skriv ditt svar till kunden…" : "T.ex. Kontaktat entreprenören. De återkommer före 14:00."}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
      />
      <div className="composer__actions">
        {msg && <span className={msg.ok ? "detail-save-ok" : "formfield__error"}>{msg.ok ? "✓ " : ""}{msg.text}</span>}
        <span className="composer__hint ink-faint">Cmd/Ctrl+Enter</span>
        {reply ? (
          <>
            <button className="btn btn--ghost" disabled={busy || !text.trim()} onClick={() => void submit("waiting_customer")}>Skicka & vänta på kund</button>
            <button className="btn btn--brand" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "Skickar…" : "Skicka"}</button>
          </>
        ) : (
          <button className="btn btn--brand" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "Sparar…" : "Spara kommentar"}</button>
        )}
      </div>
    </div>
  );
});

function EmailEditor({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => Promise<void> }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <>
      <label className="label" htmlFor="cs-email">Kundens e-post</label>
      <input id="cs-email" className="input" type="email" value={v} disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (v.trim().toLowerCase() !== value) void onSave(v); }}
        placeholder="namn@exempel.se" />
    </>
  );
}

function LinkPicker({ label, type, current, disabled, onPick }: {
  label: string; type: "property" | "d2d_lagenhet"; current: string | null; disabled: boolean;
  onPick: (id: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Array<{ id: string; title: string | null; subtitle: string | null }>>([]);
  useEffect(() => {
    if (!editing || q.trim().length < 2) { setHits([]); return; }
    const t = window.setTimeout(() => { searchLinkTargets(type, q).then(setHits).catch(() => setHits([])); }, 250);
    return () => window.clearTimeout(t);
  }, [q, editing, type]);
  return (
    <div className="linkpick">
      <span className="label">{label}</span>
      {!editing ? (
        <div className="linkpick__row">
          <span className={current ? "" : "ink-faint"}>{current ?? "Ej kopplad"}</span>
          {!disabled && (
            <span className="linkpick__btns">
              <button className="linklike" onClick={() => { setEditing(true); setQ(""); }}>{current ? "Byt" : "Koppla"}</button>
              {current && <button className="linklike" onClick={() => void onPick(null)}>Ta bort</button>}
            </span>
          )}
        </div>
      ) : (
        <div className="linkpick__search">
          <input className="input" autoFocus placeholder={type === "property" ? "Sök fastighet eller adress…" : "Sök adress, lgh-nr eller kundens e-post…"}
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          {hits.length > 0 && (
            <ul className="linkpick__hits">
              {hits.map((h) => (
                <li key={h.id}>
                  <button onClick={() => { setEditing(false); void onPick(h.id); }}>
                    <span>{h.title || "—"}</span>{h.subtitle && <span className="ink-faint">{h.subtitle}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="linklike" onClick={() => setEditing(false)}>Avbryt</button>
        </div>
      )}
    </div>
  );
}
