// =====================================================================
//  MAIL-SYNC — hämtar nya mejl från hyresgast@connectestate.se till CRM.
//
//  Körs:
//   1. Av pg_cron varje minut (header x-cron-token, token i Vault).
//   2. Manuellt av admin ("Synka nu" i Microsoft 365-vyn), med användarens JWT.
//
//  Per brevlåda och mapp (Inkorg + Skickat):
//   Graph delta query → nya/ändrade meddelanden → hämta fullständigt
//   meddelande → mail_ingest_message() (idempotent) → bilagor till storage.
//   Delta-länken sparas efter varje sida, så en avbruten körning fortsätter
//   där den slutade. Samma mejl kan aldrig skapa två ärenden (unika nycklar
//   + lås per konversation i databasen).
//
//  Webhooks (Graph change notifications) kan läggas till senare: de behöver
//  bara anropa denna funktion — pollningen blir kvar som reserv.
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { graph, graphConfigured, graphJson, GraphError, htmlToText } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const FOLDERS = ["inbox", "sentitems"] as const;
const TIME_BUDGET_MS = 45_000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const BLOCKED_EXT = /\.(exe|bat|cmd|com|scr|pif|msi|msp|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|jar|lnk|hta|dll|cpl|reg|iso|img)$/i;
const KEEP_HEADERS = ["in-reply-to", "references", "auto-submitted", "precedence", "x-autoreply",
  "x-autorespond", "x-auto-response-suppress", "list-id"];

type Account = { id: string; tenant_id: string; mailbox: string; import_from: string };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function authorized(req: Request): Promise<boolean> {
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

function addr(r: any): string | null {
  return r?.emailAddress?.address ? String(r.emailAddress.address).toLowerCase() : null;
}

function normalize(m: any, folder: string) {
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) {
    const k = String(h.name ?? "").toLowerCase();
    if (KEEP_HEADERS.includes(k)) headers[k] = String(h.value ?? "").slice(0, 4000);
  }
  const refs = (headers["references"] ?? "").split(/\s+/).filter((x) => x.startsWith("<"));
  const bodyHtml = m.body?.contentType === "html" ? m.body.content : null;
  const unique = m.uniqueBody?.content ?? m.body?.content ?? "";
  const bodyText = m.uniqueBody?.contentType === "html" || m.body?.contentType === "html"
    ? htmlToText(unique) : String(unique);
  return {
    id: m.id,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId ?? null,
    inReplyTo: headers["in-reply-to"]?.trim() || null,
    references: refs,
    from: addr(m.from) ?? addr(m.sender),
    to: (m.toRecipients ?? []).map(addr).filter(Boolean),
    cc: (m.ccRecipients ?? []).map(addr).filter(Boolean),
    bcc: (m.bccRecipients ?? []).map(addr).filter(Boolean),
    subject: m.subject ?? "",
    bodyText: bodyText.slice(0, 200_000),
    bodyHtml: bodyHtml ? String(bodyHtml).slice(0, 1_000_000) : null,
    receivedAt: m.receivedDateTime ?? m.sentDateTime ?? new Date().toISOString(),
    isRead: !!m.isRead,
    hasAttachments: !!m.hasAttachments,
    folder,
    headers,
  };
}

const SELECT_FULL = [
  "id", "internetMessageId", "conversationId", "subject", "from", "sender", "toRecipients",
  "ccRecipients", "bccRecipients", "receivedDateTime", "sentDateTime", "isRead", "hasAttachments",
  "body", "uniqueBody", "internetMessageHeaders",
].join(",");

