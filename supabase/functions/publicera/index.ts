// =====================================================================
//  PUBLICERA — Inställningar → Publicera: visar vad som gjorts i testmiljön
//  (grenen staging) men inte publicerats, och publicerar det till riktiga
//  CRM:et (grenen main) med en knapptryckning.
//
//  Publicering = main flyttas fram till staging (fast-forward). Har main fått
//  egna ändringar slås staging ihop med main i stället, och staging flyttas
//  sedan fram till main så grenarna är lika. Pushen till main startar
//  "Deploy to Loopia": nya migreringar körs mot riktiga databasen och sidan byggs.
//
//  Åtgärder (POST { action }):
//    status     → opublicerade ändringar, databasändringar, senaste byggen, kanPublicera
//    publicera  → publicerar (bara de som står i PUBLICERARE, standard Gustav)
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

const forsta = (s: string) => String(s ?? "").split("\n")[0].slice(0, 200);

async function senasteKorning(workflow: string, branch: string) {
  const r = await gh(`/actions/workflows/${workflow}/runs?branch=${branch}&per_page=1`);
  const run = r.data?.workflow_runs?.[0];
  return run ? {
    status: run.status, slutsats: run.conclusion, tid: run.created_at, url: run.html_url,
    titel: forsta(run.display_title ?? run.head_commit?.message ?? ""),
  } : null;
}

async function status() {
  const [fram, bak, bygg, test] = await Promise.all([
    gh(`/compare/main...staging`),
    gh(`/compare/staging...main`),
    senasteKorning("deploy.yml", "main"),
    senasteKorning("deploy-staging.yml", "staging"),
  ]);
  if (fram.status === 404) throw new Error("Hittar inte grenen staging på GitHub.");
  if (fram.status >= 400) throw new Error(`GitHub svarade ${fram.status}: ${fram.data?.message ?? ""}`);
  const filer: Array<{ filename: string; status: string }> = fram.data?.files ?? [];
  return {
    andringar: (fram.data?.commits ?? []).slice().reverse().map((c: any) => ({
      sha: String(c.sha).slice(0, 7), meddelande: forsta(c.commit?.message), tid: c.commit?.author?.date,
      av: c.commit?.author?.name ?? c.author?.login ?? null,
    })),
    antal: fram.data?.ahead_by ?? 0,
    migreringar: filer.filter((f) => /^supabase\/migrations\/2\d{7}_\d{4}_.+\.sql$/.test(f.filename) && f.status !== "removed")
      .map((f) => f.filename.split("/").pop()),
    funktioner: [...new Set(filer.filter((f) => f.filename.startsWith("supabase/functions/"))
      .map((f) => f.filename.split("/")[2]).filter((n) => n && !n.startsWith("_")))],
    filer: filer.length,
    riktigaFore: bak.data?.ahead_by ?? 0,
    bygge: bygg, testbygge: test,
  };
}

async function publicera(av: string) {
  const [m, s] = await Promise.all([gh(`/git/ref/heads/main`), gh(`/git/ref/heads/staging`)]);
  const mainSha = m.data?.object?.sha, stagingSha = s.data?.object?.sha;
  if (!mainSha || !stagingSha) throw new Error("Hittar inte grenarna main och staging.");
  if (mainSha === stagingSha) return { publicerat: false, meddelande: "Inget att publicera." };

  // 1. Fast-forward: main → staging (går bara om main inte fått egna ändringar).
  const ff = await gh(`/git/refs/heads/main`, { method: "PATCH", body: JSON.stringify({ sha: stagingSha, force: false }) });
  if (ff.status === 200) return { publicerat: true, sha: stagingSha.slice(0, 7), satt: "direkt" };

  // 2. Annars: slå ihop staging i main och flytta fram staging så grenarna blir lika.
  const mg = await gh(`/merges`, { method: "POST", body: JSON.stringify({
    base: "main", head: "staging", commit_message: `Publicera från testmiljön (${av})`,
  }) });
  if (mg.status === 409) throw new Error("Testmiljön och riktiga CRM:et har ändrat samma rader. Be en agent lösa konflikten i staging först.");
  if (mg.status === 204) return { publicerat: false, meddelande: "Inget att publicera." };
  if (mg.status !== 201) throw new Error(`GitHub svarade ${mg.status}: ${mg.data?.message ?? ""}`);
  const ny = mg.data?.sha;
  await gh(`/git/refs/heads/staging`, { method: "PATCH", body: JSON.stringify({ sha: ny, force: false }) });
  return { publicerat: true, sha: String(ny).slice(0, 7), satt: "sammanslagning" };
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

  try {
    switch (String(b.action ?? "")) {
      case "status":
        return json({ ...(await status()), kanPublicera });
      case "publicera":
        if (!kanPublicera) return fail("Bara Gustav kan publicera.", 403);
        return json(await publicera(me.user.user_metadata?.full_name ?? email));
      default:
        return fail("Okänd åtgärd");
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
});
