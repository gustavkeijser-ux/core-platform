import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TopbarActions, SearchField, PlusIcon } from "./PageChrome";
import type { StatusDef } from "@/lib/data";
import { DataError } from "@/lib/data";
import {
  type ArendeFilter, type CaseCategory, type CaseCounts, type CaseFilter, type CaseListItem,
  PRIORITIES, SLA_META, assignableUsers, caseCategories, caseSet, listArenden, priorityLabel, relTime,
} from "@/lib/cases";
import { StatusPill } from "./StatusPill";
import { getUserName, useUserName } from "@/lib/users";
import { loadListState, rememberRow, saveListState, useReturnToRow } from "@/lib/returnRow";
import { supabase } from "@/integrations/supabase/client";

/**
 * Ärendelistan (Fas 3, skiss "Ärendelista"): färdiga vyer som flikar med
 * antal, kombinerbara filter, masshantering och sidvis visning. Sök, filter
 * och sortering körs på servern och listan visar bara ärenden man får se.
 * Tangentbord: "/" söker, j/k flyttar markeringen, Enter öppnar, "t" tar
 * markerat ärende.
 */

const VYER: Array<{ key: CaseFilter; label: string }> = [
  { key: "open", label: "Alla" },
  { key: "mine", label: "Mina ärenden" },
  { key: "new", label: "Nya" },
  { key: "overdue", label: "Försenade" },
  { key: "waiting", label: "Väntar på svar" },
  { key: "unassigned", label: "Ej tilldelade" },
  { key: "felanmalan", label: "Felanmälningar" },
  { key: "closed", label: "Avslutade" },
];

const SORT: Array<{ key: NonNullable<ArendeFilter["sort"]>; label: string }> = [
  { key: "deadline", label: "deadline" },
  { key: "priority", label: "prioritet" },
  { key: "created", label: "senast skapade" },
  { key: "activity", label: "senaste aktivitet" },
];

const PER_SIDA = [25, 50, 100];

type Props = {
  filter: CaseFilter;
  statuses: StatusDef[];
  onFilter: (f: CaseFilter) => void;
  onOpenCase: (id: string) => void;
  onCreate?: () => void;
};

/* ── Små byggstenar som även används i ärendet och på översikten ───────── */

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

/** Prioritet: ikon + ord (status bärs aldrig av färg ensam). */
export function PriorityTag({ p }: { p: string }) {
  const k = p || "normal";
  return (
    <span className={`prio prio--${k}`}>
      {k === "urgent" || k === "critical" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3l10 18H2z" /><path d="M12 10v4" /><path d="M12 17.5v.01" />
        </svg>
      ) : k === "high" ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 19V5" /><path d="M6 11l6-6 6 6" />
        </svg>
      ) : (
        <span className="prio__dot" aria-hidden />
      )}
      {priorityLabel(k)}
    </span>
  );
}

/** Hur ärendet kom in — liten ikon med text som verktygstips. */
export function KanalIkon({ kanal }: { kanal: string | null | undefined }) {
  const t = kanal ?? "";
  const titel = { email: "E-post", phone: "Telefon", app: "App", web: "Webb", sms: "SMS", internal: "Internt", d2d: "Door to door (felanmälan)" }[t] ?? "Okänd kanal";
  return (
    <span className="kanal" title={titel} aria-label={titel}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {t === "email" ? <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6l8.5 7 8.5-7" /></>
          : t === "phone" ? <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
          : t === "app" || t === "sms" ? <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18h2" /></>
          : t === "web" ? <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>
          : t === "d2d" ? <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>
          : <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>}
      </svg>
    </span>
  );
}

/** Under "Väntar på Telia" står SLA-klockan still — ingen deadline att visa. */
export const PAUSAD = { text: "Pausad (Telia)", ton: "none" as const };

