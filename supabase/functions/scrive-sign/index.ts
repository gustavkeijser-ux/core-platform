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
//
//  Behörighet: användarens JWT. d2d_avtal_for() släpper bara igenom den som
//  får se lägenheten. Priserna räknas här på servern, aldrig i klienten.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { scriveJson, scriveMissing, syncAvtal, SCRIVE_URL, ScriveError } from "../_shared/scrive.ts";

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
type Rad = { falt: string; val: string; label: string; kampanj: number | null; ordinarie: number | null };
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
    for (const val of aktiv(f)) {
      const nyckel = val ? `${f.key}:${val}` : f.key;
      const label = val ? (f.options?.choices?.find((c: any) => c.key === val)?.label ?? val) : f.label;
      if (f.key === "salt_router") {
        const p = engangP[nyckel] ?? {};
        const pris = bb && tv && tillval ? tal(p.bbTvTillval) : bb && tv ? tal(p.bbTv) : bb && mobil ? tal(p.bbPp) : tal(p.bbEnsam);
        engang.push({ falt: f.key, val, label, kampanj: pris, ordinarie: tal(p.bbEnsam) ?? pris });
        continue;
      }
      if (f.key === "salt_tvbox") {
        const p = engangP[nyckel] ?? {};
        engang.push({ falt: f.key, val, label, kampanj: tal(p.kampanj) ?? tal(p.ordinarie), ordinarie: tal(p.ordinarie) ?? tal(p.kampanj) });
        continue;
      }
      const p = priser[nyckel] ?? {};
      let k = tal(p.kampanj);
      const o = tal(p.ordinarie);
      if (f.key === "salt_bredband" && !tv && tal(p.kampanjUtanTv) != null) k = tal(p.kampanjUtanTv);
      if (f.key === "salt_tv" && !bb) k = o;
      if (f.key === "salt_trygghet" && !bb && tal(p.kampanjUtanBredband) != null) k = tal(p.kampanjUtanBredband);
      if (f.key === "salt_streaming_sport" && utanNetflix && tal(p.kampanjUtanNetflix) != null) k = tal(p.kampanjUtanNetflix);
      manad.push({ falt: f.key, val, label, kampanj: k ?? o, ordinarie: o ?? k });
    }
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
  "salt_tv:tv_bas": "tv_mini", "salt_tv:tv_mini": "tv_mini", "salt_tv:tv_mellan": "tv_mellan", "salt_tv:tv_mycket": "tv_mycket",
  "salt_streaming_film:streaming_mer": "film_mer", "salt_streaming_film:streaming_maxad": "film_maxad", "salt_streaming_film:streaming_mest": "film_mest",
  "salt_streaming_sport:lilla_sportpaketet": "sport_lilla", "salt_streaming_sport:stora_sportpaketet": "sport_stora",
  "salt_streaming_sport:storsta_sportpaketet": "sport_storsta",
  "salt_mobil:10_gb": "mobil_10gb", "salt_mobil:20_gb": "mobil_20gb", "salt_mobil:obegransad": "mobil_obegransad",
  "salt_mobil:obegransad_plus": "mobil_obegransad_plus", "salt_mobil:obegransad_plus_1_streaming": "mobil_plus_1_streaming",
  "salt_mobil:obegransad_plus_3_streaming": "mobil_plus_3_streaming", "salt_mobil:extra_anvandare": "mobil_extra",
  "salt_trygghet": "trygghet",
};
const KATEGORI: Record<string, string> = {
  salt_bredband: "bb", salt_tv: "tv", salt_streaming_film: "film", salt_streaming_sport: "sport", salt_mobil: "mobil", salt_trygghet: "trygghet",
};
const kr = (n: number | null) => (n == null ? "" : `${n.toLocaleString("sv-SE")} kr`);

