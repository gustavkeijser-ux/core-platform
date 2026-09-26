import type { FieldDef, FieldType } from "./data";
import { getUserName, useTenantUsers } from "./users";

/**
 * FÄLTREGISTRET
 *
 * Ett register, inte en switch-sats. Att lägga till en fälttyp är en post
 * här plus en rad i schemats CHECK-constraint. Ingen annan fil ändras.
 *
 * Varje typ har två sidor:
 *   format  — hur värdet visas i en lista eller på ett kort
 *   Input   — hur värdet redigeras
 *
 * Om en komponent någonstans i appen skriver `if (field.key === "...")`
 * har vylagret slutat vara metadatadrivet. Sådan logik hör hemma här,
 * uttryckt i termer av fälttyp.
 */

type Renderer = {
  format: (value: unknown, field: FieldDef) => string;
  /** Sant för fält som ska ligga i egen rad i formulär och på kort. */
  wide?: boolean;
  align?: "left" | "right";
};

const nf = (decimals = 0) =>
  new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

const text: Renderer = { format: (v) => String(v ?? "") };

/** Tolkar ett lagrat datum/tid-värde. Tål äldre format som "+00" (offset
 *  utan minuter), som Date annars inte förstår → "Invalid Date". */
export function parseDateValue(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  let s = String(v).trim();
  s = s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Datum → "ÅÅÅÅ-MM-DDTHH:MM" i lokal tid, för <input type="datetime-local">. */
function toLocalInput(v: unknown): string {
  const d = parseDateValue(v);
  if (!d) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export const RENDERERS: Record<FieldType, Renderer> = {
  text,
  phone: text,
  email: text,
  url: text,

  long_text: { ...text, wide: true },

  number: {
    align: "right",
    format: (v, f) => (v == null ? "" : nf(f.options.decimals ?? 0).format(Number(v))),
  },

  currency: {
    align: "right",
    format: (v, f) =>
      v == null
        ? ""
        : new Intl.NumberFormat("sv-SE", {
            style: "currency",
            currency: f.options.code ?? "SEK",
            maximumFractionDigits: 0,
          }).format(Number(v)),
  },

  percent: {
    align: "right",
    format: (v) => (v == null ? "" : `${nf(0).format(Number(v))} %`),
  },

  boolean: { format: (v) => (v ? "Ja" : "Nej") },

  date: {
    format: (v) => {
      const d = parseDateValue(v);
      return d
        ? d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" })
        : String(v ?? "");
    },
  },

  datetime: {
    format: (v) => {
      const d = parseDateValue(v);
      return d
        ? d.toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
        : String(v ?? "");
    },
  },

  select: {
    format: (v, f) =>
      f.options.choices?.find((c) => c.key === v)?.label ?? String(v ?? ""),
  },

  multi_select: {
    format: (v, f) => {
      if (!Array.isArray(v)) return "";
      return v
        .map((k) => f.options.choices?.find((c) => c.key === k)?.label ?? String(k))
        .join(", ");
    },
  },

  // Användarfält lagrar ett id men visas alltid med namn (från
  // användarcachen i users.tsx, som App fyller vid inloggning).
  user: { format: (v) => (v ? getUserName(String(v)) : "") },

  address: {
    wide: true,
    format: (v) => {
      if (!v || typeof v !== "object") return "";
      const a = v as Record<string, string>;
      return [a.street, a.postal_code, a.city].filter(Boolean).join(", ");
    },
  },

  json: { wide: true, format: (v) => (v ? JSON.stringify(v) : "") },
};

export const formatValue = (field: FieldDef, value: unknown): string =>
  RENDERERS[field.fieldType].format(value, field);

// -----------------------------------------------------------------------------

type InputProps = {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
};

/** Väljare för användarfält: visar namn, sparar id. */
function UserSelect({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const users = useTenantUsers();
  const cur = value ? String(value) : "";
  const known = !cur || users.some((u) => u.id === cur);
  return (
    <select id={id} className="input" value={cur} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Välj</option>
      {!known && <option value={cur}>{getUserName(cur)}</option>}
      {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );
}

export function FieldInput({ field, value, onChange, error }: InputProps) {
  const id = `f-${field.key}`;
  const t = field.fieldType;
  const wide = RENDERERS[t].wide;

  const control = () => {
    switch (t) {
      case "long_text":
        return (
          <textarea
            id={id} className="input input--area" rows={4}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
        );

      case "boolean":
        return (
          <label className="switch">
            <input
              id={id} type="checkbox" checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="switch__track" aria-hidden="true" />
            <span className="switch__label">{value ? "Ja" : "Nej"}</span>
          </label>
        );

      case "select":
        return (
          <select
            id={id} className="input"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">Välj</option>
            {field.options.choices?.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        );

      case "multi_select": {
        const selected: string[] = Array.isArray(value) ? value.map(String) : [];
        const toggle = (key: string) =>
          onChange(
            selected.includes(key)
              ? selected.filter((k) => k !== key)
              : [...selected, key]
          );

        // Fält med free_text har ingen fast lista. Kommaseparerad inmatning
        // är rätt här: värdena växer under drift och att kräva en
        // administratör för varje ny region vore fel.
        if (field.options.free_text || !field.options.choices) {
          return (
            <input
              id={id} className="input"
              value={selected.join(", ")}
              placeholder="Kommaseparerat"
              onChange={(e) =>
                onChange(
                  e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                )
              }
            />
          );
        }
        return (
          <div className="chips">
            {field.options.choices.map((c) => (
              <button
                key={c.key} type="button"
                className="chip" aria-pressed={selected.includes(c.key)}
                onClick={() => toggle(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
        );
      }

      case "number":
      case "currency":
      case "percent":
        return (
          <input
            id={id} className="input tnum" type="number"
            inputMode="decimal"
            min={field.options.min} max={field.options.max}
            step={field.options.decimals ? 10 ** -field.options.decimals : 1}
            value={value == null ? "" : String(value)}
            onChange={(e) =>
              onChange(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        );

      case "date":
        return (
          <input
            id={id} className="input" type="date"
            value={value ? String(value).slice(0, 10) : ""}
            onChange={(e) => onChange(e.target.value || null)}
          />
        );

      case "datetime":
        // Visas i lokal tid, sparas som UTC (ISO med Z).
        return (
          <input
            id={id} className="input" type="datetime-local"
            value={toLocalInput(value)}
            onChange={(e) => {
              const d = e.target.value ? new Date(e.target.value) : null;
              onChange(d && !isNaN(d.getTime()) ? d.toISOString() : null);
            }}
          />
        );

      case "user":
        return <UserSelect id={id} value={value} onChange={onChange} />;

      case "address":
      case "json":
        return (
          <textarea
            id={id} className="input input--area mono" rows={3}
            value={value ? JSON.stringify(value, null, 2) : ""}
            onChange={(e) => {
              try { onChange(JSON.parse(e.target.value || "null")); }
              catch { /* ofullständig JSON under inmatning, servern validerar */ }
            }}
          />
        );

      default:
        return (
          <input
            id={id} className="input"
            type={t === "email" ? "email" : t === "url" ? "url" : t === "phone" ? "tel" : "text"}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  };

  return (
    <div className={`formfield ${wide ? "formfield--wide" : ""}`}>
      <label className="label" htmlFor={id}>
        {field.label}
        {field.isRequired && <span className="req" aria-label="obligatoriskt"> *</span>}
      </label>
      {control()}
      {error
        ? <div className="formfield__error">{error}</div>
        : field.helpText && <div className="formfield__help">{field.helpText}</div>}
    </div>
  );
}
