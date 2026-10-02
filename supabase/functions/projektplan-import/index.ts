// =====================================================================
//  PROJEKTPLAN-IMPORT — läser Projektplan CE.xlsx från SharePoint och
//  importerar (samma tolkning som manuell import under Import):
//   • "Projektplan" → Leveranser
//   • "Avslutade"   → Leveranser med status 99. Avslutad (rader som också
//                     finns i Projektplan hoppas över, där gäller Projektplan)
//   • "FLIT-SDU"    → FLIT-SDU under Leveransprocess
//
//  Körs:
//   1. Av pg_cron varje timme (header x-cron-token, token i Vault).
//   2. Manuellt av admin ("Hämta nu" under Import), med användarens JWT.
//
//  Filen hämtas med Microsoft Graph (appens client credentials, samma som
//  e-posten). Är filen oförändrad sedan senaste lyckade import görs inget.
//  Varje körning loggas i projektplan_import.
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { graph, graphConfigured, graphJson, GraphError } from "../_shared/graph.ts";
import { lasXlsx, tillObjekt } from "../_shared/xlsx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Var filen ligger (kan ändras med secrets utan kodändring).
const HOST = Deno.env.get("PROJEKTPLAN_HOST") ?? "connectestate24.sharepoint.com";
const SITE = Deno.env.get("PROJEKTPLAN_SITE") ?? "/sites/ConnectEstateTelia";
const FIL = Deno.env.get("PROJEKTPLAN_FIL") ?? "CRM-Import/Projektplan/Projektplan CE.xlsx";
const BLAD = "Projektplan";
const BLAD_AVSLUTADE = ["Avslutade", "Avslutade projekt"];
const BLAD_FLIT = ["FLIT-SDU"];
const OMGANG = 80;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function behorig(req: Request): Promise<"auto" | "manuell" | null> {
  const cronToken = req.headers.get("x-cron-token");
  if (cronToken) {
    const { data } = await db.rpc("mail_check_cron_token", { p_token: cronToken });
    return data === true ? "auto" : null;
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const userDb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data } = await userDb.rpc("is_admin");
  return data === true ? "manuell" : null;
}

type Logg = {
  kalla: string; status: "ok" | "oforandrad" | "fel"; fil_andrad?: string | null; ctag?: string | null;
  rader?: number | null; resultat?: unknown; fel?: string | null;
};
async function logga(l: Logg) {
  await db.from("projektplan_import").insert(l);
  // Behåll en månads historik.
  await db.from("projektplan_import").delete().lt("tid", new Date(Date.now() - 31 * 86400_000).toISOString());
}

type Summa = { nya: number; uppdaterade: number; hoppade: number; slangda_varden: number; statusbyten: number; kopplade_kunder: number };
const tomSumma = (): Summa => ({ nya: 0, uppdaterade: 0, hoppade: 0, slangda_varden: 0, statusbyten: 0, kopplade_kunder: 0 });

/** Läser första bladet som finns av de angivna namnen, annars null. */
async function lasValfrittBlad(buf: ArrayBuffer, namn: string[]) {
  for (const n of namn) {
    try { return tillObjekt((await lasXlsx(buf, n)).rader); }
    catch (e) { if (!String((e as Error).message).includes("finns inte")) throw e; }
  }
  return null;
}

const radNyckel = (r: Record<string, string>) =>
  `${(r["Fastighetsbeteckning"] ?? "").trim().toUpperCase()}|${(r["Ort:"] ?? "").trim().toUpperCase()}`;

