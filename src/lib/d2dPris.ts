import { supabase } from "@/integrations/supabase/client";
import type { FieldDef } from "@/lib/data";

/* =============================================================================
   D2D-prislistan och avtalssammanfattningen ("Vad såldes?" → priser).
   Nycklar i prislistan: "<fält>:<alternativ>" (t.ex. "salt_bredband:bb300")
   eller bara "<fält>" för Ja/Nej-kategorier (t.ex. "salt_trygghet").
   ========================================================================== */

export type Pris = {
  kampanj?: number | null;
  ordinarie?: number | null;
  /** Bredband utan TV (stand alone). */
  kampanjUtanTv?: number | null;
  /** Trygghetspaket utan bredband. */
  kampanjUtanBredband?: number | null;
  /** Sportpaket utan Netflix. */
  kampanjUtanNetflix?: number | null;
};
/** Router: engångskostnad beroende på vad kunden köper. */
export type RouterPris = { bbEnsam?: number | null; bbTv?: number | null; bbPp?: number | null; bbTvTillval?: number | null };

export type Prislista = {
  kampanjManader?: number;
  bindningManader?: number;
  priser?: Record<string, Pris>;
  engang?: Record<string, Pris & RouterPris>;
  updatedAt?: string;
};

export const ROUTER_FALT = "salt_router";
export const TVBOX_FALT = "salt_tvbox";
export const UTAN_NETFLIX_FALT = "salt_sport_utan_netflix";
/** Kategorier som är engångskostnader (inte per månad). */
export const ENGANG_FALT = new Set([ROUTER_FALT, TVBOX_FALT]);

let cache: Promise<Prislista> | null = null;
const lyssnare = new Set<(p: Prislista) => void>();

export function loadPrislista(force = false): Promise<Prislista> {
  if (!cache || force) {
    cache = (async () => {
      const { data, error } = await supabase.rpc("get_d2d_prislista");
      if (error) { cache = null; throw error; }
      return (data ?? {}) as Prislista;
    })();
  }
  return cache;
}

export async function savePrislista(p: Prislista): Promise<Prislista> {
  const { data, error } = await supabase.rpc("set_d2d_prislista", { p_data: p });
  if (error) throw error;
  const next = (data ?? {}) as Prislista;
  cache = Promise.resolve(next);
  lyssnare.forEach((l) => l(next));
  return next;
}

export function onPrislista(l: (p: Prislista) => void) {
  lyssnare.add(l);
  return () => { lyssnare.delete(l); };
}

// ── Beräkning ──────────────────────────────────────────────────────────────

export type AvtalsRad = {
  falt: string;
  kategori: string;
  label: string;
  kampanj: number | null;
  ordinarie: number | null;
  /** Kort förklaring, t.ex. "utan TV" eller "kombopris". */
  not?: string;
};

export type Avtal = {
  manad: AvtalsRad[];
  engang: AvtalsRad[];
  totalKampanj: number;
  totalOrdinarie: number;
  totalEngang: number;
  kampanjManader: number;
  bindningManader: number;
  /** Rader där pris saknas i prislistan. */
  saknas: string[];
  antalMobil: number;
  harBredband: boolean;
  harTv: boolean;
};

