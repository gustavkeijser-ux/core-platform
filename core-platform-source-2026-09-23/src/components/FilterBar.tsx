import { useMemo, useState } from "react";
import type { ObjectDef, FieldDef, RecordFilter, FilterOp } from "@/lib/data";

type Props = {
  objectDef: ObjectDef;
  filters: RecordFilter[];
  onChange: (f: RecordFilter[]) => void;
};

/** Systemkolumner som inte är fält men går att filtrera på */
const SYSTEMFALT: Array<{ key: string; label: string; typ: string }> = [
  { key: "__title",      label: "Namn",           typ: "text" },
  { key: "__status",     label: "Status",         typ: "select" },
  { key: "__updated_at", label: "Senast ändrad",  typ: "date" },
  { key: "__created_at", label: "Skapad",         typ: "date" },
];

/** Vilka operatorer som är meningsfulla för en fälttyp */
function operatorer(typ: string): Array<{ op: FilterOp; label: string }> {
  const tomhet: Array<{ op: FilterOp; label: string }> = [
    { op: "empty", label: "är tom" },
    { op: "not_empty", label: "är ifylld" },
  ];
  if (typ === "number" || typ === "currency" || typ === "percent") {
    return [
      { op: "eq", label: "=" }, { op: "neq", label: "≠" },
      { op: "gt", label: ">" }, { op: "gte", label: "≥" },
      { op: "lt", label: "<" }, { op: "lte", label: "≤" },
      { op: "between", label: "mellan" }, ...tomhet,
    ];
  }
  if (typ === "date" || typ === "datetime") {
    return [
      { op: "eq", label: "är" },
      { op: "gte", label: "från och med" },
      { op: "lte", label: "till och med" },
      { op: "between", label: "mellan" }, ...tomhet,
    ];
  }
  if (typ === "boolean") {
    return [{ op: "eq", label: "är" }, ...tomhet];
  }
  if (typ === "select") {
    return [
      { op: "eq", label: "är" }, { op: "neq", label: "är inte" },
      { op: "in", label: "är någon av" }, ...tomhet,
    ];
  }
  return [
    { op: "contains", label: "innehåller" },
    { op: "not_contains", label: "innehåller inte" },
    { op: "eq", label: "är exakt" },
    { op: "neq", label: "är inte" }, ...tomhet,
  ];
}

const UTAN_VARDE = new Set<FilterOp>(["empty", "not_empty"]);

