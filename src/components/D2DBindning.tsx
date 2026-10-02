import type { FieldDef } from "@/lib/data";

/* =============================================================================
   Säljarvyn: bindningstid hos kundens nuvarande operatör (på alla besök där
   någon öppnade) och "varför inte mer än bredband" på sålda kunder.
   Fälten och alternativen styrs av fältdefinitionerna (bunden_till,
   bunden_tjanst, bunden_operator, ej_mer_anledning) och syns i rapporten
   Door to door → Utfall.
   ========================================================================== */

type Setter = (key: string, delayMs?: number) => (value: unknown) => void;

const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function Chips({ field, value, multi, onPick }: {
  field: FieldDef | undefined; value: unknown; multi: boolean; onPick: (next: unknown) => void;
}) {
  if (!field?.options.choices?.length) return null;
  const valda = multi ? lista(value) : [];
  return (
    <div className="d2d-reason-panel__chips">
      {field.options.choices.map((c) => {
        const vald = multi ? valda.includes(c.key) : value === c.key;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={vald}
            className={`d2d-reason-chip${vald ? " d2d-reason-chip--active" : ""}`}
            onClick={() => {
              if (multi) {
                const next = vald ? valda.filter((x) => x !== c.key) : [...valda, c.key];
                onPick(next.length ? next : null);
              } else onPick(vald ? null : c.key);
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/** Bindningstid: månad + tjänst + operatör. */
export function BindningPanel({ fields, data, set }: {
  fields: FieldDef[]; data: Record<string, unknown>; set: Setter;
}) {
  const f = (k: string) => fields.find((x) => x.key === k);
  if (!f("bunden_till")) return null;
  const manad = typeof data.bunden_till === "string" ? data.bunden_till.slice(0, 7) : "";
  // Äldre besök kan ha datumet i det gamla fritextfältet.
  const gammalt = !manad && typeof data.ej_intresserad_bindningstid === "string" ? data.ej_intresserad_bindningstid : "";
  return (
    <div className="d2d-reason-panel d2d-bindning">
      <span className="label">Bindningstid hos nuvarande operatör</span>
      <div className="d2d-bindning__rad">
        <label htmlFor="d2d-bunden-till" className="d2d-bindning__sub">Bunden till</label>
        <input
          id="d2d-bunden-till"
          className="input d2d-bindning__manad"
          type="month"
          value={manad}
          onChange={(e) => set("bunden_till", 0)(e.target.value || null)}
        />
        {manad && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => set("bunden_till", 0)(null)}>Rensa</button>
        )}
      </div>
      {gammalt && <span className="d2d-sold-panel__hint">Tidigare anteckning: {gammalt}</span>}
      <span className="d2d-bindning__sub">Vad är bundet?</span>
      <Chips field={f("bunden_tjanst")} value={data.bunden_tjanst} multi onPick={(v) => set("bunden_tjanst", 0)(v)} />
      <span className="d2d-bindning__sub">Operatör</span>
      <Chips field={f("bunden_operator")} value={data.bunden_operator} multi={false} onPick={(v) => set("bunden_operator", 0)(v)} />
    </div>
  );
}

/** Sålda kunder som bara tog bredband: varför inte mer? */
export function EjMerPanel({ fields, data, set }: {
  fields: FieldDef[]; data: Record<string, unknown>; set: Setter;
}) {
  const f = fields.find((x) => x.key === "ej_mer_anledning");
  if (!f) return null;
  return (
    <div className="d2d-sold-panel__group d2d-ejmer">
      <div className="d2d-sold-panel__head">
        <span className="d2d-sold-panel__title">Varför inte mer än bredband?</span>
      </div>
      <span className="d2d-sold-panel__hint">Välj en eller flera</span>
      <Chips field={f} value={data.ej_mer_anledning} multi onPick={(v) => set("ej_mer_anledning", 0)(v)} />
    </div>
  );
}
