// =====================================================================
//  SCRIVE-SIGN — "Signera med Scrive" på en lägenhet i D2D-vyn.
//
//  action "check"  → är Scrive kopplat? (saknade secrets listas, inga värden)
//  action "start"  → skapa avtal från mallen, fyll i kund + allt som såldes
//                    med priser från prislistan, starta signering.
//                    leverans "plats": länk som öppnas på säljarens telefon,
//                    kunden signerar med BankID direkt.
//                    leverans "skickat": Scrive skickar länken till kunden.
//  action "status" → hämta aktuellt läge från Scrive.
//  action "pdf"    → tillfällig länk till det signerade avtalet.
//  action "avbryt" → avbryt ett avtal som inte är signerat.
//  action "utkast" → förhandsgranskning (PDF med ifyllda fält, märkt UTKAST).
//  action "okopplade" → avtal som gjorts för hand i Scrive (utanför CRM:et)
//                    och inte finns i d2d_avtal, med tolkade uppgifter och
//                    förslag på lägenhet. Admin: alla; säljare: bara de som
//                    matchar den lägenhet som skickas med (lagenhetId).
//  action "koppla" → koppla ett sådant dokument till en lägenhet: kund-
//                    uppgifter, tjänster och säljare skrivs in på lägenheten,
//                    statusen blir "Signera med Scrive", avtalet hämtas
//                    (status, signerad PDF) som om det skapats härifrån.
//
//  Behörighet: användarens JWT. d2d_avtal_for() släpper bara igenom den som
//  får se lägenheten. Priserna räknas här på servern, aldrig i klienten.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { scrive, scriveJson, scriveMissing, syncAvtal, SCRIVE_URL, ScriveError, STATUS_FROM_SCRIVE } from "../_shared/scrive.ts";
import { skapaUtkast } from "../_shared/utkast.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── Prisberäkning (samma regler som src/lib/d2dPris.ts) ────────────────

type Field = { key: string; label: string; field_type: string; options: any };
type Rad = { falt: string; val: string; label: string; kampanj: number | null; ordinarie: number | null; antal?: number };

/** Antal extraanvändare (samma regel som src/lib/d2dPris.ts och d2d_extra_antal i databasen). */
function antalExtra(data: Record<string, any>): number {
  const n = Number(data.mobil_extra_antal);
  const angivet = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const rader = Array.isArray(data.mobil_nummer?.rows) ? data.mobil_nummer.rows.filter((r: any) => r?.typ === "extra").length : 0;
  return Math.max(angivet, rader);
}
// Telias egna sportpaket ingår Netflix (kan väljas "utan Netflix"); TV4/Viaplay-paketen gör det inte.
const SPORT_MED_NETFLIX = new Set(["lilla_sportpaketet", "stora_sportpaketet", "storsta_sportpaketet"]);
const tal = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function berakna(data: Record<string, any>, fields: Field[], lista: any) {
  const priser = lista?.priser ?? {}, engangP = lista?.engang ?? {};
  const svar = (data.salt_svar && typeof data.salt_svar === "object" ? data.salt_svar : {}) as Record<string, boolean>;
  const aktiv = (f: Field): string[] => {
    const v = data[f.key];
    if (f.field_type === "boolean") return v === true ? [""] : [];
    if (svar[f.key] === false) return [];
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    return v ? [String(v)] : [];
  };
  const by = new Map(fields.map((f) => [f.key, f]));
  const has = (k: string) => { const f = by.get(k); return !!f && aktiv(f).length > 0; };
  const bb = has("salt_bredband"), tv = has("salt_tv"), mobil = has("salt_mobil");
  const tillval = has("salt_streaming_film") || has("salt_streaming_sport") || mobil || has("salt_trygghet");
  const utanNetflix = data.salt_sport_utan_netflix === true;
  const manad: Rad[] = [], engang: Rad[] = [];

  for (const f of fields) {
    if (f.key === "salt_tvbox") continue;   // läggs till nedan, följer TV-paketet
    for (const val of aktiv(f)) {
      const nyckel = val ? `${f.key}:${val}` : f.key;
      const label = val ? (f.options?.choices?.find((c: any) => c.key === val)?.label ?? val) : f.label;
      if (f.key === "salt_router") {
        const p = engangP[nyckel] ?? {};
        const pris = bb && tv && tillval ? tal(p.bbTvTillval) : bb && tv ? tal(p.bbTv) : bb && mobil ? tal(p.bbPp) : tal(p.bbEnsam);
        engang.push({ falt: f.key, val, label, kampanj: pris, ordinarie: tal(p.bbEnsam) ?? pris });
        continue;
      }
      const p = priser[nyckel] ?? {};
      let k = tal(p.kampanj);
      const o = tal(p.ordinarie);
      if (f.key === "salt_bredband" && !tv && tal(p.kampanjUtanTv) != null) k = tal(p.kampanjUtanTv);
      if (f.key === "salt_tv" && !bb) k = o;
      if (f.key === "salt_trygghet" && !bb && tal(p.kampanjUtanBredband) != null) k = tal(p.kampanjUtanBredband);
      if (f.key === "salt_streaming_sport" && utanNetflix && SPORT_MED_NETFLIX.has(val) && tal(p.kampanjUtanNetflix) != null) k = tal(p.kampanjUtanNetflix);
      // Extraanvändare: priset gäller per användare.
      const st = f.key === "salt_mobil" && val === "extra_anvandare" ? antalExtra(data) : 1;
      const ggr = (x: number | null) => (x == null ? null : x * st);
      manad.push({ falt: f.key, val, label: st > 1 ? `${label} × ${st}` : label, kampanj: ggr(k ?? o), ordinarie: ggr(o ?? k), antal: st });
    }
  }
  // TV-box ingår alltid i alla TV-paket: 0 kr för TV Start/TV Bas, annars prislistan.
  const boxF = by.get("salt_tvbox");
  if (tv && boxF) {
    const paket = aktiv(by.get("salt_tv")!)[0] ?? "";
    const p = engangP["salt_tvbox"] ?? {};
    const gratis = paket === "tv_start" || paket === "tv_basic";
    const k = gratis ? 0 : (tal(p.kampanj) ?? tal(p.ordinarie));
    engang.push({ falt: "salt_tvbox", val: "", label: boxF.label, kampanj: k, ordinarie: gratis ? 0 : (tal(p.ordinarie) ?? k) });
  }
  const sum = (r: Rad[], x: "kampanj" | "ordinarie") => r.reduce((s, y) => s + (y[x] ?? 0), 0);
  return { manad, engang, bb, tv, totalKampanj: sum(manad, "kampanj"), totalOrdinarie: sum(manad, "ordinarie"),
    kampanjManader: lista?.kampanjManader ?? 12, bindningManader: lista?.bindningManader ?? 12 };
}

