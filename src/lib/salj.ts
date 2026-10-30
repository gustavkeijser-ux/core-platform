import { supabase, DataError } from "@/lib/data";

/* =============================================================================
   Säljflödet enligt mockupen "koncernmoder, affär och leverans" (30 okt 2026):
   koncernmödrar (registret och utdelning), affär (kundens säljprocess) och
   affärsmöjligheter (en per produkt). RPC:erna ligger i
   supabase/migrations/20261030_1300_master_affarsmojlighet.sql och framåt.
   ========================================================================== */

const fel = (e: { code?: string; message: string } | null): void => {
  if (!e) return;
  const kind = e.code === "22023" ? "invalid" : e.code === "42501" ? "forbidden" : e.code === "P0002" ? "not_found" : "unknown";
  throw new DataError(kind, e.message.replace(/^Ogiltig data: /, ""));
};

// ── Produkter ─────────────────────────────────────────────────────────────

export type Produkt = "fiber" | "boendeapp_las" | "hyresforhandling" | "tv" | "annat";
export const PRODUKTER: Array<{ key: Produkt; label: string }> = [
  { key: "fiber", label: "Fiber" },
  { key: "boendeapp_las", label: "Boendeapp och lås" },
  { key: "hyresforhandling", label: "Hyresförhandling" },
  { key: "tv", label: "TV-paket" },
  { key: "annat", label: "Annat" },
];
export const produktLabel = (k: string | null | undefined) => PRODUKTER.find((p) => p.key === k)?.label ?? (k || "Produkt");

/** Möjlighetens steg (status_definitions på affarsmojlighet), i ordning. */
export const MOJLIGHET_STEG: Array<{ key: string; label: string }> = [
  { key: "kontakt", label: "Kontakt etablerad" },
  { key: "mote", label: "Möte genomfört" },
  { key: "underlag", label: "Underlag skickat" },
  { key: "avtal_skickat", label: "Avtal skickat" },
  { key: "signerad", label: "Avtal signerat" },
];

export const KUNDTYPER: Array<{ key: string; label: string; begransad?: boolean }> = [
  { key: "privat_fastighetsbolag", label: "Privat fastighetsbolag" },
  { key: "kommunalt_fastighetsbolag", label: "Kommunalt fastighetsbolag" },
  { key: "brf", label: "Bostadsrättsförening" },
  { key: "bef_telia_oppen", label: "Befintlig Telia Öppen", begransad: true },
  { key: "bef_telia_stangt", label: "Befintlig Telia stängt" },
  { key: "bef_telia_kollektiv", label: "Befintlig Telia Kollektiv" },
  { key: "omsorgsbostader", label: "Omsorgsbostäder", begransad: true },
  { key: "studentbostader", label: "Studentbostäder", begransad: true },
];
export const kundtypLabel = (k: string | null | undefined) => KUNDTYPER.find((x) => x.key === k)?.label ?? (k || "–");

// ── Koncernmödrar: registret ──────────────────────────────────────────────

export type KmFilter = "alla" | "ej_utdelade" | "utdelade" | "saknar_fastigheter" | "saknar_orgnr" | "icke_saljbara";
export type KmRad = {
  id: string; namn: string | null; orgnr: string | null; kundtyp: string | null; icke_saljbar: boolean;
  saljare: string | null; motesbokare: string | null; kalla: string | null; tilldelad: string | null;
  fastigheter: number; lgh: number; deal: string | null; deal_status: string | null;
  kvalitet: "komplett" | "saknar_fastigheter" | "saknar_orgnr"; begransning: string | null;
};
export type KmRegister = { items: KmRad[]; total: number; counts: Record<KmFilter, number> };

export async function kmRegister(filter: KmFilter, search: string, limit: number, offset: number): Promise<KmRegister> {
  const { data, error } = await supabase.rpc("km_register", { p_filter: filter, p_search: search || null, p_limit: limit, p_offset: offset });
  fel(error);
  return (data ?? { items: [], total: 0, counts: {} }) as KmRegister;
}

export type KmUtdelning = { utdelade: number; hoppade: Array<{ id: string; namn: string; orsak: string }>; affarer: Array<{ km: string; deal: string }> };
export async function kmDelaUt(ids: string[], saljare: string, motesbokare: string | null, fordelning: number): Promise<KmUtdelning> {
  const { data, error } = await supabase.rpc("km_dela_ut", { p_ids: ids, p_saljare: saljare, p_motesbokare: motesbokare, p_fordelning: fordelning });
  fel(error);
  return data as KmUtdelning;
}

// ── Koncernmoder: registerkortet ──────────────────────────────────────────

export type KmKort = {
  id: string; data: Record<string, unknown>; status: string | null; created_at: string; created_by: string | null;
  bolag: Array<{ id: string; namn: string | null; orgnr: string | null; typ: "direktagt_bolag" | "forvaltningsbolag"; fastigheter: number }>;
  fastigheter: { antal: number; lgh: number; lokaler: number; koax: number; fiber: number; okand: number };
  dokument: Array<{ id: string; namn: string; url: string | null; typ: string | null; datum: string }>;
  affar: { id: string; status: string | null; saljare: string | null } | null;
  kontakter: Array<{ id: string; namn: string | null; titel: string | null; telefon: string | null; epost: string | null }>;
  begransning: string | null;
};
export async function kmKort(id: string): Promise<KmKort> {
  const { data, error } = await supabase.rpc("km_kort", { p_id: id });
  fel(error);
  return data as KmKort;
}

// ── Affärsmöjligheter ─────────────────────────────────────────────────────

export async function skapaMojlighet(dealId: string, produkt: Produkt, namn?: string): Promise<string> {
  const { data, error } = await supabase.rpc("skapa_mojlighet", { p_deal: dealId, p_produkt: produkt, p_namn: namn ?? null });
  fel(error);
  return data as string;
}

// ── Säljare att dela ut till ──────────────────────────────────────────────

export type Saljare = { id: string; name: string };
/** Användare med en säljroll (inte dörrsäljare): admin, ledning, säljchef, säljare. */
export async function listFastighetssaljare(): Promise<Saljare[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("user_id, users(id,full_name,email), roles!inner(key)")
    .in("roles.key", ["admin", "ledning", "sales_manager", "sales_rep"]);
  fel(error);
  const sedda = new Set<string>();
  const ut: Saljare[] = [];
  for (const r of (data ?? []) as unknown as Array<{ users: { id: string; full_name: string | null; email: string | null } | null }>) {
    const u = r.users;
    if (!u || sedda.has(u.id)) continue;
    sedda.add(u.id);
    ut.push({ id: u.id, name: u.full_name || u.email || u.id.slice(0, 8) });
  }
  return ut.sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

// ── Hjälpare ──────────────────────────────────────────────────────────────

export const datum = (v: unknown): string => {
  if (!v || typeof v !== "string") return "–";
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
};
export const tal = (n: unknown): string => (typeof n === "number" ? n.toLocaleString("sv-SE") : n == null || n === "" ? "–" : String(n));
