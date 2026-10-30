// =====================================================================
//  PUBLICERA — Inställningar → Publicera: Gustav godkänner eller nekar varje
//  uppgift som gjorts i testmiljön, en i taget.
//
//  En uppgift = en gren "uppgift-<id>" som utgår från main (se AGENTS.md 3b).
//  Flödet "Uppgift till testmiljön" slår ihop grenen med staging så att den
//  syns på test.crm.connectestate.se. Grenen innehåller filen
//  uppgifter/<id>.md (titel, område, beställare, testlänk, sammanfattning).
//
//  Publicera uppgift: sammanfattningen skrivs in i ANDRINGSLOGG.md på grenen,
//  grenen slås ihop med main (en push → "Deploy to Loopia": migreringar mot
//  riktiga databasen, sedan bygge), staging tar in main och grenen tas bort.
//  Neka uppgift: grenen döps om till "nekad-<id>". Den ligger kvar i
//  testmiljön men publiceras aldrig. Kan ångras.
//
//  Ändringar som gjordes direkt i staging innan uppgifterna fanns (fram till
//  FORE_UPPGIFTER) visas som ett eget paket som bara kan publiceras i sin helhet.
//
//  Åtgärder (POST { action, uppgift? }):
//    status          → uppgifter, nekade, äldre paket, okopplade ändringar, byggen
//    publicera       → { uppgift }  (bara PUBLICERARE)
//    neka            → { uppgift }  (bara PUBLICERARE)
//    angra_neka      → { uppgift }  (bara PUBLICERARE)
//    publicera_aldre → paketet med ändringar före uppgifterna (bara PUBLICERARE)
//
//  Hemligheter (Supabase → Edge Functions → Secrets, läggs in av Gustav):
//    GITHUB_TOKEN  fine-grained token för gustavkeijser-ux/core-platform med
//                  Contents: Read and write, Workflows: Read and write, Actions: Read
//    PUBLICERARE   (valfri) e-postadresser som får publicera, kommaseparerade
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const REPO = "gustavkeijser-ux/core-platform";
const TESTMILJO = "https://test.crm.connectestate.se";
// Senaste ändringen som gjordes direkt i staging innan uppgifterna infördes (30 okt).
const FORE_UPPGIFTER = "cf61a062720ecd3d070e26d227cd8a505cfe4095";
const PUBLICERARE = (Deno.env.get("PUBLICERARE") ?? "gustav@connectestate.se")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

