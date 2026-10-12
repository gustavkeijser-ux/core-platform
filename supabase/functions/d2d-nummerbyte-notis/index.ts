// =====================================================================
//  D2D-NUMMERBYTE-NOTIS — påminnelse om porteringar som snart måste vara inskickade.
//
//  Körs av pg_cron (05:05 och 11:05 UTC). Databasen avgör vad som ska skickas
//  (d2d_nummerbyte_notis_underlag): öppna nummerbyten med 2 arbetsdagar kvar till
//  "Senaste hantering" (typ 2d) och de med 1 arbetsdag kvar som fortfarande inte är
//  genomförda (typ 1d). Helger och svenska helgdagar räknas bort i databasen.
//  Mottagare: d2d_nummerbyte_notis_mottagare (Lukas) + ansvarig admin på ärendet.
//  Skickas via Microsoft Graph från ärendebrevlådan (mail_accounts), saveToSentItems = false
//  så mail-sync inte gör ärenden av dem. Därefter markeras (d2d_nummerbyte_notis_klar).
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
  ansvarigEpost: string | null; startdatum: string | null; senastDatum: string | null; arbetsdagarKvar: number;
  nummer: Array<{ typ: string; tillfalligt?: string; riktigt?: string; agare?: string }>;
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

function mejl(r: Rad) {
  const kvar = r.typ === "1d" ? "1 arbetsdag" : "2 arbetsdagar";
  const nummer = (r.nummer ?? []).map((n) =>
    `<li>${n.typ === "huvud" ? "Huvudnummer" : "Extraanvändare"}: <strong>${esc(n.riktigt || "—")}</strong>${n.agare ? ` (står på ${esc(n.agare)})` : ""}${n.tillfalligt ? ` — ersätter ${esc(n.tillfalligt)}` : ""}</li>`).join("");
  return {
    amne: `${r.typ === "1d" ? "SISTA DAGEN I MORGON" : "Påminnelse"}: portering för ${r.kund ?? "kund"} måste vara inskickad senast ${datum(r.senastDatum)}`,
    html: `<div style="${STIL}">
      <p>${r.typ === "1d"
        ? `<strong>Porteringen är fortfarande inte markerad som genomförd</strong> och måste vara inskickad senast <strong>${esc(datum(r.senastDatum))}</strong> — det är ${kvar} kvar.`
        : `Porteringen nedan måste vara inskickad senast <strong>${esc(datum(r.senastDatum))}</strong> — det är ${kvar} kvar (helger och helgdagar borträknade).`}</p>
      ${fakta([
        ["Kund", esc(r.kund)], ["Adress", esc(r.adress)], ["Säljare", esc(r.saljare)],
        ["Startdatum abonnemang", esc(datum(r.startdatum))], ["Senaste hantering", `<strong>${esc(datum(r.senastDatum))}</strong>`],
      ])}
      ${nummer ? `<p style="margin:4px 0">Nummer att portera in:</p><ul style="margin:4px 0 12px;padding-left:20px">${nummer}</ul>` : ""}
      <p style="color:#64748B">Innan porteringen: kontrollera i Telias SharePoint att ingen ånger eller avbeställning har kommit in. Markera sedan ärendet som genomfört i CRM:et så skickas inga fler påminnelser.</p>
      <p>${knapp(`${APP_URL}/#/nummerbyten`, "Öppna Nummerbyten i CRM")}</p></div>`,
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
    const { data: u, error } = await db.rpc("d2d_nummerbyte_notis_underlag", { p_tenant: t.tenant_id });
    if (error || !u) { resultat.push({ tenant_id: t.tenant_id, fel: error?.message ?? "inget underlag" }); continue; }
    const lista = (u.lista ?? []) as Rad[];
    const bas: string[] = (u.mottagare ?? []) as string[];
    const utskick = lista.map((r) => ({
      r, till: [...new Set([...bas, r.ansvarigEpost].filter((x): x is string => !!x))], mejl: mejl(r),
    }));
    if (torr) {
      resultat.push({ tenant_id: t.tenant_id, torr: true, idag: u.idag, utskick: utskick.map((x) => ({ typ: x.r.typ, kund: x.r.kund, till: x.till, amne: x.mejl.amne })) });
      continue;
    }
    if (!utskick.length) { resultat.push({ tenant_id: t.tenant_id, skickade: 0 }); continue; }
    const { data: acc } = await db.from("mail_accounts").select("mailbox").eq("tenant_id", t.tenant_id).eq("is_active", true).limit(1).maybeSingle();
    if (!acc?.mailbox) { resultat.push({ tenant_id: t.tenant_id, fel: "ingen aktiv brevlåda" }); continue; }

    const klara: Array<{ id: string; typ: string }> = []; const fel: string[] = [];
    for (const x of utskick) {
      try {
        if (x.till.length) await skicka(acc.mailbox, x.till, x.mejl);
        klara.push({ id: x.r.id, typ: x.r.typ });
      } catch (e) {
        fel.push(`${x.r.typ} ${x.r.id}: ${String(e).slice(0, 200)}`);
      }
    }
    if (klara.length) await db.rpc("d2d_nummerbyte_notis_klar", { p_rader: klara });
    if (fel.length) console.error("d2d-nummerbyte-notis", t.tenant_id, fel);
    resultat.push({ tenant_id: t.tenant_id, skickade: klara.length, fel });
  }
  return json({ ok: true, resultat });
});