const tal = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Valda alternativ i en kategori (select = ett, multi_select = flera). */
function valda(f: FieldDef, v: unknown): string[] {
  if (f.fieldType === "boolean") return v === true ? [""] : [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return v ? [String(v)] : [];
}

/**
 * Sammanfattning av avtalet utifrån det säljaren valt under "Vad såldes?".
 * Regler (från Telias kampanjer):
 *  - Bredband har kombopris med TV, annars stand alone-pris.
 *  - TV har kombopris med bredband, annars ordinarie.
 *  - Trygghetspaket 99 kr med bredband, annars 129 kr.
 *  - Sportpaket kan väljas utan Netflix (lägre pris).
 *  - Router: 0 kr för 1 st med BB + TV + tillval (premium/mobil/trygghet)
 *    eller BB + mobil; annars enligt prislistan. TV-box: engångspris.
 */
export function beraknaAvtal(data: Record<string, unknown>, soldFields: FieldDef[], lista: Prislista): Avtal {
  const priser = lista.priser ?? {};
  const engangPriser = lista.engang ?? {};
  const svar = (data.salt_svar && typeof data.salt_svar === "object" ? data.salt_svar : {}) as Record<string, boolean>;
  const aktiv = (f: FieldDef) => {
    if (f.fieldType !== "boolean" && svar[f.key] === false) return [];
    return valda(f, data[f.key]);
  };
  const byKey = new Map(soldFields.map((f) => [f.key, f]));
  const has = (key: string) => { const f = byKey.get(key); return !!f && aktiv(f).length > 0; };

  const harBredband = has("salt_bredband");
  const harTv = has("salt_tv");
  const harMobil = has("salt_mobil");
  const harTillval = has("salt_streaming_film") || has("salt_streaming_sport") || harMobil || has("salt_trygghet");
  const utanNetflix = data[UTAN_NETFLIX_FALT] === true;

  const manad: AvtalsRad[] = [];
  const engang: AvtalsRad[] = [];
  const saknas: string[] = [];
  let antalMobil = 0;

  for (const f of soldFields) {
    for (const val of aktiv(f)) {
      const nyckel = val ? `${f.key}:${val}` : f.key;
      const label = val ? (f.options.choices?.find((c) => c.key === val)?.label ?? val) : f.label;

      if (f.key === ROUTER_FALT) {
        const p = engangPriser[nyckel] ?? {};
        const pris = harBredband && harTv && harTillval ? tal(p.bbTvTillval)
          : harBredband && harTv ? tal(p.bbTv)
          : harBredband && harMobil ? tal(p.bbPp)
          : tal(p.bbEnsam);
        if (pris == null) saknas.push(label);
        engang.push({ falt: f.key, kategori: f.label, label, kampanj: pris, ordinarie: tal(p.bbEnsam) ?? pris,
          not: pris === 0 ? "ingår" : undefined });
        continue;
      }
      if (ENGANG_FALT.has(f.key)) {
        const p = engangPriser[nyckel] ?? {};
        const k = tal(p.kampanj), o = tal(p.ordinarie);
        if (k == null && o == null) saknas.push(label);
        engang.push({ falt: f.key, kategori: f.label, label, kampanj: k ?? o, ordinarie: o ?? k });
        continue;
      }

      const p = priser[nyckel] ?? {};
      let kampanj = tal(p.kampanj);
      const ordinarie = tal(p.ordinarie);
      let not: string | undefined;
      if (f.key === "salt_bredband" && !harTv && tal(p.kampanjUtanTv) != null) { kampanj = tal(p.kampanjUtanTv); not = "utan TV"; }
      if (f.key === "salt_tv" && !harBredband) { kampanj = ordinarie; not = "utan bredband"; }
      if (f.key === "salt_trygghet" && !harBredband && tal(p.kampanjUtanBredband) != null) { kampanj = tal(p.kampanjUtanBredband); not = "utan bredband"; }
      if (f.key === "salt_trygghet" && harBredband) not = "första månaden gratis";
      if (f.key === "salt_streaming_sport" && utanNetflix && tal(p.kampanjUtanNetflix) != null) { kampanj = tal(p.kampanjUtanNetflix); not = "utan Netflix"; }
      if (f.key === "salt_mobil") antalMobil++;
      if (kampanj == null && ordinarie == null) saknas.push(label);
      manad.push({ falt: f.key, kategori: f.label, label, kampanj: kampanj ?? ordinarie, ordinarie: ordinarie ?? kampanj, not });
    }
  }

  const sum = (rows: AvtalsRad[], k: "kampanj" | "ordinarie") => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  return {
    manad, engang, saknas, antalMobil, harBredband, harTv,
    totalKampanj: sum(manad, "kampanj"),
    totalOrdinarie: sum(manad, "ordinarie"),
    totalEngang: sum(engang, "kampanj"),
    kampanjManader: lista.kampanjManader ?? 12,
    bindningManader: lista.bindningManader ?? 12,
  };
}

export const kr = (n: number | null | undefined) =>
  n == null ? "–" : `${n.toLocaleString("sv-SE")} kr`;
