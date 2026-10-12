// =====================================================================
//  D2D-VT-NOTIS — påminnelse om signerade Scrive-avtal som snart måste beställas i VT.
//
//  Körs av pg_cron (05:10 och 11:10 UTC). Databasen avgör vad som ska skickas
//  (d2d_vt_notis_underlag): öppna VT-beställningar med 2 arbetsdagar kvar till
//  "Beställ senast" (typ 2d) och de med 1 arbetsdag kvar som fortfarande inte är
//  beställda (typ 1d). Aldrig efter att datumet passerat. Helger/helgdagar räknas bort.
//  Mottagare: d2d_nummerbyte_notis_mottagare (Lukas) + ansvarig admin, samt säljaren
//  (eget mejl med länk till D2D-sälj → Signerade).
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
  id: string; typ: "2d" | "1d"; kund: string | null; adress: string | null; saljare: string | null;
  saljareEpost: string | null; ansvarigEpost: string | null; harMobil: boolean;
  startdatum: string | null; mobilStartdatum: string | null; helstDatum: string | null; senastDatum: string | null;
  arbetsdagarKvar: number;
};

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const datum = (iso: string | null | undefined) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  const veckodag = new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("sv-SE", { weekday: "long" });
  return `${veckodag} ${d}/${m}/${y}`;
};
const STIL = "font-family:Segoe UI,Calibri,Arial,sans-serif;font-size:14px;color:#14213D;line-height:1.5";
const knapp = (href: string, text: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#1E7A8C;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">${esc(text)}</a>`;

function fakta(rader: Array<[string, unknown]>) {
  return `<table style="border-collapse:collapse;margin:12px 0">${rader.filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#64748B;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${v}</td></tr>`)
    .join("")}</table>`;
}

function kvarText(n: number) {
  return n <= 0 ? "i dag är sista dagen" : n === 1 ? "det är 1 arbetsdag kvar" : `det är ${n} arbetsdagar kvar`;
}

function mejl(r: Rad, forSaljare: boolean) {
  const lank = forSaljare ? `${APP_URL}/#/d2d/signerade` : `${APP_URL}/#/vtbestallningar`;
  return {
    amne: `${r.typ === "1d" ? "SISTA CHANSEN" : "Påminnelse"}: beställ avtalet för ${r.kund ?? "kunden"} i VT senast ${datum(r.senastDatum)}`,
    html: `<div style="${STIL}">
      <p>${r.typ === "1d" ? "<strong>Avtalet är fortfarande inte markerat som beställt i VT.</strong> " : ""}Det signerade avtalet nedan måste beställas i VT senast <strong>${esc(datum(r.senastDatum))}</strong> — ${kvarText(r.arbetsdagarKvar)} (helger och helgdagar borträknade).</p>
      ${fakta([
        ["Kund", esc(r.kund)], ["Adress", esc(r.adress)], ["Säljare", esc(r.saljare)],
        ["Startdatum tjänst", esc(datum(r.startdatum))],
        ...(r.harMobil ? [["Mobil, startdatum", esc(datum(r.mobilStartdatum ?? r.startdatum))] as [string, unknown]] : []),
        ...(r.helstDatum && r.helstDatum !== r.senastDatum ? [["Beställ helst senast", esc(datum(r.helstDatum))] as [string, unknown]] : []),
        ["Beställ senast", `<strong>${esc(datum(r.senastDatum))}</strong>`],
      ])}
      <p style="color:#64748B">${r.harMobil ? "Mobilabonnemang: avtalet ska skickas via VT senast 30 dagar före startdatum, helst 45. " : "Avtalet ska skickas in senast 30 dagar före startdatum. "}Markera beställningen som "Beställd i VT" när den är gjord, så skickas inga fler påminnelser.</p>
      <p>${knapp(lank, forSaljare ? "Öppna Signerade i D2D-sälj" : "Öppna VT-beställningar i CRM")}</p></div>`,
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

  const { data: tenants } = await db.from("d2d_nummerbyte_notis_mottagare").select("tenant_id, epost");
  const resultat: unknown[] = [];
  for (const t of tenants ?? []) {
    const { data: u, error } = await db.rpc("d2d_vt_notis_underlag", { p_tenant: t.tenant_id });
    if (error || !u) { resultat.push({ tenant_id: t.tenant_id, fel: error?.message ?? "inget underlag" }); continue; }
    const lista = (u.lista ?? []) as Rad[];
    const bas: string[] = (u.mottagare ?? []) as string[];
    const utskick = lista.map((r) => {
      const admin = [...new Set([...bas, r.ansvarigEpost].filter((x): x is string => !!x))];
      const saljare = r.saljareEpost && !admin.includes(r.saljareEpost) ? r.saljareEpost : null;
      return { r, admin, saljare, mejlAdmin: mejl(r, false), mejlSaljare: mejl(r, true) };
    });
    if (torr) {
      resultat.push({ tenant_id: t.tenant_id, torr: true, idag: u.idag,
        utskick: utskick.map((x) => ({ typ: x.r.typ, kund: x.r.kund, admin: x.admin, saljare: x.saljare, amne: x.mejlAdmin.amne })) });
      continue;
    }
    if (!utskick.length) { resultat.push({ tenant_id: t.tenant_id, skickade: 0 }); continue; }
    const { data: acc } = await db.from("mail_accounts").select("mailbox").eq("tenant_id", t.tenant_id).eq("is_active", true).limit(1).maybeSingle();
    if (!acc?.mailbox) { resultat.push({ tenant_id: t.tenant_id, fel: "ingen aktiv brevlåda" }); continue; }

    const klara: Array<{ id: string; typ: string }> = []; const fel: string[] = [];
    for (const x of utskick) {
      try {
        if (x.admin.length) await skicka(acc.mailbox, x.admin, x.mejlAdmin);
        if (x.saljare) await skicka(acc.mailbox, [x.saljare], x.mejlSaljare);
        klara.push({ id: x.r.id, typ: x.r.typ });
      } catch (e) {
        fel.push(`${x.r.typ} ${x.r.id}: ${String(e).slice(0, 200)}`);
      }
    }
    if (klara.length) await db.rpc("d2d_vt_notis_klar", { p_rader: klara });
    if (fel.length) console.error("d2d-vt-notis", t.tenant_id, fel);
    resultat.push({ tenant_id: t.tenant_id, skickade: klara.length, fel });
  }
  return json({ ok: true, resultat });
});