async function saveAttachments(acc: Account, graphMsgId: string, commId: string) {
  const list = await graphJson<{ value: any[] }>(
    `/users/${encodeURIComponent(acc.mailbox)}/messages/${encodeURIComponent(graphMsgId)}/attachments?$select=id,name,contentType,size,isInline`,
  );
  for (const a of list.value ?? []) {
    const type = String(a["@odata.type"] ?? "");
    const name = String(a.name ?? "bilaga").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "bilaga";
    const extId = `${graphMsgId}:${a.id}`;
    let blocked: string | null = null;
    let path: string | null = null;
    if (!type.endsWith("fileAttachment")) blocked = "Inbäddat meddelande eller länk – öppna i Outlook";
    else if (BLOCKED_EXT.test(name)) blocked = "Filtypen blockeras av säkerhetsskäl";
    else if (Number(a.size ?? 0) > MAX_ATTACHMENT_BYTES) blocked = "Filen är för stor (max 20 MB)";
    if (!blocked) {
      const res = await graph(`/users/${encodeURIComponent(acc.mailbox)}/messages/${encodeURIComponent(graphMsgId)}/attachments/${encodeURIComponent(a.id)}/$value`);
      if (!res.ok) throw new Error(`Kunde inte hämta bilaga (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      path = `${acc.tenant_id}/${commId}/${crypto.randomUUID()}-${name}`;
      // Lagras alltid som application/octet-stream-nedladdning; öppnas aldrig automatiskt.
      const { error } = await db.storage.from("case-attachments").upload(path, bytes, {
        contentType: "application/octet-stream", upsert: false,
      });
      if (error) throw new Error("Uppladdning misslyckades: " + error.message);
    }
    const { error } = await db.rpc("mail_register_attachment", {
      p_comm: commId, p_external_id: extId, p_name: name, p_mime: a.contentType ?? null,
      p_size: a.size ?? null, p_storage_path: path, p_content_id: a.contentId ?? null,
      p_is_inline: !!a.isInline, p_blocked_reason: blocked,
    });
    if (error) throw new Error("Bilaga kunde inte registreras: " + error.message);
  }
}

async function importOne(acc: Account, graphId: string, folder: string, stats: Record<string, number>) {
  const full = await graphJson(
    `/users/${encodeURIComponent(acc.mailbox)}/messages/${encodeURIComponent(graphId)}?$select=${SELECT_FULL}`,
    { prefer: ['outlook.body-content-type="html"'] },
  );
  const msg = normalize(full, folder);
  const { data: res, error } = await db.rpc("mail_ingest_message", { p_account: acc.id, p_msg: msg });
  if (error) throw new Error(error.message);
  if (res?.duplicate) stats.duplicates++; else stats.imported++;
  if (msg.hasAttachments && res?.id) {
    // Även för redan importerade mejl: saknas bilagorna (tidigare fel) hämtas de nu.
    const { count } = await db.from("documents").select("id", { count: "exact", head: true })
      .eq("communication_id", res.id);
    if (!count) await saveAttachments(acc, graphId, res.id); // fel → omförsökskön
  }
}

/** Meddelanden som inte gick att hämta tidigare (max 10 försök). */
async function retryFailures(acc: Account, stats: Record<string, number>) {
  const { data: rows } = await db.from("mail_fetch_failures").select("graph_id, folder")
    .eq("account_id", acc.id).lt("attempts", 10).order("last_attempt_at").limit(20);
  for (const r of rows ?? []) {
    try {
      await importOne(acc, r.graph_id, r.folder, stats);
      await db.from("mail_fetch_failures").delete().eq("account_id", acc.id).eq("graph_id", r.graph_id);
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        // Meddelandet finns inte längre i brevlådan — inget att importera.
        await db.from("mail_fetch_failures").delete().eq("account_id", acc.id).eq("graph_id", r.graph_id);
      } else {
        await db.rpc("mail_fetch_failed", { p_account: acc.id, p_graph_id: r.graph_id, p_folder: r.folder, p_error: String(e) });
      }
    }
  }
}

async function syncFolder(acc: Account, folder: string, deadline: number, stats: Record<string, number>) {
  const { data: state } = await db.from("mail_sync_state").select("delta_link")
    .eq("account_id", acc.id).eq("folder", folder).maybeSingle();
  const since = new Date(acc.import_from).toISOString();
  let url: string = state?.delta_link
    ?? `/users/${encodeURIComponent(acc.mailbox)}/mailFolders/${folder}/messages/delta?$select=id,receivedDateTime,isRead&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;

  let importedBefore = stats.imported;
  while (url && Date.now() < deadline) {
    let page: any;
    try {
      page = await graphJson(url, { prefer: ["odata.maxpagesize=25"] });
    } catch (e) {
      // Ogiltig/utgången delta-länk → börja om från import_from (dubbletter stoppas i databasen).
      if (e instanceof GraphError && (e.status === 410 || /syncStateNotFound|resyncRequired/i.test(e.code))) {
        await db.from("mail_sync_state").update({ delta_link: null }).eq("account_id", acc.id).eq("folder", folder);
        url = `/users/${encodeURIComponent(acc.mailbox)}/mailFolders/${folder}/messages/delta?$select=id,receivedDateTime,isRead&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
        continue;
      }
      // Om Graph inte godtar datumfiltret på delta: kör utan (äldre mejl hoppas över i koden).
      if (e instanceof GraphError && e.status === 400 && url.includes("$filter=")) {
        url = url.replace(/&\$filter=[^&]*/, "");
        continue;
      }
      throw e;
    }

    for (const item of page.value ?? []) {
      if (item["@removed"]) continue;
      stats.fetched++;
      if (item.receivedDateTime && new Date(item.receivedDateTime) < new Date(acc.import_from)) continue;

      // Redan importerat? Då räcker läst-status (billigt, inget fullständigt hämtande).
      const { data: known } = await db.from("communications").select("id")
        .eq("tenant_id", acc.tenant_id).eq("provider", "microsoft_graph").eq("external_id", item.id).maybeSingle();
      if (known) {
        await db.rpc("mail_ingest_message", { p_account: acc.id, p_msg: { id: item.id, isRead: !!item.isRead } });
        stats.duplicates++;
        continue;
      }

      try {
        await importOne(acc, item.id, folder, stats);
      } catch (e) {
        // Ett trasigt meddelande får inte stoppa resten: det läggs i en
        // omförsökskö och delta-länken flyttas fram som vanligt.
        stats.failed++;
        console.error("meddelande", item.id, String(e));
        await db.rpc("mail_fetch_failed", { p_account: acc.id, p_graph_id: item.id, p_folder: folder, p_error: String(e) });
      }
    }

    const next = page["@odata.nextLink"] ?? null;
    const delta = page["@odata.deltaLink"] ?? null;
    await db.rpc("mail_sync_report", { p_account: acc.id, p_folder: folder, p_delta_link: next ?? delta,
      p_ok: true, p_error: null, p_imported: stats.imported - importedBefore });
    importedBefore = stats.imported;
    url = next;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await authorized(req))) return json({ error: "Ej behörig" }, 401);

  const { data: accounts, error } = await db.from("mail_accounts")
    .select("id, tenant_id, mailbox, import_from").eq("is_active", true);
  if (error) return json({ error: error.message }, 500);

  const results: unknown[] = [];
  for (const acc of (accounts ?? []) as Account[]) {
    if (!graphConfigured()) {
      // Uppdatera en och samma rad i stället för en ny per minut.
      const { data: last } = await db.from("integration_runs").select("id, status")
        .eq("account_id", acc.id).order("started_at", { ascending: false }).limit(1).maybeSingle();
      if (last?.status === "not_configured") {
        await db.from("integration_runs").update({ started_at: new Date().toISOString(), finished_at: new Date().toISOString() }).eq("id", last.id);
      } else {
        await db.from("integration_runs").insert({ tenant_id: acc.tenant_id, account_id: acc.id, status: "not_configured",
          finished_at: new Date().toISOString(), error: "Microsoft 365-uppgifterna (MICROSOFT_*) är inte inlagda som secrets ännu." });
      }
      results.push({ mailbox: acc.mailbox, status: "not_configured" });
      continue;
    }

    const { data: gotLease } = await db.rpc("mail_acquire_lease", { p_account: acc.id, p_seconds: 120 });
    if (!gotLease) { results.push({ mailbox: acc.mailbox, status: "busy" }); continue; }

    // Första körningen efter kopplingen: importera bara mejl från och med nu.
    const { data: importFrom } = await db.rpc("mail_first_run_init", { p_account: acc.id });
    if (importFrom) acc.import_from = importFrom as string;

    const { data: run } = await db.from("integration_runs")
      .insert({ tenant_id: acc.tenant_id, account_id: acc.id }).select("id").single();
    const stats = { fetched: 0, imported: 0, duplicates: 0, failed: 0 };
    const deadline = Date.now() + TIME_BUDGET_MS;
    let runError: string | null = null;
    try {
      await retryFailures(acc, stats);
      for (const folder of FOLDERS) {
        try { await syncFolder(acc, folder, deadline, stats); }
        catch (e) {
          runError = String(e);
          console.error("mapp", folder, runError);
          await db.rpc("mail_sync_report", { p_account: acc.id, p_folder: folder, p_delta_link: null,
            p_ok: false, p_error: runError, p_imported: 0 });
        }
      }
      await db.rpc("mail_retry_pending", { p_limit: 50 });
    } finally {
      await db.from("integration_runs").update({
        finished_at: new Date().toISOString(), status: runError ? "error" : "ok", error: runError, ...stats,
      }).eq("id", run?.id);
      await db.rpc("mail_release_lease", { p_account: acc.id });
    }
    results.push({ mailbox: acc.mailbox, status: runError ? "error" : "ok", ...stats });
  }
  return json({ results });
});
