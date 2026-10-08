import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ObjectDef, RecordRow, ListView, RecordFilter, FieldDef } from "@/lib/data";
import { listRecords, deleteRecord, listSavedViews, saveListView, deleteListView, bulkAssign, DataError, supabase } from "@/lib/data";
import { formatValue } from "@/lib/fields";
import { UserBadge, useTenantUsers } from "@/lib/users";
import { rememberRow, useReturnToRow, loadListState, saveListState } from "@/lib/returnRow";
import { recordsToCsv, downloadCsv } from "@/lib/csv";
import { StatusPill } from "./StatusPill";
import { RecordDrawer } from "./RecordDrawer";
import { KanbanBoard } from "./KanbanBoard";
import { LeveransKort } from "./LeveransKort";
import { LeveransAgareKort, hamtaAgareOversikt, agareFilter, INGEN_AGARE, type AgareGrupp } from "./LeveransAgareKort";
import { ColumnConfigPanel } from "./ColumnConfigPanel";
import { FilterBar } from "./FilterBar";
import { ColumnFilter, kolumnVal } from "./ColumnFilter";
import { TopbarActions, SearchField, PlusIcon, FilterPills, Pager, EmptyState, SkeletonRows } from "./PageChrome";
import { getStatusCounts, type StatusCounts } from "@/lib/statusCounts";
import { readRoute, navigate } from "@/lib/route";

type Props = {
  objectDef: ObjectDef;
  onOpenRecord: (id: string) => void;
  onMetadataChanged?: () => void;
  /** Ökas när en post sparats någon annanstans → ladda om listan utan att
   *  tappa sida, filter eller skrollläge. */
  reloadKey?: number;
  /** Fasta filter som alltid gäller (syns inte i filterpanelen), t.ex.
   *  "lägenheter i projekt X" i D2D. */
  baseFilters?: RecordFilter[];
  /** Eget sparat listläge per urval (t.ex. per D2D-projekt). */
  stateKeySuffix?: string;
  /** Antal per status för urvalet (annars hela objekttypen). */
  countsOverride?: StatusCounts | null;
  /** Rad överst på sidan, t.ex. "← Alla projekt · Gävle". */
  banner?: ReactNode;
  /** Anropas när data i listan ändrats (live eller efter tilldelning). */
  onDataChanged?: () => void;
  /** Bara dessa fält som kolumner, i den här ordningen (ingen titel/status-kolumn). */
  fastaKolumner?: string[];
  /** Väljarläge: bocka i poster (t.ex. leveranser som ska ingå i ett D2D-projekt).
   *  Raden växlar valet i stället för att öppna posten. */
  picker?: {
    valda: Set<string>;
    onVal: (rader: RecordRow[], valj: boolean) => void | Promise<void>;
    /** Text medan valet sparas, t.ex. "Lägger till 3 av 10…". */
    arbetar?: string | null;
    etikett?: string;
  };
};

type ListMode = "list" | "kanban" | "kort";

type SavedListState = {
  mode: ListMode; page: number; search: string; status: string;
  filters: RecordFilter[]; sort: { field: string; dir: "asc" | "desc" } | null; activeViewId: string;
  /** Kortvyn för leveranser: vald fastighetsägare ("" = översikten). */
  agare?: string;
};

const PAGE_SIZE = 25;
const KANBAN_LIMIT = 300;

/**
 * Standardsortering per objekttyp. Leveranser ska som standard visas i
 * stigande statusordning (0/1 ... 99, dvs "Signerat avtal" → "Avslutad")
 * i stället för senast uppdaterad — så flödet går att följa steg för steg.
 * Andra objekttyper faller tillbaka på befintligt beteende (ingen explicit
 * sortering → senast uppdaterad, fallande, sätts av list_records_filtered).
 */
const DEFAULT_SORT: Record<string, { field: string; dir: "asc" | "desc" }> = {
  delivery: { field: "status", dir: "asc" },
};

/**
 * Kolumner styrs av admin via ColumnConfigPanel, som sätter options._column
 * och options._column_order på fältdefinitionerna. Har ingen admin valt än
 * faller vi tillbaka på heuristiken: de tre första icke-breda fälten.
 */
function pickColumns(def: ObjectDef) {
  const visible = def.fields.filter((f) => f.visibility !== "hidden");

  // Ett uttryckligt val vinner över heuristiken — även för långa fält,
  // som annars aldrig hade platsat som kolumn.
  const chosen = visible.filter((f) => f.options._column === true);
  if (chosen.length > 0) {
    return [...chosen].sort(
      (a, b) => (a.options._column_order ?? 0) - (b.options._column_order ?? 0)
    );
  }

  return visible
    .filter((f) => f.fieldType !== "long_text" && f.fieldType !== "json")
    .slice(0, 3);
}

