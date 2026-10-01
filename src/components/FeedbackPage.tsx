import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fmtDateTime, relTime } from "@/lib/cases";
import { StatusPill } from "./StatusPill";
import { EmptyState, FilterPills, SearchField, SkeletonRows, TopbarActions } from "./PageChrome";

/* =============================================================================
   Övrigt → Feedback. All feedback från knappen längst ned till höger, en rad
   per inskick: vem som skickat, när, modul, kategori, prioritet och text.
   Administratörer markerar som Pågående eller Klar.
   ========================================================================== */

type FbStatus = "new" | "in_progress" | "done";
type Feedback = {
  id: string; category: string; module: string; priority: "low" | "normal" | "high" | "critical";
  message: string; page: string | null; createdAt: string;
  status: FbStatus; statusChangedAt: string | null; statusChangedBy: string | null;
  sender: { id: string | null; name: string; email: string | null };
};

const STATUS: Record<FbStatus, { label: string; color: string }> = {
  new: { label: "Ny", color: "sky" },
  in_progress: { label: "Pågående", color: "amber" },
  done: { label: "Klar", color: "green" },
};
const PRIO: Record<string, { label: string; cls: string }> = {
  low: { label: "Låg", cls: "low" },
  normal: { label: "Normal", cls: "normal" },
  high: { label: "Hög", cls: "high" },
  critical: { label: "Kritisk", cls: "critical" },
};

function initials(name: string) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
}

export function FeedbackPage({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"open" | FbStatus | "all">("open");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("list_feedback", { p_status: null });
    if (err) { setError(err.message); return; }
    setItems((data ?? []) as Feedback[]); setError(null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function setStatus(f: Feedback, status: FbStatus) {
    setBusy(f.id);
    // Direkt i listan, sedan bekräftat från servern.
    setItems((xs) => xs?.map((x) => (x.id === f.id ? { ...x, status } : x)) ?? xs);
    const { error: err } = await supabase.rpc("set_feedback_status", { p_id: f.id, p_status: status });
    if (err) setError(err.message);
    await load();
    setBusy(null);
  }

  const counts = useMemo(() => {
    const c = { new: 0, in_progress: 0, done: 0 };
    for (const f of items ?? []) c[f.status]++;
    return c;
  }, [items]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter((f) =>
      (filter === "all" || (filter === "open" ? f.status !== "done" : f.status === filter))
      && (!q || [f.message, f.category, f.module, f.sender.name, f.sender.email ?? ""].some((s) => s.toLowerCase().includes(q))));
  }, [items, filter, search]);

  return (
    <div className="page fbl">
      <TopbarActions>
        <SearchField value={search} onChange={setSearch} placeholder="Sök i feedback…" />
      </TopbarActions>

      <FilterPills
        active={filter}
        onSelect={(k) => setFilter(k as typeof filter)}
        items={[
          { key: "open", label: "Att hantera", count: counts.new + counts.in_progress },
          { key: "new", label: "Nya", count: counts.new, color: "var(--hue-sky)" },
          { key: "in_progress", label: "Pågående", count: counts.in_progress, color: "var(--hue-amber)" },
          { key: "done", label: "Klara", count: counts.done, color: "var(--hue-green)" },
          { key: "all", label: "Alla", count: items?.length ?? null },
        ]}
      />

      {error && <div className="formfield__error">{error}</div>}

      <div className="card fbl__list">
        {items == null ? <SkeletonRows rows={5} />
          : shown.length === 0 ? (
            <EmptyState kind={search || filter !== "all" ? "filtered" : "empty"}
              title={items.length === 0 ? "Ingen feedback ännu" : "Inget matchar"}
              text={items.length === 0 ? "Feedback som skickas med knappen längst ned till höger hamnar här." : "Prova ett annat filter eller en annan sökning."} />
          ) : shown.map((f) => {
            const prio = PRIO[f.priority] ?? PRIO.normal;
            const long = f.message.length > 220 || f.message.split("\n").length > 3;
            const open = !!expanded[f.id];
            return (
              <article key={f.id} className={`fbl__row fbl__row--${f.status}`}>
                <div className="fbl__who">
                  <span className="avatar">{initials(f.sender.name)}</span>
                  <div className="fbl__who-text">
                    <div className="fbl__name">{f.sender.name}</div>
                    <div className="fbl__email">{f.sender.email ?? ""}</div>
                  </div>
                </div>

                <div className="fbl__main">
                  <div className="fbl__tags">
                    <span className="fbl__cat">{f.category}</span>
                    <span className="fbl__module">{f.module}</span>
                    <span className={`fbl__prio fbl__prio--${prio.cls}`}>{prio.label}</span>
                    <span className="fbl__time" title={fmtDateTime(f.createdAt, { withYear: true })}>{relTime(f.createdAt)}</span>
                  </div>
                  <div className={`fbl__msg${long && !open ? " fbl__msg--clamped" : ""}`}>{f.message}</div>
                  {long && <button className="linklike fbl__more" onClick={() => setExpanded((e) => ({ ...e, [f.id]: !open }))}>{open ? "Visa mindre" : "Visa allt"}</button>}
                  {f.statusChangedBy && f.status !== "new" && (
                    <div className="fbl__changed">{STATUS[f.status].label} · {f.statusChangedBy} · {fmtDateTime(f.statusChangedAt)}</div>
                  )}
                </div>

                <div className="fbl__side">
                  <StatusPill status={f.status} def={{ key: f.status, label: STATUS[f.status].label, color: STATUS[f.status].color } as never} />
                  {isAdmin && (
                    <div className="fbl__actions">
                      <button className={`btn btn--sm ${f.status === "in_progress" ? "btn--ghost fbl__btn--on" : "btn--ghost"}`}
                        disabled={busy === f.id} aria-pressed={f.status === "in_progress"}
                        onClick={() => void setStatus(f, f.status === "in_progress" ? "new" : "in_progress")}>
                        Pågående
                      </button>
                      <button className={`btn btn--sm ${f.status === "done" ? "btn--brand" : "btn--ghost"}`}
                        disabled={busy === f.id} aria-pressed={f.status === "done"}
                        onClick={() => void setStatus(f, f.status === "done" ? "new" : "done")}>
                        {f.status === "done" ? "✓ Klar" : "Klar"}
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
      </div>
    </div>
  );
}
