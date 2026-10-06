// =====================================================================
//  D2D-FEEDBACK-SEND — granskaren (Lukas) godkänner en säljares feedback
//  från Blitz (säljarvyn) → feedbacklistan i CRM:et + Teams.
//
//  1) Godkänner som den inloggade (d2d_feedback_godkann: bara granskaren).
//     Funktionen lägger in raden i tabellen feedback med säljaren som
//     avsändare, modul "Blitz", och med den text granskaren skickade med
//     (kan vara redigerad).
//  2) Skickar ett kort till Teams via samma arbetsflödes-webhook som
//     feedbackknappen (secret TEAMS_FEEDBACK_WEBHOOK_URL).
//  3) Noterar om det gick fram (feedback.teams_status).
//  Saknas webhooken godkänns feedbacken ändå (teams_status = not_configured).
//
//  Anrop: POST { id, text } med användarens JWT.
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

type Godkand = {
  id: string; user_id: string | null; category: string; module: string; priority: string;
  message: string; page: string | null; created_at: string; saljare: string; granskare: string | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Ej inloggad" }, 401);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* tom kropp hanteras nedan */ }
  const id = String(b.id ?? "").trim();
  const text = String(b.text ?? "").trim().slice(0, 4000);
  if (!id) return json({ error: "Saknar id" }, 400);
  if (!text) return json({ error: "Texten får inte vara tom" }, 400);

  // Godkänn som användaren — funktionen kontrollerar att det är granskaren.
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data, error } = await userDb.rpc("d2d_feedback_godkann", { p_id: id, p_text: text });
  if (error || !data) return json({ error: error?.message ?? "Kunde inte godkänna feedbacken" }, 400);
  const fb = data as Godkand;

  if (!WEBHOOK) {
    await db.from("feedback").update({ teams_status: "not_configured" }).eq("id", fb.id);
    return json({ ok: true, id: fb.id, teams: false });
  }

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
          { type: "Column", width: "auto", items: [{ type: "TextBlock", text: "🚪", size: "Large" }] },
          {
            type: "Column", width: "stretch", items: [
              { type: "TextBlock", text: "Feedback från säljare (Blitz)", weight: "Bolder", size: "Medium", wrap: true },
              { type: "TextBlock", text: `${fb.saljare} · ${when}`, isSubtle: true, spacing: "None", wrap: true, size: "Small" },
            ],
          },
          { type: "Column", width: "auto", items: [{ type: "TextBlock", text: "Godkänd", weight: "Bolder", color: "Good" }] },
        ],
      },
      { type: "FactSet", facts: [
        { title: "Säljare", value: fb.saljare },
        { title: "Godkänd av", value: fb.granskare ?? "Granskaren" },
        { title: "Modul", value: fb.module },
      ] },
      { type: "TextBlock", text: fb.message, wrap: true, spacing: "Medium" },
    ],
    actions: [{ type: "Action.OpenUrl", title: "Öppna feedbacklistan i CRM", url: `${APP_URL}/#/feedback` }, { type: "Action.OpenUrl", title: "Öppna sidan", url: pageUrl }],
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
  if (teamsError) console.error("d2d-feedback-send", fb.id, teamsError);
  return json({ ok: true, id: fb.id, teams: status === "sent" });
});
