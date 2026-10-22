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
/** TV-paket där TV-boxen ingår utan kostnad (TV Start, TV Bas). */
export const TV_GRATIS_BOX = new Set(["tv_start", "tv_basic"]);
/** Kategorier som är engångskostnader (inte per månad). */
/** Telias egna sportpaket (ingår Netflix → kan väljas "utan Netflix"). TV4/Viaplay-paketen gör det inte. */
export const SPORT_MED_NETFLIX = new Set(["lilla_sportpaketet", "stora_sportpaketet", "storsta_sportpaketet"]);
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

/** Fältet med antalet extraanvändare (mobil) och valet i salt_mobil. */
export const EXTRA_ANTAL_FALT = "mobil_extra_antal";
export const EXTRA_VAL = "extra_anvandare";

/**
 * Antal extraanvändare när "Extra användare" är vald: det angivna antalet,
 * eller fler om det finns fler extrarader bland mobilnumren. Minst 1.
 */
export function antalExtra(data: Record<string, unknown>): number {
  const n = Number(data[EXTRA_ANTAL_FALT]);
  const angivet = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const v = data.mobil_nummer as { rows?: unknown } | null | undefined;
  const rader = Array.isArray(v?.rows) ? (v!.rows as { typ?: string }[]).filter((r) => r?.typ === "extra").length : 0;
  return Math.max(angivet, rader);
}

/** Antal per mobilabonnemang (t.ex. {"10_gb": 2}); saknas = 1. */
export const MOBIL_ANTAL_FALT = "mobil_antal";

/** Antal av ett mobilabonnemang (2 × 10 GB osv.). Samma regel som d2d_mobil_antal i databasen. */
export function antalAbonnemang(data: Record<string, unknown>, val: string): number {
  const m = data[MOBIL_ANTAL_FALT];
  const n = m && typeof m === "object" ? Number((m as Record<string, unknown>)[val]) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : 1;
}

/** Ett värde per sålt mobilabonnemang i valordning (extraanvändare ingår inte): ["10_gb", "10_gb", "obegransad"]. */
export function mobilEnheter(data: Record<string, unknown>): string[] {
  const valda = Array.isArray(data.salt_mobil) ? (data.salt_mobil as unknown[]).map(String) : [];
  return valda.filter((v) => v && v !== EXTRA_VAL).flatMap((v) => Array.from({ length: antalAbonnemang(data, v) }, () => v));
}

const tal = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Valda alternativ i en kategori (select = ett, multi_select = flera). */
function valda(f: FieldDef, v: unknown): string[] {
  if (f.fieldType === "boolean") return v === true ? [""] : [];
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return v ? [String(v)] : [];
}

/**
 * Sålda tjänster som korta etiketter ("BB300", "TV Bas", "10 GB × 2"), i samma
 * ordning som "Vad såldes?". Följer det säljaren ser: en kategori med svaret
 * Nej räknas inte även om val ligger kvar. TV-box och "utan Netflix" är
 * tillägg till TV/sport och visas inte separat.
 */
export function saldaTjanster(data: Record<string, unknown>, soldFields: FieldDef[]): string[] {
  const svar = (data.salt_svar && typeof data.salt_svar === "object" ? data.salt_svar : {}) as Record<string, boolean>;
  const ut: string[] = [];
  for (const f of soldFields) {
    if (f.key === TVBOX_FALT || f.key === UTAN_NETFLIX_FALT) continue;
    if (f.fieldType !== "boolean" && svar[f.key] === false) continue;
    for (const val of valda(f, data[f.key])) {
      const label = val ? (f.options.choices?.find((c) => c.key === val)?.label ?? val) : f.label;
      const st = f.key !== "salt_mobil" ? 1 : val === EXTRA_VAL ? antalExtra(data) : antalAbonnemang(data, val);
      ut.push(st > 1 ? `${label} × ${st}` : label);
    }
  }
  return ut;
}

/**
 * Sammanfattning av avtalet utifrån det säljaren valt under "Vad såldes?".
 * Regler (från Telias kampanjer):
 *  - Bredband har kombopris med TV, annars stand alone-pris.
 *  - TV har kombopris med bredband, annars ordinarie.
 *  - Trygghetspaket 99 kr med bredband, annars 129 kr.
 *  - Sportpaket kan väljas utan Netflix (lägre pris).
 *  - Router: 0 kr för 1 st med BB + TV + tillval (premium/mobil/trygghet)
 *    eller BB + mobil; annars enligt prislistan.
 *  - TV-box ingår alltid i alla TV-paket: 0 kr för TV Start/TV Bas,
 *    annars engångspriset i prislistan.
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
    if (f.key === TVBOX_FALT) continue;   // läggs till nedan, följer TV-paketet
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
      if (f.key === "salt_streaming_sport" && utanNetflix && SPORT_MED_NETFLIX.has(val) && tal(p.kampanjUtanNetflix) != null) { kampanj = tal(p.kampanjUtanNetflix); not = "utan Netflix"; }
      // Extraanvändare och flera abonnemang av samma sort: priset gäller per styck.
      const st = f.key !== "salt_mobil" ? 1 : val === EXTRA_VAL ? antalExtra(data) : antalAbonnemang(data, val);
      if (f.key === "salt_mobil") antalMobil += st;
      if (kampanj == null && ordinarie == null) saknas.push(label);
      const ggr = (x: number | null) => (x == null ? null : x * st);
      manad.push({ falt: f.key, kategori: f.label, label: st > 1 ? `${label} × ${st}` : label,
        kampanj: ggr(kampanj ?? ordinarie), ordinarie: ggr(ordinarie ?? kampanj), not });
    }
  }

  // TV-box: ingår alltid när kunden har ett TV-paket.
  const tvboxF = byKey.get(TVBOX_FALT);
  if (harTv && tvboxF) {
    const tvPaket = aktiv(byKey.get("salt_tv")!)[0] ?? "";
    const p = engangPriser[TVBOX_FALT] ?? {};
    const gratis = TV_GRATIS_BOX.has(tvPaket);
    const k = gratis ? 0 : (tal(p.kampanj) ?? tal(p.ordinarie));
    const o = gratis ? 0 : (tal(p.ordinarie) ?? k);
    if (k == null) saknas.push(tvboxF.label);
    engang.push({ falt: TVBOX_FALT, kategori: tvboxF.label, label: tvboxF.label, kampanj: k, ordinarie: o,
      not: k === 0 ? "ingår" : undefined });
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
