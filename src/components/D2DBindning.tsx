import type { FieldDef } from "@/lib/data";

/* =============================================================================
   Säljarvyn: "Vad är bundet?" — per tjänst anger säljaren när kundens
   bindning löper ut (år + månad) och vilken operatör kunden har för just den
   tjänsten. Sparas i bunden_per_tjanst:
     { "mobil": { "till": "2027-03", "operator": "telia" }, "tv": { … } }
   De äldre fälten bunden_tjanst (valda tjänster), bunden_till (tidigaste
   månaden) och bunden_operator (operatören på tjänsten som löper ut först)
   härleds vid varje ändring så rapporten Door to door → Utfall fungerar som
   förut. Tjänsterna kommer från fältet bunden_tjanst, operatörsnamnen från
   bunden_operator; vilka operatörer som visas per tjänst styrs här.
   "Varför inte mer än bredband" på sålda kunder ligger också här.
   ========================================================================== */

type Setter = (key: string, delayMs?: number) => (value: unknown) => void;
type Patch = (patch: Record<string, unknown>) => void;

const lista = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Vanliga operatörer per tjänst (nycklar ur fältet bunden_operator). */
const OPERATORER_PER_TJANST: Record<string, string[]> = {
  mobil:    ["fello", "vimla", "hallon", "comviq", "tre", "telenor", "tele2", "telia", "halebop"],
  bredband: ["ownit", "bredband2", "bahnhof", "telenor", "tele2", "telia"],
  tv:       ["sappa", "allente", "telenor", "telia", "tele2"],
  mbb:      ["comviq", "tre", "telenor", "tele2", "telia", "hallon"],
};

type Bindning = { till?: string | null; operator?: string | null };
type PerTjanst = Record<string, Bindning>;

/** Läser bunden_per_tjanst; saknas det byggs det av de gamla fälten. */
export function lasBindningar(data: Record<string, unknown>): PerTjanst {
  const raw = data.bunden_per_tjanst;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const ut: PerTjanst = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const b = v as Record<string, unknown>;
        ut[k] = {
          till: typeof b.till === "string" ? b.till.slice(0, 7) : null,
          operator: typeof b.operator === "string" ? b.operator : null,
        };
      } else ut[k] = {};
    }
    return ut;
  }
  const ut: PerTjanst = {};
  const till = typeof data.bunden_till === "string" ? data.bunden_till.slice(0, 7) : null;
  const operator = typeof data.bunden_operator === "string" ? data.bunden_operator : null;
  for (const t of lista(data.bunden_tjanst)) ut[t] = { till, operator };
  return ut;
}

/** Patch med det nya fältet och de härledda gamla. */
function tillPatch(per: PerTjanst): Record<string, unknown> {
  const tjanster = Object.keys(per);
  const medDatum = tjanster
    .map((t) => ({ t, till: per[t].till ?? "" }))
    .filter((x) => /^\d{4}-\d{2}$/.test(x.till))
    .sort((a, b) => a.till.localeCompare(b.till));
  const forst = medDatum[0]?.t ?? tjanster.find((t) => per[t].operator) ?? null;
  return {
    bunden_per_tjanst: tjanster.length ? per : null,
    bunden_tjanst: tjanster.length ? tjanster : null,
    bunden_till: medDatum[0]?.till ?? null,
    bunden_operator: forst ? (per[forst].operator ?? null) : null,
  };
}

function Chips({ field, value, multi, onPick, bara }: {
  field: FieldDef | undefined; value: unknown; multi: boolean; onPick: (next: unknown) => void;
  /** Visa bara dessa nycklar, i den här ordningen (övriga göms). */
  bara?: string[];
}) {
  if (!field?.options.choices?.length) return null;
  const valda = multi ? lista(value) : [];
  const choices = bara
    ? bara.map((k) => field.options.choices!.find((c) => c.key === k)).filter((c): c is { key: string; label: string } => !!c)
    : field.options.choices;
  return (
    <div className="d2d-reason-panel__chips">
      {choices.map((c) => {
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

/** Vad är bundet? — tjänster, och per vald tjänst månad + operatör. */
export function BindningPanel({ fields, data, onPatch }: {
  fields: FieldDef[]; data: Record<string, unknown>; onPatch: Patch;
}) {
  const f = (k: string) => fields.find((x) => x.key === k);
  const tjanstFalt = f("bunden_tjanst");
  const operatorFalt = f("bunden_operator");
  if (!tjanstFalt?.options.choices?.length) return null;
  const per = lasBindningar(data);
  const valda = Object.keys(per);
  const label = (k: string) => tjanstFalt.options.choices!.find((c) => c.key === k)?.label ?? k;

  const andra = (next: PerTjanst) => onPatch(tillPatch(next));
  const vaxlaTjanst = (k: string) => {
    const next = { ...per };
    if (next[k]) delete next[k]; else next[k] = {};
    andra(next);
  };
  const sattTill = (k: string, till: string) => andra({ ...per, [k]: { ...per[k], till: till || null } });
  const sattOperator = (k: string, op: string | null) => andra({ ...per, [k]: { ...per[k], operator: op } });

  return (
    <div className="d2d-reason-panel d2d-bindning">
      <span className="label">Vad är bundet?</span>
      <span className="d2d-sold-panel__hint">Välj de tjänster kunden har bindningstid på</span>
      <Chips
        field={tjanstFalt}
        value={valda}
        multi
        onPick={(v) => {
          // Chips ger hela nästa lista — hitta tjänsten som växlades.
          const next = lista(v);
          const k = valda.find((x) => !next.includes(x)) ?? next.find((x) => !valda.includes(x));
          if (k) vaxlaTjanst(k);
        }}
      />
      {tjanstFalt.options.choices.filter((c) => valda.includes(c.key)).map((c) => {
        const b = per[c.key] ?? {};
        const id = `d2d-bunden-${c.key}`;
        const ops = OPERATORER_PER_TJANST[c.key] ?? operatorFalt?.options.choices?.map((o) => o.key) ?? [];
        return (
          <div key={c.key} className="d2d-bindning__tjanst">
            <span className="d2d-bindning__sub">{label(c.key)}</span>
            <div className="d2d-bindning__rad">
              <label htmlFor={id} className="d2d-bindning__etikett">Bunden till</label>
              <input
                id={id}
                className="input d2d-bindning__manad"
                type="month"
                value={b.till ?? ""}
                onChange={(e) => sattTill(c.key, e.target.value)}
              />
              {!!b.till && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => sattTill(c.key, "")}>Rensa</button>
              )}
            </div>
            <span className="d2d-bindning__etikett">Operatör</span>
            <Chips
              field={operatorFalt}
              value={b.operator ?? null}
              multi={false}
              bara={[...ops, "annan"]}
              onPick={(v) => sattOperator(c.key, typeof v === "string" ? v : null)}
            />
          </div>
        );
      })}
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
