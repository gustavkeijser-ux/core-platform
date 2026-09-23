import { useEffect, useRef, useState } from "react";
import type { ObjectDef, RecordRow } from "@/lib/data";
import { listRecords } from "@/lib/data";

type Props = {
  objects: ObjectDef[];
  onOpenRecord: (id: string) => void;
};

export function GlobalSearch({ objects, onOpenRecord }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(RecordRow & { _objectLabel: string })[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Stäng dropdown vid klick utanför
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  // Debounce-sök
  useEffect(() => {
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    setLoading(true);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const promises = objects.map(async (o) => {
          const res = await listRecords({ objectType: o.key, search: query.trim(), limit: 5, offset: 0 });
          return res.items.map((r) => ({ ...r, _objectLabel: o.labelSingular }));
        });
        const all = (await Promise.all(promises)).flat();
        if (!ctrl.signal.aborted) {
          setResults(all.slice(0, 12));
          setOpen(all.length > 0);
        }
      } catch {
        // noop
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query, objects]);

  return (
    <div className="global-search" ref={ref}>
      <div className="global-search__icon">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" />
        </svg>
      </div>
      <input
        className="global-search__input"
        placeholder="Sök i allt…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {loading && <div className="global-search__spinner" />}
      {open && results.length > 0 && (
        <div className="global-search__dropdown">
          {results.map((r) => (
            <button
              key={r.id}
              className="global-search__result"
              onClick={() => { onOpenRecord(r.id); setOpen(false); setQuery(""); }}
            >
              <span className="global-search__result-title">{r.title ?? "Namnlös post"}</span>
              <span className="global-search__result-type">{r._objectLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
