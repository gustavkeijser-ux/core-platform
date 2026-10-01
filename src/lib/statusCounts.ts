import { getDashboardSummary, type DashboardSummary } from "@/lib/data";

/**
 * Antal poster per objekt och status (till filterpillren "Alla · 36",
 * "Vakanta · 2" … överst i listorna). Hämtas från samma sammanställning
 * som Översikten och cachas en kort stund, så att alla listor delar ett
 * enda anrop när man klickar runt i menyn.
 */
let cache: { at: number; p: Promise<DashboardSummary> } | null = null;
const TTL = 30_000;

export function loadSummary(force = false): Promise<DashboardSummary> {
  if (force || !cache || Date.now() - cache.at > TTL) {
    const p = getDashboardSummary();
    cache = { at: Date.now(), p };
    p.catch(() => { cache = null; });
  }
  return cache.p;
}

export type StatusCounts = { total: number; byStatus: Record<string, number> };

export async function getStatusCounts(objectKey: string, force = false): Promise<StatusCounts | null> {
  try {
    const s = await loadSummary(force);
    const o = s.objects.find((x) => x.key === objectKey);
    if (!o) return null;
    const byStatus: Record<string, number> = {};
    for (const st of o.statuses) byStatus[st.key] = st.count;
    return { total: o.total, byStatus };
  } catch {
    return null;
  }
}
