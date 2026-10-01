import { supabase } from "@/integrations/supabase/client";
import { DataError } from "@/lib/data";

/**
 * Ärendehantering (v1: e-post via hyresgast@connectestate.se).
 * Ärenden är vanliga poster av typen "case"; allt ärendespecifikt går via
 * RPC:erna i migration 0030–0033 så att behörighet, audit och SLA hanteras
 * på ett ställe i databasen.
 */

const fail = (e: { code?: string; message: string }): never => {
  const kind =
    e.code === "22023" ? "invalid" :
    e.code === "42501" || e.code === "PGRST301" ? "forbidden" :
    e.code === "P0002" ? "not_found" : "unknown";
  throw new DataError(kind, e.message);
};

export type CaseFilter =
  | "open" | "all" | "new" | "mine" | "unassigned" | "in_progress"
  | "waiting_customer" | "waiting_internal" | "waiting_contractor"
  | "resolved" | "closed" | "overdue";

export type SlaState = "ok" | "warning" | "breached" | "met" | null;
export type CasePriority = "normal" | "high" | "critical" | "urgent";

export const PRIORITIES: Array<{ key: CasePriority; label: string }> = [
  { key: "normal", label: "Normal" },
  { key: "high", label: "Hög" },
  { key: "critical", label: "Kritisk" },
  { key: "urgent", label: "Akut" },
];
export const priorityLabel = (p: string | null | undefined) =>
  PRIORITIES.find((x) => x.key === p)?.label ?? "Normal";

export const SOURCE_LABEL: Record<string, string> = {
  email: "E-post", phone: "Telefon", app: "App", web: "Webb", sms: "SMS",
  internal: "Intern", api: "API", partner: "Partner",
};

export type CaseListItem = {
  id: string; caseNumber: string | null; title: string | null; status: string;
  priority: CasePriority; category: string | null; subcategory: string | null;
  categoryLabel: string | null; subcategoryLabel: string | null;
  kundEpost: string | null; fastighet: string | null; lagenhet: string | null;
  ownerUserId: string | null; channel: string | null;
  lastActivityAt: string | null; createdAt: string; sla: SlaState; nextDue: string | null;
  firstResponseAt: string | null; preview: string | null; lastDirection: "inbound" | "outbound" | null;
};

export type CaseCounts = Record<CaseFilter, number>;

export async function listCases(filter: CaseFilter, search: string, limit = 50, offset = 0) {
  const { data, error } = await supabase.rpc("list_cases", {
    p_filter: filter, p_search: search.trim() || null, p_limit: limit, p_offset: offset,
  });
  if (error) fail(error);
  return data as { items: CaseListItem[]; total: number; counts: CaseCounts };
}

export type CaseAttachment = {
  id: string; name: string; mimeType: string | null; sizeBytes: number | null;
  storagePath: string | null; blockedReason: string | null; sender: string | null; receivedAt: string | null;
};
export type CaseMessage = {
  id: string; channel: "email" | "internal_note" | string; direction: "inbound" | "outbound" | "internal";
  subject: string | null; bodyText: string | null; hasHtml: boolean;
  from: string | null; to: string[]; cc: string[]; occurredAt: string; authorUserId: string | null;
  sendStatus: "pending" | "sending" | "sent" | "failed" | null; sendError: string | null;
  attachments: CaseAttachment[];
};
export type CaseEvent = {
  id: string; type: string; body: string | null; actorUserId: string | null; actorKind: string; occurredAt: string;
};
export type CaseDetail = {
  case: {
    id: string; status: string; owner_user_id: string | null; created_at: string; updated_at: string;
    data: Record<string, any>;
  };
  canUpdate: boolean;
  categoryLabel: string | null; subcategoryLabel: string | null;
  sla: { firstResponse: SlaState; resolution: SlaState };
  messages: CaseMessage[];
  events: CaseEvent[];
  related: Array<{ relType: string; label: string; id: string; objectType: string; title: string | null; status: string | null }>;
  otherCases: Array<{ id: string; caseNumber: string; title: string; status: string; createdAt: string }>;
};

