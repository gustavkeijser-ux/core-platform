import { supabase, DataError, createRecord, updateRecord, addRelation, removeRelation } from "@/lib/data";

/* =============================================================================
   Kontaktytor för befintliga kunder (Gustav 5 nov 2026).
   En kontakt hör till ett eller flera bolag (koncernmoder, direktägt bolag,
   förvaltningsbolag) och har kontaktytor ur en fast lista + en fritext som
   aldrig läggs till i listan. Kontakterna ärvs till affär, leverans och alla
   processer via kontaktytor_for_post (supabase/migrations/20261105_1545_salj_kontaktytor.sql).
   ========================================================================== */

export const KONTAKTYTOR = [
  { key: "avtalskontakt", label: "Avtalskontakt" },
  { key: "ansvarig_forvaltare", label: "Ansvarig förvaltare" },
  { key: "bostadsforvaltare", label: "Bostadsförvaltare" },
  { key: "kommersiell_forvaltare", label: "Kommersiell förvaltare" },
  { key: "teknisk_forvaltare", label: "Teknisk förvaltare" },
  { key: "teknisk_ansvarig", label: "Teknisk ansvarig" },
  { key: "avisering", label: "Kontakt för avisering" },
  { key: "infomail", label: "Infomail (info@)" },
  { key: "ombud_hyresforhandling", label: "Ombud hyresförhandling" },
] as const;
export type KontaktytaKey = (typeof KONTAKTYTOR)[number]["key"];
export const ytaLabel = (k: string) => KONTAKTYTOR.find((y) => y.key === k)?.label ?? k;

/** Objekttyper som visar fliken Kontaktytor (kontakterna ärvs från bolagen). */
export const KONTAKTYTOR_TYPER = new Set([
  "koncernmoder", "direktagt_bolag", "forvaltningsbolag", "deal", "affarsmojlighet", "delivery",
  "leveransoversikt", "flit_sdu", "onboarding", "uppstartsmote", "hyresforhandling", "appleverans",
  "case", "d2d_fastighet", "d2d_projekt", "property",
]);

export type BolagTyp = "koncernmoder" | "direktagt_bolag" | "forvaltningsbolag";
export type Bolag = { id: string; namn: string | null; typ: BolagTyp };
export type Kontakt = {
  id: string; namn: string | null; titel: string | null; telefon: string | null; epost: string | null;
  kontaktytor: string[]; fritext: string | null; notering: string | null;
  bolag: Array<Bolag & { rel: string }> | null;
};
export type KontaktytorSvar = { bolag: Bolag[]; kontakter: Kontakt[] };

export const BOLAG_TYP_LABEL: Record<BolagTyp, string> = {
  koncernmoder: "Koncernmoder", direktagt_bolag: "Direktägt bolag", forvaltningsbolag: "Förvaltningsbolag",
};
const REL: Record<BolagTyp, string> = {
  koncernmoder: "contact_of", direktagt_bolag: "contact_of_db", forvaltningsbolag: "contact_of_fb",
};

export async function kontaktytorForPost(id: string): Promise<KontaktytorSvar> {
  const { data, error } = await supabase.rpc("kontaktytor_for_post", { p_id: id });
  if (error) throw new DataError("unknown", error.message);
  return (data ?? { bolag: [], kontakter: [] }) as KontaktytorSvar;
}

export type KontaktUtkast = {
  namn: string; titel: string; telefon: string; epost: string; kontaktytor: string[]; fritext: string; notering: string;
};

/** Skapar eller uppdaterar kontakten och sätter vilka bolag den hör till (av de bolag posten ärver från). */
export async function sparaKontakt(
  id: string | null, u: KontaktUtkast, valdaBolag: Bolag[], allaBolag: Bolag[], nuvarande: Array<Bolag & { rel: string }> = [],
): Promise<string> {
  const t = (s: string) => (s.trim() ? s.trim() : null);
  const data: Record<string, unknown> = {
    name: u.namn.trim(), role_title: t(u.titel), phone: t(u.telefon), email: t(u.epost),
    kontaktytor: u.kontaktytor, kontaktyta_fritext: t(u.fritext), bra_att_veta: t(u.notering),
  };
  const kontaktId = id ? (await updateRecord(id, data)).id : (await createRecord("contact", data)).id;
  const valda = new Set(valdaBolag.map((b) => b.id));
  for (const b of valdaBolag) {
    if (!nuvarande.some((n) => n.id === b.id)) await addRelation(kontaktId, REL[b.typ], b.id);
  }
  // Koppla bara bort från bolag som syns här — kopplingar till andra bolag rörs inte.
  for (const n of nuvarande) {
    if (!valda.has(n.id) && allaBolag.some((b) => b.id === n.id)) await removeRelation(kontaktId, n.rel, n.id);
  }
  return kontaktId;
}
