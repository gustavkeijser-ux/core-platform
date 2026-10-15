// =====================================================================
//  D2D-KUNDTJANST-NOTIS — mejl till säljaren när kundtjänst lämnar en affär.
//
//  Anropas direkt av d2d_kundtjanst_lamna (pg_net) och som reserv av pg_cron
//  var 5:e minut. Databasen avgör vad som ska skickas (d2d_kundtjanst_notis_underlag:
//  väntande rader i kön d2d_kundtjanst_notis, max 5 försök, 24 h).
//  Mottagare: säljarens e-post (users.email). Innehåll: kund, adress, telefon,
//  meddelandet från kundtjänst och en knapp till kundkortet i D2D-sälj.
//  Skickas via Microsoft Graph från ärendebrevlådan (mail_accounts),
//  saveToSentItems = false så mail-sync inte gör ärenden av dem.
//  Skydd: x-cron-token mot vault-hemligheten mail_sync_cron_token.
//  Body {"torr": true} = skicka inget, returnera bara vad som skulle ha skickats.
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { graph, graphConfigured } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://crm.connectestate.se";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Rad = {
  id: string; tenantId: string; lagenhetId: string;
  saljare: string | null; saljareEpost: string | null; kundtjanst: string | null; meddelande: string | null;
  kund: string | null; telefon: string | null; epost: string | null; adress: string | null; lgh: string | null;
  pinnar: number | null; lamnad: string;
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const STIL = "font-family:Segoe UI,Calibri,Arial,sans-serif;font-size:14px;color:#14213D;line-height:1.5";
const knapp = (href: string, text: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#1E7A8C;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${esc(text)}</a>`;

function fakta(rader: Array<[string, string | null | undefined]>) {
  return `<table style="border-collapse:collapse;margin:12px 0">${rader.filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#64748B;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${v}</td></tr>`)
    .join("")}</table>`;
}

function mejl(r: Rad) {
  const lank = `${APP_URL}/#/d2d/lagenhet/${encodeURIComponent(r.lagenhetId)}/-/kundtjanst`;
  const adress = [r.adress, r.lgh ? `lgh ${r.lgh}` : null].filter(Boolean).join(", ");
  const tel = r.telefon ? `<a href="tel:${esc(r.telefon.replace(/[^\d+]/g, ""))}" style="color:#1E7A8C">${esc(r.telefon)}</a>` : null;
  return {
    amne: `Ny affär från kundtjänst: ${r.kund || adress || "ny kund"}`,
    html: `<div style="${STIL}">
      <p>Hej ${esc(r.saljare ?? "")}!</p>
      <p><strong>${esc(r.kundtjanst ?? "Kundtjänst")}</strong> har tagit emot en affär och lämnat den till dig.
      Ring kunden, validera tjänsterna och signera — Såld eller Signera med Scrive.</p>
      ${fakta([
        ["Kund", esc(r.kund)], ["Telefon", tel], ["E-post", esc(r.epost)], ["Adress", esc(adress)],
        ["Från kundtjänst", r.meddelande ? `<em>${esc(r.meddelande)}</em>` : null],
      ])}
      <p>${knapp(lank, "Öppna kundkortet")}</p>
      <p style="color:#64748B;font-size:12px">Du hittar alla affärer från kundtjänst i D2D-sälj under Alla lägenheter → Sälj från kundtjänst.</p></div>`,
  };
}

async function skicka(mailbox: string, till: string, m: { amne: string; html: string }) {
  const res = await graph(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: m.amne,
        body: { contentType: "HTML", content: m.html },
        toRecipients: [{ emailAddress: { address: till } }],
        importance: "high",
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok && res.status !== 202) throw new Error(`Graph ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

Deno.serve(async (req: Request) => {
  const tok = req.headers.get("x-cron-token") ?? "";
  const { data: ok } = tok ? await db.rpc("mail_check_cron_token", { p_token: tok }) : { data: false };
  if (!ok) return json({ error: "Ej behörig" }, 401);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* */ }
  const torr = b.torr === true;
  if (!torr && !graphConfigured()) return json({ error: "Microsoft 365 är inte konfigurerat" }, 500);

  const { data, error } = await db.rpc("d2d_kundtjanst_notis_underlag");
  if (error) return json({ error: error.message }, 500);
  const lista = (data ?? []) as Rad[];
  if (torr) return json({ ok: true, torr: true, utskick: lista.map((r) => ({ id: r.id, till: r.saljareEpost, amne: mejl(r).amne })) });
  if (!lista.length) return json({ ok: true, skickade: 0 });

  const brevlador = new Map<string, string | null>();
  const klara: Array<{ id: string; fel?: string }> = [];
  for (const r of lista) {
    try {
      if (!r.saljareEpost) throw new Error("säljaren saknar e-post");
      if (!brevlador.has(r.tenantId)) {
        const { data: acc } = await db.from("mail_accounts").select("mailbox").eq("tenant_id", r.tenantId).eq("is_active", true).limit(1).maybeSingle();
        brevlador.set(r.tenantId, acc?.mailbox ?? null);
      }
      const mailbox = brevlador.get(r.tenantId);
      if (!mailbox) throw new Error("ingen aktiv brevlåda");
      await skicka(mailbox, r.saljareEpost, mejl(r));
      klara.push({ id: r.id });
    } catch (e) {
      klara.push({ id: r.id, fel: String(e).slice(0, 300) });
    }
  }
  await db.rpc("d2d_kundtjanst_notis_klar", { p_rader: klara });
  const fel = klara.filter((k) => k.fel);
  if (fel.length) console.error("d2d-kundtjanst-notis", fel);
  return json({ ok: true, skickade: klara.length - fel.length, fel });
});