/** Deadline som text: "Försenad 2 d", "Idag 16:00", "Imorgon", "Fre 10 okt". */
export function deadlineText(iso: string | null | undefined, avslutad = false): { text: string; ton: "late" | "soon" | "ok" | "none" } {
  if (!iso) return { text: "—", ton: "none" };
  const d = new Date(iso);
  const nu = new Date();
  const kl = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  if (!avslutad && d < nu) {
    const min = Math.round((nu.getTime() - d.getTime()) / 60000);
    const t = min < 60 ? `${min} min` : min < 60 * 24 ? `${Math.round(min / 60)} t` : `${Math.round(min / 1440)} d`;
    return { text: `Försenad ${t}`, ton: "late" };
  }
  const dag = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dag(d) - dag(nu)) / 86400000);
  if (diff === 0) return { text: `Idag ${kl}`, ton: avslutad ? "ok" : "soon" };
  if (diff === 1) return { text: `Imorgon ${kl}`, ton: "ok" };
  const txt = d.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" }).replace(".", "");
  return { text: txt.charAt(0).toUpperCase() + txt.slice(1), ton: "ok" };
}

function Ansvarig({ id }: { id: string | null }) {
  const namn = useUserName(id);
  if (!id) return <span className="arl__ingen">Ej tilldelad</span>;
  const delar = namn.split(/\s+/);
  return <span title={namn}>{delar.length > 1 ? `${delar[0]} ${delar[delar.length - 1][0]}.` : namn}</span>;
}

/* ── Sidan ──────────────────────────────────────────────────────────────── */

