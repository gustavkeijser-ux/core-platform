// Lovable Cloud genererar klienten. Skapa ingen egen med createClient —
// då tappar du auth-sessionen som resten av appen använder.
import { supabase } from "@/integrations/supabase/client";
export { supabase };

/**
 * Dataåtkomst.
 *
 * LÄSNING går direkt mot tabeller. RLS filtrerar på tenant och scope, så
 * klienten kan inte se mer än den får oavsett vad den frågar efter.
 *
 * SKRIVNING går alltid via rpc(). Klienten har inga insert-, update- eller
 * delete-rättigheter i databasen, så ett försök att skriva direkt returnerar
 * ett behörighetsfel. Det är avsiktligt: funktionerna validerar mot metadata
 * och skriver aktivitet, audit och event i samma transaktion.
 *
 * Lägg aldrig till .insert(), .update() eller .delete() i den här filen.
 */

// -----------------------------------------------------------------------------
// Typer — speglar metadataformatet, inte någon bransch
// -----------------------------------------------------------------------------

export type FieldType =
  | "text" | "long_text" | "number" | "currency" | "percent"
  | "date" | "datetime" | "boolean" | "select" | "multi_select"
  | "user" | "email" | "phone" | "url" | "address" | "json";

export type FieldDef = {
  key: string;
  label: string;
  fieldType: FieldType;
  isRequired: boolean;
  options: {
    choices?: Array<{ key: string; label: string }>;
    free_text?: boolean;
    code?: string; min?: number; max?: number; decimals?: number;
    section?: string;
    _hidden?: boolean;
    /** Visas som kolumn i listvyn */
    _column?: boolean;
    /** Ordning bland listkolumnerna */
    _column_order?: number;
  };
  helpText: string | null;
  sortOrder: number;
  visibility?: string;
  isUnique?: boolean;
};

export type StatusDef = {
  key: string; label: string; color: string | null;
  isInitial: boolean; isTerminal: boolean;
};

export type RelationDef = {
  relType: string; fromObject: string; toObject: string;
  cardinality: "one_to_one" | "many_to_one" | "one_to_many" | "many_to_many";
  labelForward: string; labelReverse: string; isRequired: boolean;
};

export type ObjectDef = {
  key: string;
  labelSingular: string;
  labelPlural: string;
  icon: string | null;
  titleField: string;
  sortOrder: number;
  fields: FieldDef[];
  statuses: StatusDef[];
  relations: { outgoing: RelationDef[]; incoming: RelationDef[] };
  can: { create: boolean; update: boolean; delete: boolean };
};

export type TenantBranding = {
  id: string;
  name: string;
  brandColor: string | null;
  logoUrl: string | null;
};