/**
 * Lång text i en tabellcell (t.ex. kommentarer): upp till tre rader syns
 * direkt. Får inte allt plats visas hela texten i en ruta när man hovrar
 * (eller fokuserar cellen med tangentbordet).
 */
function LangText({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ x: number; y: number; upp: boolean } | null>(null);
  if (!text || text === "—") return <>{text}</>;
  const visa = () => {
    const el = ref.current;
    if (!el || el.scrollHeight <= el.clientHeight + 1) return;
    const r = el.getBoundingClientRect();
    const upp = r.bottom + 220 > window.innerHeight;
    setPop({ x: Math.min(r.left, window.innerWidth - 380), y: upp ? r.top - 6 : r.bottom + 6, upp });
  };
  return (
    <div
      ref={ref}
      className="rtable__lang"
      tabIndex={0}
      onMouseEnter={visa}
      onMouseLeave={() => setPop(null)}
      onFocus={visa}
      onBlur={() => setPop(null)}
    >
      {text}
      {pop && createPortal(
        <div className={`rtable__pop${pop.upp ? " rtable__pop--upp" : ""}`} role="tooltip"
          style={{ left: Math.max(8, pop.x), top: pop.y }}>{text}</div>,
        document.body,
      )}
    </div>
  );
}

type Cell = { kind: "title" } | { kind: "status" } | { kind: "field"; field: FieldDef };

/**
 * Kolumnordningen i tabellen. Normalt: postens titel, status, sedan de
 * valda kolumnerna. Två undantag, båda styrda från fältdefinitionerna:
 *  - Är titelfältet (t.ex. "name") självt valt som kolumn visas det på sin
 *    plats i ordningen i stället för som fast första kolumn.
 *  - Har ett valt fält options._status_after = true hamnar statuskolumnen
 *    direkt efter det fältet i stället för tidigt.
 */
function columnLayout(def: ObjectDef, columns: FieldDef[]): Cell[] {
  const hasStatuses = def.statuses.length > 0;
  const titleAsColumn = columns.some((c) => c.key === def.titleField);
  const statusAfter = columns.find((c) => c.options._status_after === true);
  const out: Cell[] = [];
  if (!titleAsColumn) out.push({ kind: "title" });
  if (hasStatuses && !statusAfter) out.push({ kind: "status" });
  for (const c of columns) {
    out.push({ kind: "field", field: c });
    if (hasStatuses && statusAfter && c.key === statusAfter.key) out.push({ kind: "status" });
  }
  return out;
}