async function gh(path: string, init: RequestInit = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const post = (path: string, body: unknown) => gh(path, { method: "POST", body: JSON.stringify(body) });

const forsta = (s: string) => String(s ?? "").split("\n")[0].slice(0, 200);
const MIGRERING = /^supabase\/migrations\/2\d{7}_\d{4}_.+\.sql$/;
const ID = /^[0-9]{8}-[0-9]{4}-[a-z0-9-]{1,60}$/;

// ---- base64 med UTF-8 -------------------------------------------------------
function fran64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function till64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---- uppgiftsfilen ----------------------------------------------------------
type Info = { titel: string; omrade: string; bestallare: string; testlank: string; sammanfattning: string };
function lasInfo(text: string, id: string): Info {
  const info: Info = { titel: id, omrade: "", bestallare: "", testlank: TESTMILJO, sammanfattning: "" };
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const huvud = m ? m[1] : "";
  const kropp = m ? m[2] : text;
  for (const rad of huvud.split("\n")) {
    const k = rad.match(/^\s*([a-zåäö]+)\s*:\s*(.*)$/i);
    if (!k) continue;
    const nyckel = k[1].toLowerCase(), varde = k[2].trim();
    if (nyckel === "titel") info.titel = varde || id;
    else if (nyckel === "omrade" || nyckel === "område") info.omrade = varde;
    else if (nyckel === "bestallare" || nyckel === "beställare") info.bestallare = varde;
    else if (nyckel === "testlank" || nyckel === "testlänk") info.testlank = varde;
  }
  info.sammanfattning = kropp.trim();
  // Bara länkar till testmiljön.
  if (!info.testlank.startsWith(TESTMILJO)) info.testlank = TESTMILJO;
  return info;
}
async function hamtaInfo(gren: string, id: string): Promise<Info> {
  const r = await gh(`/contents/uppgifter/${id}.md?ref=${encodeURIComponent(gren)}`);
  return lasInfo(r.status === 200 && r.data?.content ? fran64(r.data.content) : "", id);
}

// ---- status -----------------------------------------------------------------
async function senasteKorning(workflow: string, branch: string) {
  const r = await gh(`/actions/workflows/${workflow}/runs?branch=${branch}&per_page=1`);
  const run = r.data?.workflow_runs?.[0];
  return run ? {
    status: run.status, slutsats: run.conclusion, tid: run.created_at, url: run.html_url,
    titel: forsta(run.display_title ?? run.head_commit?.message ?? ""),
  } : null;
}

async function grenar(prefix: string): Promise<string[]> {
  const r = await gh(`/git/matching-refs/heads/${prefix}`);
  return (Array.isArray(r.data) ? r.data : []).map((x: any) => String(x.ref).replace("refs/heads/", ""));
}

async function uppgift(gren: string, prefix: string) {
  const id = gren.slice(prefix.length);
  const [mot, test, info, sammanslagning] = await Promise.all([
    gh(`/compare/main...${encodeURIComponent(gren)}`),
    gh(`/compare/staging...${encodeURIComponent(gren)}`),
    hamtaInfo(gren, id),
    senasteKorning("uppgift-till-staging.yml", gren),
  ]);
  const commits: any[] = mot.data?.commits ?? [];
  const filer: Array<{ filename: string; status: string }> = mot.data?.files ?? [];
  const iTest = test.status === 200 && (test.data?.ahead_by ?? 1) === 0;
  return {
    id, gren, ...info,
    antal: mot.data?.ahead_by ?? 0,
    shas: commits.map((c) => c.sha as string),
    skapad: commits[0]?.commit?.author?.date ?? null,
    senast: commits[commits.length - 1]?.commit?.author?.date ?? null,
    av: commits[0]?.commit?.author?.name ?? null,
    filer: filer.length,
    migreringar: filer.filter((f) => MIGRERING.test(f.filename) && f.status !== "removed").map((f) => f.filename.split("/").pop()),
    funktioner: [...new Set(filer.filter((f) => f.filename.startsWith("supabase/functions/"))
      .map((f) => f.filename.split("/")[2]).filter((n) => n && !n.startsWith("_")))],
    testmiljo: iTest ? "ja" : sammanslagning?.status !== "completed" ? "pagar" : sammanslagning?.slutsats === "success" ? "pagar" : "krock",
    testUrl: sammanslagning?.url ?? null,
  };
}

async function status() {
  const [uppg, nek, aldre, bygg, test] = await Promise.all([
    grenar("uppgift-"),
    grenar("nekad-"),
    gh(`/compare/main...${FORE_UPPGIFTER}`),
    senasteKorning("deploy.yml", "main"),
    senasteKorning("deploy-staging.yml", "staging"),
  ]);
  const uppgifter = (await Promise.all(uppg.map((g) => uppgift(g, "uppgift-")))).filter((u) => u.antal > 0);
  const nekade = await Promise.all(nek.map(async (g) => {
    const id = g.slice("nekad-".length);
    const info = await hamtaInfo(g, id);
    return { id, gren: g, titel: info.titel, omrade: info.omrade, testlank: info.testlank };
  }));

  // Ändringar som ligger direkt i staging efter FORE_UPPGIFTER och inte hör till någon uppgift.
  const kanda = new Set(uppgifter.flatMap((u) => u.shas));
  for (const g of nek) {
    const r = await gh(`/compare/main...${encodeURIComponent(g)}`);
    for (const c of r.data?.commits ?? []) kanda.add(c.sha);
  }
  const efter = await gh(`/compare/${FORE_UPPGIFTER}...staging`);
  const huvud = await gh(`/compare/staging...main`);
  const iMain = new Set((huvud.data?.commits ?? []).map((c: any) => c.sha));
  const okopplade = (efter.data?.commits ?? [])
    .filter((c: any) => (c.parents?.length ?? 1) < 2 && !kanda.has(c.sha) && !iMain.has(c.sha)
      && !/^Testmiljö: /.test(c.commit?.message ?? ""))
    .map((c: any) => ({ sha: String(c.sha).slice(0, 7), meddelande: forsta(c.commit?.message), tid: c.commit?.author?.date }));

  const aldreCommits: any[] = aldre.data?.commits ?? [];
  const aldreFiler: Array<{ filename: string; status: string }> = aldre.data?.files ?? [];
  return {
    uppgifter: uppgifter.sort((a, b) => String(a.skapad).localeCompare(String(b.skapad))).map(({ shas: _s, ...u }) => u),
    nekade,
    aldre: aldre.status === 200 && (aldre.data?.ahead_by ?? 0) > 0 ? {
      antal: aldre.data.ahead_by,
      andringar: aldreCommits.slice().reverse().map((c) => ({ sha: String(c.sha).slice(0, 7), meddelande: forsta(c.commit?.message), tid: c.commit?.author?.date })),
      migreringar: aldreFiler.filter((f) => MIGRERING.test(f.filename) && f.status !== "removed").map((f) => f.filename.split("/").pop()),
      funktioner: [...new Set(aldreFiler.filter((f) => f.filename.startsWith("supabase/functions/"))
        .map((f) => f.filename.split("/")[2]).filter((n) => n && !n.startsWith("_")))],
    } : null,
    okopplade,
    bygge: bygg, testbygge: test,
  };
}

// ---- loggen -----------------------------------------------------------------
function idag(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}
function medLoggrad(logg: string, rad: string): string {
  const dag = `## ${idag()}`;
  const i = logg.indexOf(`\n${dag}\n`);
  if (i >= 0) {
    const efterRubrik = i + dag.length + 2;
    const tom = logg.startsWith("\n", efterRubrik) ? efterRubrik + 1 : efterRubrik;
    return logg.slice(0, tom) + rad + "\n" + logg.slice(tom);
  }
  const m = logg.match(/\n## 20\d\d-\d\d-\d\d\n/);
  if (!m || m.index === undefined) return logg.trimEnd() + `\n\n${dag}\n\n${rad}\n`;
  return logg.slice(0, m.index + 1) + `${dag}\n\n${rad}\n\n` + logg.slice(m.index + 1);
}

// ---- åtgärder ---------------------------------------------------------------
async function synkaStaging(): Promise<string | null> {
  const r = await post(`/merges`, { base: "staging", head: "main", commit_message: "Testmiljö: ikapp riktiga CRM:et" });
  if (r.status === 201 || r.status === 204) return null;
  return r.status === 409
    ? "Publicerat, men testmiljön kunde inte ta in riktiga CRM:et automatiskt (krock). Be Master-agenten lösa det."
    : `Publicerat, men testmiljön kunde inte uppdateras (GitHub ${r.status}).`;
}

async function publicera(id: string, av: string) {
  const gren = `uppgift-${id}`;
  const ref = await gh(`/git/ref/heads/${gren}`);
  if (ref.status !== 200) throw new Error("Hittar inte uppgiften. Uppdatera sidan.");
  const info = await hamtaInfo(gren, id);

  // 1. Loggraden in på uppgiftens gren, så att main bara får en push.
  const logg = await gh(`/contents/ANDRINGSLOGG.md?ref=${gren}`);
  if (logg.status === 200 && logg.data?.content) {
    const text = info.sammanfattning.replace(/\s*\n\s*/g, " ").trim();
    const rad = `- [${info.omrade || "Övrigt"}] ${info.titel}${text ? `: ${text}` : ""} Publicerad av ${av} (uppgift ${id}).`;
    const ny = medLoggrad(fran64(logg.data.content), rad);
    const put = await gh(`/contents/ANDRINGSLOGG.md`, {
      method: "PUT",
      body: JSON.stringify({ message: `Logg: ${info.titel} [skip ci]`, content: till64(ny), sha: logg.data.sha, branch: gren }),
    });
    if (put.status !== 200 && put.status !== 201) throw new Error(`Kunde inte skriva i ändringsloggen (GitHub ${put.status}).`);
  }

  // 2. In i riktiga CRM:et.
  const mg = await post(`/merges`, { base: "main", head: gren, commit_message: `Publicera: ${info.titel} (${av})` });
  if (mg.status === 409) throw new Error("Uppgiften krockar med något som redan publicerats. Be agenten uppdatera uppgiften från main.");
  if (mg.status !== 201 && mg.status !== 204) throw new Error(`GitHub svarade ${mg.status}: ${mg.data?.message ?? ""}`);

  // 3. Testmiljön ikapp, grenen bort.
  const varning = await synkaStaging();
  await gh(`/git/refs/heads/${gren}`, { method: "DELETE" });
  return { publicerat: true, titel: info.titel, varning };
}

async function bytNamn(fran: string, till: string) {
  const r = await post(`/branches/${encodeURIComponent(fran)}/rename`, { new_name: till });
  if (r.status !== 201) throw new Error(r.status === 404 ? "Hittar inte uppgiften. Uppdatera sidan." : `GitHub svarade ${r.status}: ${r.data?.message ?? ""}`);
}

async function publiceraAldre(av: string) {
  const mg = await post(`/merges`, { base: "main", head: FORE_UPPGIFTER, commit_message: `Publicera: ändringar före uppgifterna (${av})` });
  if (mg.status === 204) return { publicerat: false, meddelande: "Redan publicerat." };
  if (mg.status === 409) throw new Error("Krockar med något som redan publicerats. Be Master-agenten lösa det.");
  if (mg.status !== 201) throw new Error(`GitHub svarade ${mg.status}: ${mg.data?.message ?? ""}`);
  return { publicerat: true, varning: await synkaStaging() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return fail("Ej inloggad", 401);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* tom kropp */ }

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const [{ data: me }, { data: isAdmin }] = await Promise.all([userDb.auth.getUser(), userDb.rpc("is_admin")]);
  const email = String(me?.user?.email ?? "").toLowerCase();
  if (!me?.user) return fail("Ej inloggad", 401);
  if (!isAdmin) return fail("Åtkomst nekad — admin krävs.", 403);
  if (!TOKEN) return fail("GitHub är inte kopplat: hemligheten GITHUB_TOKEN saknas i Supabase.", 503);
  const kanPublicera = PUBLICERARE.includes(email);
  const action = String(b.action ?? "");
  const id = String(b.uppgift ?? "");
  const av = String(me.user.user_metadata?.full_name ?? email);

  try {
    if (action === "status") return json({ ...(await status()), kanPublicera });
    if (!["publicera", "neka", "angra_neka", "publicera_aldre"].includes(action)) return fail("Okänd åtgärd");
    if (!kanPublicera) return fail("Bara Gustav kan publicera eller neka.", 403);
    if (action === "publicera_aldre") return json(await publiceraAldre(av));
    if (!ID.test(id)) return fail("Ogiltig uppgift");
    if (action === "publicera") return json(await publicera(id, av));
    if (action === "neka") { await bytNamn(`uppgift-${id}`, `nekad-${id}`); return json({ ok: true }); }
    await bytNamn(`nekad-${id}`, `uppgift-${id}`);
    return json({ ok: true });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
});