// ── Fältnamn i Scrive-mallen ────────────────────────────────────────────
// Kryssrutor (text "X" eller checkbox) heter som alternativet nedan;
// prisfält heter <kategori>_kampanj / <kategori>_ordinarie.
const KRYSS: Record<string, string> = {
  "salt_bredband:bb150": "bb150", "salt_bredband:bb300": "bb300", "salt_bredband:bb600": "bb600", "salt_bredband:bb1000": "bb1000",
  // tv_bas är "TV Mini" i CRM:et; nya TV Bas heter tv_basic.
  "salt_tv:tv_start": "tv_start", "salt_tv:tv_basic": "tv_bas", "salt_tv:tv_bas": "tv_mini", "salt_tv:tv_mini": "tv_mini", "salt_tv:tv_mellan": "tv_mellan", "salt_tv:tv_mycket": "tv_mycket",
  "salt_streaming_film:streaming_mer": "film_mer", "salt_streaming_film:streaming_maxad": "film_maxad", "salt_streaming_film:streaming_mest": "film_mest",
  "salt_streaming_sport:lilla_sportpaketet": "sport_lilla", "salt_streaming_sport:stora_sportpaketet": "sport_stora",
  "salt_streaming_sport:storsta_sportpaketet": "sport_storsta",
  // Sportpaket från TV4 och Viaplay — kryssrutor i mallen med samma namn som i CRM:et.
  "salt_streaming_sport:tv4_sport_hockey": "tv4_play_sport_hockey", "salt_streaming_sport:tv4_sport_total": "tv4_play_sport_total",
  "salt_streaming_sport:viaplay_all_sport": "all_sport_fran_viaplay",
  "salt_mobil:10_gb": "mobil_10gb", "salt_mobil:20_gb": "mobil_20gb", "salt_mobil:obegransad": "mobil_obegransad",
  "salt_mobil:obegransad_plus": "mobil_obegransad_plus", "salt_mobil:obegransad_plus_1_streaming": "mobil_plus_1_streaming",
  "salt_mobil:obegransad_plus_3_streaming": "mobil_plus_3_streaming", "salt_mobil:extra_anvandare": "mobil_extra",
  "salt_trygghet": "trygghet",
};
const KATEGORI: Record<string, string> = {
  salt_bredband: "bb", salt_tv: "tv", salt_streaming_film: "film", salt_streaming_sport: "sport", salt_mobil: "mobil", salt_trygghet: "trygghet",
};
// Fältnamn som de heter i ConnectEstates mall i Scrive (Lukas mall, okt 2026)
// → nycklarna ovan. Namnen jämförs utan stora/små bokstäver och å/ä/ö.
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const ALIAS: Record<string, string> = {
  kampanjpris_bredband: "bb_kampanj", ordinariepris_bredband: "bb_ordinarie",
  kampanjpris_tv_paket: "tv_kampanj", ordinariepris_tv_paket: "tv_ordinarie",
  kostnad_router: "router_kostnad", kostnad_tv_box: "tvbox_kostnad",
  kampanjpris_streaming: "film_kampanj", ordinariepris_streaming: "film_ordinarie",
  kampanjpris_sportpaket: "sport_kampanj", ordinariepris_sportpaket: "sport_ordinarie",
  antal: "mobil_antal",
  antal_extraanvandare: "mobil_extra_antal", antal_extra_anvandare: "mobil_extra_antal", extraanvandare_antal: "mobil_extra_antal",
  antal_extraanvandare_mobil: "mobil_extra_antal", extra_anvandare_antal: "mobil_extra_antal", kampanjpris_mobilabonnemang: "mobil_kampanj", ordinariepris_mobilabonnemang: "mobil_ordinarie",
  kampanjpris_trygghetspaket: "trygghet_kampanj", ordinariepris_trygghetspaket: "trygghet_ordinarie",
  total_manadskostnad_kampanjpris: "total_kampanj", total_manadskostnad_ord_pris: "total_ordinarie",
  tjansteleverantor: "leverantor",
  tv4_sport_hockey: "tv4_play_sport_hockey", tv4_hockey: "tv4_play_sport_hockey",
  tv4_sport_total: "tv4_play_sport_total", tv4_total: "tv4_play_sport_total",
  all_sport_viaplay: "all_sport_fran_viaplay", viaplay_all_sport: "all_sport_fran_viaplay", viaplay: "all_sport_fran_viaplay",
  sportpaket: "sport_namn", sportpaket_namn: "sport_namn",
  // Fältnamnen i mallen från 7 okt 2026 (kryssrutor och prisfält med klartextnamn).
  streaming_mer: "film_mer", streaming_mest: "film_mest", streaming_maxad: "film_maxad",
  lilla_sportpaketet: "sport_lilla", stora_sportpaketet: "sport_stora", storsta_sportpaketet: "sport_storsta",
  mobil_10_gb: "mobil_10gb", mobil_20_gb: "mobil_20gb", mobil_extra_anvandare: "mobil_extra",
  mobil_obegransad_plus_streaming: "mobil_plus_streaming", trygghetspaket: "trygghet",
  film_serie_kampanjpris: "film_kampanj", film_serie_ordinarie_pris: "film_ordinarie",
  sport_kampanjpris: "sport_kampanj", sport_ordinarie_pris: "sport_ordinarie",
  mobil_kampanjpris: "mobil_kampanj", mobil_ordinarie_pris: "mobil_ordinarie",
  trygghet_kampanjpris: "trygghet_kampanj", trygghet_ordinarie_pris: "trygghet_ordinarie",
  ovrigt: "ovrigt", ovrigt_text: "ovrigt", ovriga_kommentarer: "ovrigt", ovrig_information: "ovrigt", ovrigt_avtal: "ovrigt",
  // Förhandsbeställningsmallen ("avtalsförslag om fibertjänster förhandsbeställning 300/300"):
  // adressen står i ett fält som heter som exempeltexten, lägenheten i "lgh nummer".
  tex_verkstadsvagen_4_749_42_enkoping: "gatuadress", adress: "gatuadress", gatuadress_och_ort: "gatuadress",
  lgh_nummer: "lagenhetsnummer", lagenhetsnr: "lagenhetsnummer", lgh: "lagenhetsnummer",
  ditt_namn: "namn", ditt_telefonnummer: "telefon", din_e_post: "epost", namnfortydligande: "namnfortydligande",
  // Kryssrutorna i mallen heter "checkbox 1" … "checkbox 24" (i den ordning de lades ut).
  checkbox_1: "bb150", checkbox_2: "bb300", checkbox_3: "bb600", checkbox_4: "bb1000",
  checkbox_5: "tv_bas", checkbox_6: "tv_mellan", checkbox_7: "tv_mycket",
  checkbox_8: "router_ja", checkbox_9: "router_nej", checkbox_10: "tvbox_ja", checkbox_11: "tvbox_nej",
  checkbox_12: "film_mer", checkbox_14: "film_maxad", checkbox_13: "film_mest",
  checkbox_15: "sport_lilla", checkbox_17: "sport_stora", checkbox_16: "sport_storsta",
  checkbox_18: "mobil_10gb", checkbox_21: "mobil_20gb", checkbox_22: "mobil_obegransad",
  checkbox_19: "mobil_obegransad_plus", checkbox_23: "mobil_plus_streaming", checkbox_20: "mobil_extra",
  checkbox_24: "trygghet",
};
const faltnyckel = (namn: string) => { const n = norm(namn); return ALIAS[n] ?? n; };