export async function getCase(id: string) {
  const { data, error } = await supabase.rpc("get_case", { p_case: id });
  if (error) fail(error);
  return data as CaseDetail;
}

export async function caseSet(id: string, p: {
  status?: string; priority?: string; category?: string; subcategory?: string;
  ansvarig?: string; unassign?: boolean; team?: string;
}) {
  const { error } = await supabase.rpc("case_set", {
    p_case: id, p_status: p.status ?? null, p_priority: p.priority ?? null,
    p_category: p.category ?? null, p_subcategory: p.subcategory ?? null,
    p_ansvarig: p.ansvarig ?? null, p_unassign: !!p.unassign, p_team: p.team ?? null,
  });
  if (error) fail(error);
}

export async function caseAddNote(id: string, body: string) {
  const { error } = await supabase.rpc("case_add_note", { p_case: id, p_body: body });
  if (error) fail(error);
}

/** Spara svaret (behörighet kontrolleras i databasen) och skicka via Microsoft 365. */
export async function caseReply(id: string, body: string, nextStatus?: string | null): Promise<{ sent: boolean; message?: string }> {
  const { data: commId, error } = await supabase.rpc("case_queue_reply", {
    p_case: id, p_body: body, p_next_status: nextStatus ?? null,
  });
  if (error) fail(error);
  return sendQueued(commId as string);
}

export async function sendQueued(commId: string): Promise<{ sent: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke("mail-send", { body: { communicationId: commId } });
  if (error) {
    let msg = "Svaret är sparat men kunde inte skickas ännu.";
    try {
      const j = await (error as { context?: Response }).context?.json();
      if (j?.error) msg = j.error;
    } catch { /* */ }
    return { sent: false, message: msg };
  }
  return { sent: !!(data as { ok?: boolean })?.ok };
}

export async function getMessageHtml(commId: string) {
  const { data, error } = await supabase.rpc("get_message_html", { p_comm: commId });
  if (error) fail(error);
  return (data as string | null) ?? "";
}

/** Kortlivad nedladdningslänk. Filen laddas alltid ned — öppnas aldrig i webbläsaren. */
export async function attachmentUrl(a: CaseAttachment) {
  if (!a.storagePath) throw new DataError("not_found", "Bilagan finns inte lagrad.");
  const { data, error } = await supabase.storage.from("case-attachments")
    .createSignedUrl(a.storagePath, 60, { download: a.name });
  if (error || !data) throw new DataError("forbidden", "Kunde inte hämta bilagan.");
  return data.signedUrl;
}

export type CaseCategory = { key: string; parent_key: string | null; label: string; sort_order: number };
let catCache: Promise<CaseCategory[]> | null = null;
export function caseCategories() {
  if (!catCache) {
    catCache = (async () => {
      const { data, error } = await supabase.from("case_categories")
        .select("key,parent_key,label,sort_order").eq("is_active", true).order("sort_order");
      if (error) { catCache = null; return []; }
      return (data ?? []) as CaseCategory[];
    })();
  }
  return catCache;
}

let assignableCache: Promise<Array<{ id: string; name: string }>> | null = null;
export function assignableUsers() {
  if (!assignableCache) {
    assignableCache = (async () => {
      const { data, error } = await supabase.rpc("case_assignable_users");
      if (error) { assignableCache = null; return []; }
      return (data ?? []) as Array<{ id: string; name: string }>;
    })();
  }
  return assignableCache;
}

export async function searchLinkTargets(type: "property" | "d2d_lagenhet", q: string) {
  const { data, error } = await supabase.rpc("case_search_link_targets", { p_type: type, p_q: q });
  if (error) fail(error);
  return (data ?? []) as Array<{ id: string; title: string | null; subtitle: string | null }>;
}

export async function caseLink(id: string, relType: "case_property" | "case_lagenhet", target: string | null) {
  const { error } = await supabase.rpc("case_link", { p_case: id, p_rel_type: relType, p_target: target });
  if (error) fail(error);
}