export function FilterBar({ objectDef, filters, onChange }: Props) {
  const [open, setOpen] = useState(false);

  /** Alla filtrerbara fält: systemkolumner först, sedan objektets egna */
  const falt = useMemo(() => {
    const egna = objectDef.fields
      .filter((f) => f.visibility !== "hidden" && f.fieldType !== "json")
      .map((f) => ({ key: f.key, label: f.label, typ: f.fieldType as string, def: f as FieldDef }));
    return [
      ...SYSTEMFALT.map((s) => ({ ...s, def: undefined as FieldDef | undefined })),
      ...egna,
    ];
  }, [objectDef]);

  const faltFor = (key: string) => falt.find((f) => f.key === key);

  function lagg() {
    const forsta = falt[0];
    onChange([...filters, { field: forsta.key, op: operatorer(forsta.typ)[0].op, value: "" }]);
    setOpen(true);
  }

  function andra(i: number, patch: Partial<RecordFilter>) {
    onChange(filters.map((f, n) => {
      if (n !== i) return f;
      const nasta = { ...f, ...patch };
      // Byte av fält kan göra operatorn ogiltig
      if (patch.field) {
        const t = faltFor(patch.field)?.typ ?? "text";
        const giltiga = operatorer(t).map((o) => o.op);
        if (!giltiga.includes(nasta.op)) nasta.op = giltiga[0];
        nasta.value = "";
      }
      if (patch.op && UTAN_VARDE.has(patch.op)) nasta.value = undefined;
      return nasta;
    }));
  }

  function tabort(i: number) {
    onChange(filters.filter((_, n) => n !== i));
  }

  /** Värdefält anpassat efter fälttyp och operator */
  function VardeInput({ f, i }: { f: RecordFilter; i: number }) {
    if (UTAN_VARDE.has(f.op)) return null;
    const meta = faltFor(f.field);
    const typ = meta?.typ ?? "text";

    if (f.op === "between") {
      const par = Array.isArray(f.value) ? (f.value as string[]) : ["", ""];
      const inputTyp = typ === "number" ? "number" : "date";
      return (
        <div className="filt__par">
          <input
            className="input input--sm" type={inputTyp} value={par[0] ?? ""}
            onChange={(e) => andra(i, { value: [e.target.value, par[1] ?? ""] })}
          />
          <span className="filt__och">och</span>
          <input
            className="input input--sm" type={inputTyp} value={par[1] ?? ""}
            onChange={(e) => andra(i, { value: [par[0] ?? "", e.target.value] })}
          />
        </div>
      );
    }

    if (f.field === "__status") {
      return (
        <select className="input input--sm" value={String(f.value ?? "")}
                onChange={(e) => andra(i, { value: e.target.value })}>
          <option value="">Välj…</option>
          {objectDef.statuses.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      );
    }

    if (typ === "boolean") {
      return (
        <select className="input input--sm" value={String(f.value ?? "")}
                onChange={(e) => andra(i, { value: e.target.value })}>
          <option value="">Välj…</option>
          <option value="true">Ja</option>
          <option value="false">Nej</option>
        </select>
      );
    }

    if (typ === "select" && meta?.def?.options?.choices?.length) {
      return (
        <select className="input input--sm" value={String(f.value ?? "")}
                onChange={(e) => andra(i, { value: e.target.value })}>
          <option value="">Välj…</option>
          {meta.def.options.choices.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
      );
    }

    return (
      <input
        className="input input--sm"
        type={typ === "number" ? "number" : typ === "date" || typ === "datetime" ? "date" : "text"}
        placeholder="Värde"
        value={String(f.value ?? "")}
        onChange={(e) => andra(i, { value: e.target.value })}
      />
    );
  }

  const aktiva = filters.length;

  return (
    <div className="filt">
      <button
        className={`btn btn--ghost btn--sm${aktiva ? " btn--aktiv" : ""}`}
        onClick={() => (aktiva ? setOpen((o) => !o) : lagg())}
      >
        Filter{aktiva > 0 ? ` (${aktiva})` : ""}
      </button>

      {open && aktiva > 0 && (
        <div className="filt__panel">
          {filters.map((f, i) => {
            const meta = faltFor(f.field);
            const ops = operatorer(meta?.typ ?? "text");
            return (
              <div key={i} className="filt__rad">
                <span className="filt__logik">{i === 0 ? "Där" : "och"}</span>

                <select
                  className="input input--sm filt__falt"
                  value={f.field}
                  onChange={(e) => andra(i, { field: e.target.value })}
                >
                  {falt.map((x) => (
                    <option key={x.key} value={x.key}>{x.label}</option>
                  ))}
                </select>

                <select
                  className="input input--sm filt__op"
                  value={f.op}
                  onChange={(e) => andra(i, { op: e.target.value as FilterOp })}
                >
                  {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                </select>

                <VardeInput f={f} i={i} />

                <button
                  className="btn btn--ghost btn--sm btn--danger filt__bort"
                  onClick={() => tabort(i)}
                  title="Ta bort villkoret"
                >✕</button>
              </div>
            );
          })}

          <div className="filt__fot">
            <button className="btn btn--ghost btn--sm" onClick={lagg}>+ Villkor</button>
            <button className="btn btn--ghost btn--sm" onClick={() => { onChange([]); setOpen(false); }}>
              Rensa alla
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
