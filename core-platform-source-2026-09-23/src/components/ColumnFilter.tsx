import { useEffect, useRef, useState } from "react";
import type { FieldDef, RecordFilter, FilterOp, StatusDef } from "@/lib/data";

type Props = {
  /** Fältnyckel, eller __status / __title för systemkolumner */
  field: string;
  label: string;
  /** Fälttyp — styr vilka operatorer och vilket värdefält som visas */
  typ: string;
  /** Val för select-fält, eller statusar för __status */
  val?: Array<{ key: string; label: string }>;
  /** Aktivt filter för just den här kolumnen, om något */
  aktivt?: RecordFilter;
  sortering?: "asc" | "desc" | null;
  onFilter: (f: RecordFilter | null) => void;
  onSortera: (dir: "asc" | "desc") => void;
};

function operatorer(typ: string): Array<{ op: FilterOp; label: string }> {
  const tom: Array<{ op: FilterOp; label: string }> = [
    { op: "empty", label: "är tom" },
    { op: "not_empty", label: "är ifylld" },
  ];
  if (typ === "number" || typ === "currency" || typ === "percent") {
    return [{ op: "eq", label: "=" }, { op: "neq", label: "≠" },
            { op: "gte", label: "≥" }, { op: "lte", label: "≤" },
            { op: "between", label: "mellan" }, ...tom];
  }
  if (typ === "date" || typ === "datetime") {
    return [{ op: "eq", label: "är" },
            { op: "gte", label: "från och med" },
            { op: "lte", label: "till och med" },
            { op: "between", label: "mellan" }, ...tom];
  }
  if (typ === "boolean") return [{ op: "eq", label: "är" }, ...tom];
  if (typ === "select") {
    return [{ op: "eq", label: "är" }, { op: "neq", label: "är inte" }, ...tom];
  }
  return [{ op: "contains", label: "innehåller" },
          { op: "eq", label: "är exakt" },
          { op: "not_contains", label: "innehåller inte" }, ...tom];
}

const UTAN_VARDE = new Set<FilterOp>(["empty", "not_empty"]);

export function ColumnFilter({
  field, label, typ, val, aktivt, sortering, onFilter, onSortera,
}: Props) {
  const [open, setOpen] = useState(false);
  const [op, setOp] = useState<FilterOp>(aktivt?.op ?? operatorer(typ)[0].op);
  const [v, setV] = useState<unknown>(aktivt?.value ?? "");
  const rot = useRef<HTMLDivElement>(null);

  // Håll lokalt läge i takt när filtret ändras utifrån, t.ex. via en sparad vy
  useEffect(() => {
    setOp(aktivt?.op ?? operatorer(typ)[0].op);
    setV(aktivt?.value ?? "");
  }, [aktivt, typ]);

  // Stäng vid klick utanför eller Escape
  useEffect(() => {
    if (!open) return;
    const utanfor = (e: MouseEvent) => {
      if (rot.current && !rot.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", utanfor);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", utanfor);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const ops = operatorer(typ);

  function anvand() {
    if (UTAN_VARDE.has(op)) { onFilter({ field, op }); setOpen(false); return; }
    const tomt = Array.isArray(v)
      ? (v as string[]).every((x) => !x)
      : String(v ?? "").trim() === "";
    onFilter(tomt ? null : { field, op, value: v });
    setOpen(false);
  }

  function rensa() { onFilter(null); setOpen(false); }

  function Varde() {
    if (UTAN_VARDE.has(op)) return null;

    if (op === "between") {
      const par = Array.isArray(v) ? (v as string[]) : ["", ""];
      const t = typ === "number" ? "number" : "date";
      return (
        <div className="kolf__par">
          <input className="input input--sm" type={t} value={par[0] ?? ""}
                 onChange={(e) => setV([e.target.value, par[1] ?? ""])} />
          <span className="kolf__och">och</span>
          <input className="input input--sm" type={t} value={par[1] ?? ""}
                 onChange={(e) => setV([par[0] ?? "", e.target.value])} />
        </div>
      );
    }

    if (val && val.length > 0) {
      return (
        <select className="input input--sm" value={String(v ?? "")}
                onChange={(e) => setV(e.target.value)} autoFocus>
          <option value="">Välj…</option>
          {val.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      );
    }

    if (typ === "boolean") {
      return (
        <select className="input input--sm" value={String(v ?? "")}
                onChange={(e) => setV(e.target.value)} autoFocus>
          <option value="">Välj…</option>
          <option value="true">Ja</option>
          <option value="false">Nej</option>
        </select>
      );
    }

    return (
      <input
        className="input input--sm" autoFocus
        type={typ === "number" ? "number"
             : typ === "date" || typ === "datetime" ? "date" : "text"}
        placeholder="Värde"
        value={String(v ?? "")}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") anvand(); }}
      />
    );
  }

  return (
    <div className="kolf" ref={rot}>
      <button
        className={`kolf__knapp${aktivt ? " kolf__knapp--aktiv" : ""}${sortering ? " kolf__knapp--sorterad" : ""}`}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={aktivt ? `Filtrerad på ${label}` : `Filtrera ${label}`}
        aria-label={`Filtrera ${label}`}
      >
        {sortering === "asc" ? "▲" : sortering === "desc" ? "▼" : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 1.5h8L6 5v3.5L4 7.5V5L1 1.5z" />
          </svg>
        )}
      </button>

      {open && (
        <div className="kolf__panel" onClick={(e) => e.stopPropagation()}>
          <div className="kolf__rubrik">{label}</div>

          <div className="kolf__sort">
            <button className="btn btn--ghost btn--sm" onClick={() => { onSortera("asc"); setOpen(false); }}>
              ▲ Stigande
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => { onSortera("desc"); setOpen(false); }}>
              ▼ Fallande
            </button>
          </div>

          <select className="input input--sm" value={op}
                  onChange={(e) => { setOp(e.target.value as FilterOp); setV(""); }}>
            {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>

          <Varde />

          <div className="kolf__fot">
            {aktivt && (
              <button className="btn btn--ghost btn--sm" onClick={rensa}>Rensa</button>
            )}
            <button className="btn btn--brand btn--sm" onClick={anvand}>Använd</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Hjälpare: plocka fram val för en kolumn */
export function kolumnVal(
  field: string, def?: FieldDef, statusar?: StatusDef[]
): Array<{ key: string; label: string }> | undefined {
  if (field === "__status") return statusar?.map((s) => ({ key: s.key, label: s.label }));
  return def?.options?.choices;
}
