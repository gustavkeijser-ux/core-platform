// =====================================================================
//  D2D-BEKRAFTELSE-NOTIS — påminnelse om Såld-sälj som säljaren markerat Ej bekräftad.
//
//  Körs av pg_cron var 15:e minut. Databasen avgör vad som ska skickas
//  (d2d_bekraftelse_underlag): sälj som varit Ej bekräftad i 18 h (typ 18h) och
//  36 h (typ 36h) utan att säljaren ändrat till Bekräftad. Varje påminnelse skickas
//  en gång (d2d_bekraftelse_klar). Ändrar säljaren till Bekräftad skickas inget mer.
//  Mottagare: säljaren båda gångerna; vid 36 h även admin (d2d_bekraftelse_mottagare).
//  Inget personnummer i mejlen.
//  Skickas via Microsoft Graph från ärendebrevlådan (saveToSentItems = false).
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
  id: string; ejTid: string; typ: "18h" | "36h"; kund: string | null; telefon: string | null; adress: string | null;
  saldDatum: string | null; saljare: string | null; saljareEpost: string | null;
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tid = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
};
const STIL = "font-family:Segoe UI,Calibri,Arial,sans-serif;font-size:14px;color:#14213D;line-height:1.5";
const knapp = (href: string, text: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#1E7A8C;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">${esc(text)}</a>`;

function fakta(rader: Array<[string, unknown]>) {
  return `<table style="border-collapse:collapse;margin:12px 0">${rader.filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#64748B;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${v}</td></tr>`)
    .join("")}</table>`;
}

function mejl(r: Rad, forSaljare: boolean) {
  const timmar = r.typ === "36h" ? 36 : 18;
  const lank = `${APP_URL}/#/d2d/lagenhet/${encodeURIComponent(r.id)}`;
  const rader: Array<[string, unknown]> = [
    ["Kund", esc(r.kund)], ["Telefon", esc(r.telefon)], ["Adress", esc(r.adress)],
    ...(forSaljare ? [] : [["Säljare", esc(r.saljare)] as [string, unknown]]),
    ["Ej bekräftad sedan", esc(tid(r.ejTid))],
  ];
  return {
    amne: `${r.typ === "36h" ? "Påminnelse 2" : "Påminnelse"}: säljet till ${r.kund ?? "kunden"} är fortfarande inte bekräftat`,
    html: `<div style="${STIL}">
      <p>${forSaljare
        ? `Säljet nedan markerades som <strong>Ej bekräftat</strong> för ${timmar} timmar sedan och är fortfarande inte ändrat till Bekräftat.`
        : `Säljet nedan har varit <strong>Ej bekräftat</strong> i ${timmar} timmar. Säljaren har fått två påminnelser.`}</p>
      ${fakta(rader)}
      <p style="color:#64748B">${forSaljare
        ? "Öppna kundkortet och tryck på Bekräftad när kunden bekräftat. Säljet räknas som väntande i pinnar och lön tills dess."
        : "Säljet räknas som väntande i pinnar och lön tills det ändras till Bekräftad."}</p>
      <p>${knapp(lank, "Öppna kundkortet")}</p></div>`,
  };
}

async function skicka(mailbox: string, till: string[], m: { amne: string; html: string }) {
  const res = await graph(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: m.amne,
        body: { contentType: "HTML", content: m.html },
        toRecipients: till.map((a) => ({ emailAddress: { address: a } })),
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

  const { data: tenants } = await db.from("d2d_bekraftelse_mottagare").select("tenant_id");
  const resultat: unknown[] = [];
  for (const t of tenants ?? []) {
    const { data: u, error } = await db.rpc("d2d_bekraftelse_underlag", { p_tenant: t.tenant_id });
    if (error || !u) { resultat.push({ tenant_id: t.tenant_id, fel: error?.message ?? "inget underlag" }); continue; }
    const lista = (u.lista ?? []) as Rad[];
    const admin = ((u.admin ?? []) as string[]).filter(Boolean);
    const utskick = lista.map((r) => ({
      r,
      saljare: r.saljareEpost ? [r.saljareEpost] : [],
      admin: r.typ === "36h" ? admin.filter((a) => a !== r.saljareEpost) : [],
    }));
    if (torr) {
      resultat.push({ tenant_id: t.tenant_id, torr: true,
        utskick: utskick.map((x) => ({ typ: x.r.typ, kund: x.r.kund, saljare: x.saljare, admin: x.admin, amne: mejl(x.r, true).amne })) });
      continue;
    }
    if (!utskick.length) { resultat.push({ tenant_id: t.tenant_id, skickade: 0 }); continue; }
    const { data: acc } = await db.from("mail_accounts").select("mailbox").eq("tenant_id", t.tenant_id).eq("is_active", true).limit(1).maybeSingle();
    if (!acc?.mailbox) { resultat.push({ tenant_id: t.tenant_id, fel: "ingen aktiv brevlåda" }); continue; }

    const klara: Array<{ id: string; ejTid: string; typ: string }> = []; const fel: string[] = [];
    for (const x of utskick) {
      try {
        if (x.saljare.length) await skicka(acc.mailbox, x.saljare, mejl(x.r, true));
        if (x.admin.length) await skicka(acc.mailbox, x.admin, mejl(x.r, false));
        klara.push({ id: x.r.id, ejTid: x.r.ejTid, typ: x.r.typ });
      } catch (e) {
        fel.push(`${x.r.typ} ${x.r.id}: ${String(e).slice(0, 200)}`);
      }
    }
    if (klara.length) await db.rpc("d2d_bekraftelse_klar", { p_rader: klara });
    if (fel.length) console.error("d2d-bekraftelse-notis", t.tenant_id, fel);
    resultat.push({ tenant_id: t.tenant_id, skickade: klara.length, fel });
  }
  return json({ ok: true, resultat });
});
