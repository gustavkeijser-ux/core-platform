// =====================================================================
//  FELANMALAN-NOTIS — mejl för felanmälningar från D2D (körs var 5:e minut via pg_cron).
//
//  Underlaget kommer från felanmalan_notis_underlag (databasen avgör vad som ska skickas):
//    nya        → ansvarig + bevakare: "Ny felanmälan CE-…"
//    sla        → ansvarig + bevakare: "Försenad felanmälan CE-…"
//    andringar  → bevakare: vad som ändrats sedan förra körningen
//    vecka      → bevakare (måndagar efter 07): alla öppna felanmälningar per projekt
//  Skickas via Microsoft Graph från ärendebrevlådan (mail_accounts) med saveToSentItems = false,
//  så mail-sync aldrig gör ärenden av dem. Svar går till standardbevakarna (Lukas).
//  Därefter markeras utskicken (felanmalan_notis_klar) så inget skickas två gånger.
//  Skydd: x-cron-token mot vault-hemligheten mail_sync_cron_token. Body {"torr": true} = skicka inget,
//  returnera bara vad som skulle ha skickats.
// =====================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { graph, graphConfigured } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://crm.connectestate.se";
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Kort = {
  id: string; nr: string | null; rubrik: string | null; kategori: string | null; underkategori: string | null;
  plats: string | null; projekt: string | null; status: string; statusLabel: string; prioritet: string;
  ansvarig: string | null; anmaldAv: string | null; telia: string | null; deadline: string | null;
  skapad: string; dagar: number; beskrivning: string | null; mottagare?: string[];
  handelser?: Array<{ text: string | null; vem: string | null; nar: string }>;
};

const PRIO: Record<string, string> = { normal: "Normal", high: "Hög", critical: "Kritisk", urgent: "Akut" };
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tid = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "medium", timeStyle: "short" }) : "—";
const lank = (k: Kort) => `${APP_URL}/#/arende/${k.id}`;
/** Rubriken är "<underkategori> – <adress>"; adressen visas för sig. */
const adress = (k: Kort) => (k.rubrik ?? "").split(" – ").slice(1).join(" – ") || k.plats || "—";

