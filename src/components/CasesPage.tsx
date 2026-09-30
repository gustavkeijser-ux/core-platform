import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusDef } from "@/lib/data";
import { DataError } from "@/lib/data";
import {
  type CaseCounts, type CaseFilter, type CaseListItem,
  assignableUsers, caseCreate, caseSet, fmtDateTime, listCases, priorityLabel, relTime, SLA_META,
} from "@/lib/cases";
import { StatusPill } from "./StatusPill";
import { UserBadge } from "@/lib/users";
import { loadListState, rememberRow, saveListState, useReturnToRow } from "@/lib/returnRow";
import { supabase } from "@/integrations/supabase/client";

/**
 * Ärendeinkorgen. Mest akut överst (prioritet, sedan närmaste SLA-deadline).
 * Snabbt att jobba i: "/" söker, j/k eller piltangenter flyttar markeringen,
 * Enter öppnar, "t" tilldelar markerat ärende till mig.
 */

const FILTERS: Array<{ key: CaseFilter; label: string }> = [
  { key: "open", label: "Öppna" },
  { key: "new", label: "Nya" },
  { key: "mine", label: "Mina" },
  { key: "unassigned", label: "Otilldelade" },
  { key: "in_progress", label: "Pågående" },
  { key: "waiting_customer", label: "Väntar kund" },
  { key: "waiting_internal", label: "Väntar internt" },
  { key: "waiting_contractor", label: "Väntar entreprenör" },
  { key: "resolved", label: "Lösta" },
  { key: "closed", label: "Stängda" },
  { key: "all", label: "Alla" },
];

type Props = {
  filter: CaseFilter;
  statuses: StatusDef[];
  onFilter: (f: CaseFilter) => void;
  onOpenCase: (id: string) => void;
};

export function SlaBadge({ item }: { item: Pick<CaseListItem, "sla" | "nextDue" | "firstResponseAt"> }) {
  if (!item.sla) return <span className="ink-faint">—</span>;
  const meta = SLA_META[item.sla];
  return (
    <span className={`sla sla--${meta.cls}`} title={meta.label}>
      <span aria-hidden>{meta.dot}</span>
      <span>{item.nextDue ? relTime(item.nextDue) : meta.label}</span>
      {!item.firstResponseAt && item.nextDue && <span className="sla__kind">svar</span>}
    </span>
  );
}

export function PriorityTag({ p }: { p: string }) {
  if (p === "normal") return <span className="prio prio--normal">Normal</span>;
  return <span className={`prio prio--${p}`}>{priorityLabel(p)}</span>;
}