function avtalsfalt(data: Record<string, any>, a: ReturnType<typeof berakna>): Record<string, string> {
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
  const mobil = a.manad.filter((r) => r.falt === "salt_mobil").length;
  if (mobil) v.mobil_antal = String(mobil);
  const router = a.engang.find((r) => r.falt === "salt_router");
  const tvbox = a.engang.find((r) => r.falt === "salt_tvbox");
  if (a.bb) { v[router ? "router_ja" : "router_nej"] = "X"; if (router) v.router_kostnad = kr(router.kampanj); }
  if (a.tv) { v[tvbox ? "tvbox_ja" : "tvbox_nej"] = "X"; if (tvbox) v.tvbox_kostnad = kr(tvbox.kampanj); }
  if (data.salt_sport_utan_netflix === true && a.manad.some((r) => r.falt === "salt_streaming_sport")) v.sport_utan_netflix = "X";
  v.total_kampanj = kr(a.totalKampanj);
  v.total_ordinarie = kr(a.totalOrdinarie);
  v.bindningstid = `${a.bindningManader} månader`;
  v.kampanjperiod = `${a.kampanjManader} månader`;
  const start = data.startdatum_tjanst ?? data.mobil_startdatum;
  if (start) v.startdatum = String(start).slice(0, 10);
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

// ── Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Ej inloggad" }, 401);
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });

  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { /* */ }
  const action = String(b.action ?? "check");
  const missing = scriveMissing();

  if (action === "check") return json({ configured: missing.length === 0, missing });

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
    if (leverans === "skickat" && !data.kund_epost && !data.kund_telefon) saknas.push("e-post eller telefon");
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
    if (a.manad.length === 0) return json({ error: "Välj vad kunden köper under \"Vad såldes?\" först." }, 400);
    const falt = avtalsfalt(data, a);

    const { data: me } = await userDb.auth.getUser();
    const { data: row, error: insErr } = await db.from("d2d_avtal").insert({
      tenant_id: lag.tenant_id, lagenhet_id: lagenhetId, leverans, kund_namn: data.kund_namn,
      underlag: { falt, manad: a.manad, engang: a.engang }, skapad_av: me?.user?.id ?? null,
    }).select("*").single();
    if (insErr) throw new Error(insErr.message);

    try {
      // 1) Nytt dokument från mallen
      const doc = await scriveJson(`/documents/newfromtemplate/${encodeURIComponent(Deno.env.get("SCRIVE_TEMPLATE_ID")!)}`, {});
      await db.from("d2d_avtal").update({ scrive_document_id: String(doc.id) }).eq("id", row.id);

      // 2) Fyll i: kunden (motparten) + mallens namngivna fält
      const namn = String(data.kund_namn).trim().split(/\s+/);
      const efternamn = namn.length > 1 ? namn.pop()! : "";
      const fornamn = namn.join(" ");
      const ej: string[] = [];
      const hittade = new Set<string>();
      for (const p of doc.parties ?? []) {
        for (const f of p.fields ?? []) {
          if ((f.type === "text" || f.type === "checkbox") && f.name in falt) {
            hittade.add(f.name);
            if (f.type === "checkbox") f.is_checked = falt[f.name] === "X";
            else f.value = falt[f.name];
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
      for (const k of Object.keys(falt)) if (!hittade.has(k)) ej.push(k);
      doc.title = `Avtalsförslag – ${String(data.kund_namn).trim()}`;
      doc.api_callback_url = `${SUPABASE_URL}/functions/v1/scrive-callback?a=${row.id}&t=${row.callback_token}`;

      await scriveJson(`/documents/${encodeURIComponent(doc.id)}/update`, { document: JSON.stringify(doc) });

      // 3) Starta signeringen
      const started = await scriveJson(`/documents/${encodeURIComponent(doc.id)}/start`, {});
      const kund = (started.parties ?? []).find((p: any) => p.is_signatory && !p.is_author);
      await db.from("d2d_avtal").update({ status: "vantar", uppdaterad: new Date().toISOString() }).eq("id", row.id);

      return json({
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
