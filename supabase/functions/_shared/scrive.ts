// =====================================================================
//  Scrive – gemensamt för scrive-sign och scrive-callback.
//
//  Autentisering: Scrives "personal access credentials" (OAuth 1.0
//  PLAINTEXT). Secrets läses ENDAST från edge function-secrets:
//    SCRIVE_API_TOKEN, SCRIVE_API_SECRET, SCRIVE_ACCESS_TOKEN,
//    SCRIVE_ACCESS_SECRET, SCRIVE_TEMPLATE_ID
//    (valfritt) SCRIVE_URL – standard https://scrive.com
//                            (testmiljö: https://api-testbed.scrive.com)
// =====================================================================
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SECRETS = ["SCRIVE_API_TOKEN", "SCRIVE_API_SECRET", "SCRIVE_ACCESS_TOKEN", "SCRIVE_ACCESS_SECRET", "SCRIVE_TEMPLATE_ID"];
export const SCRIVE_URL = (Deno.env.get("SCRIVE_URL") ?? "https://scrive.com").replace(/\/+$/, "");
const API = `${SCRIVE_URL}/api/v2`;

export function scriveMissing(): string[] {
  return SECRETS.filter((k) => !Deno.env.get(k));
}

function authHeader(): string {
  const e = (k: string) => Deno.env.get(k) ?? "";
  return `oauth_signature_method="PLAINTEXT", oauth_consumer_key="${e("SCRIVE_API_TOKEN")}", ` +
    `oauth_token="${e("SCRIVE_ACCESS_TOKEN")}", oauth_signature="${e("SCRIVE_API_SECRET")}&${e("SCRIVE_ACCESS_SECRET")}"`;
}

export class ScriveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Anrop mot Scrive. POST-data skickas som formulär (Scrive kräver det). */
export async function scrive(path: string, form?: Record<string, string>): Promise<Response> {
  const res = await fetch(API + path, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: authHeader(),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return res;
}

export async function scriveJson<T = any>(path: string, form?: Record<string, string>): Promise<T> {
  const res = await scrive(path, form);
  const text = await res.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* */ }
  if (!res.ok) {
    // Logga aldrig secrets — bara Scrives felmeddelande.
    const msg = j?.error_message ?? j?.error_type ?? text.slice(0, 300);
    throw new ScriveError(res.status, `Scrive ${res.status}: ${msg}`);
  }
  return j as T;
}

// ── Status och signerad PDF ─────────────────────────────────────────────

export const STATUS_FROM_SCRIVE: Record<string, string> = {
  preparation: "skapas",
  pending: "vantar",
  closed: "signerat",
  rejected: "avvisat",
  canceled: "avbrutet",
  timedout: "avbrutet",
  document_error: "fel",
};

/**
 * Hämtar avtalets aktuella läge från Scrive (litar aldrig på data i en
 * callback) och uppdaterar d2d_avtal. När det är signerat: spara PDF:en i
 * lagringen och notera signeringen på lägenheten.
 */
export async function syncAvtal(db: SupabaseClient, avtalId: string): Promise<Record<string, unknown>> {
  const { data: a } = await db.from("d2d_avtal").select("*").eq("id", avtalId).maybeSingle();
  if (!a) throw new Error("Avtalet finns inte");
  if (!a.scrive_document_id) return a;

  const doc = await scriveJson(`/documents/${encodeURIComponent(a.scrive_document_id)}/get`);
  const status = STATUS_FROM_SCRIVE[String(doc.status)] ?? a.status;
  const patch: Record<string, unknown> = { status, uppdaterad: new Date().toISOString() };

  if (status === "signerat" && !a.pdf_path) {
    const res = await scrive(`/documents/${encodeURIComponent(a.scrive_document_id)}/files/main/avtal.pdf`);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const path = `${a.tenant_id}/${a.lagenhet_id}/${a.scrive_document_id}.pdf`;
      const { error } = await db.storage.from("d2d-avtal").upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (!error) patch.pdf_path = path;
    }
    const signedAt = (doc.parties ?? []).map((p: any) => p.sign_time).filter(Boolean).sort().pop();
    patch.signerad = signedAt ?? new Date().toISOString();

    // Lägenheten: när och vilket Scrive-dokument. Ett Scrive-avtal är ett
    // avtalsförslag, inte ett sälj — såld datum och avtalsnummer rörs inte.
    const { data: lag } = await db.from("records").select("data").eq("id", a.lagenhet_id).maybeSingle();
    if (lag) {
      const d = (lag.data ?? {}) as Record<string, unknown>;
      const add: Record<string, unknown> = {
        scrive_dokument: String(a.scrive_document_id),
        scrive_signerad: String(patch.signerad).slice(0, 10),
      };
      await db.from("records").update({ data: { ...d, ...add } }).eq("id", a.lagenhet_id);
    }
  }
  await db.from("d2d_avtal").update(patch).eq("id", avtalId);
  return { ...a, ...patch };
}