export type RecordRow = {
  id: string;
  object_type: string;
  data: Record<string, unknown>;
  status: string | null;
  owner_user_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type RelatedRecord = {
  relType: string;
  direction: "outgoing" | "incoming";
  label: string | null;
  /** Attribut som hör till själva kopplingen, inte till någon av posterna. */
  data: Record<string, unknown>;
  record: { id: string; objectType: string; title: string | null; status: string | null };
};

export type TimelineEntry = {
  id: string; type: string; body: string | null;
  metadata: Record<string, unknown>;
  actorKind: string; actorUserId: string | null; occurredAt: string;
};

/**
 * Databasfelen kommer med SQLSTATE. Valideringsfel har 22023 och
 * behörighetsfel 42501, så gränssnittet kan säga rätt sak i stället för
 * att visa "något gick fel" på allt.
 */
export class DataError extends Error {
  constructor(readonly kind: "invalid" | "forbidden" | "not_found" | "unknown", message: string) {
    super(message);
  }
}

const asError = (e: { code?: string; message: string }): never => {
  const kind =
    e.code === "22023" ? "invalid" :
    e.code === "42501" || e.code === "PGRST301" ? "forbidden" :
    e.code === "P0002" ? "not_found" : "unknown";
  throw new DataError(kind, e.message.replace(/^Ogiltig data: /, ""));
};

// -----------------------------------------------------------------------------
// Läsning
// -----------------------------------------------------------------------------

export async function getMetadata(): Promise<{ objects: ObjectDef[]; tenant: TenantBranding; isAdmin: boolean }> {
  const { data, error } = await supabase.rpc("get_metadata");
  if (error) asError(error);
  return data as { objects: ObjectDef[]; tenant: TenantBranding; isAdmin: boolean };
}

/**
 * Sätter varumärkesfärg och/eller logotyp för tenanten. Kräver admin-roll
 * (kontrolleras av `update_tenant_branding` i databasen — den här funktionen
 * skickar bara vidare). Skicka `null` för ett fält för att nollställa det
 * till standardutseendet.
 */
export async function updateTenantBranding(
  brandColor: string | null,
  logoUrl: string | null
): Promise<TenantBranding> {
  const { data, error } = await supabase.rpc("update_tenant_branding", {
    p_brand_color: brandColor,
    p_logo_url: logoUrl,
  });
  if (error) asError(error);
  return data as TenantBranding;
}

/**
 * Laddar upp en logotyp till storage-bucketen "branding" (publik, så
 * sidomenyn kan visa den direkt via <img src> utan signerad länk) och
 * returnerar den publika URL:en. Sökvägen <tenant>/logo-<tid>.<ext> matchar
 * RLS-policyn som kollar första mappnivån mot tenant, och admin-kravet i
 * själva policyn.
 */
export async function uploadTenantLogo(file: File): Promise<string> {
  const tenant = await myTenantId();
  const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${tenant}/logo-${Date.now()}.${ext || "png"}`;

  const { error: upErr } = await supabase.storage
    .from("branding")
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
  if (upErr) throw new DataError("unknown", upErr.message);

  const { data } = supabase.storage.from("branding").getPublicUrl(path);
  return data.publicUrl;
}

export type FilterOp =
  | "eq" | "neq" | "contains" | "not_contains"
  | "gt" | "gte" | "lt" | "lte"
  | "between" | "in" | "empty" | "not_empty";

/**
 * Ett filtervillkor. `field` är en fältnyckel ur metadata, eller en av
 * systemkolumnerna __status, __title, __updated_at, __created_at.
 * Servern validerar nyckeln mot metadata innan den används.
 */
export type RecordFilter = {
  field: string;
  op: FilterOp;
  value?: unknown;
};

export type ListParams = {
  objectType: string;
  search?: string;
  status?: string;
  filters?: RecordFilter[];
  sort?: { field: string; dir: "asc" | "desc" };
  limit?: number;
  offset?: number;
};

export async function listRecords(p: ListParams) {
  const filters: RecordFilter[] = [...(p.filters ?? [])];

  // Statusväljaren i verktygsraden är bara ett filter till
  if (p.status) filters.push({ field: "__status", op: "eq", value: p.status });

  const { data, error } = await supabase.rpc("list_records_filtered", {
    p_object_type: p.objectType,
    p_search: p.search ?? null,
    p_filters: filters,
    p_sort_field: p.sort?.field ?? "updated_at",
    p_sort_dir: p.sort?.dir ?? "desc",
    p_limit: Math.min(p.limit ?? 25, 200),
    p_offset: p.offset ?? 0,
  });
  if (error) asError(error);

  const res = (data ?? { items: [], total: 0 }) as {
    items: RecordRow[]; total: number;
  };
  return {
    items: res.items ?? [],
    total: res.total ?? 0,
    limit: p.limit ?? 25,
    offset: p.offset ?? 0,
  };
}

export async function getRecord(id: string) {
  const { data, error } = await supabase.rpc("get_record_with_relations", { p_id: id });
  if (error) asError(error);
  if (!data?.record) throw new DataError("not_found", "Posten finns inte.");
  return data as {
    record: RecordRow;
    related: RelatedRecord[];
    timeline: TimelineEntry[];
  };
}

export type DashboardSummary = {
  objects: Array<{
    key: string; labelPlural: string; icon: string | null; total: number;
    statuses: Array<{ key: string; label: string; color: string | null; count: number }>;
    pipeline: { fieldLabel: string; code: string; openValue: number } | null;
  }>;
  tasksDueSoon: {
    count: number;
    items: Array<{ id: string; title: string; dueAt: string; recordId: string | null; recordTitle: string | null }>;
  };
  recent: Array<{
    recordId: string; objectType: string; objectLabel: string;
    title: string | null; status: string | null; updatedAt: string;
  }>;
};

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const { data, error } = await supabase.rpc("get_dashboard_summary");
  if (error) asError(error);
  return data as DashboardSummary;
}

export async function addQuickActivity(
  recordId: string, type: "note" | "call" | "meeting", body: string
): Promise<void> {
  const { error } = await supabase.rpc("add_quick_activity", {
    p_record_id: recordId, p_type: type, p_body: body,
  });
  if (error) asError(error);
}

// -----------------------------------------------------------------------------
// Uppgifter
// -----------------------------------------------------------------------------

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type Task = {
  id: string;
  title: string;
  description: string | null;
  assigneeUserId: string | null;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdSource: string;
  createdAt: string;
  overdue: boolean;
};

export type MyTaskGroup = "forsenade" | "idag" | "veckan" | "senare" | "utan_datum" | "klara";

export type MyTask = {
  id: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  recordId: string | null;
  recordTitle: string | null;
  objectType: string | null;
  createdSource: string;
};

export type MyTasks = {
  grupper: Partial<Record<MyTaskGroup, MyTask[]>>;
  antal: { forsenade: number; idag: number; veckan: number; totalt: number };
};

export async function getRecordTasks(recordId: string): Promise<Task[]> {
  const { data, error } = await supabase.rpc("get_record_tasks", { p_record_id: recordId });
  if (error) asError(error);
  return (data ?? []) as Task[];
}

export async function getMyTasks(includeDone = false): Promise<MyTasks> {
  const { data, error } = await supabase.rpc("get_my_tasks", { p_include_done: includeDone });
  if (error) asError(error);
  return (data ?? { grupper: {}, antal: { forsenade: 0, idag: 0, veckan: 0, totalt: 0 } }) as MyTasks;
}

export async function createTask(p: {
  title: string;
  recordId?: string | null;
  description?: string;
  assignee?: string | null;
  priority?: TaskPriority;
  dueAt?: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc("create_task", {
    p_title: p.title,
    p_record_id: p.recordId ?? null,
    p_description: p.description ?? null,
    p_assignee: p.assignee ?? null,
    p_priority: p.priority ?? "normal",
    p_due_at: p.dueAt ?? null,
  });
  if (error) asError(error);
}

export async function updateTask(
  id: string,
  updates: Partial<{
    title: string; description: string | null;
    assignee_user_id: string | null; priority: TaskPriority; due_at: string | null;
  }>
): Promise<void> {
  const { error } = await supabase.rpc("update_task", { p_id: id, p_updates: updates });
  if (error) asError(error);
}

export async function completeTask(id: string, done = true): Promise<void> {
  const { error } = await supabase.rpc("complete_task", { p_id: id, p_done: done });
  if (error) asError(error);
}

export async function deleteTask(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_task", { p_id: id });
  if (error) asError(error);
}

// -----------------------------------------------------------------------------
// Checklistor
// -----------------------------------------------------------------------------

export type ChecklistItem = {
  id: string;
  label: string;
  helpText: string | null;
  isRequired: boolean;
  sortOrder: number;
  doneAt: string | null;
  doneBy: string | null;
  note: string | null;
};

export type Checklist = {
  id: string;
  name: string;
  statusKey: string | null;
  statusLabel: string | null;
  statusSort: number | null;
  sortOrder: number;
  items: ChecklistItem[];
  total: number;
  done: number;
};

export type PendingItem = { id: string; label: string; checklist: string };

/** Materialiserar mallar på posten. Idempotent — säker att kalla varje gång. */
export async function syncRecordChecklists(recordId: string): Promise<void> {
  const { error } = await supabase.rpc("sync_record_checklists", {
    p_record_id: recordId,
  });
  if (error) asError(error);
}

export async function getRecordChecklists(recordId: string): Promise<Checklist[]> {
  const { data, error } = await supabase.rpc("get_record_checklists", {
    p_record_id: recordId,
  });
  if (error) asError(error);
  return (data ?? []) as Checklist[];
}

export async function toggleChecklistItem(
  itemId: string, done: boolean, note?: string
): Promise<void> {
  const { error } = await supabase.rpc("toggle_checklist_item", {
    p_item_id: itemId, p_done: done, p_note: note ?? null,
  });
  if (error) asError(error);
}

/**
 * Obligatoriska punkter som inte är avbockade i faser på eller före
 * målstatusen. Används för att varna vid statusbyte — den blockerar inte.
 */
export async function pendingRequiredItems(
  recordId: string, targetStatus?: string | null
): Promise<PendingItem[]> {
  const { data, error } = await supabase.rpc("pending_required_items", {
    p_record_id: recordId, p_target_status: targetStatus ?? null,
  });
  if (error) asError(error);
  return (data ?? []) as PendingItem[];
}

// -----------------------------------------------------------------------------
// Kommunikation & dokument
// -----------------------------------------------------------------------------

export type CommChannel = "email" | "call" | "meeting" | "letter" | "sms";
export type CommDirection = "inbound" | "outbound" | "internal";

export type Communication = {
  id: string;
  channel: CommChannel;
  direction: CommDirection;
  provider: string;
  subject: string | null;
  bodyText: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  occurredAt: string;
};

export type DocumentRow = {
  id: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  webUrl: string | null;
  provider: string;
  createdAt: string;
};

export async function getRecordCommunications(
  recordId: string
): Promise<{ communications: Communication[]; documents: DocumentRow[] }> {
  const { data, error } = await supabase.rpc("get_record_communications", {
    p_record_id: recordId,
  });
  if (error) asError(error);
  return (data ?? { communications: [], documents: [] }) as {
    communications: Communication[];
    documents: DocumentRow[];
  };
}

export async function logCommunication(p: {
  recordId: string;
  channel: CommChannel;
  direction: CommDirection;
  subject?: string;
  body?: string;
  fromAddress?: string;
  toAddresses?: string[];
  occurredAt?: string;
}): Promise<void> {
  const { error } = await supabase.rpc("log_communication", {
    p_record_id: p.recordId,
    p_channel: p.channel,
    p_direction: p.direction,
    p_subject: p.subject ?? null,
    p_body: p.body ?? null,
    p_from_address: p.fromAddress ?? null,
    p_to_addresses: p.toAddresses ?? [],
    p_occurred_at: p.occurredAt ?? null,
  });
  if (error) asError(error);
}

export async function deleteCommunication(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_communication", { p_id: id });
  if (error) asError(error);
}

export async function attachDocument(p: {
  recordId: string;
  name: string;
  webUrl: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}): Promise<void> {
  const { error } = await supabase.rpc("attach_document", {
    p_record_id: p.recordId,
    p_name: p.name,
    p_web_url: p.webUrl,
    p_mime_type: p.mimeType ?? null,
    p_size_bytes: p.sizeBytes ?? null,
  });
  if (error) asError(error);
}

export async function deleteDocumentLink(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_document", { p_id: id });
  if (error) asError(error);
}

/** Vilken tenant den inloggade tillhör — behövs för filsökvägen i storage. */
async function myTenantId(): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new DataError("forbidden", "Ingen inloggad användare.");
  const { data, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .single();
  if (error) asError(error);
  return (data as { tenant_id: string }).tenant_id;
}

/**
 * Laddar upp en fil till storage-bucketen "documents" och kopplar den till
 * posten. Sökvägen är <tenant>/<record>/<tid>-<filnamn>, vilket matchar
 * RLS-policyn som kollar första mappnivån mot tenant.
 */
export async function uploadDocument(recordId: string, file: File): Promise<void> {
  const tenant = await myTenantId();
  const safeName = file.name.replace(/[^\w.\-() ]+/g, "_");
  const path = `${tenant}/${recordId}/${Date.now()}-${safeName}`;

  const { error: upErr } = await supabase.storage
    .from("documents")
    .upload(path, file, { cacheControl: "3600", upsert: false });
  if (upErr) throw new DataError("unknown", upErr.message);

  await attachDocument({
    recordId,
    name: file.name,
    webUrl: path, // relativ sökväg — signeras vid nedladdning
    mimeType: file.type || null,
    sizeBytes: file.size,
  });
}

/**
 * Ger en tidsbegränsad länk till en uppladdad fil. Externa länkar
 * (http/https) returneras som de är.
 */
export async function documentUrl(doc: DocumentRow): Promise<string | null> {
  if (!doc.webUrl) return null;
  if (/^https?:\/\//i.test(doc.webUrl)) return doc.webUrl;

  const { data, error } = await supabase.storage
    .from("documents")
    .createSignedUrl(doc.webUrl, 60 * 10);
  if (error) throw new DataError("unknown", error.message);
  return data?.signedUrl ?? null;
}

// -----------------------------------------------------------------------------
// Sparade listvyer
// -----------------------------------------------------------------------------

export type ListView = {
  id: string; object_type: string; name: string;
  filters: {
    search?: string;
    status?: string;
    conditions?: RecordFilter[];
    sort?: { field: string; dir: "asc" | "desc" };
  };
  is_shared: boolean; user_id: string;
};

export async function listSavedViews(objectType: string): Promise<ListView[]> {
  const { data, error } = await supabase
    .from("list_views")
    .select("id,object_type,name,filters,is_shared,user_id")
    .eq("object_type", objectType)
    .order("name");
  if (error) asError(error);
  return (data ?? []) as ListView[];
}

export async function saveListView(
  objectType: string, name: string, filters: ListView["filters"], shared: boolean
): Promise<ListView> {
  const { data, error } = await supabase.rpc("save_list_view", {
    p_object_type: objectType, p_name: name, p_filters: filters, p_shared: shared,
  });
  if (error) asError(error);
  return data as ListView;
}

export async function deleteListView(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_list_view", { p_id: id });
  if (error) asError(error);
}

// -----------------------------------------------------------------------------
// AI-agenter
// -----------------------------------------------------------------------------

export type Agent = {
  id: string; key: string; name: string; department_id: string | null;
};

export type AiMessage = { role: "user" | "assistant"; content: { text: string } };

export type AiProposal = {
  id: string; actions: Array<{ tool: string; args: Record<string, unknown> }>;
  rationale: string | null; state: string; created_at: string;
};

export async function listAgents(): Promise<Agent[]> {
  const { data, error } = await supabase
    .from("ai_agents")
    .select("id,key,name,department_id")
    .eq("is_active", true)
    .order("name");
  if (error) asError(error);
  return (data ?? []) as Agent[];
}

export async function listThreadMessages(threadId: string): Promise<AiMessage[]> {
  const { data, error } = await supabase
    .from("ai_messages")
    .select("role,content")
    .eq("thread_id", threadId)
    .order("created_at");
  if (error) asError(error);
  return (data ?? []) as AiMessage[];
}

export async function listPendingProposals(): Promise<AiProposal[]> {
  const { data, error } = await supabase
    .from("ai_proposals")
    .select("id,actions,rationale,state,created_at")
    .eq("state", "pending")
    .order("created_at", { ascending: false });
  if (error) asError(error);
  return (data ?? []) as AiProposal[];
}

export async function decideProposal(id: string, approve: boolean): Promise<AiProposal> {
  const { data, error } = await supabase.rpc("decide_ai_proposal", { p_id: id, p_approve: approve });
  if (error) asError(error);
  return data as AiProposal;
}

export async function sendAiMessage(
  agentKey: string, message: string, threadId?: string
): Promise<{ threadId: string; reply: string; pendingProposals: string[] }> {
  const { data, error } = await supabase.functions.invoke("ai-chat", {
    body: { agentKey, message, threadId },
  });
  if (error) {
    // supabase-js ger bara ett generiskt "non-2xx status code" i .message —
    // det riktiga felet ligger i själva svarskroppen (error.context).
    let detail = error.message ?? "Kunde inte nå AI-agenten.";
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) detail = body.error;
    } catch {
      // svarskroppen var inte JSON — behåll det generiska meddelandet
    }
    throw new DataError("unknown", detail);
  }
  if (data?.error) throw new DataError("unknown", data.error);
  return data;
}

// -----------------------------------------------------------------------------
// Skrivning — alltid via rpc
// -----------------------------------------------------------------------------

export async function createRecord(
  objectType: string,
  data: Record<string, unknown>,
  status?: string | null
): Promise<RecordRow> {
  const { data: row, error } = await supabase.rpc("create_record", {
    p_object_type: objectType, p_data: data, p_status: status ?? null,
  });
  if (error) asError(error);
  return row as RecordRow;
}

export async function updateRecord(
  id: string,
  data?: Record<string, unknown>,
  status?: string | null
): Promise<RecordRow> {
  const { data: row, error } = await supabase.rpc("update_record", {
    p_id: id, p_data: data ?? null, p_status: status ?? null,
  });
  if (error) asError(error);
  return row as RecordRow;
}

export async function deleteRecord(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_record", { p_id: id });
  if (error) asError(error);
}

export async function addRelation(from: string, relType: string, to: string): Promise<void> {
  const { error } = await supabase.rpc("add_relation", {
    p_from: from, p_rel_type: relType, p_to: to,
  });
  if (error) asError(error);
}

export async function removeRelation(from: string, relType: string, to: string): Promise<void> {
  const { error } = await supabase.rpc("remove_relation", {
    p_from: from, p_rel_type: relType, p_to: to,
  });
  if (error) asError(error);
}

/**
 * Sätter attribut på en befintlig relation (t.ex. antal och ja/nej-val per
 * fastighet i en affär). Relationen måste redan finnas — skapa den först
 * med addRelation.
 */
export async function setRelationData(
  from: string, relType: string, to: string, data: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.rpc("set_relation_data", {
    p_from: from, p_rel_type: relType, p_to: to, p_data: data,
  });
  if (error) asError(error);
}

// -----------------------------------------------------------------------------
// Door 2 Door — projektbyggare (Lukas / d2d_projektledare)
// -----------------------------------------------------------------------------

export type SellerOption = { id: string; name: string };

/** Alla användare i tenanten som har rollen "dorrsaljare". */
export async function listSellers(): Promise<SellerOption[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("user_id, users(id,full_name,email), roles!inner(key)")
    .eq("roles.key", "dorrsaljare");
  if (error) asError(error);
  const rows = (data ?? []) as unknown as Array<{
    user_id: string;
    users: { id: string; full_name: string | null; email: string | null } | null;
  }>;
  const out: SellerOption[] = [];
  for (const r of rows) {
    const u = r.users;
    if (u) out.push({ id: u.id, name: u.full_name || u.email || u.id.slice(0, 8) });
  }
  return out;
}

/** Lägger in adressrader (lägenheter) på en D2D-fastighet. */
export async function d2dImportAddresses(
  fastighetId: string, rows: Record<string, string>[]
): Promise<{ imported: number }> {
  const { data, error } = await supabase.rpc("d2d_import_addresses", {
    p_fastighet_id: fastighetId, p_rows: rows,
  });
  if (error) asError(error);
  return data as { imported: number };
}

/** Sätter procentuell säljartilldelning för en fastighet (måste summera till 100). */
export async function d2dSetAssignment(
  fastighetId: string, assignments: Array<{ user_id: string; procent: number }>
): Promise<void> {
  const { error } = await supabase.rpc("d2d_set_fastighet_assignment", {
    p_fastighet_id: fastighetId, p_assignments: assignments,
  });
  if (error) asError(error);
}

/** Godkänner ett D2D-projekt: delar ut adresserna till säljarna enligt tilldelningen. */
export async function d2dApproveProject(
  projektId: string
): Promise<{ ok: boolean; distributed: number; fastigheterUtanTilldelning: number }> {
  const { data, error } = await supabase.rpc("d2d_approve_project", {
    p_projekt_id: projektId,
  });
  if (error) asError(error);
  return data as { ok: boolean; distributed: number; fastigheterUtanTilldelning: number };
}
