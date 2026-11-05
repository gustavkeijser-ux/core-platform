// =====================================================================
//  SCRIVE-CALLBACK — Scrive meddelar att ett avtal ändrats (signerat,
//  avvisat, avbrutet) — även orderbekräftelser (?o=). Ingen inloggning: adressen innehåller avtalets id
//  och en slumpad nyckel per avtal (d2d_avtal.callback_token). Innehållet
//  i anropet används inte — läget hämtas alltid från Scrive (syncAvtal).
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { scriveMissing, syncAvtal, syncOrder } from "../_shared/scrive.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  // Orderbekräftelse (?o=…): samma kontroll mot d2d_orderbekraftelse.
  const orderId = url.searchParams.get("o") ?? "";
  if (orderId) {
    const token = url.searchParams.get("t") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(orderId) || !token) return new Response("bad request", { status: 400 });
    const { data: o } = await db.from("d2d_orderbekraftelse").select("id, callback_token").eq("id", orderId).maybeSingle();
    if (!o || !safeEqual(String(o.callback_token), token)) return new Response("not found", { status: 404 });
    if (scriveMissing().some((k) => k !== "SCRIVE_TEMPLATE_ID")) return new Response("not configured", { status: 503 });
    try { await syncOrder(db, orderId); return new Response("ok"); }
    catch (e) { console.error("scrive-callback order", orderId, String(e)); return new Response("error", { status: 500 }); }
  }
  const id = url.searchParams.get("a") ?? "";
  const token = url.searchParams.get("t") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id) || !token) return new Response("bad request", { status: 400 });

  const { data: a } = await db.from("d2d_avtal").select("id, callback_token").eq("id", id).maybeSingle();
  if (!a || !safeEqual(String(a.callback_token), token)) return new Response("not found", { status: 404 });
  if (scriveMissing().length) return new Response("not configured", { status: 503 });

  try {
    await syncAvtal(db, id);
    return new Response("ok");
  } catch (e) {
    console.error("scrive-callback", id, String(e));
    // 5xx → Scrive försöker igen senare.
    return new Response("error", { status: 500 });
  }
});
