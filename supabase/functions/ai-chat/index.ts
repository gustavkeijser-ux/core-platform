// =====================================================================
//  AI-CHAT — ConnectEstate AI, en assistent för hela systemet.
//
//  Körs som EN användare i taget: klienten skickar sitt eget JWT vidare,
//  så varje databasanrop härifrån går genom samma RLS och RPC-kontroller
//  som när användaren klickar i UI:t. Assistenten når alla moduler
//  (migration 0039), men aldrig mer än användaren själv får se.
//  Skrivande verktyg blir förslag som användaren godkänner i panelen.
//
//  Bara CRM:et: verktygen nedan är de enda assistenten har. Inga
//  webbverktyg (web_search/web_fetch) skickas någonsin med, så den kan
//  aldrig hämta information från internet.
//
//  Snålt med tokens:
//   • systemprompt + verktyg cachas (prompt caching) — betalas fullt en
//     gång, sedan till en tiondel så länge samtalet pågår
//   • bara de senaste meddelandena i tråden skickas med
//   • verktygssvar komprimeras (tomma fält bort, långa listor kapas)
//   • korta svar (max_tokens) och högst 6 verktygsrundor per fråga
// =====================================================================
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DEFAULT_AGENT = "crm_ai";
const MAX_RESULT_CHARS = 9000;     // per verktygssvar
const HISTORY_MESSAGES = 12;       // tidigare meddelanden som skickas med
const MAX_ROUNDS = 6;              // verktygsrundor per fråga
const MAX_TOKENS = 1200;           // längsta svar

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });

const ALL_TOOLS: ToolDef[] = [
  {
    name: "list_object_types",
    description: "Lista alla objekttyper (moduler) med statusar och fält (nyckel, etikett, typ). Använd för att hitta rätt objectType och fältnycklar.",
    input_schema: obj({ objectType: { type: "string", description: "Valfritt: visa bara fält för den här typen" } }),
  },
  {
    name: "search_records",
    description: "Sök och räkna poster av en objekttyp. Returnerar total (antal träffar) och upp till limit poster med fältdata. " +
      "filters: [{field, op, value}] där field är en fältnyckel eller __status/__title/__updated_at/__created_at och op är " +
      "eq, neq, contains, gt, gte, lt, lte, between, in, empty, not_empty.",
    input_schema: obj({
      objectType: { type: "string" },
      query: { type: "string", description: "Fritext" },
      status: { type: "string" },
      filters: { type: "array", items: { type: "object" } },
      sortField: { type: "string", description: "Standard updated_at" },
      sortDir: { type: "string", enum: ["asc", "desc"] },
      limit: { type: "number", description: "Max 50, standard 10. Använd 1 om du bara vill ha antalet." },
    }, ["objectType"]),
  },
  {
    name: "summarize_records",
    description: "Räkna ut summa, medel, min och max för talfält över ALLA poster som matchar (inga poster skickas tillbaka). " +
      "Använd alltid detta för summor och medelvärden (t.ex. antal portar) — summera aldrig själv från search_records. " +
      "Samma filters/status/query som search_records. groupBy: valfri fältnyckel eller __status för en uppdelning.",
    input_schema: obj({
      objectType: { type: "string" },
      fields: { type: "array", items: { type: "string" }, description: "Talfält att summera, t.ex. [\"portar\"]" },
      query: { type: "string" },
      status: { type: "string" },
      filters: { type: "array", items: { type: "object" } },
      groupBy: { type: "string" },
    }, ["objectType", "fields"]),
  },
  {
    name: "search_everything",
    description: "Sök fritt i alla moduler samtidigt (namn, adresser, nummer). Bra när du inte vet var något ligger.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "get_record",
    description: "Hämta en post med alla fält, relationer och tidslinje.",
    input_schema: obj({ recordId: { type: "string" } }, ["recordId"]),
  },
  {
    name: "get_timeline",
    description: "Hämta bara tidslinjen (aktiviteter) för en post.",
    input_schema: obj({ recordId: { type: "string" } }, ["recordId"]),
  },
  {
    name: "get_overview",
    description: "Översikt över hela CRM:et: antal poster per modul och status, senast ändrade poster och uppgifter som snart förfaller.",
    input_schema: obj({}),
  },
  {
    name: "get_case_summary",
    description: "Kundtjänstens läge: nya, otilldelade, pågående, väntande och försenade ärenden (totalt och användarens egna).",
    input_schema: obj({}),
  },
  {
    name: "list_cases",
    description: "Lista ärenden i kundtjänsten.",
    input_schema: obj({
      filter: {
        type: "string",
        enum: ["open", "all", "new", "mine", "unassigned", "in_progress", "waiting_customer", "waiting_internal",
          "waiting_contractor", "resolved", "closed", "overdue"],
      },
      query: { type: "string" },
      limit: { type: "number", description: "Max 50, standard 20" },
    }),
  },
  {
    name: "get_case",
    description: "Hämta ett ärende med hela mejltråden, kommentarer och kopplingar.",
    input_schema: obj({ caseId: { type: "string" } }, ["caseId"]),
  },
  {
    name: "get_my_tasks",
    description: "Användarens uppgifter (öppna, eller även klara).",
    input_schema: obj({ includeDone: { type: "boolean" } }),
  },
  {
    name: "get_d2d_stats",
    description: "Door2Door: säljstatistik per säljare och projekt.",
    input_schema: obj({}),
  },
  {
    name: "create_record",
    description: "Föreslå att skapa en ny post. Kräver godkännande av användaren.",
    input_schema: obj({
      objectType: { type: "string" },
      data: { type: "object", description: "Fältvärden, nycklar enligt list_object_types" },
      status: { type: "string" },
    }, ["objectType", "data"]),
  },
  {
    name: "update_record",
    description: "Föreslå att uppdatera en befintlig post. Kräver godkännande.",
    input_schema: obj({ recordId: { type: "string" }, data: { type: "object" }, status: { type: "string" } }, ["recordId"]),
  },
  {
    name: "create_task",
    description: "Föreslå att skapa en uppgift, ev. kopplad till en post. Kräver godkännande.",
    input_schema: obj({
      title: { type: "string" },
      description: { type: "string" },
      recordId: { type: "string" },
      priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
      dueAt: { type: "string", description: "ISO 8601-tidpunkt" },
    }, ["title"]),
  },
  {
    name: "add_activity",
    description: "Föreslå att logga en anteckning, ett samtal eller ett möte på en post. Kräver godkännande.",
    input_schema: obj({
      recordId: { type: "string" },
      type: { type: "string", enum: ["note", "call", "meeting"] },
      body: { type: "string" },
    }, ["recordId", "type", "body"]),
  },
];