export function CasesPage({ filter, statuses, onFilter, onOpenCase }: Props) {
  const listKey = `cases:${filter}`;
  const saved = loadListState<{ search: string }>("cases");
  const [search, setSearch] = useState(saved.search ?? "");
  const [items, setItems] = useState<CaseListItem[]>([]);
  const [counts, setCounts] = useState<CaseCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [me, setMe] = useState<string | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [creating, setCreating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnRow = useReturnToRow(listKey, !loading);

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)); }, []);
  useEffect(() => { assignableUsers().then(setUsers); }, []);
  useEffect(() => { saveListState("cases", { search }); }, [search]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await listCases(filter, search, 100, 0);
      setItems(res.items); setCounts(res.counts); setTotal(res.total); setError(null);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta ärenden.");
    } finally { setLoading(false); }
  }, [filter, search]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  // Nya mejl kommer in hela tiden — uppdatera tyst var 30:e sekund.
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => { setSel(0); }, [filter, search]);

  const open = (id: string) => { rememberRow(listKey, id); onOpenCase(id); };

  async function assign(id: string, userId: string | null) {
    try {
      await caseSet(id, userId ? { ansvarig: userId } : { unassign: true });
      await load(true);
    } catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte tilldela."); }
  }

  // Tangentbord
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (typing) { if (e.key === "Escape") (t as HTMLInputElement).blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter" && items[sel]) { e.preventDefault(); open(items[sel].id); }
      else if (e.key === "t" && items[sel] && me) { e.preventDefault(); void assign(items[sel].id, me); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    document.querySelector(`[data-case-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const statusDef = useMemo(() => new Map(statuses.map((s) => [s.key, s])), [statuses]);
  const unassignedNew = counts?.unassigned ?? 0;

  return (
    <div className="page cases">
      <div className="cases__bar">
        <div className="cases__search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
          <input
            ref={searchRef}
            className="input"
            placeholder="Sök ärendenummer, e-post, ämne, text, fastighet, lägenhet …   ( / )"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Sök ärenden"
          />
          {search && <button className="cases__clear" onClick={() => setSearch("")} aria-label="Rensa sökning">×</button>}
        </div>
        <button className="btn btn--ghost btn--sm" onClick={() => setCreating(true)}>+ Nytt ärende</button>
      </div>

      <div className="cases__filters chips" role="tablist" aria-label="Filter">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" className="chip" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)}>
            {f.label}
            {counts && f.key !== "all" && counts[f.key] > 0 && <span className="cases__count">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      {filter !== "unassigned" && unassignedNew > 0 && (
        <button className="cases__queue" onClick={() => onFilter("unassigned")}>
          <strong>{unassignedNew}</strong> {unassignedNew === 1 ? "otilldelat ärende" : "otilldelade ärenden"} väntar på en ansvarig →
        </button>
      )}
      {filter === "unassigned" && (
        <div className="cases__queue cases__queue--static">
          {total === 0 ? "Inga otilldelade ärenden. Snyggt!" : <><strong>{total}</strong> {total === 1 ? "ärende" : "ärenden"} utan ansvarig — ta ett med <kbd>t</kbd> eller knappen på raden.</>}
        </div>
      )}

      {error && <div className="card"><div className="empty-state">{error}</div></div>}

      {!error && (
        <div className="card cases__list">
          {loading && items.length === 0 ? (
            <div className="empty-state">Laddar…</div>
          ) : items.length === 0 ? (
            <div className="empty-state">{search ? "Inga ärenden matchar sökningen." : "Inga ärenden här."}</div>
          ) : (
            <table className="cases-table">
              <thead>
                <tr>
                  <th className="cases-table__sla" aria-label="SLA" />
                  <th>Ärende</th>
                  <th>Hyresgäst</th>
                  <th>Status</th>
                  <th>Prioritet</th>
                  <th>Ansvarig</th>
                  <th>SLA / deadline</th>
                  <th>Fastighet / lägenhet</th>
                  <th>Kategori</th>
                  <th>Senaste aktivitet</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c, i) => (
                  <tr
                    key={c.id}
                    {...returnRow(c.id)}
                    data-case-idx={i}
                    className={`cases-row${i === sel ? " cases-row--sel" : ""}${c.status === "new" ? " cases-row--new" : ""}`}
                    onClick={() => open(c.id)}
                    onMouseEnter={() => setSel(i)}
                  >
                    <td className="cases-table__sla" data-label="">
                      <span className={`sla-dot sla-dot--${c.sla ?? "none"}`} title={c.sla ? SLA_META[c.sla].label : ""} />
                    </td>
                    <td className="cases-row__main" data-label="Ärende">
                      <div className="cases-row__top">
                        <span className="cases-row__nr">{c.caseNumber}</span>
                        {c.lastDirection === "inbound" && c.status !== "new" && c.status !== "closed" && c.status !== "resolved" && (
                          <span className="cases-row__new-msg" title="Senaste meddelandet är från kunden">Kunden svarade</span>
                        )}
                      </div>
                      <div className="cases-row__title">{c.title || "(Inget ämne)"}</div>
                      {c.preview && <div className="cases-row__preview">{c.preview}</div>}
                    </td>
                    <td data-label="Hyresgäst" className="cases-row__email">{c.kundEpost ?? <span className="ink-faint">—</span>}</td>
                    <td data-label="Status"><StatusPill status={c.status} def={statusDef.get(c.status)} /></td>
                    <td data-label="Prioritet"><PriorityTag p={c.priority} /></td>
                    <td data-label="Ansvarig" onClick={(e) => e.stopPropagation()}>
                      {c.ownerUserId ? (
                        <UserBadge id={c.ownerUserId} />
                      ) : (
                        <div className="cases-row__assign">
                          {me && <button className="btn btn--brand btn--sm" onClick={() => void assign(c.id, me)}>Tilldela mig</button>}
                          <select
                            className="input input--sm"
                            aria-label="Tilldela"
                            value=""
                            onChange={(e) => e.target.value && void assign(c.id, e.target.value)}
                          >
                            <option value="">Annan…</option>
                            {users.filter((u) => u.id !== me).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                          </select>
                        </div>
                      )}
                    </td>
                    <td data-label="SLA"><SlaBadge item={c} /></td>
                    <td data-label="Fastighet">
                      {c.fastighet || c.lagenhet ? (
                        <>
                          <div>{c.fastighet ?? ""}</div>
                          {c.lagenhet && <div className="ink-faint">{c.lagenhet}</div>}
                        </>
                      ) : <span className="ink-faint">Ej kopplad</span>}
                    </td>
                    <td data-label="Kategori">
                      {c.categoryLabel ? (
                        <>
                          <div>{c.categoryLabel}</div>
                          {c.subcategoryLabel && <div className="ink-faint">{c.subcategoryLabel}</div>}
                        </>
                      ) : <span className="ink-faint">—</span>}
                    </td>
                    <td data-label="Senaste" className="cases-row__time">{fmtDateTime(c.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {total > items.length && (
            <div className="cases__more ink-faint">Visar {items.length} av {total}. Förfina sökningen för att se fler.</div>
          )}
        </div>
      )}
      <p className="cases__hint ink-faint">Tangentbord: <kbd>/</kbd> sök · <kbd>j</kbd>/<kbd>k</kbd> flytta · <kbd>Enter</kbd> öppna · <kbd>t</kbd> tilldela mig</p>

      {creating && (
        <NewCaseDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); open(id); }}
        />
      )}
    </div>
  );
}

function NewCaseDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState("phone");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    if (!title.trim()) { setErr("Ange ett ämne."); return; }
    setBusy(true); setErr(null);
    try { onCreated(await caseCreate(title.trim(), channel, email.trim(), body)); }
    catch (e) { setErr(e instanceof DataError ? e.message : "Kunde inte skapa ärendet."); setBusy(false); }
  }
  return (
    <div className="overlay overlay--above overlay--center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="case-dialog" role="dialog" aria-modal="true" aria-label="Nytt ärende">
        <h2>Nytt ärende</h2>
        <label className="label" htmlFor="nc-title">Ämne</label>
        <input id="nc-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="T.ex. Internet fungerar inte" />
        <label className="label" htmlFor="nc-email">Kundens e-post (valfritt)</label>
        <input id="nc-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="namn@exempel.se" />
        <label className="label">Källa</label>
        <div className="chips">
          {[["phone", "Telefon"], ["internal", "Intern"], ["web", "Webb"]].map(([k, l]) => (
            <button key={k} type="button" className="chip" aria-pressed={channel === k} onClick={() => setChannel(k)}>{l}</button>
          ))}
        </div>
        <label className="label" htmlFor="nc-body">Anteckning (intern)</label>
        <textarea id="nc-body" className="input input--area" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Vad gäller det?" />
        {err && <div className="formfield__error">{err}</div>}
        <div className="case-dialog__actions">
          <button className="btn btn--ghost" onClick={onClose}>Avbryt</button>
          <button className="btn btn--brand" disabled={busy} onClick={() => void submit()}>{busy ? "Skapar…" : "Skapa ärende"}</button>
        </div>
      </div>
    </div>
  );
}
