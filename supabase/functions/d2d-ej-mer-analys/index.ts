// =============================================================================
// d2d-ej-mer-analys — varför tog kunden bara bredband?
//
// Läser säljarens kommentar på lägenheter som köpt (Såld) eller signerat
// (Scrive) enbart bredband, och låter AI tolka varför kunden inte tog mer.
// Svaret sparas på lägenheten (data.ej_mer_ai) och syns i Utfall under
// "Varför N bara tog bredband" när säljaren inte valt något skäl själv.
//
// Anropas:
//   • av databasen direkt när någon säljer eller signerar (trigger → pg_net,
//     header x-cron-token), body { ids: [...] }
//   • av pg_cron var 5:e minut (body { ids: null }): nya eller ändrade
//     kommentarer och det som missats
//   • av en administratör (Authorization) för att köra om allt
// Bara kommentarer som är nya eller ändrade sedan förra analysen skickas.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODELL = "claude-sonnet-4-6";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Skälen som går att välja i D2D-vyn (samma nycklar som ej_mer_anledning). */
const SKAL: Record<string, string> = {
  tittar_lite: "Tittar lite på TV/streaming — behöver inte TV eller streaming",
  mobil_bunden: "Mobilen är bunden hos annan operatör",
  har_telia: "Har redan Telia (mobil eller TV)",
  familj_betalar: "Någon annan betalar mobilen/TV:n (t.ex. jobb eller familj)",
  billig_mobil: "Har billig mobil och är nöjd",
  pris: "Priset — tycker att det blir för dyrt",
  vill_fundera: "Vill fundera / återkomma om mer senare",
  flodet: "Gick inte att välja i flödet / tekniskt hinder",
  annat: "Annat skäl som framgår av kommentaren men inte passar ovan",
};

type Kandidat = { id: string; kommentar: string; hash: string; bredband: string | null; router: string | null };
type Svar = { id: string; skal: string[]; sammanfattning: string | null };

async function behorig(req: Request): Promise<boolean> {
  const cronToken = req.headers.get("x-cron-token");
  if (cronToken) {
    const { data } = await db.rpc("mail_check_cron_token", { p_token: cronToken });
    return data === true;
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const userDb = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data } = await userDb.rpc("is_admin");
  return data === true;
}

async function analysera(kandidater: Kandidat[]): Promise<Svar[]> {
  const system = [
    "Du analyserar anteckningar från dörrknackare som säljer fiber (bredband, TV, mobil, streaming) till hushåll.",
    "Varje kund nedan köpte ENBART bredband. Avgör utifrån säljarens kommentar varför kunden inte köpte mer (TV, mobil, streaming, trygghetspaket).",
    "Välj ett eller flera skäl ur listan, bara om kommentaren faktiskt ger stöd för det. Gissa inte.",
    "Säger kommentaren ingenting om varför kunden inte tog mer (t.ex. bara praktisk info om installation, telefonnummer eller tider) ska skal vara en tom lista.",
    "Skriv sammanfattning som en kort mening på svenska (högst 15 ord) om varför kunden bara tog bredband, eller null om det inte framgår.",
    "",
    "Skäl (nyckel: betydelse):",
    ...Object.entries(SKAL).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "Svara ENDAST med JSON: {\"svar\": [{\"id\": \"...\", \"skal\": [\"nyckel\", ...], \"sammanfattning\": \"...\" | null}]} med ett objekt per kund.",
  ].join("\n");
  const user = JSON.stringify(kandidater.map((k) => ({ id: k.id, kommentar: k.kommentar.slice(0, 1500) })));

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELL, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!resp.ok) throw new Error(`AI ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const body = await resp.json();
  const text: string = (body.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const start = text.indexOf("{"), slut = text.lastIndexOf("}");
  if (start < 0 || slut < 0) throw new Error("AI svarade inte med JSON");
  const parsed = JSON.parse(text.slice(start, slut + 1)) as { svar?: Svar[] };
  const giltiga = new Set(kandidater.map((k) => k.id));
  return (parsed.svar ?? [])
    .filter((s) => giltiga.has(s.id))
    .map((s) => ({
      id: s.id,
      skal: Array.isArray(s.skal) ? [...new Set(s.skal.filter((x) => x in SKAL))] : [],
      sammanfattning: typeof s.sammanfattning === "string" && s.sammanfattning.trim() ? s.sammanfattning.trim().slice(0, 200) : null,
    }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await behorig(req))) return json({ error: "Saknar behörighet" }, 401);
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY saknas" }, 500);

  const body = await req.json().catch(() => ({}));
  const ids: string[] | null = Array.isArray(body?.ids) && body.ids.length ? body.ids : null;

  let analyserade = 0, varv = 0;
  const fel: string[] = [];
  // Ta dem i omgångar om 20; högst 10 omgångar per anrop (resten tar nästa körning).
  while (varv++ < 10) {
    const { data, error } = await db.rpc("d2d_ej_mer_kandidater", { p_ids: ids, p_limit: 20 });
    if (error) return json({ error: error.message }, 500);
    const kandidater = (data ?? []) as Kandidat[];
    if (kandidater.length === 0) break;
    try {
      const svar = await analysera(kandidater);
      const hash = new Map(kandidater.map((k) => [k.id, k.hash]));
      // Även kunder som AI inte svarade för markeras som analyserade (tom
      // tolkning), så att samma kommentar inte skickas om och om igen.
      const rader = kandidater.map((k) => {
        const s = svar.find((x) => x.id === k.id);
        return { id: k.id, hash: hash.get(k.id), skal: s?.skal ?? [], sammanfattning: s?.sammanfattning ?? null };
      });
      const { error: e2 } = await db.rpc("d2d_spara_ej_mer_ai", { p_rader: rader });
      if (e2) throw new Error(e2.message);
      analyserade += rader.length;
    } catch (e) {
      fel.push(e instanceof Error ? e.message : String(e));
      break;
    }
    if (ids) break;
  }
  return json({ analyserade, fel });
});
