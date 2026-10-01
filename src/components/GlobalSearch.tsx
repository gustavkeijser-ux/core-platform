import { useEffect, useMemo, useRef, useState } from "react";
import type { ObjectDef, RecordRow } from "@/lib/data";
import { listRecords } from "@/lib/data";
import { StatusPill } from "./StatusPill";

type Props = {
  objects: ObjectDef[];
  onOpenRecord: (id: string) => void;
};

type Hit = RecordRow & { _def: ObjectDef };

/**
 * Global sök (⌘K / Ctrl+K) — samma mönster som förvaltarpanelen: en knapp
 * i toppfältet öppnar en dialog, träffarna grupperas per objekttyp, piltangenter
 * flyttar markeringen och Enter öppnar posten.
 */
export function GlobalSearch({ objects, onOpenRecord }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  // ⌘K / Ctrl+K öppnar var som helst i appen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
    else { setQuery(""); setHits([]); setActive(0); }
  }, [open]);

  // Debounce-sök i alla objekt.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setLoading(false); return; }
    setLoading(true);
    let aborted = false;
    const t = setTimeout(async () => {
      try {
        const per = await Promise.all(objects.map(async (o) => {
          try {
            const res = await listRecords({ objectType: o.key, search: q, limit: 4, offset: 0 });
            return res.items.map((r) => ({ ...r, _def: o }));
          } catch { return [] as Hit[]; }
        }));
        if (!aborted) { setHits(per.flat()); setActive(0); }
      } finally {
        if (!aborted) setLoading(false);
      }
    }, 250);
    return () => { aborted = true; clearTimeout(t); };
  }, [query, objects]);

  const groups = useMemo(() => {
    const g: Array<{ def: ObjectDef; items: Hit[] }> = [];
    for (const h of hits) {
      const last = g.find((x) => x.def.key === h._def.key);
      if (last) last.items.push(h); else g.push({ def: h._def, items: [h] });
    }
    return g;
  }, [hits]);

  function pick(h: Hit | undefined) {
    if (!h) return;
    onOpenRecord(h.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") pick(hits[active]);
  }

  let idx = -1;
  return (
    <>
      <button className="gsearch-trigger" onClick={() => setOpen(true)} aria-label="Sök i allt" title="Sök i allt">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
        </svg>
        <span className="gsearch-trigger__label">Sök i allt</span>
        <kbd className="gsearch-trigger__kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>

      {open && (
        <div className="gsearch-scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="gsearch" role="dialog" aria-modal="true" aria-label="Global sök" onKeyDown={onKeyDown}>
            <div className="gsearch__head">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
              </svg>
              <input
                ref={inputRef}
                className="gsearch__input"
                placeholder="Sök kunder, fastigheter, affärer, ärenden…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="gsearch__esc" onClick={() => setOpen(false)}>ESC</button>
            </div>

            <div className="gsearch__body">
              {!query.trim() && <div className="gsearch__hint">Skriv för att söka i alla moduler.</div>}
              {query.trim() && loading && hits.length === 0 && <div className="gsearch__hint">Söker…</div>}
              {query.trim() && !loading && hits.length === 0 && <div className="gsearch__hint">Inga träffar på "{query.trim()}".</div>}
              {groups.map((g) => (
                <div key={g.def.key} className="gsearch__group">
                  <div className="gsearch__group-title">{g.def.labelPlural}</div>
                  {g.items.map((h) => {
                    idx += 1;
                    const i = idx;
                    return (
                      <button
                        key={h.id}
                        className="gsearch__hit"
                        aria-selected={i === active}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => pick(h)}
                      >
                        <span className="gsearch__hit-icon">{(h.title ?? "?").slice(0, 1).toUpperCase()}</span>
                        <span className="gsearch__hit-text">
                          <span className="gsearch__hit-title">{h.title ?? "Namnlös post"}</span>
                          <span className="gsearch__hit-sub">{g.def.labelSingular}</span>
                        </span>
                        {h.status && <StatusPill status={h.status} def={g.def.statuses.find((s) => s.key === h.status)} />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="gsearch__foot">
              <span><kbd>↑↓</kbd> navigera</span>
              <span><kbd>↵</kbd> öppna</span>
              <span className="gsearch__foot-right">Söker i alla moduler du har tillgång till</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
