import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Enkel process-cache för användarnamn. RLS på `users` filtrerar redan på
 * tenant, så det är säkert att slå upp vilket user-id som helst som dyker
 * upp i data (owner, actor, ett `user`-fält) — resultatet blir ändå bara
 * de rader som finns inom samma tenant.
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();

async function fetchName(id: string): Promise<string> {
  const { data } = await supabase
    .from("users")
    .select("full_name,email")
    .eq("id", id)
    .maybeSingle();
  const name = data?.full_name || data?.email || id.slice(0, 8);
  cache.set(id, name);
  listeners.forEach((l) => l());
  return name;
}

export function getUserName(id: string | null | undefined): string {
  if (!id) return "";
  if (cache.has(id)) return cache.get(id)!;
  if (!inflight.has(id)) inflight.set(id, fetchName(id));
  return id.slice(0, 8);
}

/** Hook-variant som ritar om komponenten när namnet blivit klart. */
export function useUserName(id: string | null | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return getUserName(id);
}

export function UserBadge({ id }: { id: string | null | undefined }) {
  const name = useUserName(id);
  if (!id) return <span className="ink-faint">—</span>;
  return <span title={id}>{name}</span>;
}
