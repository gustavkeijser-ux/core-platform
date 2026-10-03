// =====================================================================
//  SCRIVE-MALL — adminverktyg: visa hur Scrive-mallen ser ut.
//  Returnerar parter och fält (typ, namn, placering) och en tillfällig
//  länk till mallens PDF. Kräver cron-token (Vault) — inga secrets ut.
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { scrive, scriveJson } from "../_shared/scrive.ts";
import { skapaUtkast } from "../_shared/utkast.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const tok = req.headers.get("x-cron-token");
  const { data: ok } = tok ? await db.rpc("mail_check_cron_token", { p_token: tok }) : { data: false };
  if (!ok) return json({ error: "Ej behörig" }, 403);

  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { /* */ }
  let id = String(b.mall ?? "");
  if (!id) {
    const { data } = await db.from("scrive_installningar").select("mall_id").limit(1).maybeSingle();
    id = data?.mall_id ?? "";
  }
  if (!/^\d+$/.test(id)) return json({ error: "Ingen mall" }, 400);

  try {
    const d = await scriveJson(`/documents/${id}/get`);
    const parter = (d.parties ?? []).map((p: any) => ({
      roll: p.signatory_role, author: p.is_author, signatory: p.is_signatory,
      falt: (p.fields ?? []).map((f: any) => ({ type: f.type, name: f.name ?? null, order: f.order ?? null, pl: f.placements ?? [] })),
    }));
    let url: string | null = null;
    let b64: string | null = null;   // b.b64: PDF:en inline (för granskning)
    if (b.pdf !== false) {
      const res = await scrive(`/documents/${id}/files/main/mall.pdf`);
      if (res.ok) {
        const path = `_mallar/${id}.pdf`;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (b.utkast) {   // granska utkastet för ett skickat dokument
          const u = await skapaUtkast(bytes);
          await db.storage.from("d2d-avtal").upload(`_mallar/${id}-utkast.pdf`, u, { contentType: "application/pdf", upsert: true });
          url = (await db.storage.from("d2d-avtal").createSignedUrl(`_mallar/${id}-utkast.pdf`, 900)).data?.signedUrl ?? null;
          return json({ ok: true, id, url });
        }
        if (b.b64) { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); b64 = btoa(s); }
        const { error } = await db.storage.from("d2d-avtal").upload(path, bytes, { contentType: "application/pdf", upsert: true });
        if (!error) url = (await db.storage.from("d2d-avtal").createSignedUrl(path, 900)).data?.signedUrl ?? null;
      }
    }
    return json({ ok: true, id, titel: d.title, mall: d.is_template, status: d.status, parter, url, b64 });
  } catch (e) {
    return json({ ok: false, fel: String(e) });
  }
});