const kr = (n: number | null) => (n == null ? "" : `${n.toLocaleString("sv-SE")} kr`);

function avtalsfalt(data: Record<string, any>, a: ReturnType<typeof berakna>, lista: any): Record<string, string> {
  const v: Record<string, string> = {};
  const summa: Record<string, number> = {};
  for (const r of a.manad) {
    const x = KRYSS[r.val ? `${r.falt}:${r.val}` : r.falt];
    if (x) v[x] = "X";
    const kat = KATEGORI[r.falt];
    if (kat) {
      summa[`${kat}_kampanj`] = (summa[`${kat}_kampanj`] ?? 0) + (r.kampanj ?? 0);
      summa[`${kat}_ordinarie`] = (summa[`${kat}_ordinarie`] ?? 0) + (r.ordinarie ?? 0);
    }
  }
  for (const [k, n] of Object.entries(summa)) v[k] = kr(n);
  if (v.mobil_plus_1_streaming || v.mobil_plus_3_streaming) v.mobil_plus_streaming = "X";
  const mobil = a.manad.filter((r) => r.falt === "salt_mobil").reduce((n, r) => n + (r.antal ?? 1), 0);
  if (mobil) v.mobil_antal = String(mobil);
  const extra = a.manad.find((r) => r.falt === "salt_mobil" && r.val === "extra_anvandare");
  if (extra) v.mobil_extra_antal = String(extra.antal ?? 1);
  const router = a.engang.find((r) => r.falt === "salt_router");
  const tvbox = a.engang.find((r) => r.falt === "salt_tvbox");
  if (a.bb) { v[router ? "router_ja" : "router_nej"] = "X"; if (router) v.router_kostnad = kr(router.kampanj); }
  if (a.tv) { v[tvbox ? "tvbox_ja" : "tvbox_nej"] = "X"; if (tvbox) v.tvbox_kostnad = tvbox.kampanj === 0 ? "Ingår" : kr(tvbox.kampanj); }
  const sport = a.manad.find((r) => r.falt === "salt_streaming_sport");
  if (data.salt_sport_utan_netflix === true && sport && SPORT_MED_NETFLIX.has(sport.val)) v.sport_utan_netflix = "X";
  if (sport) v.sport_namn = sport.label;
  v.total_kampanj = kr(a.totalKampanj);
  v.total_ordinarie = kr(a.totalOrdinarie);
  v.bindningstid = `${a.bindningManader} månader`;
  v.kampanjperiod = `${a.kampanjManader} månader`;
  const start = data.startdatum_tjanst ?? data.mobil_startdatum;
  v.startdatum = start ? String(start).slice(0, 10) : "Enligt orderbekräftelse";
  v.leverantor = String(lista?.leverantor ?? "Telia");
  // Kunduppgifter som textfält (utöver Scrives standardfält för namn m.m.)
  const adress = [data.gatunamn, data.gatunummer].filter(Boolean).join(" ") + (data.ingang ? ` ${data.ingang}` : "");
  if (adress.trim()) v.gatuadress = adress.trim();
  if (data.name) v.lagenhetsnummer = String(data.name);
  if (data.kund_telefon) v.telefon = String(data.kund_telefon);
  if (data.kund_epost) v.epost = String(data.kund_epost);
  if (data.kund_namn) v.namn = String(data.kund_namn);
  if (data.personnummer) v.personnummer = String(data.personnummer);
  if (data.postort) v.ort = String(data.postort);
  if (String(data.scrive_ovrigt ?? "").trim()) v.ovrigt = String(data.scrive_ovrigt).trim();
  v.datum = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
  return v;
}

const pnr = (s: string) => {
  const d = s.replace(/\D/g, "");
  return d.length === 12 ? `${d.slice(0, 8)}-${d.slice(8)}` : d.length === 10 ? `${d.slice(0, 6)}-${d.slice(6)}` : "";
};
const mobilnr = (s: string) => {
  const d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("0")) return "+46" + d.slice(1);
  return d ? "+46" + d : "";
};

// ── Manuella Scrive-avtal: tolka ett dokument och hitta lägenheten ──────

/** Mallnyckel (t.ex. "bb300", "tv_mini") → CRM-fält och värde. Första i KRYSS vinner
 *  (tv_mini → salt_tv:tv_bas, som är "TV Mini" i CRM:et). */
const KRYSS_BAK: Record<string, { falt: string; val: string }> = {};
for (const [k, v] of Object.entries(KRYSS)) {
  if (KRYSS_BAK[v]) continue;
  const [falt, val = ""] = k.split(":");
  KRYSS_BAK[v] = { falt, val };
}

type Tolkat = {
  id: string; titel: string; status: string; skapad: string | null; andrad: string | null; signerad: string | null;
  kundNamn: string | null; epost: string | null; telefon: string | null; personnummer: string | null;
  adress: string | null; lgh: string | null; ort: string | null; avsandare: string | null;
  tjanster: Record<string, unknown>; tjansterText: string[]; falt: Record<string, string>; ovrigt: string | null; startdatum: string | null;
  /** Tjänsterna kunde inte läsas säkert ur dokumentet (annan mall) — fyll i för hand. */
  osaker: boolean;
};