const STIL = "font-family:Segoe UI,Calibri,Arial,sans-serif;font-size:14px;color:#14213D;line-height:1.5";
const knapp = (href: string, text: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#1E7A8C;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">${esc(text)}</a>`;

function fakta(rader: Array<[string, unknown]>) {
  return `<table style="border-collapse:collapse;margin:12px 0">${rader.filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0;color:#64748B;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

function kortFakta(k: Kort) {
  return fakta([
    ["Fel", [k.kategori, k.underkategori].filter(Boolean).join(" – ")],
    ["Adress", adress(k)],
    ["Projekt", k.projekt],
    ["Anmäld av", k.anmaldAv],
    ["Ansvarig", k.ansvarig ?? "Ej tilldelad"],
    ["Prioritet", PRIO[k.prioritet] ?? k.prioritet],
    ["Status", k.statusLabel],
    ["Telia-ärende", k.telia],
    ["Lösning senast", k.status === "waiting_telia" ? "Pausad (väntar på Telia)" : tid(k.deadline)],
  ]);
}

function mejlNy(k: Kort) {
  return {
    amne: `Ny felanmälan ${k.nr ?? ""}: ${k.underkategori ?? "Fel"} – ${adress(k)}`,
    html: `<div style="${STIL}"><p>En säljare har gjort en felanmälan i Door to door.</p>${kortFakta(k)}
      ${k.beskrivning ? `<p style="background:#F8F9FB;border-left:3px solid #1E7A8C;padding:8px 12px;margin:12px 0">${esc(k.beskrivning).replace(/\n/g, "<br>")}</p>` : ""}
      <p>${knapp(lank(k), "Öppna i CRM")}</p></div>`,
  };
}

function mejlSla(k: Kort) {
  return {
    amne: `Försenad felanmälan ${k.nr ?? ""}: ${k.underkategori ?? "Fel"} – ${adress(k)}`,
    html: `<div style="${STIL}"><p><strong>Felanmälan har passerat sin deadline</strong> (${esc(tid(k.deadline))}) och är inte löst.</p>${kortFakta(k)}
      <p>Väntar ni på Telia: sätt statusen "Väntar på Telia" och fyll i Telias ärendenummer — då står klockan still.</p>
      <p>${knapp(lank(k), "Öppna i CRM")}</p></div>`,
  };
}

function mejlAndring(k: Kort) {
  const rader = (k.handelser ?? []).map((h) =>
    `<li>${esc(h.text ?? "Ändring")} <span style="color:#64748B">— ${esc(h.vem ?? "systemet")}, ${esc(tid(h.nar))}</span></li>`).join("");
  return {
    amne: `Uppdaterad felanmälan ${k.nr ?? ""}: ${k.statusLabel} – ${adress(k)}`,
    html: `<div style="${STIL}"><p>Felanmälan du bevakar har ändrats:</p><ul style="margin:8px 0 12px;padding-left:20px">${rader}</ul>${kortFakta(k)}
      <p>${knapp(lank(k), "Öppna i CRM")}</p></div>`,
  };
}

function mejlVecka(lista: Kort[]) {
  const perProjekt = new Map<string, Kort[]>();
  for (const k of lista) {
    const p = k.projekt ?? "Utan projekt";
    perProjekt.set(p, [...(perProjekt.get(p) ?? []), k]);
  }
  const forsenade = lista.filter((k) => k.status !== "waiting_telia" && k.deadline && new Date(k.deadline) < new Date()).length;
  const telia = lista.filter((k) => k.status === "waiting_telia").length;
  const th = (t: string) => `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #E2E8F0;color:#64748B;font-weight:600">${t}</th>`;
  const td = (t: string, extra = "") => `<td style="padding:6px 10px;border-bottom:1px solid #E2E8F0;vertical-align:top${extra}">${t}</td>`;
  const tabeller = [...perProjekt.entries()].map(([p, rader]) => `
    <h3 style="margin:20px 0 6px;font-size:15px">${esc(p)} <span style="color:#64748B;font-weight:400">· ${rader.length} öppna</span></h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <tr>${th("Ärende")}${th("Fel")}${th("Adress")}${th("Ansvarig")}${th("Status")}${th("Ålder")}</tr>
      ${rader.map((k) => {
        const sen = k.status !== "waiting_telia" && k.deadline && new Date(k.deadline) < new Date();
        return `<tr>${td(`<a href="${esc(lank(k))}" style="color:#1E7A8C">${esc(k.nr)}</a>`)}${td(esc(k.underkategori))}${td(esc(adress(k)))}${td(esc(k.ansvarig ?? "Ej tilldelad"))}${td(esc(k.statusLabel) + (k.telia ? `<br><span style="color:#64748B">Telia ${esc(k.telia)}</span>` : "") + (sen ? `<br><span style="color:#DC2626;font-weight:600">Försenad</span>` : ""))}${td(`${k.dagar} d`, ";white-space:nowrap")}</tr>`;
      }).join("")}
    </table>`).join("");
  return {
    amne: `Veckans felanmälningar: ${lista.length} öppna${forsenade ? `, ${forsenade} försenade` : ""}`,
    html: `<div style="${STIL}"><p>Öppna felanmälningar från Door to door, per projekt.</p>
      <p><strong>${lista.length}</strong> öppna · <strong>${forsenade}</strong> försenade · <strong>${telia}</strong> väntar på Telia</p>
      ${lista.length ? tabeller : "<p>Inga öppna felanmälningar. 🎉</p>"}
      <p style="margin-top:20px">${knapp(`${APP_URL}/#/arenden/felanmalan`, "Alla felanmälningar i CRM")}</p></div>`,
  };
}

async function skicka(mailbox: string, till: string[], svaraTill: string[], m: { amne: string; html: string }) {
  const res = await graph(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: m.amne,
        body: { contentType: "HTML", content: m.html },
        toRecipients: till.map((a) => ({ emailAddress: { address: a } })),
        replyTo: svaraTill.map((a) => ({ emailAddress: { address: a } })),
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

  const { data: inst } = await db.from("case_felanmalan_installningar").select("tenant_id");
  const resultat: unknown[] = [];
  for (const { tenant_id } of inst ?? []) {
    const { data: u, error } = await db.rpc("felanmalan_notis_underlag", { p_tenant: tenant_id });
    if (error || !u) { resultat.push({ tenant_id, fel: error?.message ?? "inget underlag" }); continue; }
    const { data: acc } = await db.from("mail_accounts").select("mailbox").eq("tenant_id", tenant_id).eq("is_active", true).limit(1).maybeSingle();
    const svaraTill: string[] = u.svaraTill ?? [];

    const utskick: Array<{ typ: string; id?: string; till: string[]; mejl: { amne: string; html: string } }> = [];
    for (const k of (u.nya ?? []) as Kort[]) utskick.push({ typ: "ny", id: k.id, till: k.mottagare ?? [], mejl: mejlNy(k) });
    for (const k of (u.sla ?? []) as Kort[]) utskick.push({ typ: "sla", id: k.id, till: k.mottagare ?? [], mejl: mejlSla(k) });
    for (const k of (u.andringar ?? []) as Kort[]) {
      if ((k.mottagare ?? []).length) utskick.push({ typ: "andring", id: k.id, till: k.mottagare ?? [], mejl: mejlAndring(k) });
    }
    if (u.vecka) utskick.push({ typ: "vecka", till: u.vecka.mottagare ?? [], mejl: mejlVecka(u.vecka.lista ?? []) });

    if (torr) {
      resultat.push({ tenant_id, torr: true, utskick: utskick.map((x) => ({ typ: x.typ, till: x.till, amne: x.mejl.amne })) });
      continue;
    }
    if (!acc?.mailbox) { resultat.push({ tenant_id, fel: "ingen aktiv brevlåda" }); continue; }

    const nya: string[] = []; const sla: Array<{ id: string; deadline: string }> = []; const fel: string[] = [];
    let vecka = false;
    for (const x of utskick) {
      try {
        if (x.till.length) await skicka(acc.mailbox, x.till, svaraTill, x.mejl);
        if (x.typ === "ny" && x.id) nya.push(x.id);
        if (x.typ === "sla" && x.id) sla.push({ id: x.id, deadline: ((u.sla ?? []) as Kort[]).find((k) => k.id === x.id)?.deadline ?? "" });
        if (x.typ === "vecka") vecka = true;
      } catch (e) {
        fel.push(`${x.typ} ${x.id ?? ""}: ${String(e).slice(0, 200)}`);
      }
    }
    // Ändringar markeras alltid som hanterade (tidsstämpeln flyttas fram) — annars skickas de om och om igen.
    await db.rpc("felanmalan_notis_klar", { p_tenant: tenant_id, p_nya: nya, p_sla: sla, p_nu: u.nu, p_vecka: vecka });
    if (fel.length) console.error("felanmalan-notis", tenant_id, fel);
    resultat.push({ tenant_id, skickade: utskick.length - fel.length, fel });
  }
  return json({ ok: true, resultat });
});
