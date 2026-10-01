// =====================================================================
//  MAIL-SEND — skickar ett handläggarsvar via Microsoft 365.
//
//  Frontend: case_queue_reply() (kontrollerar behörighet, sparar svaret)
//            → invoke("mail-send", { communicationId })
//  Här:      1) läs meddelandet MED ANVÄNDARENS behörighet (RLS)
//            2) skapa utkast i hyresgast@ (createReply på kundens senaste
//               mejl → samma tråd i Outlook och hos kunden)
//            3) spara utkastets id (så ett omförsök aldrig skickar två gånger)
//            4) skicka → mail_mark_sent()
//  Bara direction = 'outbound' kan skickas. Interna kommentarer
//  (channel 'internal_note') avvisas alltid.
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { graph, graphConfigured, graphJson, GraphError, textToHtml } from "../_shared/graph.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Ej inloggad" }, 401);

  let commId = "";
  try { commId = String((await req.json()).communicationId ?? ""); } catch { /* */ }
  if (!/^[0-9a-f-]{36}$/.test(commId)) return json({ error: "Ogiltigt meddelande-id" }, 400);

  // 1) Användarens behörighet: RLS släpper bara igenom meddelanden på ärenden hen får läsa.
  const userDb = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: m, error: readErr } = await userDb.from("communications")
    .select("id, channel, direction, send_status, external_id, subject, body_text, to_addresses, mailbox, headers, author_user_id")
    .eq("id", commId).maybeSingle();
  if (readErr || !m) return json({ error: "Meddelandet finns inte" }, 404);
  if (m.channel !== "email" || m.direction !== "outbound") return json({ error: "Det här meddelandet kan inte skickas" }, 400);
  if (m.send_status === "sent") return json({ ok: true, alreadySent: true });
  const { data: me } = await userDb.auth.getUser();
  if (!me?.user || me.user.id !== m.author_user_id) return json({ error: "Bara den som skrev svaret kan skicka det" }, 403);

  if (!graphConfigured()) {
    await db.rpc("mail_mark_send_failed", { p_comm: commId, p_error: "Microsoft 365 är inte kopplat ännu" });
    return json({ error: "Microsoft 365 är inte kopplat ännu. Svaret är sparat och kan skickas när kopplingen är klar." }, 503);
  }

  // Lås: bara ett sändningsförsök åt gången (dubbelklick skickar inte två mejl).
  const { data: claimed } = await db.rpc("mail_claim_send", { p_comm: commId });
  if (!claimed) return json({ error: "Svaret håller redan på att skickas" }, 409);

  const mailbox = encodeURIComponent(m.mailbox);
  // Svarstext + signatur. Med HTML-signatur (migration 0038) står själva svaret
  // i headers.replyText och signaturen i headers.signatureHtml; body_text har en
  // textversion av signaturen för tråden i CRM:et.
  const replyText = (m.headers?.replyText as string | undefined) ?? m.body_text ?? "";
  const sigHtml = (m.headers?.signatureHtml as string | undefined) ?? "";
  const bodyHtml = textToHtml(replyText) + (sigHtml ? `<br><div>${sigHtml}</div>` : "");
  const to = (m.to_addresses ?? []) as string[];
  try {
    // 2) Utkast — återanvänd om ett tidigare försök redan skapat det.
    const { data: fresh } = await db.from("communications").select("external_id").eq("id", commId).single();
    let draftId: string = fresh.external_id.startsWith("pending:") ? "" : fresh.external_id;
    const reused = !!draftId;
    if (!draftId) {
      const replyTo = m.headers?.replyToGraphId as string | undefined;
      let draft: any;
      if (replyTo) {
        draft = await graphJson(`/users/${mailbox}/messages/${encodeURIComponent(replyTo)}/createReply`, {
          method: "POST", body: JSON.stringify({}),
        });
        draft = await graphJson(`/users/${mailbox}/messages/${encodeURIComponent(draft.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            subject: m.subject,
            toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
            body: { contentType: "HTML", content: bodyHtml + "<br>" + (draft.body?.content ?? "") },
          }),
        });
      } else {
        draft = await graphJson(`/users/${mailbox}/messages`, {
          method: "POST",
          body: JSON.stringify({
            subject: m.subject,
            toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
            body: { contentType: "HTML", content: bodyHtml },
          }),
        });
      }
      draftId = draft.id;
      // 3) Spara utkastets id innan vi skickar.
      await db.rpc("mail_mark_sent", { p_comm: commId, p_graph_id: draftId,
        p_internet_message_id: draft.internetMessageId ?? null, p_conversation_id: draft.conversationId ?? null, p_draft: true });
    }

    // 4) Skicka. 404 vid omförsök = utkastet är redan skickat.
    const res = await graph(`/users/${mailbox}/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
    if (!res.ok && res.status !== 202 && !(reused && res.status === 404)) {
      const j = await res.json().catch(() => ({}));
      throw new GraphError(res.status, j?.error?.code ?? "", `Graph ${res.status}: ${j?.error?.message ?? ""}`);
    }

    // Immutable id följer med till Skickat — hämta slutliga id:n (kan dröja en stund).
    let sent: any = {};
    for (let i = 0; i < 3; i++) {
      try {
        sent = await graphJson(`/users/${mailbox}/messages/${encodeURIComponent(draftId)}?$select=id,internetMessageId,conversationId,isDraft`);
        if (sent.isDraft === false) break;
      } catch { /* inte flyttat ännu */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    await db.rpc("mail_mark_sent", { p_comm: commId, p_graph_id: sent.id ?? draftId,
      p_internet_message_id: sent.internetMessageId ?? null, p_conversation_id: sent.conversationId ?? null, p_draft: false });
    return json({ ok: true });
  } catch (e) {
    console.error("mail-send", commId, String(e));
    await db.rpc("mail_mark_send_failed", { p_comm: commId, p_error: String(e) });
    return json({ error: "Svaret kunde inte skickas. Försök igen om en stund." }, 502);
  }
});
