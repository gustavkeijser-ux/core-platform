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
//
//  Behörighet: användarens JWT. d2d_avtal_for() släpper bara igenom den som
//  får se lägenheten. Priserna räknas här på servern, aldrig i klienten.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { scrive, scriveJson, scriveMissing, syncAvtal, SCRIVE_URL, ScriveError } from "../_shared/scrive.ts";
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
  // Mall-id: från databasen (scrive_installningar), annars secret SCRIVE_TEMPLATE_ID.
  const { data: inst } = await db.from("scrive_installningar").select("tenant_id, mall_id");
  const mallFor = (tenantId?: string) =>
    (inst ?? []).find((r: any) => r.tenant_id === tenantId)?.mall_id ?? Deno.env.get("SCRIVE_TEMPLATE_ID") ?? (inst ?? [])[0]?.mall_id ?? null;
  const missing = scriveMissing().filter((k) => k !== "SCRIVE_TEMPLATE_ID" || !mallFor());

  if (action === "check") return json({ configured: missing.length === 0, missing });

  // Testa nycklarna mot Scrive (bara läsning): listar kontots mallar (id + namn).
  // Kräver cron-token (pg_cron/Vault) — inga nyckelvärden returneras.
  if (action === "test") {
    const tok = req.headers.get("x-cron-token");
    const { data: okTok } = tok ? await db.rpc("mail_check_cron_token", { p_token: tok }) : { data: false };
    if (!okTok) return json({ error: "Ej behörig" }, 403);
    const nycklar = missing.filter((k) => k !== "SCRIVE_TEMPLATE_ID");
    if (nycklar.length) return json({ ok: false, missing });
    try {
      const filter = encodeURIComponent(JSON.stringify([{ filter_by: "is_template" }]));
      const l = await scriveJson(`/documents/list?max=50&filter=${filter}`);
      const mallar = (l.documents ?? []).map((d: any) => ({ id: String(d.id), titel: d.title }));
      const mall = mallFor();
      // Granska en eller flera mallar: hur många av mallens fält känner vi igen?
      const granska: string[] = Array.isArray(b.granska) ? b.granska.map(String) : mall ? [mall] : [];
      const granskning = [];
      for (const id of granska.slice(0, 6)) {
        try {
          const d = await scriveJson(`/documents/${encodeURIComponent(id)}/get`);
          const falt = (d.parties ?? []).flatMap((p: any) => (p.fields ?? []).filter((f: any) => f.type === "text" || f.type === "checkbox"));
          const namn = falt.map((f: any) => String(f.name ?? ""));
          const kanda = new Set([...Object.values(ALIAS), ...Object.values(KRYSS), "bindningstid", "kampanjperiod", "startdatum",
            "gatuadress", "lagenhetsnummer", "telefon", "epost", "namn", "personnummer", "ort", "datum", "sport_utan_netflix", "sport_namn"]);
          granskning.push({ id, titel: d.title, andrad: d.mtime, antalFalt: namn.length,
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

  // Avtal-id → lägenhet (och behörighetskontroll via d2d_avtal_for).
  let lagenhetId = String(b.lagenhetId ?? "");
  let avtal: Record<string, any> | null = null;
  if (b.avtalId) {
    const { data } = await db.from("d2d_avtal").select("*").eq("id", String(b.avtalId)).maybeSingle();
    if (!data) return json({ error: "Avtalet finns inte" }, 404);
    avtal = data; lagenhetId = data.lagenhet_id;
  }
  if (!/^[0-9a-f-]{36}$/.test(lagenhetId)) return json({ error: "Ogiltig lägenhet" }, 400);
  const { error: accessErr } = await userDb.rpc("d2d_avtal_for", { p_lagenhet: lagenhetId });
  if (accessErr) return json({ error: "Du har inte behörighet till den här lägenheten" }, 403);

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

    const { data: od } = await db.from("object_definitions").select("id").eq("tenant_id", lag.tenant_id).eq("key", "d2d_lagenhet").maybeSingle();
    if (!od) return json({ error: "Lägenheter saknas i systemet" }, 500);
    const { data: fdefs } = await db.from("field_definitions").select("key, label, field_type, options, sort_order, visibility")
      .eq("object_id", od.id).order("sort_order");
    const sold = (fdefs ?? []).filter((f: any) => f.options?.sold_panel && f.visibility !== "hidden") as Field[];
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
          if (f.type !== "text" && f.type !== "checkbox") continue;
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