/** Läser ut kund, adress och ikryssade tjänster ur ett Scrive-dokument (samma fältnamn som vid ifyllnad). */
function tolkaDokument(doc: any, fields: Field[]): Tolkat {
  const v: Record<string, string> = {};
  // Kryssrutor som bara heter "checkbox N" betyder något bara i vår egen mall
  // (24 numrerade rutor). I ett annat dokument (t.ex. förhandsbeställningen)
  // kan de inte tolkas — då hoppar vi över dem och märker tjänsterna som osäkra.
  const alla: any[] = (doc.parties ?? []).flatMap((p: any) => p.fields ?? []);
  const namnRaa = new Set(alla.map((f) => norm(String(f.name ?? ""))));
  const numrerade = alla.filter((f) => f.type === "checkbox" && /^checkbox_\d+$/.test(norm(String(f.name ?? "")))).length;
  // Vår egen mall: minst 8 numrerade rutor (checkbox 1–11 + namngivna) eller fälten Gatuadress/Lägenhetsnummer.
  const egenMall = numrerade >= 8 || namnRaa.has("gatuadress") || namnRaa.has("lagenhetsnummer");
  // Förhandsbeställningen: de numrerade rutorna betyder något annat där (checkbox 4 var
  // ikryssad på 300/300-avtal), så bredbandet läses ur textfältet "Internet, mb/s" i stället.
  const forhand = namnRaa.has("lgh_nummer") || namnRaa.has("tex_verkstadsvagen_4_749_42_enkoping");
  let osaker = false;
  for (const f of alla) {
    const n = norm(String(f.name ?? ""));
    if (f.type === "checkbox") {
      if (!f.is_checked) continue;
      const m = n.match(/^checkbox_(\d+)$/);
      if (m && (!egenMall || forhand)) { if (!forhand) osaker = true; continue; }
      v[faltnyckel(String(f.name ?? ""))] = "X";
    } else if ((f.type === "text" || f.type === "multi_line_text") && String(f.value ?? "").trim()) {
      v[faltnyckel(String(f.name ?? ""))] = String(f.value).trim();
    }
  }
  if (forhand) {
    const mb = Number((String(v.internet_mb_s ?? "").match(/\d+/) ?? [""])[0]);
    const bb = mb >= 1000 ? "bb1000" : mb >= 600 ? "bb600" : mb >= 300 ? "bb300" : mb >= 100 ? "bb150" : null;
    if (bb) v[bb] = "X"; else osaker = true;
  }
  const parter: any[] = doc.parties ?? [];
  const kund = parter.find((p) => p.is_signatory && !p.is_author) ?? parter.find((p) => p.is_signatory) ?? null;
  const avs = parter.find((p) => p.is_author) ?? null;
  const fv = (p: any, typ: string, order?: number) => {
    const f = (p?.fields ?? []).find((x: any) => x.type === typ && (order == null || x.order === order));
    return f && String(f.value ?? "").trim() ? String(f.value).trim() : null;
  };
  const namn = [fv(kund, "name", 1), fv(kund, "name", 2)].filter(Boolean).join(" ") || fv(kund, "name") || v.namn || null;

  // Tjänster: kryssrutor → CRM-fält (select/multi_select/boolean).
  const tj: Record<string, unknown> = {};
  const text: string[] = [];
  const by = new Map(fields.map((f) => [f.key, f]));
  const label = (falt: string, val: string) => {
    const f = by.get(falt);
    return val ? (f?.options?.choices?.find((c: any) => c.key === val)?.label ?? val) : (f?.label ?? falt);
  };
  for (const [nyckel, m] of Object.entries(KRYSS_BAK)) {
    if (v[nyckel] !== "X") continue;
    const f = by.get(m.falt);
    if (!f) continue;
    if (f.field_type === "boolean") tj[m.falt] = true;
    else if (f.field_type === "multi_select") tj[m.falt] = [...((tj[m.falt] as string[] | undefined) ?? []), m.val];
    else if (!tj[m.falt]) tj[m.falt] = m.val;
    text.push(label(m.falt, m.val));
  }
  // "Obegränsad Plus + streaming" utan antal → 1 streaming (kan ändras i CRM:et).
  if (v.mobil_plus_streaming === "X" && !v.mobil_plus_1_streaming && !v.mobil_plus_3_streaming && by.has("salt_mobil")) {
    tj.salt_mobil = [...((tj.salt_mobil as string[] | undefined) ?? []), "obegransad_plus_1_streaming"];
    text.push(label("salt_mobil", "obegransad_plus_1_streaming"));
  }
  if (v.router_ja === "X" && by.has("salt_router")) { tj.salt_router = "1_router"; text.push("Router"); }
  if (v.tvbox_ja === "X" && by.has("salt_tvbox")) tj.salt_tvbox = true;
  if (v.sport_utan_netflix === "X") tj.salt_sport_utan_netflix = true;
  const extra = Number(v.mobil_extra_antal);
  if (Array.isArray(tj.salt_mobil) && (tj.salt_mobil as string[]).includes("extra_anvandare") && Number.isFinite(extra) && extra >= 1) tj.mobil_extra_antal = Math.floor(extra);

  const datum = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
  const signerad = parter.map((p) => p.sign_time).filter(Boolean).sort().pop() ?? null;
  return {
    id: String(doc.id), titel: String(doc.title ?? ""), status: String(doc.status ?? ""), skapad: doc.ctime ?? null, andrad: doc.mtime ?? null, signerad,
    kundNamn: namn, epost: fv(kund, "email") ?? v.epost ?? null, telefon: fv(kund, "mobile") ?? v.telefon ?? null,
    personnummer: fv(kund, "personal_number") ?? v.personnummer ?? null,
    adress: v.gatuadress ?? null, lgh: v.lagenhetsnummer ?? null, ort: v.ort ?? null, avsandare: fv(avs, "email"),
    tjanster: tj, tjansterText: text, falt: v, ovrigt: v.ovrigt ?? null, startdatum: datum(v.startdatum),
    osaker: osaker || (Object.keys(tj).length === 0),
  };
}

const siffror = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const pnr10 = (s: unknown) => { const d = siffror(s); return d.length === 12 ? d.slice(2) : d.length === 10 ? d : ""; };
const tel = (s: unknown) => { const d = mobilnr(String(s ?? "")); return d.length >= 9 ? d.slice(-9) : ""; };
const normNamn = (s: unknown) => norm(String(s ?? ""));
const normAdress = (gata: unknown, nr: unknown) => norm(`${gata ?? ""} ${nr ?? ""}`);
/** "Storgatan 12 B, Umeå" → gata "storgatan", nummer "12", ingång "B". */
const delaAdress = (s: string) => {
  const m = s.trim().match(/^(.*?)[\s,]+(\d+)\s*([A-Za-z]?)\b.*$/);
  return m ? { gata: m[1], nr: m[2], ing: (m[3] ?? "").toUpperCase() } : { gata: s, nr: "", ing: "" };
};

type LagRad = { id: string; status: string; owner_user_id: string | null; data: Record<string, any> };
type Forslag = { lagenhetId: string; poang: number; skal: string[]; adress: string; lgh: string | null; ort: string | null;
  kundNamn: string | null; status: string; saljare: string | null };

