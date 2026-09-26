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

/** Hämtar alla användare i tenanten på en gång (RLS begränsar till egen
 *  tenant) och fyller cachen — så att namn visas direkt i listor i stället
 *  för ett id-fragment medan varje namn slås upp för sig. */
let allUsers: Promise<UserOption[]> | null = null;
export type UserOption = { id: string; name: string };
export function loadAllUsers(): Promise<UserOption[]> {
  if (!allUsers) {
    allUsers = (async () => {
      const { data, error } = await supabase.from("users").select("id,full_name,email");
      if (error) { allUsers = null; return []; }
      const list = (data ?? []).map((u) => ({
        id: u.id as string,
        name: (u.full_name as string | null) || (u.email as string | null) || String(u.id).slice(0, 8),
      }));
      for (const u of list) cache.set(u.id, u.name);
      listeners.forEach((l) => l());
      return list.sort((a, b) => a.name.localeCompare(b.name, "sv"));
    })();
  }
  return allUsers;
}

/** Alla användare i tenanten (för väljare), sorterade på namn. */
export function useTenantUsers(): UserOption[] {
  const [list, setList] = useState<UserOption[]>([]);
  useEffect(() => { let on = true; loadAllUsers().then((l) => { if (on) setList(l); }); return () => { on = false; }; }, []);
  return list;
}

export function getUserName(id: string | null | undefined): string {
  if (!id) return "";
  if (cache.has(id)) return cache.get(id)!;
  if (!inflight.has(id)) inflight.set(id, fetchName(id));
  // Medan namnet laddas: visa inget hellre än ett id-fragment.
  return "…";
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
