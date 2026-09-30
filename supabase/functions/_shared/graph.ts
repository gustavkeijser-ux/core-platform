// =====================================================================
//  Microsoft Graph – gemensamt för mail-sync och mail-send.
//
//  Autentisering: OAuth 2.0 client credentials (Microsoft Entra ID).
//  Secrets läses ENDAST från edge function-secrets, aldrig från frontend
//  eller databasen:
//    MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
//  Brevlådan (hyresgast@connectestate.se) konfigureras i mail_accounts.
//
//  Alla anrop använder ImmutableId så att ett meddelandes id inte ändras
//  när det flyttas mellan mappar — grunden för dedupliceringen.
// =====================================================================

export const GRAPH = "https://graph.microsoft.com/v1.0";

export function graphConfigured(): boolean {
  return !!(Deno.env.get("MICROSOFT_TENANT_ID") && Deno.env.get("MICROSOFT_CLIENT_ID")
    && Deno.env.get("MICROSOFT_CLIENT_SECRET"));
}

let cachedToken: { value: string; expires: number } | null = null;

export async function graphToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const tenant = Deno.env.get("MICROSOFT_TENANT_ID")!;
  const body = new URLSearchParams({
    client_id: Deno.env.get("MICROSOFT_CLIENT_ID")!,
    client_secret: Deno.env.get("MICROSOFT_CLIENT_SECRET")!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // Logga aldrig secrets — bara Microsofts felkod.
    throw new Error(`Inloggning mot Microsoft misslyckades (${res.status} ${json.error ?? ""}: ${String(json.error_description ?? "").split("\r\n")[0]})`);
  }
  cachedToken = { value: json.access_token, expires: Date.now() + (Number(json.expires_in ?? 3600) * 1000) };
  return cachedToken.value;
}

export class GraphError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Graph-anrop med omförsök vid 429/5xx (respekterar Retry-After). */
export async function graph(path: string, init: RequestInit & { prefer?: string[] } = {}, attempt = 0): Promise<Response> {
  const token = await graphToken();
  const url = path.startsWith("http") ? path : GRAPH + path;
  const prefer = ['IdType="ImmutableId"', ...(init.prefer ?? [])].join(", ");
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: prefer,
      ...(init.body && !(init.body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const wait = Math.min(Number(res.headers.get("Retry-After") ?? 0) * 1000 || 1000 * 2 ** attempt, 20_000);
    await new Promise((r) => setTimeout(r, wait));
    return graph(path, init, attempt + 1);
  }
  if (res.status === 401 && attempt === 0) {
    cachedToken = null;
    return graph(path, init, attempt + 1);
  }
  return res;
}

export async function graphJson<T = any>(path: string, init: RequestInit & { prefer?: string[] } = {}): Promise<T> {
  const res = await graph(path, init);
  if (res.status === 202 || res.status === 204) return {} as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GraphError(res.status, json?.error?.code ?? "", `Graph ${res.status} ${json?.error?.code ?? ""}: ${json?.error?.message ?? ""}`);
  }
  return json as T;
}

/** Enkel HTML → text (för sökning, förhandsvisning och tidslinjen). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${esc.replace(/\r?\n/g, "<br>")}</div>`;
}
