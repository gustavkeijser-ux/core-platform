import { supabase } from "@/integrations/supabase/client";
import { lasXlsx, tillObjekt } from "@/lib/xlsx";
import { skrivXlsx, laddaNer } from "@/lib/xlsxWrite";

/* =============================================================================
   FMO-check: säljaren skickar fastigheter i en affär, Telia (rollen "fmo")
   svarar Godkänd / Ej godkänd per fastighet — i CRM:et eller via fil.
   Ej godkända tas bort ur affären (finns kvar i historiken).
   ========================================================================== */

export type FmoStatus = "skickad" | "godkand" | "ej_godkand";
export type FmoRad = {
  id: string; dealId: string; affar: string | null; koncernmoder: string | null; orgnr: string | null;
  propertyId: string; fastighet: string | null; fastighetKomplett: string | null;
  adress: string | null; postnummer: string | null; ort: string | null; kommun: string | null;
  hushall: string | null; status: FmoStatus | null; skickad: string | null; besvarad: string | null;
  kommentar: string | null; saljare: string | null;
};
export type FmoLogg = { propertyId: string; fastighet: string | null; status: string; kommentar: string | null; tid: string; av: string | null };
export type FmoSvar = { id: string; status: "godkand" | "ej_godkand"; kommentar?: string };

const fel = (e: { message?: string } | null) => { if (e) throw new Error(e.message ?? "Något gick fel"); };

export async function arFmo(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_fmo");
  return !error && !!data;
}
export async function fmoLista(filter: "oppna" | "alla" = "oppna"): Promise<FmoRad[]> {
  const { data, error } = await supabase.rpc("fmo_lista", { p_filter: filter });
  fel(error);
  return (data ?? []) as FmoRad[];
}
export async function fmoSkicka(dealId: string, propertyIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("fmo_skicka", { p_deal: dealId, p_properties: propertyIds });
  fel(error);
  return Number(data ?? 0);
}
export async function fmoAngra(dealId: string, propertyIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("fmo_angra", { p_deal: dealId, p_properties: propertyIds });
  fel(error);
  return Number(data ?? 0);
}
export async function fmoSvara(svar: FmoSvar[]): Promise<{ godkanda: number; borttagna: number; hoppade: number; affarer: number }> {
  const { data, error } = await supabase.rpc("fmo_svara", { p_svar: svar });
  fel(error);
  return data as { godkanda: number; borttagna: number; hoppade: number; affarer: number };
}
export async function fmoLoggFor(dealId: string): Promise<FmoLogg[]> {
  const { data, error } = await supabase.rpc("fmo_logg_for", { p_deal: dealId });
  fel(error);
  return (data ?? []) as FmoLogg[];
}

// ── Fil: export till Telia och import av svaren ──────────────────────────────

const RUBRIKER = ["FMO-id", "Koncernmoder", "Org.nr", "Fastighetsbeteckning", "Adress", "Postnummer", "Ort", "Kommun",
  "Antal hushåll", "Skickad", "Svar (Godkänd/Ej godkänd)", "Kommentar"];
const datum = (s: string | null) => (s ? s.slice(0, 10) : "");

export function exporteraFmo(rader: FmoRad[]) {
  const data = [RUBRIKER, ...rader.map((r) => [
    r.id, r.koncernmoder ?? "", r.orgnr ?? "", r.fastighetKomplett ?? r.fastighet ?? "", r.adress ?? "",
    r.postnummer ?? "", r.ort ?? "", r.kommun ?? "", r.hushall && /^\d+$/.test(r.hushall) ? Number(r.hushall) : (r.hushall ?? ""),
    datum(r.skickad), r.status === "godkand" ? "Godkänd" : r.status === "ej_godkand" ? "Ej godkänd" : "", r.kommentar ?? "",
  ])];
  const stamp = new Date().toISOString().slice(0, 10);
  laddaNer(`FMO-check ${stamp}.xlsx`, skrivXlsx(data, "FMO-check", [38, 30, 14, 30, 34, 11, 16, 16, 12, 12, 24, 40]));
}

/** "Godkänd", "OK", "Ja" → godkand; "Ej godkänd", "Nej", "Ej OK" → ej_godkand. */
export function tolkaSvar(v: string | undefined): "godkand" | "ej_godkand" | null {
  const s = (v ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!s) return null;
  if (/^(ej|inte|ej_|nej|no|underkand|avslag|ej ok|not)/.test(s) || s.includes("ej god")) return "ej_godkand";
  if (/^(godkand|ok|ja|yes|godk|approved|1)/.test(s)) return "godkand";
  return null;
}

export type ImportRad = { rad: number; id: string | null; rubrik: string; status: "godkand" | "ej_godkand" | null; kommentar: string; problem?: string };

function lasCsv(text: string): string[][] {
  const sep = (text.split("\n")[0].match(/;/g)?.length ?? 0) >= (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const rader: string[][] = [];
  let rad: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { rad.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      rad.push(cell); rader.push(rad); rad = []; cell = "";
    } else cell += ch;
  }
  if (cell || rad.length) { rad.push(cell); rader.push(rad); }
  return rader;
}

/** Läs Telias svarsfil (.xlsx eller .csv) och matcha mot öppna rader. */
export async function lasSvarsfil(fil: File, oppna: FmoRad[]): Promise<ImportRad[]> {
  const rader = fil.name.toLowerCase().endsWith(".csv")
    ? lasCsv((await fil.text()).replace(/^\uFEFF/, ""))
    : (await lasXlsx(fil)).rader;
  // Rubrikraden = första raden som innehåller något som liknar "svar" eller "fmo-id".
  const hi = Math.max(0, rader.findIndex((r) => (r ?? []).some((c) => /fmo-?id|svar/i.test(String(c ?? "")))));
  const obj = tillObjekt(rader, hi);
  const hitta = (o: Record<string, string>, ...namn: RegExp[]) => {
    const k = Object.keys(o).find((h) => namn.some((n) => n.test(h)));
    return k ? o[k] : undefined;
  };
  const byId = new Map(oppna.map((r) => [r.id, r]));
  const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  return obj.map((o, i) => {
    const id = hitta(o, /fmo-?id/i, /^id$/i)?.trim() ?? null;
    const bet = hitta(o, /fastighetsbeteckning/i, /^fastighet$/i);
    const kommun = hitta(o, /kommun/i, /^ort/i);
    let rad = id ? byId.get(id) : undefined;
    if (!rad && bet) {
      const kand = oppna.filter((r) => norm(r.fastighetKomplett) === norm(bet) || norm(r.fastighet) === norm(bet));
      rad = kand.length === 1 ? kand[0]
        : kand.find((r) => kommun && (norm(r.kommun) === norm(kommun) || norm(r.ort) === norm(kommun)));
    }
    const status = tolkaSvar(hitta(o, /svar/i, /status/i, /godk/i));
    const kommentar = hitta(o, /kommentar/i, /anteckning/i) ?? "";
    return {
      rad: hi + i + 2, id: rad?.id ?? null, rubrik: rad ? `${rad.fastighet ?? ""} · ${rad.koncernmoder ?? ""}` : (bet ?? id ?? "–"), status, kommentar,
      problem: !rad ? "Hittar inte fastigheten bland de som väntar på svar" : !status ? "Svar saknas eller går inte att tolka" : undefined,
    };
  });
}