export async function caseSetCustomerEmail(id: string, email: string) {
  const { error } = await supabase.rpc("case_set_customer_email", { p_case: id, p_email: email });
  if (error) fail(error);
}

export async function caseCreate(title: string, channel: string, kundEpost: string, body: string) {
  const { data, error } = await supabase.rpc("case_create", {
    p_title: title, p_channel: channel, p_kund_epost: kundEpost || null, p_body: body || null,
  });
  if (error) fail(error);
  return data as string;
}

export type CaseSummary = {
  today: { new: number; createdToday: number; inProgress: number; waiting: number; overdue: number; unassigned: number };
  mine: { new: number; inProgress: number; waiting: number; slaToday: number; overdue: number };
};
export async function getCaseSummary() {
  const { data, error } = await supabase.rpc("get_case_summary");
  if (error) return null;
  return data as CaseSummary | null;
}

export type MailFolderState = {
  folder: string; lastSuccessAt: string | null; lastError: string | null; lastErrorAt: string | null;
  consecutiveFailures: number; messagesImported: number; hasDelta: boolean;
};
export type MailAccountStatus = {
  id: string; mailbox: string; isActive: boolean; importFrom: string;
  folders: MailFolderState[];
  lastRun: { status: string; started_at: string; finished_at: string | null; error: string | null;
             fetched: number; imported: number; duplicates: number; failed: number } | null;
  lastOkRun: string | null; lastError: { at: string; error: string } | null;
  runs24h: number; errors24h: number; imported: number; casesFromEmail: number;
  retryQueue: number; failedProcessing: number; failedSends: number;
};
export async function mailIntegrationStatus() {
  const { data, error } = await supabase.rpc("mail_integration_status");
  if (error) fail(error);
  return (data ?? []) as MailAccountStatus[];
}
export async function triggerMailSync() {
  const { data, error } = await supabase.functions.invoke("mail-sync", { body: {} });
  if (error) throw new DataError("unknown", "Synken kunde inte startas.");
  return data;
}

// ── Presentation ────────────────────────────────────────────────────────
export const SLA_META: Record<"ok" | "warning" | "breached" | "met", { dot: string; label: string; cls: string }> = {
  ok: { dot: "🟢", label: "Inom SLA", cls: "ok" },
  warning: { dot: "🟡", label: "SLA närmar sig", cls: "warning" },
  breached: { dot: "🔴", label: "SLA överskridet", cls: "breached" },
  met: { dot: "✓", label: "SLA uppfyllt", cls: "met" },
};

export function fmtDateTime(iso: string | null | undefined, opts: { withYear?: boolean } = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Idag ${time}`;
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Igår ${time}`;
  return d.toLocaleDateString("sv-SE", {
    day: "numeric", month: "short", ...(opts.withYear || d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  }) + " " + time;
}

/** "om 3 h", "2 h sedan", … för deadlines. */
export function relTime(iso: string | null | undefined) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const txt = m < 60 ? `${m} min` : m < 60 * 48 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return diff >= 0 ? `om ${txt}` : `${txt} sedan`;
}

export function formatBytes(n: number | null | undefined) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Gemensam e-postsignatur för alla svar från ärendehanteringen (migration 0037). */
export type MailSettings = {
  signature: string; signatureHtml: string; preview: string; previewHtml: string;
  updatedAt: string | null; updatedBy: string | null; canEdit: boolean;
};
export async function getMailSettings(): Promise<MailSettings | null> {
  const { data, error } = await supabase.rpc("get_mail_settings");
  if (error) return null;
  return data as MailSettings;
}
export async function setMailSignature(signature: string, signatureHtml?: string): Promise<MailSettings> {
  const { data, error } = await supabase.rpc("set_mail_signature", {
    p_signature: signature, p_signature_html: signatureHtml ?? null,
  });
  if (error) fail(error);
  return data as MailSettings;
}
