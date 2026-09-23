import { useEffect, useMemo, useState } from "react";
import type { ObjectDef, RecordRow, ListView, RecordFilter } from "@/lib/data";
import { listRecords, deleteRecord, listSavedViews, saveListView, deleteListView, DataError, supabase } from "@/lib/data";
import { formatValue } from "@/lib/fields";
import { recordsToCsv, downloadCsv } from "@/lib/csv";
import { StatusPill } from "./StatusPill";
import { RecordDrawer } from "./RecordDrawer";
import { KanbanBoard } from "./KanbanBoard";
import { ColumnConfigPanel } from "./ColumnConfigPanel";
import { FilterBar } from "./FilterBar";
import { ColumnFilter, kolumnVal } from "./ColumnFilter";

type Props = {
  objectDef: ObjectDef;
  onOpenRecord: (id: string) => void;
  onMetadataChanged?: () => void;
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

export function ObjectListPage({ objectDef, onOpenRecord, onMetadataChanged }: Props) {
  const [mode, setMode] = useState<"list" | "kanban">("list");
  const [showColumns, setShowColumns] = useState(false);
  const [items, setItems] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [filters, setFilters] = useState<RecordFilter[]>([]);
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(
    () => DEFAULT_SORT[objectDef.key] ?? null
  );

  const [views, setViews] = useState<ListView[]>([]);
  const [activeViewId, setActiveViewId] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveShared, setSaveShared] = useState(false);

  const columns = useMemo(() => pickColumns(objectDef), [objectDef]);
  const hasStatuses = objectDef.statuses.length > 0;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await listRecords({
        objectType: objectDef.key,
        search: search || undefined,
        status: status || undefined,
        filters: filters.length ? filters : undefined,
        sort: sort ?? undefined,
        limit: mode === "kanban" ? KANBAN_LIMIT : PAGE_SIZE,
        offset: mode === "kanban" ? 0 : page * PAGE_SIZE,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte hämta listan.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Ny objekttyp: nollställ vyval och gå tillbaka till listläge.
    setMode("list"); setPage(0); setSearch(""); setStatus(""); setActiveViewId(""); setFilters([]);
    setSort(DEFAULT_SORT[objectDef.key] ?? null);
    listSavedViews(objectDef.key).then(setViews).catch(() => setViews([]));
    /* eslint-disable-next-line */
  }, [objectDef.key]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [objectDef.key, page, status, mode]);
  useEffect(() => { setPage(0); load(); /* eslint-disable-next-line */ }, [JSON.stringify(filters)]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [sort?.field, sort?.dir]);
  useEffect(() => {
    const t = setTimeout(() => { setPage(0); load(); }, 300);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [search]);

  /**
   * Live: lyssna på ändringar i records för den här objekttypen.
   * RLS gäller även på realtime-kanalen, så vi får bara notiser om rader
   * vi ändå hade fått läsa. Vi laddar om listan i stället för att patcha
   * den lokalt — sortering, filter och sidbrytning ska fortsätta stämma.
   */
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

  return (
    <div className="page">
      <div className="list-toolbar">
        <input
          className="input"
          placeholder={`Sök ${objectDef.labelPlural.toLowerCase()}…`}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setActiveViewId(""); }}
        />
        {hasStatuses && (
          <select
            className="input" style={{ maxWidth: 200 }} value={status}
            onChange={(e) => { setPage(0); setStatus(e.target.value); setActiveViewId(""); }}
          >
            <option value="">Alla statusar</option>
            {objectDef.statuses.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        )}

        <FilterBar
          objectDef={objectDef}
          filters={filters}
          onChange={(f) => { setFilters(f); setActiveViewId(""); }}
        />

        {views.length > 0 && (
          <select className="input" style={{ maxWidth: 200 }} value={activeViewId} onChange={(e) => applyView(e.target.value)}>
            <option value="">Sparade vyer…</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.is_shared ? " (delad)" : ""}</option>
            ))}
          </select>
        )}

        {(search || status || filters.length > 0) && (
          <button className="btn btn--ghost btn--sm" onClick={() => setShowSave((s) => !s)}>Spara vy</button>
        )}
        {canDeleteActiveView && (
          <button className="btn btn--ghost btn--sm" onClick={onDeleteView}>Ta bort vy</button>
        )}

        <div className="list-toolbar__spacer" />

        {liveCount > 0 && (
          <span className="live-dot" title={`${liveCount} uppdatering${liveCount === 1 ? "" : "ar"} sedan sidan öppnades`}>
            <span className="live-dot__pip" />
            Live
          </span>
        )}

        {hasStatuses && (
          <div className="view-toggle">
            <button className="view-toggle__btn" aria-current={mode === "list"} onClick={() => setMode("list")}>Lista</button>
            <button className="view-toggle__btn" aria-current={mode === "kanban"} onClick={() => setMode("kanban")}>Kanban</button>
          </div>
        )}

        {mode === "list" && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => setShowColumns(true)}
            title="Välj kolumner"
          >
            Kolumner
          </button>
        )}

        {items.length > 0 && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              const csv = recordsToCsv(objectDef.fields, items);
              downloadCsv(`${objectDef.key}_export.csv`, csv);
            }}
          >
            CSV-export
          </button>
        )}

        {objectDef.can.create && (
          <button className="btn btn--brand" onClick={() => setShowCreate(true)}>
            + Ny {objectDef.labelSingular.toLowerCase()}
          </button>
        )}
      </div>

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

      {error && <div className="card"><div className="empty-state">{error}</div></div>}

      {!error && mode === "kanban" && (
        loading
          ? <div className="card"><div className="empty-state">Laddar…</div></div>
          : <KanbanBoard objectDef={objectDef} records={items} onOpenRecord={onOpenRecord} onMoved={load} />
      )}

      {!error && mode === "list" && (
        <div className="card" style={{ padding: 0 }}>
          {loading && <div className="empty-state">Laddar…</div>}
          {!loading && items.length === 0 && (
            <div className="empty-state">Inga {objectDef.labelPlural.toLowerCase()} ännu.</div>
          )}
          {!loading && items.length > 0 && (
            <div className="rtable-scroll">
            <table className={`rtable${columns.length > 6 ? " rtable--wide" : ""}`}>
              <thead>
                <tr>
                  <th>
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
                  {hasStatuses && (
                    <th>
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
                  )}
                  {columns.map((c) => (
                    <th key={c.key}>
                      <span className="rtable__th">
                        <span className="rtable__th-label">{c.label}</span>
                        <ColumnFilter
                          field={c.key} label={c.label} typ={c.fieldType}
                          val={kolumnVal(c.key, c)}
                          aktivt={filterFor(c.key)} sortering={sortFor(c.key)}
                          onFilter={(f) => satKolumnfilter(c.key, f)}
                          onSortera={(dir) => setSort({ field: c.key, dir })}
                        />
                      </span>
                    </th>
                  ))}
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="rtable__row" onClick={() => onOpenRecord(r.id)}>
                    <td className="rtable__title">{r.title ?? "Namnlös post"}</td>
                    {hasStatuses && (
                      <td><StatusPill status={r.status} def={objectDef.statuses.find((s) => s.key === r.status)} /></td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key}>{formatValue(c, r.data[c.key])}</td>
                    ))}
                    <td>
                      {objectDef.can.delete && (
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

      {mode === "list" && total > PAGE_SIZE && (
        <div className="pagination">
          <span>{page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} av {total}</span>
          <button className="btn btn--ghost btn--sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Föregående</button>
          <button className="btn btn--ghost btn--sm" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Nästa</button>
        </div>
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
