import { useEffect, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

/**
 * Sidans egna åtgärder (sökfält, primärknapp) i toppfältets högra del —
 * samma uppbyggnad som förvaltarpanelen: rubrik till vänster, sök +
 * "Lägg till …" till höger. Toppfältet ligger i App, därför en portal.
 */
export function TopbarActions({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setEl(document.getElementById("topbar-actions")); }, []);
  return el ? createPortal(children, el) : null;
}

/** Sökfält med förstoringsglas (sidans egen sökning, inte den globala). */
export function SearchField({ value, onChange, placeholder, inputRef }: {
  value: string; onChange: (v: string) => void; placeholder: string; inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className="search-field">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
      </svg>
      <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && (
        <button type="button" className="search-field__clear" onClick={() => onChange("")} aria-label="Rensa sökning">×</button>
      )}
    </label>
  );
}

export const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

/** Filterpiller med antal: "Alla · 36", "Vakanta · 2" … */
export function FilterPills({ items, active, onSelect }: {
  items: Array<{ key: string; label: string; count?: number | null; color?: string | null }>;
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="filter-pills" role="tablist">
      {items.map((it) => (
        <button
          key={it.key || "__all"}
          type="button"
          role="tab"
          aria-selected={active === it.key}
          className="filter-pill"
          onClick={() => onSelect(it.key)}
        >
          {it.color && <span className="filter-pill__dot" style={{ background: it.color }} />}
          {it.label}
          {it.count != null && <span className="filter-pill__count">· {it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Sidnumrering som i panelen: "Visar 1–25 av 151" + numrerade sidor. */
export function Pager({ page, pageSize, total, unit, onPage }: {
  page: number; pageSize: number; total: number; unit: string; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const nums: Array<number | "…"> = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <div className="pager">
      <span className="pager__info">Visar {from}–{to} av {total} {unit}</span>
      {pages > 1 && (
        <div className="pager__pages">
          <button className="pager__btn" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Föregående sida">‹</button>
          {nums.map((n, i) => n === "…"
            ? <span key={"e" + i} className="pager__gap">…</span>
            : <button key={n} className="pager__btn" aria-current={n === page} onClick={() => onPage(n)}>{n + 1}</button>)}
          <button className="pager__btn" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Nästa sida">›</button>
        </div>
      )}
    </div>
  );
}

/** Tomt läge / tomt vid filtrering / fel — samma tre mönster som i panelen. */
export function EmptyState({ kind = "empty", title, text, action }: {
  kind?: "empty" | "filtered" | "error"; title: string; text?: string; action?: ReactNode;
}) {
  return (
    <div className={`state state--${kind}`}>
      <div className="state__icon">
        {kind === "filtered" ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></svg>
        ) : kind === "error" ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17" /></svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21h18" /><path d="M6 21V8l6-4 6 4v13" /><rect x="10" y="13" width="4" height="8" /></svg>
        )}
      </div>
      <div className="state__title">{title}</div>
      {text && <div className="state__text">{text}</div>}
      {action}
    </div>
  );
}

/** Skelettrader i stället för "Laddar…" — mindre hoppigt när tabeller laddas. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-label="Laddar" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton__row">
          <span className="skeleton__dot" />
          <span className="skeleton__bar" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
        </div>
      ))}
    </div>
  );
}