const WRITE_TOOLS = new Set(["create_record", "update_record", "create_task", "add_activity"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: "AI är inte aktiverat: ANTHROPIC_API_KEY saknas som secret." }, 500);
    }
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Ej inloggad." }, 401);

    const body = await req.json();
    const message = String(body.message ?? "").trim();
    const agentKey = String(body.agentKey ?? DEFAULT_AGENT);
    const context = typeof body.context === "string" ? body.context.slice(0, 500) : "";
    if (!message) return json({ error: "Meddelandet är tomt." }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id,key,name,system_prompt,allowed_tools,requires_approval,model")
      .eq("key", agentKey)
      .eq("is_active", true)
      .maybeSingle();
    if (agentErr || !agent) return json({ error: "AI-assistenten är inte aktiverad för organisationen." }, 404);

    let threadId = body.threadId as string | undefined;
    if (!threadId) {
      const { data: thread, error: threadErr } = await supabase.rpc("start_ai_thread", { p_agent_key: agentKey });
      if (threadErr) return json({ error: threadErr.message }, 400);
      threadId = thread.id;
    }

    await supabase.rpc("append_ai_message", { p_thread_id: threadId, p_role: "user", p_content: { text: message } });

    // Bara de senaste meddelandena (nyast först, sedan vänt till tidsordning).
    const { data: senaste } = await supabase
      .from("ai_messages")
      .select("role,content")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_MESSAGES);
    const history = (senaste ?? []).reverse();
    while (history.length && history[0].role !== "user") history.shift();

    const allowed: string[] = agent.allowed_tools?.length ? agent.allowed_tools : ALL_TOOLS.map((t) => t.name);
    // Endast CRM-verktygen (inga webbverktyg). Sista verktyget markeras för
    // cachning, så hela verktygslistan återanvänds mellan anropen.
    const tools: Array<Record<string, unknown>> = ALL_TOOLS.filter((t) => allowed.includes(t.name)).map((t) => ({ ...t }));
    if (tools.length) tools[tools.length - 1].cache_control = { type: "ephemeral" };

    // Vem frågar, och när — så "idag", "min" och "denna vecka" blir rätt.
    const { data: me } = await supabase.auth.getUser();
    let who = me?.user?.email ?? "";
    if (me?.user) {
      const { data: u } = await supabase.from("users").select("full_name,email").eq("id", me.user.id).maybeSingle();
      if (u?.full_name) who = `${u.full_name} (${u.email})`;
    }
    const now = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "full", timeStyle: "short" });
    // Fast del (cachas) + det som ändras varje gång (cachas inte).
    const system = [
      { type: "text", text: agent.system_prompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: `Nu: ${now} (svensk tid).\nAnvändare: ${who}.` + (context ? `\nAnvändaren tittar just nu på: ${context}` : "") },
    ];

    const messages: Array<Record<string, unknown>> = history.map(toAnthropicMessage);
    const pendingProposals: string[] = [];
    let finalText = "";
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, rounds: 0 };

    for (let i = 0; i < MAX_ROUNDS; i++) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: agent.model || "claude-sonnet-4-6", max_tokens: MAX_TOKENS, system, messages, tools }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error("anthropic", resp.status, errText);
        return json({ error: `AI-tjänsten svarade inte (${resp.status}). Försök igen om en stund.` }, 502);
      }
      const data = await resp.json();
      usage.rounds++;
      usage.input += data.usage?.input_tokens ?? 0;
      usage.output += data.usage?.output_tokens ?? 0;
      usage.cacheRead += data.usage?.cache_read_input_tokens ?? 0;
      usage.cacheWrite += data.usage?.cache_creation_input_tokens ?? 0;
      const content = data.content as Array<Record<string, any>>;
      const toolUses = content.filter((b) => b.type === "tool_use");
      finalText = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      messages.push({ role: "assistant", content });
      if (toolUses.length === 0) break;

      const results = [];
      for (const use of toolUses) {
        if (!allowed.includes(use.name)) {
          results.push(toolResult(use.id, { error: "Verktyget är inte tillgängligt." }));
          continue;
        }
        try {
          if (WRITE_TOOLS.has(use.name) && agent.requires_approval) {
            const { data: proposal, error } = await supabase.rpc("propose_ai_action", {
              p_thread_id: threadId,
              p_agent_id: agent.id,
              p_actions: [{ tool: use.name, args: use.input }],
              p_rationale: finalText || `Föreslagen åtgärd: ${use.name}`,
            });
            if (error) throw error;
            pendingProposals.push(proposal.id);
            results.push(toolResult(use.id, {
              proposed: true, proposalId: proposal.id,
              note: "Förslaget väntar på att användaren godkänner det i panelen. Det är inte genomfört än.",
            }));
          } else {
            results.push(toolResult(use.id, await runTool(supabase, use.name, use.input ?? {})));
          }
        } catch (e) {
          results.push(toolResult(use.id, { error: errMsg(e) }));
        }
      }
      messages.push({ role: "user", content: results });
    }

    if (!finalText.trim()) finalText = "Jag hann inte bli klar med frågan. Försök gärna med en smalare fråga.";
    await supabase.rpc("append_ai_message", {
      p_thread_id: threadId, p_role: "assistant", p_content: { text: finalText, pendingProposals, usage },
    });
    console.log("ai-chat usage", JSON.stringify(usage));
    return json({ threadId, reply: finalText, pendingProposals, usage });
  } catch (e) {
    console.error("ai-chat", errMsg(e));
    return json({ error: errMsg(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

function errMsg(e: unknown) {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Ta bort tomma värden (null, "", [], {}) rekursivt — sparar tokens utan att
 *  tappa information. Långa listor kapas till de första 40. */
function kompakt(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(kompakt).filter((x) => x !== undefined);
    return arr.length ? (arr.length > 40 ? [...arr.slice(0, 40), `… +${arr.length - 40} till`] : arr) : undefined;
  }
  if (v && typeof v === "object") {
    const ut: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = kompakt(x);
      if (y !== undefined) ut[k] = y;
    }
    return Object.keys(ut).length ? ut : undefined;
  }
  if (v === null || v === "") return undefined;
  return v;
}

function toolResult(toolUseId: string, content: unknown) {
  let s = JSON.stringify(kompakt(content) ?? null);
  if (s.length > MAX_RESULT_CHARS) s = s.slice(0, MAX_RESULT_CHARS) + "… [avkortat — be om färre poster eller filtrera]";
  return { type: "tool_result", tool_use_id: toolUseId, content: s };
}

function toAnthropicMessage(m: { role: string; content: any }) {
  if (typeof m.content?.text === "string") {
    return { role: m.role === "assistant" ? "assistant" : "user", content: m.content.text || "…" };
  }
  return { role: m.role, content: JSON.stringify(m.content) };
}

async function rpc(supabase: SupabaseClient, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

/** Läsverktyg körs direkt (som användaren). Skrivverktyg går annars via
 *  propose_ai_action ovan och körs först när användaren godkänt. */
async function runTool(supabase: SupabaseClient, name: string, input: any): Promise<unknown> {
  switch (name) {
    case "list_object_types": {
      const meta = await rpc(supabase, "get_metadata");
      const objects = (meta?.objects ?? []) as any[];
      return objects
        .filter((o) => !input.objectType || o.key === input.objectType)
        .map((o) => ({
          key: o.key, label: o.labelPlural,
          statuses: (o.statuses ?? []).map((s: any) => `${s.key} (${s.label})`),
          ...(input.objectType || objects.length <= 3
            ? { fields: (o.fields ?? []).map((f: any) => ({ key: f.key, label: f.label, type: f.fieldType })) }
            : { fields: (o.fields ?? []).map((f: any) => f.key) }),
        }));
    }
    case "search_records": {
      const filters = Array.isArray(input.filters) ? [...input.filters] : [];
      if (input.status) filters.push({ field: "__status", op: "eq", value: input.status });
      const res = await rpc(supabase, "list_records_filtered", {
        p_object_type: input.objectType,
        p_search: input.query || null,
        p_filters: filters,
        p_sort_field: input.sortField || "updated_at",
        p_sort_dir: input.sortDir === "asc" ? "asc" : "desc",
        p_limit: Math.max(1, Math.min(Number(input.limit) || 10, 50)),
        p_offset: 0,
      });
      return {
        total: res?.total ?? 0,
        items: (res?.items ?? []).map((r: any) => ({ id: r.id, title: r.title, status: r.status, updatedAt: r.updated_at, data: r.data })),
      };
    }
    case "summarize_records": {
      const filters = Array.isArray(input.filters) ? [...input.filters] : [];
      if (input.status) filters.push({ field: "__status", op: "eq", value: input.status });
      const fields: string[] = (Array.isArray(input.fields) ? input.fields : [input.fields]).filter(Boolean).map(String).slice(0, 10);
      if (!fields.length) return { error: "Ange minst ett fält i fields." };
      const SIDA = 500, MAX = 10000;
      const rows: any[] = [];
      let total = 0;
      for (let offset = 0; offset < MAX; offset += SIDA) {
        const res = await rpc(supabase, "list_records_filtered", {
          p_object_type: input.objectType, p_search: input.query || null, p_filters: filters,
          p_sort_field: "created_at", p_sort_dir: "asc", p_limit: SIDA, p_offset: offset,
        });
        total = res?.total ?? 0;
        const items = (res?.items ?? []) as any[];
        rows.push(...items);
        if (items.length < SIDA || rows.length >= total) break;
      }
      const tal = (v: unknown): number | null => {
        if (typeof v === "number") return Number.isFinite(v) ? v : null;
        if (typeof v !== "string") return null;
        const m = v.replace(/\s/g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
        return m ? Number(m[0]) : null;
      };
      const rakna = (lista: any[]) => Object.fromEntries(fields.map((f) => {
        const v = lista.map((r) => tal(r.data?.[f])).filter((x): x is number => x !== null);
        const sum = v.reduce((a, b) => a + b, 0);
        return [f, { summa: Math.round(sum * 100) / 100, medel: v.length ? Math.round((sum / v.length) * 100) / 100 : null,
          min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null, medVarde: v.length, utanVarde: lista.length - v.length }];
      }));
      const ut: Record<string, unknown> = { antalPoster: rows.length, ...(rows.length < total ? { obs: `Bara ${rows.length} av ${total} poster räknades.` } : {}), falt: rakna(rows) };
      if (input.groupBy) {
        const g = String(input.groupBy);
        const grupper = new Map<string, any[]>();
        for (const r of rows) {
          const raw = g === "__status" ? r.status : r.data?.[g];
          const k = raw === null || raw === undefined || raw === "" ? "(tomt)" : (typeof raw === "object" ? JSON.stringify(raw) : String(raw));
          if (!grupper.has(k)) grupper.set(k, []);
          grupper.get(k)!.push(r);
        }
        ut.grupper = [...grupper.entries()].slice(0, 60).map(([k, l]) => ({ grupp: k, antalPoster: l.length, falt: rakna(l) }));
      }
      return ut;
    }
    case "search_everything": {
      const meta = await rpc(supabase, "get_metadata");
      const objects = (meta?.objects ?? []) as any[];
      const hits = await Promise.all(objects.map(async (o) => {
        try {
          const res = await rpc(supabase, "list_records_filtered", {
            p_object_type: o.key, p_search: input.query, p_filters: [], p_sort_field: "updated_at",
            p_sort_dir: "desc", p_limit: 4, p_offset: 0,
          });
          return { objectType: o.key, label: o.labelPlural, total: res?.total ?? 0,
            items: (res?.items ?? []).map((r: any) => ({ id: r.id, title: r.title, status: r.status })) };
        } catch { return null; }
      }));
      let cases: unknown = null;
      try { cases = await rpc(supabase, "list_cases", { p_filter: "all", p_search: input.query, p_limit: 5, p_offset: 0 }); } catch { /* ingen behörighet */ }
      return { modules: hits.filter((h) => h && h.total > 0), cases };
    }
    case "get_record": {
      const d = await rpc(supabase, "get_record_with_relations", { p_id: input.recordId });
      if (!d) return { error: "Posten finns inte eller ligger utanför användarens behörighet." };
      // Tidslinjen kan vara lång — de 15 senaste räcker här (get_timeline ger alla).
      return Array.isArray(d.timeline) && d.timeline.length > 15
        ? { ...d, timeline: d.timeline.slice(0, 15), timelineTotal: d.timeline.length } : d; // nyast först
    }
    case "get_timeline": {
      const d = await rpc(supabase, "get_record_with_relations", { p_id: input.recordId });
      return d?.timeline ?? [];
    }
    case "get_overview":
      return await rpc(supabase, "get_dashboard_summary");
    case "get_case_summary":
      return await rpc(supabase, "get_case_summary");
    case "list_cases":
      return await rpc(supabase, "list_cases", {
        p_filter: input.filter || "open", p_search: input.query || null,
        p_limit: Math.max(1, Math.min(Number(input.limit) || 20, 50)), p_offset: 0,
      });
    case "get_case":
      return await rpc(supabase, "get_case", { p_case: input.caseId });
    case "get_my_tasks":
      return await rpc(supabase, "get_my_tasks", { p_include_done: !!input.includeDone });
    case "get_d2d_stats":
      return await rpc(supabase, "d2d_saljstatistik");
    case "create_record":
      return await rpc(supabase, "create_record", { p_object_type: input.objectType, p_data: input.data ?? {}, p_status: input.status ?? null });
    case "update_record":
      return await rpc(supabase, "update_record", { p_id: input.recordId, p_data: input.data ?? null, p_status: input.status ?? null });
    case "create_task":
      return await rpc(supabase, "create_task", {
        p_title: input.title, p_description: input.description ?? null, p_record_id: input.recordId ?? null,
        p_priority: input.priority ?? "normal", p_due_at: input.dueAt ?? null,
      });
    case "add_activity":
      await rpc(supabase, "add_quick_activity", { p_record_id: input.recordId, p_type: input.type, p_body: input.body });
      return { done: true };
    default:
      throw new Error(`Okänt verktyg: ${name}`);
  }
}