export function CasesPage({ filter, statuses, onFilter, onOpenCase, onCreate }: Props) {
  const listKey = `cases:${filter}`;
  const saved = loadListState<{ search: string; f: ArendeFilter; perSida: number; tatt: boolean }>("cases");
  const [search, setSearch] = useState(saved.search ?? "");
  const [f, setF] = useState<ArendeFilter>(saved.f ?? {});
  const [perSida, setPerSida] = useState(saved.perSida ?? 50);
  const [tatt, setTatt] = useState(!!saved.tatt);
  const [sida, setSida] = useState(0);
  const [items, setItems] = useState<CaseListItem[]>([]);
  const [counts, setCounts] = useState<CaseCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [valda, setValda] = useState<Set<string>>(new Set());
  const [me, setMe] = useState<string | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [cats, setCats] = useState<CaseCategory[]>([]);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const returnRow = useReturnToRow(listKey, !loading);

  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)); }, []);
  useEffect(() => { assignableUsers().then(setUsers); caseCategories().then(setCats); }, []);
  useEffect(() => { saveListState("cases", { search, f, perSida, tatt }); }, [search, f, perSida, tatt]);
  useEffect(() => { setSida(0); setValda(new Set()); setSel(0); }, [filter, search, f, perSida]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await listArenden(filter, search, f, perSida, sida * perSida);
      setItems(res.items); setCounts(res.counts); setTotal(res.total); setError(null);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta ärenden.");
    } finally { setLoading(false); }
  }, [filter, search, f, perSida, sida]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, search]);

  // Nya mejl kommer in hela tiden — uppdatera tyst var 30:e sekund.
  useEffect(() => {
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const open = (id: string) => { rememberRow(listKey, id); onOpenCase(id); };

  async function massa(patch: Parameters<typeof caseSet>[1], ids = [...valda]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      for (const id of ids) await caseSet(id, patch);
      setValda(new Set());
      await load(true);
    } catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte uppdatera alla ärenden."); }
    finally { setBusy(false); }
  }

  // Tangentbord
  const keyMoved = useRef(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (typing) { if (e.key === "Escape") (t as HTMLInputElement).blur(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j") { e.preventDefault(); keyMoved.current = true; setSel((s) => Math.min(s + 1, items.length - 1)); }
      else if (e.key === "k") { e.preventDefault(); keyMoved.current = true; setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter" && items[sel]) { e.preventDefault(); open(items[sel].id); }
      else if (e.key === "t" && items[sel] && me) { e.preventDefault(); void massa({ ansvarig: me }, [items[sel].id]); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (!keyMoved.current) return;
    keyMoved.current = false;
    document.querySelector(`[data-case-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const statusDef = useMemo(() => new Map(statuses.map((s) => [s.key, s])), [statuses]);
  const huvudkat = cats.filter((c) => !c.parent_key);
  const antalFilter = [f.status, f.category, f.priority, f.owner].filter(Boolean).length;
  const allaValda = items.length > 0 && items.every((i) => valda.has(i.id));

  function toggla(id: string) {
    setValda((v) => { const n = new Set(v); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function exportera() {
    setBusy(true);
    try {
      const res = await listArenden(filter, search, f, 500, 0);
      const rader = [["Ärende", "Rubrik", "Status", "Prioritet", "Kategori", "Anmälare", "E-post", "Fastighet", "Lägenhet", "Ansvarig", "Deadline", "Skapat"]];
      for (const c of res.items) {
        rader.push([
          c.caseNumber ?? "", c.title ?? "", statusDef.get(c.status)?.label ?? c.status, priorityLabel(c.priority),
          c.categoryLabel ?? "", c.kundNamn ?? "", c.kundEpost ?? "", c.fastighet ?? "", c.lagenhet ?? "",
          c.ownerUserId ? getUserName(c.ownerUserId) : "", c.deadline ?? c.nextDue ?? "", c.createdAt,
        ]);
      }
      const csv = "﻿" + rader.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(";")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = `arenden-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof DataError ? e.message : "Kunde inte exportera."); }
    finally { setBusy(false); }
  }

  const sidor = Math.max(1, Math.ceil(total / perSida));
  const fran = total === 0 ? 0 : sida * perSida + 1;
  const till = Math.min(total, (sida + 1) * perSida);
  const sortLabel = SORT.find((s) => s.key === (f.sort ?? "deadline"))?.label ?? "deadline";

  return (
    <div className={`page arl${tatt ? " arl--tatt" : ""}`}>
      <TopbarActions>
        <SearchField
          inputRef={searchRef}
          value={search}
          onChange={setSearch}
          placeholder="Sök ärende, anmälare, adress, text …"
        />
        <button className="btn btn--ghost arl__export" onClick={() => void exportera()} disabled={busy}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" />
          </svg>
          <span className="btn__label">Exportera CSV</span>
        </button>
        {onCreate && (
          <button className="btn btn--brand" onClick={onCreate}>
            <PlusIcon /><span className="btn__label">Skapa ärende</span>
          </button>
        )}
      </TopbarActions>

      {/* Färdiga vyer med antal */}
      <div className="tab-bar arl__vyer" role="tablist">
        {VYER.map((v) => {
          const n = counts?.[v.key];
          return (
            <button key={v.key} role="tab" aria-selected={filter === v.key}
              className={`tab-bar__tab${filter === v.key ? " tab-bar__tab--active" : ""}`}
              onClick={() => onFilter(v.key)}>
              {v.label}
              {n != null && n > 0 && v.key !== "closed" && (
                <span className={`tab-bar__count${v.key === "overdue" ? " tab-bar__count--alert" : ""}`}>{n.toLocaleString("sv-SE")}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Kombinerbara filter */}
      <div className="arl__filter">
        <select className={`arl__val${f.status ? " arl__val--on" : ""}`} aria-label="Status" value={f.status ?? ""}
          onChange={(e) => setF({ ...f, status: e.target.value || undefined })}>
          <option value="">Status</option>
          {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className={`arl__val${f.category ? " arl__val--on" : ""}`} aria-label="Kategori" value={f.category ?? ""}
          onChange={(e) => setF({ ...f, category: e.target.value || undefined })}>
          <option value="">Kategori</option>
          {huvudkat.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select className={`arl__val${f.priority ? " arl__val--on" : ""}`} aria-label="Prioritet" value={f.priority ?? ""}
          onChange={(e) => setF({ ...f, priority: e.target.value || undefined })}>
          <option value="">Prioritet</option>
          {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select className={`arl__val${f.owner ? " arl__val--on" : ""}`} aria-label="Ansvarig" value={f.owner ?? ""}
          onChange={(e) => setF({ ...f, owner: e.target.value || undefined })}>
          <option value="">Ansvarig</option>
          <option value="me">Jag</option>
          <option value="none">Ej tilldelad</option>
          {users.filter((u) => u.id !== me).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="arl__val" aria-label="Sortering" value={f.sort ?? "deadline"}
          onChange={(e) => setF({ ...f, sort: e.target.value as ArendeFilter["sort"] })}>
          {SORT.map((s) => <option key={s.key} value={s.key}>Sortera: {s.label}</option>)}
        </select>
        {antalFilter > 0 && (
          <button className="linklike arl__rensa" onClick={() => setF({ sort: f.sort })}>Rensa filter ({antalFilter})</button>
        )}
        <label className="arl__tatt">
          <input type="checkbox" checked={tatt} onChange={(e) => setTatt(e.target.checked)} /> Tätt läge
        </label>
      </div>

      {/* Masshantering */}
      {valda.size > 0 && (
        <div className="arl__mass" role="region" aria-label="Masshantering">
          <strong>{valda.size} markerade</strong>
          <select className="arl__val" value="" disabled={busy} aria-label="Tilldela"
            onChange={(e) => { const v = e.target.value; if (v) void massa(v === "none" ? { unassign: true } : { ansvarig: v }); }}>
            <option value="">Tilldela</option>
            {me && <option value={me}>Mig</option>}
            {users.filter((u) => u.id !== me).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            <option value="none">Ta bort ansvarig</option>
          </select>
          <select className="arl__val" value="" disabled={busy} aria-label="Ändra status"
            onChange={(e) => e.target.value && void massa({ status: e.target.value })}>
            <option value="">Ändra status</option>
            {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select className="arl__val" value="" disabled={busy} aria-label="Kategorisera"
            onChange={(e) => e.target.value && void massa({ category: e.target.value })}>
            <option value="">Kategorisera</option>
            {huvudkat.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void massa({ status: "resolved" })}>Avsluta</button>
          <button className="linklike" onClick={() => setValda(new Set())}>Avmarkera</button>
        </div>
      )}

      {error && <div className="card"><div className="empty-state">{error}</div></div>}

      {!error && (
        <div className="card arl__kort">
          {loading && items.length === 0 ? (
            <div className="empty-state">Laddar…</div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              {search || antalFilter ? "Inga ärenden matchar sökningen och filtren."
                : filter === "unassigned" ? "Inga otilldelade ärenden. Snyggt!"
                : filter === "overdue" ? "Inga försenade ärenden."
                : "Inga ärenden här."}
            </div>
          ) : (
            <table className="arl__tabell">
              <thead>
                <tr>
                  <th className="arl__cb">
                    <input type="checkbox" aria-label="Markera alla" checked={allaValda}
                      onChange={() => setValda(allaValda ? new Set() : new Set(items.map((i) => i.id)))} />
                  </th>
                  <th>Prio</th>
                  <th>Ärende</th>
                  <th>Plats</th>
                  <th>Anmälare</th>
                  <th>Kategori</th>
                  <th>Ansvarig</th>
                  <th>Deadline</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c, i) => {
                  const avslutad = c.status === "resolved" || c.status === "closed";
                  const dl = c.status === "waiting_telia" ? PAUSAD : deadlineText(c.nextDue ?? c.deadline, avslutad);
                  const plats = [c.fastighet, c.lagenhet].filter(Boolean).join(" · ");
                  return (
                    <tr
                      key={c.id}
                      {...returnRow(c.id)}
                      data-case-idx={i}
                      className={`arl__rad${i === sel ? " arl__rad--sel" : ""}${valda.has(c.id) ? " arl__rad--vald" : ""}${c.status === "new" ? " arl__rad--ny" : ""}`}
                      onClick={() => open(c.id)}
                      onMouseEnter={() => setSel(i)}
                    >
                      <td className="arl__cb" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Markera ${c.caseNumber ?? ""}`} checked={valda.has(c.id)} onChange={() => toggla(c.id)} />
                      </td>
                      <td className="arl__prio" data-label="Prio"><PriorityTag p={c.priority} /></td>
                      <td className="arl__arende" data-label="Ärende">
                        <div className="arl__titel">
                          {c.title || "(Inget ämne)"}
                          {c.lastDirection === "inbound" && !avslutad && c.status !== "new" && (
                            <span className="arl__svar" title="Senaste meddelandet är från kunden">Nytt svar</span>
                          )}
                        </div>
                        <div className="arl__nr"><KanalIkon kanal={c.channel} /> {c.caseNumber}</div>
                      </td>
                      <td className="arl__plats" data-label="Plats">{plats || <span className="ink-faint">Ej kopplad</span>}</td>
                      <td className="arl__anm" data-label="Anmälare">{c.kundNamn ?? c.kundEpost ?? <span className="ink-faint">Okänd</span>}</td>
                      <td data-label="Kategori">{c.categoryLabel ?? <span className="ink-faint">—</span>}</td>
                      <td data-label="Ansvarig" onClick={(e) => e.stopPropagation()}>
                        {c.ownerUserId || !me || avslutad ? <Ansvarig id={c.ownerUserId} /> : (
                          <button className="arl__ta" onClick={() => void massa({ ansvarig: me }, [c.id])} title="Tilldela mig (t)">Ta ärendet</button>
                        )}
                      </td>
                      <td data-label="Deadline" className={`arl__dl arl__dl--${dl.ton}`}>
                        {dl.ton === "late" && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                          </svg>
                        )}
                        {dl.text}
                      </td>
                      <td data-label="Status"><StatusPill status={c.status} def={statusDef.get(c.status)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {total > 0 && (
            <div className="arl__fot">
              <span>Visar {fran}–{till} av {total.toLocaleString("sv-SE")} · sorterat på {sortLabel}</span>
              <span className="arl__sidor">
                <button className="arl__sida" disabled={sida === 0} onClick={() => setSida(sida - 1)} aria-label="Föregående sida">‹</button>
                {sidnummer(sida, sidor).map((n, k) => n < 0
                  ? <span key={`g${k}`} className="arl__gap">…</span>
                  : <button key={n} className="arl__sida" aria-current={n === sida} onClick={() => setSida(n)}>{n + 1}</button>)}
                <button className="arl__sida" disabled={sida >= sidor - 1} onClick={() => setSida(sida + 1)} aria-label="Nästa sida">›</button>
                <select className="arl__val" value={perSida} onChange={(e) => setPerSida(Number(e.target.value))} aria-label="Per sida">
                  {PER_SIDA.map((n) => <option key={n} value={n}>{n} per sida</option>)}
                </select>
              </span>
            </div>
          )}
        </div>
      )}
      <p className="arl__tips ink-faint">Röd deadline = försenad. Ikonen vid ärendenumret visar hur ärendet kom in. Tangentbord: <kbd>/</kbd> sök · <kbd>j</kbd>/<kbd>k</kbd> flytta · <kbd>Enter</kbd> öppna · <kbd>t</kbd> ta ärendet</p>
    </div>
  );
}

/** Sidnummer att visa: första, sista och några runt aktuell sida (-1 = lucka). */
function sidnummer(sida: number, sidor: number): number[] {
  if (sidor <= 7) return Array.from({ length: sidor }, (_, i) => i);
  const set = new Set([0, sidor - 1, sida - 1, sida, sida + 1].filter((n) => n >= 0 && n < sidor));
  const arr = [...set].sort((a, b) => a - b);
  const ut: number[] = [];
  arr.forEach((n, i) => { if (i > 0 && n - arr[i - 1] > 1) ut.push(-1); ut.push(n); });
  return ut;
}