export function ObjectListPage({ objectDef, onOpenRecord, onMetadataChanged, reloadKey, baseFilters, stateKeySuffix, countsOverride, banner, onDataChanged, fastaKolumner, picker }: Props) {
  // Listans läge (sida, sök, filter, sortering, vy) sparas per objekttyp så
  // man kommer tillbaka till exakt samma läge efter menybyte/omladdning.
  const stateKey = `list:${objectDef.key}${stateKeySuffix ?? ""}`;
  const [saved] = useState(() => loadListState<SavedListState>(stateKey));
  // Leveranser har en kortvy (LeveransKort) som är standard; övriga typer lista/kanban.
  const harKort = objectDef.key === "delivery" && !picker;
  const [modeState, setMode] = useState<ListMode>(saved.mode ?? (harKort ? "kort" : "list"));
  const mode: ListMode = picker ? "list" : modeState === "kort" && !harKort ? "list" : modeState;
  const [showColumns, setShowColumns] = useState(false);
  const [items, setItems] = useState<RecordRow[]>([]);
  // Kortvyn: först ett kort per fastighetsägare, sedan ägarens leveranser.
  const [agare, setAgare] = useState<string>(saved.agare ?? "");
  const [grupper, setGrupper] = useState<AgareGrupp[]>([]);
  const visarAgare = mode === "kort" && !agare;
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(saved.page ?? 0);
  const [search, setSearch] = useState(saved.search ?? "");
  const [status, setStatus] = useState(saved.status ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "?ny=1" i adressen (t.ex. från Översiktens snabbåtgärder) öppnar
  // skapa-dialogen direkt.
  const [showCreate, setShowCreate] = useState(() => readRoute().query.get("ny") === "1");
  useEffect(() => {
    if (readRoute().query.get("ny") === "1") navigate(readRoute().segs, {}, true);
  }, []);
  const [liveCount, setLiveCount] = useState(0);
  const [filters, setFilters] = useState<RecordFilter[]>(saved.filters ?? []);
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(
    () => (saved.sort !== undefined ? saved.sort : DEFAULT_SORT[objectDef.key] ?? null)
  );

  const [views, setViews] = useState<ListView[]>([]);
  const [activeViewId, setActiveViewId] = useState(saved.activeViewId ?? "");
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveShared, setSaveShared] = useState(false);

  // Antal per status till filterpillren.
  const [globalCounts, setCounts] = useState<StatusCounts | null>(null);
  const counts = countsOverride !== undefined ? countsOverride : globalCounts;
  const countsTick = useRef(0);
  useEffect(() => {
    let on = true;
    getStatusCounts(objectDef.key, countsTick.current++ > 0).then((c) => { if (on) setCounts(c); });
    return () => { on = false; };
  }, [objectDef.key, liveCount, reloadKey]);

  const allFilters = useMemo(() => [...(baseFilters ?? []), ...filters], [baseFilters, filters]);
  const fastaKey = fastaKolumner?.join(",") ?? "";
  const columns = useMemo(() => fastaKolumner
    ? fastaKolumner.map((k) => objectDef.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f)
    : pickColumns(objectDef),
    /* eslint-disable-next-line */
    [objectDef, fastaKey]);
  const layout = useMemo<Cell[]>(() => fastaKolumner
    ? columns.map((field) => ({ kind: "field" as const, field }))
    : columnLayout(objectDef, columns),
    /* eslint-disable-next-line */
    [objectDef, columns, fastaKey]);
  const hasStatuses = objectDef.statuses.length > 0;

  // ── Ägarfält + uppföljningsdatum (styrs av fältoptioner, t.ex. Affärer:
  // Säljare = owner_field, Nästa steg datum = _overdue).
  const ownerField = objectDef.fields.find((f) => f.fieldType === "user" && f.options.owner_field);
  // Koncernmoder: ledningen delar ut till säljare → affär skapas automatiskt.
  const isKm = objectDef.key === "koncernmoder";
  const dueField = objectDef.fields.find((f) => (f.fieldType === "date" || f.fieldType === "datetime") && f.options._overdue);
  const terminalStatuses = useMemo(
    () => new Set(objectDef.statuses.filter((s) => s.isTerminal).map((s) => s.key)),
    [objectDef.statuses]
  );
  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (r: RecordRow) => {
    if (!dueField || (r.status && terminalStatuses.has(r.status))) return false;
    const v = r.data[dueField.key];
    return !!v && String(v).slice(0, 10) < today;
  };

  const [myId, setMyId] = useState<string | null>(null);
  useEffect(() => { supabase.auth.getSession().then(({ data }) => setMyId(data.session?.user.id ?? null)); }, []);

  type Quick = { key: string; label: string; filter: RecordFilter };
  const quickFilters: Quick[] = [
    ...(ownerField && myId ? [{ key: "mine", label: "Mina", filter: { field: ownerField.key, op: "eq" as const, value: myId } }] : []),
    ...(ownerField ? [{ key: "unassigned", label: "Ej tilldelade", filter: { field: ownerField.key, op: "empty" as const } }] : []),
    ...(dueField ? [
      { key: "overdue", label: "Försenade", filter: { field: dueField.key, op: "lt" as const, value: today } },
      { key: "today", label: "Idag", filter: { field: dueField.key, op: "eq" as const, value: today } },
      { key: "nodate", label: `Utan ${dueField.label.toLowerCase()}`, filter: { field: dueField.key, op: "empty" as const } },
    ] : []),
  ];
  const quickActive = (q: Quick) => filters.some((f) => f.field === q.filter.field && f.op === q.filter.op && String(f.value ?? "") === String(q.filter.value ?? ""));
  function toggleQuick(q: Quick) {
    setActiveViewId("");
    setFilters((prev) => {
      const without = prev.filter((f) => f.field !== q.filter.field);
      return quickActive(q) ? without : [...without, q.filter];
    });
  }

  // ── Markera + tilldela (bara för den som får ta bort/ändra allt — i
  // praktiken chef/admin; servern kontrollerar ändå behörigheten).
  const canAssign = !picker && !!ownerField && objectDef.can.delete;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignUsers, setAssignUsers] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);
  const users = useTenantUsers();
  useEffect(() => { setSelected(new Set()); setAllMatching(false); }, [objectDef.key, JSON.stringify(filters), search, status]);
  const toggleRow = (id: string) => setSelected((prev) => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); setAllMatching(false); return n;
  });
  const pageAllSelected = items.length > 0 && items.every((r) => selected.has(r.id));
  const togglePage = () => setSelected((prev) => {
    const n = new Set(prev);
    if (pageAllSelected) items.forEach((r) => n.delete(r.id)); else items.forEach((r) => n.add(r.id));
    setAllMatching(false);
    return n;
  });
  const selectedCount = allMatching ? total : selected.size;

  /** Alla poster som matchar aktuellt sök/filter/sortering (sidvis om 200). */
  async function collectMatching(onProgress?: (n: number) => void): Promise<RecordRow[]> {
    const rows: RecordRow[] = [];
    const seen = new Set<string>();
    for (let offset = 0; ; offset += 200) {
      const res = await listRecords({
        objectType: objectDef.key, search: search || undefined, status: status || undefined,
        filters: allFilters.length ? allFilters : undefined, sort: sort ?? undefined, limit: 200, offset,
      });
      for (const r of res.items) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
      onProgress?.(rows.length);
      if (res.items.length < 200 || offset + 200 >= res.total) break;
    }
    return rows;
  }
  async function collectMatchingIds(): Promise<string[]> {
    return (await collectMatching()).map((r) => r.id);
  }

  const [exporting, setExporting] = useState<number | null>(null);
  async function runExport() {
    if (exporting !== null) return;
    setExporting(0);
    try {
      const rows = await collectMatching((n) => setExporting(n));
      const csv = recordsToCsv(objectDef.fields, rows);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`${objectDef.key}_export_${stamp}.csv`, csv);
    } catch (e) {
      alert(e instanceof DataError ? e.message : "Kunde inte exportera.");
    } finally {
      setExporting(null);
    }
  }

  async function runAssign() {
    if (!ownerField || assignUsers.length === 0) return;
    setAssigning(true);
    try {
      const ids = allMatching ? await collectMatchingIds() : Array.from(selected);
      const n = await bulkAssign(ids, assignUsers, ownerField.key);
      setAssignOpen(false); setAssignUsers([]); setSelected(new Set()); setAllMatching(false);
      await load();
      onDataChanged?.();
      alert(`${n} ${n === 1 ? objectDef.labelSingular.toLowerCase() : objectDef.labelPlural.toLowerCase()} ${assignUsers.length > 1 ? "fördelade" : "tilldelade"}.${isKm ? " Affärer med fastigheterna är skapade hos säljarna." : ""}`);
    } catch (e) {
      alert(e instanceof DataError ? e.message : "Kunde inte tilldela.");
    } finally {
      setAssigning(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      if (mode === "kort" && !agare) {
        const f: RecordFilter[] = [...allFilters];
        if (status) f.push({ field: "__status", op: "eq", value: status });
        const g = await hamtaAgareOversikt(search || undefined, f);
        setGrupper(g);
        setTotal(g.reduce((n, x) => n + x.antal, 0));
        return;
      }
      const lasFilter = mode === "kort" && agare ? [...allFilters, agareFilter(agare)] : allFilters;
      const res = await listRecords({
        objectType: objectDef.key,
        search: search || undefined,
        status: status || undefined,
        filters: lasFilter.length ? lasFilter : undefined,
        sort: sort ?? undefined,
        limit: mode === "kanban" ? KANBAN_LIMIT : PAGE_SIZE,
        offset: mode === "kanban" ? 0 : page * PAGE_SIZE,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof DataError || (e instanceof Error && visarAgare) ? (e as Error).message : "Kunde inte hämta listan.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    listSavedViews(objectDef.key).then(setViews).catch(() => setViews([]));
    /* eslint-disable-next-line */
  }, [objectDef.key]);

  // Spara läget varje gång det ändras.
  useEffect(() => {
    saveListState<SavedListState>(stateKey, { mode, page, search, status, filters, sort, activeViewId, agare });
  }, [stateKey, mode, page, search, status, filters, sort, activeViewId, agare]);

  // Första renderingen återställer ett sparat läge — då ska sidnumret
  // INTE nollställas av filter/sök-effekterna nedan.
  const firstRun = useRef(true);
  useEffect(() => { const t = setTimeout(() => { firstRun.current = false; }, 0); return () => clearTimeout(t); }, []);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [objectDef.key, page, status, mode, reloadKey, agare]);
  useEffect(() => { if (firstRun.current) return; setPage(0); load(); /* eslint-disable-next-line */ }, [JSON.stringify(filters)]);
  useEffect(() => { if (firstRun.current) return; load(); /* eslint-disable-next-line */ }, [sort?.field, sort?.dir]);
  useEffect(() => {
    if (firstRun.current) return;
    const t = setTimeout(() => { setPage(0); load(); }, 300);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [search]);

  // Tillbaka till raden man öppnade senast.
  const returnKey = `list:${objectDef.key}`;
  const returnRow = useReturnToRow(returnKey, !loading && (mode === "list" || mode === "kort"));
  const openRow = (id: string) => { rememberRow(returnKey, id); onOpenRecord(id); };

  /**
   * Live: lyssna på ändringar i records för den här objekttypen.
   * RLS gäller även på realtime-kanalen, så vi får bara notiser om rader
   * vi ändå hade fått läsa. Vi laddar om listan i stället för att patcha
   * den lokalt — sortering, filter och sidbrytning ska fortsätta stämma.
   */
  const onDataChangedRef = useRef(onDataChanged);
  onDataChangedRef.current = onDataChanged;
  useEffect(() => {
    const kanal = supabase
      .channel(`records:${objectDef.key}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "records",
          filter: `object_type=eq.${objectDef.key}`,
        },
        () => {
          setLiveCount((n) => n + 1);
          load();
          onDataChangedRef.current?.();
        }
      )
      .subscribe();

    return () => { void supabase.removeChannel(kanal); };
    /* eslint-disable-next-line */
  }, [objectDef.key]);

  function applyView(id: string) {
    setActiveViewId(id);
    const v = views.find((x) => x.id === id);
    setSearch(v?.filters.search ?? "");
    setStatus(v?.filters.status ?? "");
    setFilters(v?.filters.conditions ?? []);
    setPage(0);
  }

  async function onSaveView() {
    if (!saveName.trim()) return;
    try {
      const row = await saveListView(objectDef.key, saveName.trim(), {
        search: search || undefined,
        status: status || undefined,
        conditions: filters.length ? filters : undefined,
      }, saveShared);
      const next = await listSavedViews(objectDef.key);
      setViews(next);
      setActiveViewId(row.id);
      setShowSave(false);
      setSaveName(""); setSaveShared(false);
    } catch (e) {
      alert(e instanceof DataError ? e.message : "Kunde inte spara vyn.");
    }
  }

  async function onDeleteView() {
    if (!activeViewId) return;
    if (!confirm("Ta bort den sparade vyn?")) return;
    await deleteListView(activeViewId);
    setViews(await listSavedViews(objectDef.key));
    setActiveViewId("");
  }

  async function onDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Ta bort posten?")) return;
    try {
      await deleteRecord(id);
      load();
    } catch (e2) {
      alert(e2 instanceof DataError ? e2.message : "Kunde inte ta bort posten.");
    }
  }

  /** Sätt eller ta bort filtret för en enskild kolumn. Delar modell med FilterBar. */
  function satKolumnfilter(field: string, f: RecordFilter | null) {
    setActiveViewId("");
    setFilters((prev) => {
      const utan = prev.filter((x) => x.field !== field);
      return f ? [...utan, f] : utan;
    });
  }
  const filterFor = (field: string) => filters.find((f) => f.field === field);
  const sortFor = (field: string) =>
    sort && sort.field === field ? sort.dir : null;

  const activeView = views.find((v) => v.id === activeViewId);
  const canDeleteActiveView = !!activeView; // RLS/RPC redan begränsar till egna vyer

  const filtered = !!(search || status || filters.length > 0);
  const plural = objectDef.labelPlural.toLowerCase();
  const statusPills = hasStatuses ? [
    { key: "", label: "Alla", count: counts?.total ?? null },
    ...objectDef.statuses
      .filter((s) => !counts || (counts.byStatus[s.key] ?? 0) > 0 || s.key === status)
      .map((s) => ({
        key: s.key, label: s.label, count: counts ? counts.byStatus[s.key] ?? 0 : null,
        color: s.color ? (s.color.startsWith("#") ? s.color : `var(--hue-${s.color})`) : null,
      })),
  ] : [];

  return (
    <div className="page">
      {banner}
      {!picker && <TopbarActions>
        <SearchField
          value={search}
          placeholder={`Sök ${plural}…`}
          onChange={(v) => { setSearch(v); setActiveViewId(""); }}
        />
        {objectDef.can.create && (
          <button className="btn btn--brand" onClick={() => setShowCreate(true)}>
            <PlusIcon />
            <span className="btn__label">Ny {objectDef.labelSingular.toLowerCase()}</span>
          </button>
        )}
      </TopbarActions>}

      <div className="list-head">
        {hasStatuses
          ? <FilterPills items={statusPills} active={status} onSelect={(k) => { setPage(0); setStatus(k); setActiveViewId(""); }} />
          : <span className="list-head__count">{total} {plural}</span>}
        <div className="list-head__tools">
          {liveCount > 0 && (
            <span className="live-dot" title={`${liveCount} uppdatering${liveCount === 1 ? "" : "ar"} sedan sidan öppnades`}>
              <span className="live-dot__pip" />
              Live
            </span>
          )}
          {hasStatuses && !picker && (
            <div className="view-toggle">
              {harKort && <button className="view-toggle__btn" aria-current={mode === "kort"} onClick={() => setMode("kort")}>Kort</button>}
              <button className="view-toggle__btn" aria-current={mode === "list"} onClick={() => setMode("list")}>Lista</button>
              <button className="view-toggle__btn" aria-current={mode === "kanban"} onClick={() => setMode("kanban")}>Kanban</button>
            </div>
          )}
          {mode === "list" && !fastaKolumner && (
            <button className="btn btn--ghost btn--sm" onClick={() => setShowColumns(true)} title="Välj kolumner">
              Kolumner
            </button>
          )}
          {total > 0 && (
            <button
              className="btn btn--ghost btn--sm"
              disabled={exporting !== null}
              onClick={() => void runExport()}
              title={`Exporterar alla ${total} rader som matchar sök och filter`}
            >
              {exporting !== null ? `Exporterar… ${exporting}/${total}` : `Exportera (${total})`}
            </button>
          )}
        </div>
      </div>

      <div className="list-toolbar">
        {picker && (
          <SearchField
            value={search}
            placeholder={`Sök ${plural}…`}
            onChange={(v) => { setSearch(v); setActiveViewId(""); }}
          />
        )}
        {quickFilters.map((q) => (
          <button key={q.key} type="button" className="chip" aria-pressed={quickActive(q)} onClick={() => toggleQuick(q)}>
            {q.label}
          </button>
        ))}

        <FilterBar
          objectDef={objectDef}
          filters={filters}
          onChange={(f) => { setFilters(f); setActiveViewId(""); }}
        />

        {views.length > 0 && (
          <select className="input input--sm" style={{ maxWidth: 200 }} value={activeViewId} onChange={(e) => applyView(e.target.value)}>
            <option value="">Sparade vyer…</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.is_shared ? " (delad)" : ""}</option>
            ))}
          </select>
        )}

        {filtered && (
          <button className="btn btn--ghost btn--sm" onClick={() => setShowSave((s) => !s)}>Spara vy</button>
        )}
        {canDeleteActiveView && (
          <button className="btn btn--ghost btn--sm" onClick={onDeleteView}>Ta bort vy</button>
        )}
      </div>

      {canAssign && selectedCount === 0 && mode === "list" && items.length > 0 && (
        <label className="bulk-hint">
          <input type="checkbox" checked={false} onChange={togglePage} />
          {isKm ? `Markera ${plural} för att dela ut dem till säljare`
            : `Markera ${plural} för att byta ${ownerField!.label.toLowerCase()} på flera samtidigt`}
        </label>
      )}

      {canAssign && selectedCount > 0 && (
        <div className="bulk-bar card">
          <span className="bulk-bar__count">
            <strong>{selectedCount}</strong> markerade
            {!allMatching && pageAllSelected && total > items.length && (
              <button className="btn btn--ghost btn--sm" onClick={() => setAllMatching(true)}>
                Markera alla {total} träffar
              </button>
            )}
          </span>
          <button className="btn btn--brand btn--sm" onClick={() => setAssignOpen((o) => !o)}>
            {isKm ? "Dela ut till säljare" : `Byt ${ownerField!.label.toLowerCase()}`}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => { setSelected(new Set()); setAllMatching(false); }}>
            Avmarkera
          </button>
          {assignOpen && (
            <div className="bulk-bar__assign">
              <p className="formfield__help" style={{ margin: 0 }}>
                Välj en {ownerField!.label.toLowerCase()} för att ge hen alla, eller flera för att fördela jämnt.
                {isKm && " Varje koncernmoder hamnar i Affärer hos säljaren, tillsammans med sina fastigheter."}
              </p>
              <div className="chips">
                {users.map((u) => (
                  <button
                    key={u.id} type="button" className="chip"
                    aria-pressed={assignUsers.includes(u.id)}
                    onClick={() => setAssignUsers((p) => p.includes(u.id) ? p.filter((x) => x !== u.id) : [...p, u.id])}
                  >
                    {u.name}
                  </button>
                ))}
              </div>
              <button className="btn btn--brand btn--sm" disabled={assigning || assignUsers.length === 0} onClick={() => void runAssign()}>
                {assigning ? "Tilldelar…"
                  : assignUsers.length > 1 ? `Fördela ${selectedCount} på ${assignUsers.length} personer`
                  : `Byt till vald ${ownerField!.label.toLowerCase()} (${selectedCount})`}
              </button>
            </div>
          )}
        </div>
      )}

      {picker && (() => {
        const valdaHar = items.filter((r) => picker.valda.has(r.id)).length;
        return (
          <div className="bulk-bar card picker-bar">
            <span className="bulk-bar__count">
              <strong>{picker.valda.size}</strong> {picker.etikett ?? "valda"}
              {picker.arbetar && <span className="picker-bar__arbetar"> · {picker.arbetar}</span>}
            </span>
            {valdaHar < items.length && (
              <button className="btn btn--brand btn--sm" disabled={!!picker.arbetar}
                onClick={() => void picker.onVal(items.filter((r) => !picker.valda.has(r.id)), true)}>
                Välj alla på sidan ({items.length - valdaHar})
              </button>
            )}
            {filtered && total > items.length && (
              <button className="btn btn--ghost btn--sm" disabled={!!picker.arbetar}
                onClick={async () => {
                  const alla = await collectMatching();
                  const nya = alla.filter((r) => !picker.valda.has(r.id));
                  if (nya.length === 0) return;
                  if (!confirm(`Lägga till ${nya.length} ${plural} som matchar filtren?`)) return;
                  await picker.onVal(nya, true);
                }}>
                Välj alla {total} träffar
              </button>
            )}
            {valdaHar > 0 && (
              <button className="btn btn--ghost btn--sm" disabled={!!picker.arbetar}
                onClick={() => void picker.onVal(items.filter((r) => picker.valda.has(r.id)), false)}>
                Avmarkera sidan ({valdaHar})
              </button>
            )}
          </div>
        );
      })()}

      {showSave && (
        <div className="card save-view-row">
          <input className="input" placeholder="Namn på vyn" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          <label className="switch">
            <input type="checkbox" checked={saveShared} onChange={(e) => setSaveShared(e.target.checked)} />
            <span className="switch__track" />
            <span className="switch__label">Dela med hela teamet</span>
          </label>
          <button className="btn btn--brand btn--sm" onClick={onSaveView} disabled={!saveName.trim()}>Spara</button>
          <button className="btn btn--ghost btn--sm" onClick={() => setShowSave(false)}>Avbryt</button>
        </div>
      )}

      {error && (
        <div className="card">
          <EmptyState kind="error" title="Kunde inte hämta listan" text={error}
            action={<button className="btn btn--danger btn--sm" onClick={() => void load()}>Försök igen</button>} />
        </div>
      )}

      {!error && mode === "kanban" && (
        loading
          ? <div className="card"><SkeletonRows /></div>
          : <KanbanBoard objectDef={objectDef} records={items} onOpenRecord={onOpenRecord} onMoved={load} />
      )}

      {!error && mode === "list" && (
        <div className="card" style={{ padding: 0 }}>
          {loading && items.length === 0 && <SkeletonRows />}
          {!loading && items.length === 0 && (filtered ? (
            <EmptyState kind="filtered" title="Inga träffar"
              text={search ? `Inget matchar "${search}". Prova ett bredare sökord eller rensa filtren.` : "Inget matchar filtren. Rensa dem för att se alla."}
              action={<button className="btn btn--ghost btn--sm" onClick={() => { setSearch(""); setStatus(""); setFilters([]); setActiveViewId(""); }}>Rensa filter</button>} />
          ) : (
            <EmptyState title={`Inga ${plural} än`}
              text={`Lägg till den första för att komma igång.`}
              action={objectDef.can.create && !picker ? <button className="btn btn--brand btn--sm" onClick={() => setShowCreate(true)}><PlusIcon /> Ny {objectDef.labelSingular.toLowerCase()}</button> : undefined} />
          ))}
          {items.length > 0 && (
            <div className={`rtable-scroll${loading ? " is-loading" : ""}`}>
            <table className={`rtable${columns.length > 6 ? " rtable--wide" : ""}`}>
              <thead>
                <tr>
                  {canAssign && (
                    <th className="rtable__select">
                      <input type="checkbox" aria-label="Markera alla på sidan" checked={pageAllSelected} onChange={togglePage} />
                    </th>
                  )}
                  {picker && (() => {
                    const alla = items.length > 0 && items.every((r) => picker.valda.has(r.id));
                    return (
                      <th className="rtable__select">
                        <input type="checkbox" aria-label="Välj alla på sidan" checked={alla} disabled={!!picker.arbetar}
                          onChange={() => void picker.onVal(alla ? items : items.filter((r) => !picker.valda.has(r.id)), !alla)} />
                      </th>
                    );
                  })()}
                  {layout.map((cell) => {
                    if (cell.kind === "title") return (
                      <th key="__title">
                        <span className="rtable__th">
                          <span className="rtable__th-label">{objectDef.labelSingular}</span>
                          <ColumnFilter
                            field="__title" label={objectDef.labelSingular} typ="text"
                            aktivt={filterFor("__title")} sortering={sortFor("title")}
                            onFilter={(f) => satKolumnfilter("__title", f)}
                            onSortera={(dir) => setSort({ field: "title", dir })}
                          />
                        </span>
                      </th>
                    );
                    if (cell.kind === "status") return (
                      <th key="__status">
                        <span className="rtable__th">
                          <span className="rtable__th-label">Status</span>
                          <ColumnFilter
                            field="__status" label="Status" typ="select"
                            val={kolumnVal("__status", undefined, objectDef.statuses)}
                            aktivt={filterFor("__status")} sortering={sortFor("status")}
                            onFilter={(f) => satKolumnfilter("__status", f)}
                            onSortera={(dir) => setSort({ field: "status", dir })}
                          />
                        </span>
                      </th>
                    );
                    const c = cell.field;
                    return (
                      <th key={c.key}>
                        <span className="rtable__th">
                          <span className="rtable__th-label">{c.label}</span>
                          <ColumnFilter
                            field={c.key} label={c.label} typ={c.fieldType}
                            val={kolumnVal(c.key, c, undefined, users)}
                            aktivt={filterFor(c.key)} sortering={sortFor(c.key)}
                            onFilter={(f) => satKolumnfilter(c.key, f)}
                            onSortera={(dir) => setSort({ field: c.key, dir })}
                          />
                        </span>
                      </th>
                    );
                  })}
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr
                    key={r.id}
                    className={`rtable__row${isOverdue(r) ? " rtable__row--overdue" : ""}${selected.has(r.id) || allMatching || picker?.valda.has(r.id) ? " rtable__row--selected" : ""}`}
                    {...returnRow(r.id)}
                    onClick={() => {
                      if (picker) { if (!picker.arbetar) void picker.onVal([r], !picker.valda.has(r.id)); }
                      else openRow(r.id);
                    }}
                  >
                    {picker && (
                      <td className="rtable__select" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Välj ${r.title ?? "post"}`}
                          checked={picker.valda.has(r.id)}
                          disabled={!!picker.arbetar}
                          onChange={() => void picker.onVal([r], !picker.valda.has(r.id))}
                        />
                      </td>
                    )}
                    {canAssign && (
                      <td className="rtable__select" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Markera ${r.title ?? "post"}`}
                          checked={allMatching || selected.has(r.id)}
                          onChange={() => toggleRow(r.id)}
                        />
                      </td>
                    )}
                    {layout.map((cell) => {
                      if (cell.kind === "title") return <td key="__title" className="rtable__title" data-label={objectDef.labelSingular}>{r.title ?? "Namnlös post"}</td>;
                      if (cell.kind === "status") return (
                        <td key="__status" data-label="Status"><StatusPill status={r.status} def={objectDef.statuses.find((s) => s.key === r.status)} /></td>
                      );
                      const c = cell.field;
                      return (
                        <td
                          key={c.key}
                          className={[
                            c.key === objectDef.titleField ? "rtable__title" : "",
                            dueField && c.key === dueField.key && isOverdue(r) ? "rtable__cell--overdue" : "",
                          ].filter(Boolean).join(" ") || undefined}
                          data-label={c.label}
                        >
                          {c.fieldType === "user" ? <UserBadge id={r.data[c.key] as string | null} />
                            : c.fieldType === "long_text" ? <LangText text={formatValue(c, r.data[c.key])} />
                            : formatValue(c, r.data[c.key])}
                        </td>
                      );
                    })}
                    <td className="rtable__actions">
                      {objectDef.can.delete && !picker && (
                        <button className="btn btn--ghost btn--sm" onClick={(e) => onDelete(r.id, e)}>Ta bort</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {!error && visarAgare && (
        loading && grupper.length === 0
          ? <div className="card"><SkeletonRows /></div>
          : grupper.length === 0
            ? <div className="card"><EmptyState kind={filtered ? "filtered" : undefined} title={filtered ? "Inga träffar" : `Inga ${plural} än`}
                text={filtered ? "Inget matchar sökningen eller filtren. Rensa dem för att se alla." : "Lägg till den första för att komma igång."} /></div>
            : <LeveransAgareKort
                objectDef={objectDef}
                grupper={grupper}
                loading={loading}
                onOpen={(a) => { setItems([]); setTotal(0); setPage(0); setAgare(a); window.scrollTo({ top: 0 }); }}
              />
      )}

      {!error && mode === "kort" && agare && (
        <div className="lev-agare-rubrik">
          <button className="btn btn--ghost btn--sm" onClick={() => { setPage(0); setAgare(""); }}>← Alla fastighetsägare</button>
          <h2 className="lev-agare-rubrik__titel">{agare === INGEN_AGARE ? "Ingen fastighetsägare" : agare}</h2>
          {!loading && <span className="lev-agare-rubrik__antal">{total} {total === 1 ? "fastighet" : "fastigheter"}</span>}
        </div>
      )}

      {!error && mode === "kort" && agare && (
        loading && items.length === 0
          ? <div className="card"><SkeletonRows /></div>
          : items.length === 0
            ? <div className="card"><EmptyState kind={filtered ? "filtered" : undefined} title={filtered ? "Inga träffar" : `Inga ${plural} än`}
                text={filtered ? "Inget matchar sökningen eller filtren. Rensa dem för att se alla." : "Lägg till den första för att komma igång."} /></div>
            : <LeveransKort
                objectDef={objectDef}
                items={items}
                loading={loading}
                onOpen={openRow}
                onDelete={objectDef.can.delete ? onDelete : undefined}
                returnRow={returnRow}
              />
      )}

      {(mode === "list" || (mode === "kort" && !!agare)) && !error && total > 0 && (
        <Pager page={page} pageSize={PAGE_SIZE} total={total} unit={plural} onPage={setPage} />
      )}

      {showCreate && (
        <RecordDrawer
          objectDef={objectDef}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); load(); }}
        />
      )}

      {showColumns && (
        <ColumnConfigPanel
          objectDef={objectDef}
          onClose={() => setShowColumns(false)}
          onChanged={() => { if (onMetadataChanged) onMetadataChanged(); }}
        />
      )}
    </div>
  );
}
