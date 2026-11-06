// =====================================================================
//  D2D-SMS-SKICKA — skickar ett SMS-utskick från Door to door → Kontaktlista
//  via LeadDesk (Original API, kommandot send_sms).
//
//  Frontend: d2d_sms_skapa() (urval, mall, avsändare → köade rader)
//            → invoke("d2d-sms-skicka", { utskickId }) tills kvar = 0
//  Här, med ANVÄNDARENS behörighet (d2d_kontakt_behorig i databasen):
//    1) d2d_sms_ta_rader: tar upp till 40 köade rader och märker dem
//       'skickar' — en rad skickas aldrig två gånger, även vid omförsök
//    2) LeadDesk send_sms per rad (ca 5 per sekund)
//    3) d2d_sms_rapportera: skickad/fel; skickade loggas på lägenheten
//  Varje anrop håller på högst ~45 s och svarar med hur många som är kvar.
//
//  Secrets (Supabase → Edge Functions → Secrets, läggs in av Gustav):
//    LEADDESK_API_AUTH  32 tecken, LeadDesk Admin → Settings → API, raden "(Original API)"
//    LEADDESK_API_URL   valfri, standard https://api.leaddesk.com/
//    LEADDESK_SMS_MOD   valfri, standard "call" (modulen som har send_sms)
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const FEL: Record<string, string> = {
  ERR_AUTHENTICATION: "LeadDesk godkände inte API-nyckeln",
  ERR_ARGUMENT_MISSING: "LeadDesk: obligatoriskt värde saknas",
  ERR_ARGUMENT_EMPTY: "LeadDesk: tomt värde",
  ERR_ARGUMENT_LENGTH: "LeadDesk: avsändare, nummer eller text har fel längd",
  ERR_INVALID_FORMAT: "LeadDesk: ogiltigt telefonnummer",
  ERR_SMS_FAILED: "LeadDesk kunde inte skicka SMS:et (avsändaren kan vara otillåten)",
  ERR_NO_SMS_PROVIDER: "SMS är inte aktiverat i LeadDesk (ingen SMS-leverantör vald)",
  ERR_NOT_SUPPORTED: "LeadDesk stöder inte anropet",
};
/** Fel som gäller alla rader — då avbryts utskicket i stället för att alla rader blir fel. */
const STOPPFEL = new Set(["ERR_AUTHENTICATION", "ERR_NO_SMS_PROVIDER", "ERR_NOT_SUPPORTED"]);

type Svar = { ok: boolean; kod?: string; fel?: string; data?: unknown };

async function skickaSms(auth: string, sender: string, receiver: string, message: string): Promise<Svar> {
  const bas = (Deno.env.get("LEADDESK_API_URL") || "https://api.leaddesk.com/").trim();
  const mod = (Deno.env.get("LEADDESK_SMS_MOD") || "call").trim();
  const url = new URL(bas);
  url.searchParams.set("auth", auth);
  url.searchParams.set("mod", mod);
  url.searchParams.set("cmd", "send_sms");
  const body = new URLSearchParams({ sender, receiver, message });
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, fel: `Kunde inte nå LeadDesk (${(e as Error).name})` };
  }
  const text = (await res.text()).trim();
  const kod = /ERR_[A-Z_]+/.exec(text)?.[0];
  if (!res.ok || kod) {
    return { ok: false, kod, fel: (kod && FEL[kod]) || `LeadDesk svarade ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
  }
  let data: unknown = text || null;
  try { data = text ? JSON.parse(text) : null; } catch { /* text */ }
  if (data && typeof data === "object" && (data as { success?: unknown }).success === false) {
    return { ok: false, fel: `LeadDesk: ${text.slice(0, 200)}`, data };
  }
  return { ok: true, data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Ej inloggad" }, 401);

  let utskickId = "";
  try { utskickId = String((await req.json()).utskickId ?? ""); } catch { /* */ }
  if (!/^[0-9a-f-]{36}$/.test(utskickId)) return json({ error: "Ogiltigt utskick" }, 400);

  const ldAuth = (Deno.env.get("LEADDESK_API_AUTH") ?? "").trim();
  if (!ldAuth) {
    return json({ error: "LeadDesk-nyckeln saknas (secret LEADDESK_API_AUTH). Inget har skickats." }, 503);
  }

  // Användarens behörighet gäller i alla databasanrop (security definer-funktionerna kontrollerar den).
  const db = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });

  const start = Date.now();
  let skickade = 0, fel = 0;
  let stopp: string | null = null;

  while (!stopp && Date.now() - start < 45_000) {
    const { data: tag, error: tagErr } = await db.rpc("d2d_sms_ta_rader", { p_utskick: utskickId, p_max: 40 });
    if (tagErr) return json({ error: tagErr.message }, tagErr.code === "42501" ? 403 : 400);
    const { avsandare, rader } = tag as { avsandare: string; rader: Array<{ id: string; telefon: string; text: string }> };
    if (!rader.length) break;

    for (const r of rader) {
      // Stoppfel: släpp tillbaka resten av raderna som fel med samma orsak (de kan skickas om i ett nytt utskick).
      const svar: Svar = stopp ? { ok: false, fel: stopp } : await skickaSms(ldAuth, avsandare, r.telefon, r.text);
      if (!svar.ok && svar.kod && STOPPFEL.has(svar.kod)) stopp = svar.fel ?? svar.kod;
      const { error: rapErr } = await db.rpc("d2d_sms_rapportera", {
        p_rad: r.id, p_ok: svar.ok, p_fel: svar.ok ? null : svar.fel ?? "Okänt fel",
        p_svar: svar.data === undefined ? null : { leaddesk: svar.data },
      });
      if (rapErr) console.error("d2d_sms_rapportera", r.id, rapErr.message);
      if (svar.ok) skickade++; else fel++;
      if (!stopp) await new Promise((ok) => setTimeout(ok, 200));
    }
  }

  const { data: status } = await db.rpc("d2d_sms_status", { p_utskick: utskickId });
  const s = (status ?? {}) as { koad?: number; skickar?: number };
  return json({ ok: !stopp, stopp, skickade, fel, kvar: stopp ? 0 : (s.koad ?? 0), status });
});
