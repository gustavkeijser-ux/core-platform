// =====================================================================
//  D2D-TELIA-PAMINNELSE — påminnelse den 15:e om att ladda upp Telias orderfil.
//
//  Körs av pg_cron (06:30 UTC den 15:e, reserv den 16:e). Databasen avgör vad som
//  ska skickas (d2d_telia_paminnelse_underlag): från den 15:e, för föregående månad,
//  bara om ingen orderfil är inläst för den månaden och mottagaren inte redan fått
//  mejlet (d2d_telia_paminnelse). Mottagare: d2d_telia_paminnelse_mottagare (Gustav).
//  Mejlet innehåller vilken månad filen avser och en direktlänk till uppladdningen
//  (Door to door → Utfall → Telia-avstämning).
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

const MANAD = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const manadNamn = (iso: string) => { const [y, m] = iso.slice(0, 7).split("-"); return `${MANAD[Number(m) - 1] ?? m} ${y}`; };
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const STIL = "font-family:Segoe UI,Calibri,Arial,sans-serif;font-size:14px;color:#14213D;line-height:1.5";
const knapp = (href: string, text: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#1E7A8C;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">${esc(text)}</a>`;

function mejl(manad: string) {
  const lank = `${APP_URL}/#/d2dutfall?flik=telia&manad=${manad.slice(0, 7)}`;
  const namn = manadNamn(manad);
  return {
    amne: `Dags att ladda upp Telias orderfil för ${namn}`,
    html: `<div style="${STIL}">
      <p>Telias orderfil för <strong>${esc(namn)}</strong> är inte inläst i CRM:et ännu. Ladda upp den under Door to door → Utfall → Telia-avstämning när den har kommit, så stäms månadens försäljning av mot Telia och nyckeltalen per säljare räknas fram.</p>
      <p>${knapp(lank, `Ladda upp orderfilen för ${namn}`)}</p>
      <p style="color:#64748B">Välj filen (VT-exporten som xlsx, csv eller text), kontrollera att "Filen avser" visar ${esc(namn)} och klicka på "Läs in och stäm av". Personnummer i filen läses inte in.</p></div>`,
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
  try { b = await req.json(); } catch { /* tom body */ }
  const torr = b.torr === true;
  if (!torr && !graphConfigured()) return json({ error: "Microsoft 365 är inte konfigurerat" }, 500);

  const { data: tenants } = await db.from("d2d_telia_paminnelse_mottagare").select("tenant_id");
  const resultat: unknown[] = [];
  for (const t of [...new Set((tenants ?? []).map((x) => x.tenant_id as string))]) {
    const { data: u, error } = await db.rpc("d2d_telia_paminnelse_underlag", { p_tenant: t });
    if (error || !u) { resultat.push({ tenant_id: t, fel: error?.message ?? "inget underlag" }); continue; }
    const mottagare = (u.mottagare ?? []) as string[];
    const m = mejl(u.manad as string);
    if (torr) { resultat.push({ tenant_id: t, torr: true, idag: u.idag, manad: u.manad, harFil: u.harFil, mottagare, amne: m.amne }); continue; }
    if (!mottagare.length) { resultat.push({ tenant_id: t, skickade: 0, harFil: u.harFil }); continue; }
    const { data: acc } = await db.from("mail_accounts").select("mailbox").eq("tenant_id", t).eq("is_active", true).limit(1).maybeSingle();
    if (!acc?.mailbox) { resultat.push({ tenant_id: t, fel: "ingen aktiv brevlåda" }); continue; }
    try {
      await skicka(acc.mailbox, mottagare, m);
      await db.rpc("d2d_telia_paminnelse_klar", { p_tenant: t, p_manad: u.manad, p_epost: mottagare });
      resultat.push({ tenant_id: t, skickade: mottagare.length, manad: u.manad });
    } catch (e) {
      console.error("d2d-telia-paminnelse", t, String(e));
      resultat.push({ tenant_id: t, fel: String(e).slice(0, 200) });
    }
  }
  return json({ ok: true, resultat });
});