async function importera(fn: string, rader: Record<string, string>[], namn: string): Promise<Summa> {
  const summa = tomSumma();
  for (let i = 0; i < rader.length; i += OMGANG) {
    const { data, error } = await db.rpc(fn, { p_rows: rader.slice(i, i + OMGANG), p_dry_run: false });
    if (error) throw new Error(`Importen av ${namn} avbröts vid rad ${i + 2}: ${error.message}`);
    for (const k of Object.keys(summa) as Array<keyof Summa>) summa[k] += Number((data as any)?.[k] ?? 0);
  }
  return summa;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const kalla = await behorig(req);
  if (!kalla) return json({ error: "Saknar behörighet" }, 401);
  const body = await req.json().catch(() => ({}));
  const tvinga = body?.tvinga === true;

  if (!graphConfigured()) {
    await logga({ kalla, status: "fel", fel: "Microsoft 365-kopplingen är inte konfigurerad (secrets saknas)." });
    return json({ status: "fel", fel: "Microsoft 365 är inte konfigurerat" });
  }

  try {
    // 1. Filens metadata
    const site = await graphJson<{ id: string }>(`/sites/${HOST}:${SITE}`);
    const item = await graphJson<{
      id: string; cTag?: string; eTag?: string; lastModifiedDateTime?: string; size?: number;
      parentReference?: { driveId?: string };
    }>(`/sites/${site.id}/drive/root:/${FIL.split("/").map(encodeURIComponent).join("/")}`);
    const ctag = item.cTag ?? item.eTag ?? null;

    if (!tvinga && ctag) {
      const { data: senast } = await db.from("projektplan_import").select("ctag")
        .eq("status", "ok").order("tid", { ascending: false }).limit(1).maybeSingle();
      if (senast?.ctag === ctag) {
        await logga({ kalla, status: "oforandrad", fil_andrad: item.lastModifiedDateTime ?? null, ctag });
        return json({ status: "oforandrad", filAndrad: item.lastModifiedDateTime });
      }
    }

    // 2. Ladda ner och läs bladet
    const res = await graph(`/drives/${item.parentReference?.driveId}/items/${item.id}/content`);
    if (!res.ok) throw new Error(`Kunde inte ladda ner filen (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();
    const blad = await lasXlsx(buf, BLAD);
    const rader = tillObjekt(blad.rader);

    // Rimlighetskontroll — hellre ingen import än en trasig.
    const medBet = rader.filter((r) => (r["Fastighetsbeteckning"] ?? "").trim() !== "").length;
    if (medBet < 10) {
      throw new Error(`Bladet ${BLAD} ser fel ut: ${rader.length} rader, ${medBet} med fastighetsbeteckning. Ingen import gjord.`);
    }

    // Avslutade och FLIT-SDU är valfria blad — saknas de läses bara Projektplan.
    const aktiva = new Set(rader.map(radNyckel));
    const avslutadeAlla = await lasValfrittBlad(buf, BLAD_AVSLUTADE);
    const avslutade = (avslutadeAlla ?? []).filter((r) => !aktiva.has(radNyckel(r)));
    const flit = await lasValfrittBlad(buf, BLAD_FLIT);

    // 3. Importera i omgångar
    const pp = await importera("ingest_projektplan", rader, BLAD);
    const av = avslutade.length ? await importera("ingest_projektplan_avslutade", avslutade, "Avslutade") : tomSumma();
    const fl = flit?.length ? await importera("ingest_flit_sdu", flit, "FLIT-SDU") : tomSumma();

    // Toppnivån gäller leveranser (Projektplan + Avslutade), som tidigare.
    const summa = tomSumma();
    for (const k of Object.keys(summa) as Array<keyof Summa>) summa[k] = pp[k] + av[k];
    const perBlad = {
      projektplan: { rader: rader.length, ...pp },
      avslutade: avslutadeAlla ? { rader: avslutade.length, iProjektplan: avslutadeAlla.length - avslutade.length, ...av } : null,
      flit_sdu: flit ? { rader: flit.length, ...fl } : null,
    };
    const antal = rader.length + avslutade.length + (flit?.length ?? 0);

    await logga({ kalla, status: "ok", fil_andrad: item.lastModifiedDateTime ?? null, ctag, rader: antal, resultat: { ...summa, blad: perBlad } });
    return json({ status: "ok", rader: antal, filAndrad: item.lastModifiedDateTime, ...summa, blad: perBlad });
  } catch (e) {
    let fel = (e as Error).message ?? String(e);
    if (e instanceof GraphError && e.status === 403) {
      fel = "Microsoft 365-appen saknar behörighet att läsa SharePoint. Ge appen Sites.Read.All (Application) " +
        "med administratörsgodkännande i Entra ID. (" + fel + ")";
    } else if (e instanceof GraphError && e.status === 404) {
      fel = `Hittar inte filen ${FIL} på ${HOST}${SITE}. (` + fel + ")";
    }
    await logga({ kalla, status: "fel", fel: fel.slice(0, 1000) });
    return json({ status: "fel", fel }); // 200 så att Import-sidan kan visa felet
  }
});
