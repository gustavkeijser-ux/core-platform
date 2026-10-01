// =====================================================================
//  FEEDBACK-SEND — feedbackknappen i CRM:et → Teams.
//
//  1) Sparar feedbacken som användaren (submit_feedback, RLS gäller).
//  2) Skickar ett kort till Teams via ett Teams-arbetsflöde
//     ("Post to a chat/channel when a webhook request is received").
//     Webhook-adressen ligger i secret TEAMS_FEEDBACK_WEBHOOK_URL.
//  3) Noterar om det gick fram (feedback.teams_status).
//  Saknas adressen sparas feedbacken ändå (teams_status = not_configured).
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const WEBHOOK = Deno.env.get("TEAMS_FEEDBACK_WEBHOOK_URL") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://crm.connectestate.se";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PRIO: Record<string, { label: string; color: string }> = {
  low: { label: "Låg", color: "Default" },
  normal: { label: "Normal", color: "Accent" },
  high: { label: "Hög", color: "Warning" },
  critical: { label: "Kritisk", color: "Attention" },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Ej inloggad" }, 401);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* */ }
  const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: fb, error } = await userDb.rpc("submit_feedback", {
    p_category: str(b.category, 80) || "Övrigt",
    p_module: str(b.module, 80) || "Övrigt",
    p_priority: str(b.priority, 10) || "normal",
    p_message: str(b.message, 4000),
    p_page: str(b.page, 300) || null,
  });
  if (error || !fb) return json({ error: error?.message ?? "Kunde inte spara feedbacken" }, 400);

  if (!WEBHOOK) {
    await db.from("feedback").update({ teams_status: "not_configured" }).eq("id", fb.id);
    return json({ ok: true, id: fb.id, teams: false });
  }

  const { data: u } = await db.from("users").select("full_name, email").eq("id", fb.user_id).maybeSingle();
  const who = u?.full_name ? `${u.full_name} (${u.email})` : (u?.email ?? "Okänd användare");
  const prio = PRIO[fb.priority] ?? PRIO.normal;
  const when = new Date(fb.created_at).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "medium", timeStyle: "short" });
  const pageUrl = typeof fb.page === "string" && fb.page.startsWith("#") ? `${APP_URL}/${fb.page}` : APP_URL;

  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body: [
      {
        type: "ColumnSet",
        columns: [
          { type: "Column", width: "auto", items: [{ type: "TextBlock", text: "⚠️", size: "Large" }] },
          {
            type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: `Feedback: ${fb.category}`, weight: "Bolder", size: "Medium", wrap: true },
              { type: "TextBlock", text: `${who} · ${when}`, isSubtle: true, spacing: "None", wrap: true, size: "Small" },
            ],
          },
          { type: "Column", width: "auto", items: [{ type: "TextBlock", text: prio.label, weight: "Bolder", color: prio.color }] },
        ],
      },
      { type: "FactSet", facts: [
        { title: "Modul", value: fb.module },
        { title: "Kategori", value: fb.category },
        { title: "Prioritet", value: prio.label },
      ] },
      { type: "TextBlock", text: fb.message, wrap: true, spacing: "Medium" },
    ],
    actions: [{ type: "Action.OpenUrl", title: "Öppna sidan i CRM", url: pageUrl }],
  };

  let status: "sent" | "failed" = "sent";
  let teamsError: string | null = null;
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }],
      }),
    });
    if (!res.ok) { status = "failed"; teamsError = `Teams ${res.status}: ${(await res.text()).slice(0, 300)}`; }
  } catch (e) {
    status = "failed"; teamsError = String(e).slice(0, 300);
  }
  await db.from("feedback").update({ teams_status: status, teams_error: teamsError }).eq("id", fb.id);
  if (teamsError) console.error("feedback-send", fb.id, teamsError);
  return json({ ok: true, id: fb.id, teams: status === "sent" });
});