/** Poängsätter hur väl ett dokument stämmer med en lägenhet. */
function matcha(t: Tolkat, l: LagRad): { poang: number; skal: string[] } {
  const d = l.data ?? {};
  let p = 0; const skal: string[] = [];
  if (t.personnummer && pnr10(t.personnummer) && pnr10(t.personnummer) === pnr10(d.personnummer)) { p += 100; skal.push("personnummer"); }
  if (t.telefon && tel(t.telefon) && tel(t.telefon) === tel(d.kund_telefon)) { p += 60; skal.push("telefon"); }
  if (t.epost && String(d.kund_epost ?? "").trim().toLowerCase() === t.epost.trim().toLowerCase()) { p += 60; skal.push("e-post"); }
  if (t.adress) {
    const a = delaAdress(t.adress);
    if (a.nr && normAdress(a.gata, a.nr) === normAdress(d.gatunamn, d.gatunummer)) {
      // Ingången (53 A / 53 B) skiljer lägenheter med samma lgh-nummer åt.
      const ing = String(d.ingang ?? "").trim().toUpperCase();
      const ingOk = !a.ing || !ing || a.ing === ing;
      if (ingOk) {
        if (t.lgh && siffror(t.lgh) && siffror(t.lgh) === siffror(d.name)) { p += a.ing && ing ? 60 : 50; skal.push(a.ing && ing ? "adress + ingång + lgh" : "adress + lgh"); }
        else { p += 15; skal.push("adress"); }
      } else if (t.lgh && siffror(t.lgh) && siffror(t.lgh) === siffror(d.name)) { p += 5; skal.push("adress (annan ingång)"); }
    }
  }
  if (t.kundNamn && normNamn(d.kund_namn)) {
    const a = normNamn(t.kundNamn), b = normNamn(d.kund_namn);
    if (a === b) { p += 30; skal.push("namn"); }
    else {
      const ta = a.split("_").filter((x) => x.length > 1), tb = b.split("_");
      if (ta.length && ta.every((x) => tb.includes(x))) { p += 15; skal.push("namn (delvis)"); }
    }
  }
  return { poang: p, skal };
}

/** Kategorierna i "Vad såldes?" (fält med sold_panel) för en tenant. */
async function soldFalt(tenantId: string): Promise<Field[]> {
  const { data: od } = await db.from("object_definitions").select("id").eq("tenant_id", tenantId).eq("key", "d2d_lagenhet").maybeSingle();
  if (!od) throw new Error("Lägenheter saknas i systemet");
  const { data: fdefs } = await db.from("field_definitions").select("key, label, field_type, options, sort_order, visibility")
    .eq("object_id", od.id).order("sort_order");
  return (fdefs ?? []).filter((f: any) => f.options?.sold_panel && f.visibility !== "hidden") as Field[];
}

/** Utkast (förhandsgranskning) av ett Scrive-dokument → tillfällig länk till PDF:en. */
async function utkastLank(doc: any, tenantId: string, lagenhetId: string): Promise<string | null> {
  const res = await scrive(`/documents/${encodeURIComponent(doc.id)}/files/main/avtal.pdf`);
  if (!res.ok) return null;
  const pdf = await skapaUtkast(new Uint8Array(await res.arrayBuffer()));
  const path = `${tenantId}/${lagenhetId}/${doc.id}-utkast.pdf`;
  const { error } = await db.storage.from("d2d-avtal").upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (error) return null;
  return (await db.storage.from("d2d-avtal").createSignedUrl(path, 1800)).data?.signedUrl ?? null;
}

// ── Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Ej inloggad" }, 401);
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });

  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { /* */ }
  const action = String(b.action ?? "check");
  // Mall-id: från databasen (scrive_installningar) i första hand, annars secret SCRIVE_TEMPLATE_ID.
  const { data: inst } = await db.from("scrive_installningar").select("tenant_id, mall_id");
  const mallFor = (tenantId?: string) =>
    (inst ?? []).find((r: any) => r.tenant_id === tenantId)?.mall_id ?? (inst ?? [])[0]?.mall_id ?? Deno.env.get("SCRIVE_TEMPLATE_ID") ?? null;
  const missing = scriveMissing().filter((k) => k !== "SCRIVE_TEMPLATE_ID" || !mallFor());

  if (action === "check") return json({ configured: missing.length === 0, missing });

  // Cron-token (Vault-hemligheten mail_sync_cron_token) = kontroll från databasen
  // med administratörsrätt: "test", och för "okopplade"/"koppla" utan inloggad användare.
  const tok = req.headers.get("x-cron-token");
  const { data: okTok } = tok ? await db.rpc("mail_check_cron_token", { p_token: tok }) : { data: false };

  // Testa nycklarna mot Scrive (bara läsning): listar kontots mallar (id + namn).
  // Kräver cron-token (pg_cron/Vault) — inga nyckelvärden returneras.
  if (action === "test") {
    if (!okTok) return json({ error: "Ej behörig" }, 403);
    const nycklar = missing.filter((k) => k !== "SCRIVE_TEMPLATE_ID");
    if (nycklar.length) return json({ ok: false, missing });
    try {
      const filter = encodeURIComponent(JSON.stringify([{ filter_by: "is_template" }]));
      const l = await scriveJson(`/documents/list?max=50&filter=${filter}`);
      const mallar = (l.documents ?? []).map((d: any) => ({ id: String(d.id), titel: d.title, andrad: d.mtime,
        papperskorg: d.is_trashed === true || d.is_deleted === true }));
      const mall = mallFor();
      // Granska en eller flera mallar: hur många av mallens fält känner vi igen?
      const granska: string[] = Array.isArray(b.granska) ? b.granska.map(String) : mall ? [mall] : [];
      const granskning = [];
      for (const id of granska.slice(0, 6)) {
        try {
          const d = await scriveJson(`/documents/${encodeURIComponent(id)}/get`);
          const falt = (d.parties ?? []).flatMap((p: any) => (p.fields ?? []).filter((f: any) => f.type === "text" || f.type === "multi_line_text" || f.type === "checkbox"));
          const namn = falt.map((f: any) => String(f.name ?? ""));
          const kanda = new Set([...Object.values(ALIAS), ...Object.values(KRYSS), "bindningstid", "kampanjperiod", "startdatum",
            "gatuadress", "lagenhetsnummer", "telefon", "epost", "namn", "personnummer", "ort", "datum", "sport_utan_netflix", "sport_namn", "ovrigt"]);
          granskning.push({ id, titel: d.title, andrad: d.mtime, antalFalt: namn.length, falt: namn.map((n: string) => `${n} → ${faltnyckel(n)}`),
            kanda: namn.filter((n: string) => kanda.has(faltnyckel(n))).length,
            okanda: namn.filter((n: string) => !kanda.has(faltnyckel(n))).slice(0, 30) });
        } catch (e) { granskning.push({ id, fel: String(e) }); }
      }
      return json({ ok: true, url: SCRIVE_URL, missing, mallar, valdMall: mall ? mallar.some((m: any) => m.id === mall) : null, granskning });
    } catch (e) {
      // Formkontroll av nycklarna — aldrig värdena, bara längd och teckentyp.
      const form = Object.fromEntries(["SCRIVE_API_TOKEN", "SCRIVE_API_SECRET", "SCRIVE_ACCESS_TOKEN", "SCRIVE_ACCESS_SECRET"].map((k) => {
        const v = Deno.env.get(k) ?? "";
        return [k, { langd: v.length, baraHex: /^[0-9a-f]+$/i.test(v), understreck: v.includes("_"), stjarna: v.includes("*"),
          mellanslag: /\s/.test(v), citattecken: /["']/.test(v) }];
      }));
      return json({ ok: false, fel: e instanceof Error ? e.message : String(e), url: SCRIVE_URL, form });
    }
  }

  // ── Avtal gjorda för hand i Scrive som inte finns i CRM:et ──
  if (action === "okopplade") {
    if (missing.length) return json({ error: "Scrive är inte kopplat ännu.", configured: false, missing }, 503);
    // Admin ser alla; en säljare bara dokument som matchar lägenheten hen skickar med.
    const { data: arAdmin } = okTok ? { data: true } : await userDb.rpc("is_admin");
    let tenantId: string | null = okTok ? ((inst ?? [])[0]?.tenant_id ?? null) : null;
    const lagId = String(b.lagenhetId ?? "");
    if (!tenantId) {
      const { data: t } = await userDb.rpc("my_tenant_id");
      tenantId = t ? String(t) : null;
    }
    if (!tenantId) return json({ error: "Ej inloggad" }, 401);
    if (!arAdmin) {
      if (!/^[0-9a-f-]{36}$/.test(lagId)) return json({ error: "Ogiltig lägenhet" }, 400);
      const { error: e } = await userDb.rpc("d2d_avtal_for", { p_lagenhet: lagId });
      if (e) return json({ error: "Du har inte behörighet till den här lägenheten" }, 403);
    }
    try {
      const sold = await soldFalt(tenantId);
      // Alla lägenheter — i sidor om 1000 (PostgREST kapar annars tyst vid 1000 rader).
      const lagRader: LagRad[] = [];
      for (let fran = 0; ; fran += 1000) {
        const { data: sida, error: sidaErr } = await db.from("records").select("id, status, owner_user_id, data")
          .eq("tenant_id", tenantId).eq("object_type", "d2d_lagenhet").is("deleted_at", null).order("id").range(fran, fran + 999);
        if (sidaErr) throw new Error(sidaErr.message);
        lagRader.push(...((sida ?? []) as LagRad[]));
        if (!sida || sida.length < 1000) break;
      }
      const lagenheter = lagRader.filter((l) => !arAdmin ? l.id === lagId : true);
      const { data: kopplade } = await db.from("d2d_avtal").select("scrive_document_id").eq("tenant_id", tenantId).not("scrive_document_id", "is", null);
      const redan = new Set((kopplade ?? []).map((r: any) => String(r.scrive_document_id)));
      const { data: anv } = await db.from("users").select("id, full_name, email").eq("tenant_id", tenantId);
      const anvNamn = (id: unknown) => { const u = (anv ?? []).find((x: any) => String(x.id) === String(id)); return u ? (u.full_name || String(u.email)) : null; };

      // Nyaste först. Standard: skickade och signerade (utkast och avbrutna med alla=true).
      const statusar = b.alla ? ["preparation", "pending", "closed", "rejected", "canceled", "timedout"] : ["pending", "closed"];
      const filter = [{ filter_by: "is_not_template" }, { filter_by: "is_not_in_trash" }, { filter_by: "status", statuses: statusar }];
      const sortering = [{ sort_by: "mtime", order: "descending" }];
      const max = Math.min(Math.max(Number(b.max) || 60, 1), 100);
      const offset = Math.max(Number(b.offset) || 0, 0);
      const l = await scriveJson(`/documents/list?max=${max}&offset=${offset}&filter=${encodeURIComponent(JSON.stringify(filter))}&sorting=${encodeURIComponent(JSON.stringify(sortering))}`);
      const docs: any[] = (l.documents ?? []).filter((d: any) => !redan.has(String(d.id)));
      const ut: any[] = [];
      for (const d0 of docs) {
        // Listan saknar ibland fält — hämta hela dokumentet då.
        const d = Array.isArray(d0.parties) && d0.parties.some((p: any) => Array.isArray(p.fields) && p.fields.length) ? d0
          : await scriveJson(`/documents/${encodeURIComponent(String(d0.id))}/get`);
        const t = tolkaDokument(d, sold);
        const forslag: Forslag[] = lagenheter.map((lg) => {
          const m = matcha(t, lg);
          const x = lg.data ?? {};
          return { lagenhetId: lg.id, poang: m.poang, skal: m.skal, status: lg.status,
            adress: [x.gatunamn, x.gatunummer, x.ingang].filter(Boolean).join(" "), lgh: x.name ? String(x.name) : null,
            ort: x.postort ? String(x.postort) : null, kundNamn: x.kund_namn ? String(x.kund_namn) : null, saljare: anvNamn(x.saljare) };
        }).filter((f) => f.poang > 0).sort((a, b2) => b2.poang - a.poang).slice(0, 5);
        if (!arAdmin && forslag.length === 0) continue;
        const { falt: _f, ...rest } = t;
        ut.push({ ...rest, crmStatus: STATUS_FROM_SCRIVE[t.status] ?? t.status, forslag,
          avsandareNamn: t.avsandare ? ((anv ?? []).find((u: any) => String(u.email).toLowerCase() === t.avsandare!.toLowerCase())?.full_name ?? null) : null });
      }
      return json({ ok: true, dokument: ut, antalIScrive: (l.documents ?? []).length, offset, max, fler: (l.documents ?? []).length === max });
    } catch (e) {
      console.error("scrive-sign okopplade", String(e));
      return json({ error: e instanceof ScriveError ? e.message : "Kunde inte hämta dokumenten från Scrive." }, 502);
    }
  }

  // Avtal-id → lägenhet (och behörighetskontroll via d2d_avtal_for).
  let lagenhetId = String(b.lagenhetId ?? "");
  let avtal: Record<string, any> | null = null;
  if (b.avtalId) {
    const { data } = await db.from("d2d_avtal").select("*").eq("id", String(b.avtalId)).maybeSingle();
    if (!data) return json({ error: "Avtalet finns inte" }, 404);
    avtal = data; lagenhetId = data.lagenhet_id;
  }
  if (!/^[0-9a-f-]{36}$/.test(lagenhetId)) return json({ error: "Ogiltig lägenhet" }, 400);
  if (!okTok) {
    const { error: accessErr } = await userDb.rpc("d2d_avtal_for", { p_lagenhet: lagenhetId });
    if (accessErr) return json({ error: "Du har inte behörighet till den här lägenheten" }, 403);
  }

  if (action === "pdf") {
    if (!avtal?.pdf_path) return json({ error: "Det finns ingen signerad PDF ännu" }, 404);
    const { data, error } = await db.storage.from("d2d-avtal").createSignedUrl(avtal.pdf_path, 300, { download: `Avtal ${avtal.kund_namn ?? ""}.pdf`.trim() });
    if (error) return json({ error: "Kunde inte hämta PDF:en" }, 500);
    return json({ url: data.signedUrl });
  }

  if (missing.length) {
    return json({ error: "Scrive är inte kopplat ännu.", configured: false, missing }, 503);
  }

  try {
    if (action === "status") {
      if (!avtal) return json({ error: "Avtal saknas" }, 400);
      return json({ ok: true, avtal: await syncAvtal(db, avtal.id) });
    }

    if (action === "avbryt") {
      if (!avtal?.scrive_document_id) return json({ error: "Avtal saknas" }, 400);
      if (avtal.status === "vantar") await scriveJson(`/documents/${encodeURIComponent(avtal.scrive_document_id)}/cancel`, {});
      return json({ ok: true, avtal: await syncAvtal(db, avtal.id) });
    }

    if (action === "utkast") {
      if (!avtal?.scrive_document_id) return json({ error: "Avtal saknas" }, 400);
      const doc = await scriveJson(`/documents/${encodeURIComponent(avtal.scrive_document_id)}/get`);
      return json({ ok: true, url: await utkastLank(doc, avtal.tenant_id, avtal.lagenhet_id) });
    }

    if (action === "lank") {
      // Ny signeringslänk för ett väntande avtal (t.ex. om fliken stängdes).
      if (!avtal?.scrive_document_id) return json({ error: "Avtal saknas" }, 400);
      const doc = await scriveJson(`/documents/${encodeURIComponent(avtal.scrive_document_id)}/get`);
      const kund = (doc.parties ?? []).find((p: any) => p.is_signatory && !p.is_author);
      return json({ ok: true, url: kund?.api_delivery_url ? SCRIVE_URL + kund.api_delivery_url : null });
    }

    if (action === "koppla") {
      // ── Koppla ett dokument som gjorts för hand i Scrive till lägenheten ──
      const docId = String(b.dokumentId ?? "");
      if (!/^\d+$/.test(docId)) return json({ error: "Ogiltigt dokument" }, 400);
      const { data: finns } = await db.from("d2d_avtal").select("id, lagenhet_id").eq("scrive_document_id", docId).maybeSingle();
      if (finns) return json({ error: "Det här avtalet är redan kopplat till en lägenhet i CRM:et." }, 409);
      const { data: lag } = await db.from("records").select("id, tenant_id, data, status").eq("id", lagenhetId).maybeSingle();
      if (!lag) return json({ error: "Lägenheten finns inte" }, 404);
      const doc = await scriveJson(`/documents/${encodeURIComponent(docId)}/get`);
      if (doc.is_template) return json({ error: "Det är en mall, inte ett avtal." }, 400);
      if (doc.is_trashed || doc.is_deleted) return json({ error: "Dokumentet ligger i papperskorgen i Scrive." }, 400);
      const sold = await soldFalt(lag.tenant_id);
      const t = tolkaDokument(doc, sold);
      const data = (lag.data ?? {}) as Record<string, any>;
      const { data: me } = await userDb.auth.getUser();

      // Kunduppgifter: fyll tomma fält (skrivOver=true ersätter det som står).
      const patch: Record<string, unknown> = {};
      const tom = (k: string) => !String(data[k] ?? "").trim();
      const satt = (k: string, v: string | null) => { if (v && (b.skrivOver || tom(k))) patch[k] = v; };
      satt("kund_namn", t.kundNamn); satt("personnummer", t.personnummer); satt("kund_epost", t.epost); satt("kund_telefon", t.telefon);
      satt("scrive_ovrigt", t.ovrigt); satt("startdatum_tjanst", t.startdatum);
      // Tjänster: det som är ikryssat i avtalet gäller för de kategorierna.
      const svar = { ...((data.salt_svar && typeof data.salt_svar === "object") ? data.salt_svar : {}) } as Record<string, boolean>;
      for (const [k, v] of Object.entries(t.tjanster)) {
        patch[k] = v;
        if (sold.some((f) => f.key === k)) svar[k] = true;
      }
      if (Object.keys(t.tjanster).length) patch.salt_svar = svar;
      // Säljare: den som skickade avtalet från Scrive, om lägenheten saknar säljare.
      let saljareSatt: string | null = null;
      if (tom("saljare") && t.avsandare) {
        const { data: u } = await db.from("users").select("id, full_name").eq("tenant_id", lag.tenant_id).ilike("email", t.avsandare).maybeSingle();
        if (u) { patch.saljare = u.id; saljareSatt = u.full_name ?? null; }
      }
      if (lag.status !== "scrive" && lag.status !== "sald") patch.senast_kontakt = new Date().toISOString();
      const nyStatus = lag.status === "scrive" || lag.status === "sald" ? null : "scrive";
      const upd: Record<string, unknown> = { data: { ...data, ...patch } };
      if (nyStatus) upd.status = nyStatus;
      const { error: updErr } = await db.from("records").update(upd).eq("id", lagenhetId);
      if (updErr) throw new Error(updErr.message);
      if (nyStatus) {
        await db.from("activities").insert({ tenant_id: lag.tenant_id, record_id: lagenhetId, activity_type: "status_change",
          body: "Status satt när ett avtal från Scrive kopplades", metadata: { to: nyStatus, from: lag.status },
          actor_user_id: me?.user?.id ?? null, actor_kind: "user", occurred_at: new Date().toISOString() });
      }

      // Underlaget räknas som i CRM:et (prislistan) på det som nu står på lägenheten.
      const { data: lista } = await db.from("d2d_prislista").select("data").eq("tenant_id", lag.tenant_id).maybeSingle();
      const a = berakna({ ...data, ...patch }, sold, lista?.data ?? {});
      const { data: row, error: insErr } = await db.from("d2d_avtal").insert({
        tenant_id: lag.tenant_id, lagenhet_id: lagenhetId, leverans: "manuell", kund_namn: t.kundNamn ?? data.kund_namn ?? null,
        scrive_document_id: docId, status: STATUS_FROM_SCRIVE[t.status] ?? "vantar",
        underlag: { falt: t.falt, manad: a.manad, engang: a.engang, manuell: true, titel: t.titel },
        skapad_av: me?.user?.id ?? null, skapad: t.skapad ?? new Date().toISOString(),
      }).select("*").single();
      if (insErr) throw new Error(insErr.message);
      const avtalNu = await syncAvtal(db, row.id);   // status, signerad PDF, scrive_signerad på lägenheten
      return json({ ok: true, avtalId: row.id, status: avtalNu.status, tjanster: t.tjansterText, falt: Object.keys(patch),
        saljare: saljareSatt, nyStatus, osaker: t.osaker });
    }

    if (action !== "start") return json({ error: "Okänd åtgärd" }, 400);

    // ── Starta ny signering ──
    const leverans = b.leverans === "skickat" ? "skickat" : "plats";
    const { data: lag } = await db.from("records").select("id, tenant_id, data, status").eq("id", lagenhetId).maybeSingle();
    if (!lag) return json({ error: "Lägenheten finns inte" }, 404);
    const data = (lag.data ?? {}) as Record<string, any>;

    const saknas: string[] = [];
    if (!String(data.kund_namn ?? "").trim()) saknas.push("namn");
    if (!pnr(String(data.personnummer ?? ""))) saknas.push("personnummer (10 eller 12 siffror)");
    if (!String(data.kund_epost ?? "").includes("@")) saknas.push("e-post (avtalet skickas dit när det är signerat)");
    if (saknas.length) return json({ error: `Fyll i kundens ${saknas.join(", ")} först.` }, 400);

    // Pågår redan en signering? Återanvänd den i stället för att skapa en till.
    const { data: pagaende } = await db.from("d2d_avtal").select("id").eq("lagenhet_id", lagenhetId)
      .in("status", ["skapas", "vantar"]).order("skapad", { ascending: false }).limit(1).maybeSingle();
    if (pagaende && !b.nytt) return json({ error: "Det finns redan ett avtal som väntar på signering.", pagaende: pagaende.id }, 409);
    if (pagaende) {
      // Nytt avtal (t.ex. efter ändrade tjänster): avbryt det gamla först.
      const { data: gammalt } = await db.from("d2d_avtal").select("scrive_document_id").eq("id", pagaende.id).single();
      if (gammalt?.scrive_document_id) {
        try { await scriveJson(`/documents/${encodeURIComponent(gammalt.scrive_document_id)}/cancel`, {}); } catch { /* redan avslutat */ }
      }
      await db.from("d2d_avtal").update({ status: "avbrutet", uppdaterad: new Date().toISOString() }).eq("id", pagaende.id);
    }

    const sold = await soldFalt(lag.tenant_id);
    const { data: lista } = await db.from("d2d_prislista").select("data").eq("tenant_id", lag.tenant_id).maybeSingle();
    const a = berakna(data, sold, lista?.data ?? {});
    if (a.manad.length === 0) return json({ error: "Välj vad kunden köper under \"Vad ska kunden signera?\" först." }, 400);
    const falt = avtalsfalt(data, a, lista?.data ?? {});

    const { data: me } = await userDb.auth.getUser();
    const { data: row, error: insErr } = await db.from("d2d_avtal").insert({
      tenant_id: lag.tenant_id, lagenhet_id: lagenhetId, leverans, kund_namn: data.kund_namn,
      underlag: { falt, manad: a.manad, engang: a.engang }, skapad_av: me?.user?.id ?? null,
    }).select("*").single();
    if (insErr) throw new Error(insErr.message);

    try {
      // 1) Nytt dokument från mallen
      const doc = await scriveJson(`/documents/newfromtemplate/${encodeURIComponent(mallFor(lag.tenant_id)!)}`, {});
      await db.from("d2d_avtal").update({ scrive_document_id: String(doc.id) }).eq("id", row.id);

      // 2) Fyll i: kunden (motparten) + mallens namngivna fält
      const namn = String(data.kund_namn).trim().split(/\s+/);
      const efternamn = namn.length > 1 ? namn.pop()! : "";
      const fornamn = namn.join(" ");
      const ej: string[] = [];
      const hittade = new Set<string>();
      for (const p of doc.parties ?? []) {
        for (const f of p.fields ?? []) {
          // Textfält (en rad eller flera, t.ex. "Övrigt") och kryssrutor.
          if (f.type !== "text" && f.type !== "multi_line_text" && f.type !== "checkbox") continue;
          const k = faltnyckel(String(f.name ?? ""));
          if (f.type === "checkbox") {
            // Alla kryssrutor sätts: ikryssad om tjänsten valts, annars tom.
            f.is_checked = falt[k] === "X";
            if (k in falt) hittade.add(k);
          } else if (k in falt) {
            hittade.add(k);
            f.value = falt[k];
          }
        }
        if (p.is_signatory && !p.is_author) {
          for (const f of p.fields ?? []) {
            if (f.type === "name" && f.order === 1) f.value = fornamn;
            if (f.type === "name" && f.order === 2) f.value = efternamn;
            if (f.type === "email" && data.kund_epost) f.value = String(data.kund_epost);
            if (f.type === "mobile" && data.kund_telefon) f.value = mobilnr(String(data.kund_telefon));
            if (f.type === "personal_number") f.value = pnr(String(data.personnummer));
          }
          // BankID kräver personnummer; lägg till fältet om mallen saknar det.
          p.fields = p.fields ?? [];
          if (!p.fields.some((f: any) => f.type === "personal_number")) {
            p.fields.push({ type: "personal_number", value: pnr(String(data.personnummer)), is_obligatory: true, should_be_filled_by_sender: true, placements: [] });
          }
          if (data.kund_epost && !p.fields.some((f: any) => f.type === "email")) {
            p.fields.push({ type: "email", value: String(data.kund_epost), is_obligatory: false, should_be_filled_by_sender: true, placements: [] });
          }
          if (data.kund_telefon && !p.fields.some((f: any) => f.type === "mobile")) {
            p.fields.push({ type: "mobile", value: mobilnr(String(data.kund_telefon)), is_obligatory: false, should_be_filled_by_sender: true, placements: [] });
          }
          p.authentication_method_to_sign = "se_bankid";
          p.delivery_method = leverans === "plats" ? "api"
            : data.kund_epost && data.kund_telefon ? "email_mobile" : data.kund_epost ? "email" : "mobile";
        }
      }
      // Bara kunden signerar: ConnectEstate (avsändaren) blir mottagare av kopian.
      for (const p of doc.parties ?? []) {
        if (p.is_author && p.is_signatory) { p.signatory_role = "viewer"; p.is_signatory = false; }
      }
      for (const k of Object.keys(falt)) if (!hittade.has(k)) ej.push(k);
      doc.title = `Avtalsförslag – ${String(data.kund_namn).trim()}`;
      doc.api_callback_url = `${SUPABASE_URL}/functions/v1/scrive-callback?a=${row.id}&t=${row.callback_token}`;

      await scriveJson(`/documents/${encodeURIComponent(doc.id)}/update`, { document: JSON.stringify(doc) });

      // 3) Starta signeringen
      const started = await scriveJson(`/documents/${encodeURIComponent(doc.id)}/start`, {});
      const kund = (started.parties ?? []).find((p: any) => p.is_signatory && !p.is_author);
      await db.from("d2d_avtal").update({ status: "vantar", uppdaterad: new Date().toISOString() }).eq("id", row.id);

      // Förhandsgranskning till säljaren (ett fel här stoppar inte utskicket).
      let utkast: string | null = null;
      try { utkast = await utkastLank(started, lag.tenant_id, lagenhetId); } catch (e) { console.error("utkast", String(e)); }

      return json({
        utkast,
        ok: true, avtalId: row.id,
        url: leverans === "plats" && kund?.api_delivery_url ? SCRIVE_URL + kund.api_delivery_url : null,
        faltSomInteFinnsIMallen: ej,
      });
    } catch (e) {
      await db.from("d2d_avtal").update({ status: "fel", fel: String(e).slice(0, 500) }).eq("id", row.id);
      throw e;
    }
  } catch (e) {
    console.error("scrive-sign", action, String(e));
    const msg = e instanceof ScriveError ? e.message : "Något gick fel mot Scrive. Försök igen om en stund.";
    return json({ error: msg }, 502);
  }
});
