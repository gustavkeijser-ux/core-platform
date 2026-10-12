import { supabase } from "@/integrations/supabase/client";

/**
 * Arbetsvyer — vilken meny man ser. Vyn styr bara menyn; roller och behörigheter
 * styr fortfarande vilken data man får läsa. Administratörer har alltid alla vyer.
 * Tilldelas per person under Inställningar → Användare (tabellen user_arbetsvyer).
 */
export type Arbetsvy = "fastighetssaljare" | "d2d" | "leverans" | "admin";

export const ARBETSVYER: Array<{ key: Arbetsvy; label: string; kort: string; beskrivning: string }> = [
  { key: "fastighetssaljare", label: "Fastighetssäljare", kort: "Fastighetssälj", beskrivning: "Säljprocess och register" },
  { key: "d2d", label: "D2D-säljare", kort: "D2D", beskrivning: "Door to door" },
  { key: "leverans", label: "Leverans", kort: "Leverans", beskrivning: "Leveransprocess, ärenden och register" },
  { key: "admin", label: "Admin", kort: "Admin", beskrivning: "Hela menyn" },
];

export const arbetsvyLabel = (k: string) => ARBETSVYER.find((v) => v.key === k)?.label ?? k;

export type MinaArbetsvyer = { vyer: Arbetsvy[]; vald: Arbetsvy | null };

export async function hamtaMinaArbetsvyer(): Promise<MinaArbetsvyer> {
  const { data, error } = await supabase.rpc("mina_arbetsvyer");
  if (error || !data) return { vyer: [], vald: null };
  return data as MinaArbetsvyer;
}

export async function valjArbetsvy(vy: Arbetsvy): Promise<void> {
  await supabase.rpc("valj_arbetsvy", { p_vy: vy });
}

export async function hamtaAllasArbetsvyer(): Promise<Record<string, Arbetsvy[]>> {
  const { data, error } = await supabase.rpc("arbetsvyer_alla");
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, Arbetsvy[]>;
}

export async function sattArbetsvyer(userId: string, vyer: Arbetsvy[]): Promise<void> {
  const { error } = await supabase.rpc("satt_arbetsvyer", { p_user: userId, p_vyer: vyer });
  if (error) throw new Error(error.message);
}
