/**
 * Door to door → Utfall → Telia-avstämning.
 *
 * Läser Telias orderfil (VT-exporten: xlsx, csv eller tabbseparerad text) till de rader databasen
 * vill ha (d2d_telia_orderfil_import), definierar nyckeltalen (samma på teamöversikt, säljarkort
 * och i Excel-exporten) och bygger Excel-filen med nyckeltal och differenslista.
 *
 * Personnummer i filen läses aldrig in — bara ordernummer, datum, status, tjänster, adress och
 * VT-säljar-id.
 */
import { lasXlsx } from "./xlsx";
import type { Cell, SkrivBlad } from "./xlsxSkriv";

// ── Orderfilen ──────────────────────────────────────────────────────────────
export type OrderRad = {
  rad: number; order: string; fsg: string; status: string; erbjudande: string; hastighet: string;
  tv_paket: string; tv_val: string; tv_premium: string; mobil_gb: string; extra: string;
  adress: string; gatnummer: string; uppgang: string; lgh: string; postnr: string; postort: string; csr: string; uppdaterad: string;
};

function delaText(text: string): string[][] {
  const rader = text.replace(/\r/g, "").split("\n").filter((r) => r.trim() !== "");
  if (!rader.length) return [];
  const sep = rader[0].includes("\t") ? "\t" : rader[0].split(";").length > rader[0].split(",").length ? ";" : ",";
  return rader.map((r) => {
    const ut: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === '"') { if (q && r[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { ut.push(cur); cur = ""; }
      else cur += ch;
    }
    ut.push(cur);
    return ut;
  });
}

/** "2026/10/03", "2026-10-03 14:12", "03.10.2026" → "2026-10-03". Excel-serienummer → datum. */
export function normDatum(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{5}(\.\d+)?$/.test(t)) {                       // Excel-serienummer
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return "";
}

/** Läser orderfilen. Kastar med ett begripligt fel om kolumnerna saknas. */
export async function lasOrderfil(fil: File): Promise<OrderRad[]> {
  const rader = /\.xlsx$/i.test(fil.name) ? (await lasXlsx(fil)).rader : delaText(await fil.text());
  const hi = rader.findIndex((r) => r.some((c) => /^order_number$/i.test((c ?? "").trim())));
  if (hi < 0) throw new Error("Hittar inte kolumnen order_number. Ladda upp Telias orderfil (VT-exporten) som den kommer.");
  const h = rader[hi].map((c) => (c ?? "").trim().toLowerCase());
  const k = (...namn: string[]) => { for (const n of namn) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
  const kol = {
    order: k("order_number"), fsg: k("fsg_datum", "fsg_date", "orderdatum"), status: k("orderstatus", "order_status"),
    erb: k("erbjudande"), hast: k("hastighet"), tvp: k("tv_paket"), tvv: k("tv_val"), tvprem: k("tv_premium"),
    extra: k("extra_anvandare"), mobil: k("mobil_gb"),
    gata: k("adress", "gatuadress"), nr: k("gatnummer", "gatunummer"), upp: k("uppgang", "uppgång"), lgh: k("lagenhets_nr", "lgh", "lagenhetsnummer"),
    postnr: k("postnummer", "postnr"), ort: k("postort", "ort"), csr: k("ts_csr_id"), upd: k("last_updated", "uppdaterad"),
  };
  if (kol.gata < 0 || kol.nr < 0 || kol.lgh < 0) throw new Error("Orderfilen saknar adresskolumnerna (adress, gatnummer, lagenhets_nr).");
  const v = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  return rader.slice(hi + 1).map((r, i) => ({
    rad: hi + 2 + i, order: v(r, kol.order), fsg: normDatum(v(r, kol.fsg)), status: v(r, kol.status),
    erbjudande: v(r, kol.erb), hastighet: v(r, kol.hast), tv_paket: v(r, kol.tvp), tv_val: v(r, kol.tvv), tv_premium: v(r, kol.tvprem),
    mobil_gb: v(r, kol.mobil), extra: v(r, kol.extra),
    adress: v(r, kol.gata), gatnummer: v(r, kol.nr), uppgang: v(r, kol.upp), lgh: v(r, kol.lgh),
    postnr: v(r, kol.postnr), postort: v(r, kol.ort), csr: v(r, kol.csr), uppdaterad: normDatum(v(r, kol.upd)),
  })).filter((r) => r.order);
}

/** Månaden flest ordrar i filen avser (ÅÅÅÅ-MM), annars null. */
export function gissaManad(rader: OrderRad[]): string | null {
  const n = new Map<string, number>();
  for (const r of rader) if (r.fsg) n.set(r.fsg.slice(0, 7), (n.get(r.fsg.slice(0, 7)) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ── Nyckeltal ───────────────────────────────────────────────────────────────
/** Råtal per säljare och månad från d2d_nyckeltal_manad. */
export type Tal = {
  pinnar: number; kunder: number; tjanster: number; max_tjanster: number; max_kund: string | null; max_lagenhet: string | null;
  kontakter: number; salj: number; aterkoppling: number; nej: number; ej_hemma: number;
  matchade: number; avvikande: number; endast_saljare: number; har_fil: boolean;
};
export type SaljareTal = { id: string | null; namn: string; nu: Tal | null; forra: Tal | null };
export type Nyckeltal = { manad: string; forra: string; alla: boolean; saljare: SaljareTal[]; team: { nu: Tal | null; forra: Tal | null } | null; filer: string[] };

export type MattTyp = "tal" | "dec" | "pct";
export type Matt = { key: string; etikett: string; kort: string; typ: MattTyp; varde: (t: Tal) => number | null; forklaring: string };

const kvot = (a: number, b: number) => (b > 0 ? a / b : null);
/** Alla nyckeltal i visningsordning. Procenten räknas på totalerna, så teamets värde blir viktat. */
export const MATT: Matt[] = [
  { key: "pinnar", etikett: "Pinnar", kort: "Pinnar", typ: "dec", varde: (t) => Number(t.pinnar ?? 0), forklaring: "Summan av pinnar för kunder sålda i månaden (samma pinnar som lönen)." },
  { key: "kunder", etikett: "Sålda kunder", kort: "Kunder", typ: "tal", varde: (t) => t.kunder, forklaring: "Lägenheter med status Såld och säljdatum i månaden." },
  { key: "tjanster", etikett: "Tjänster", kort: "Tjänster", typ: "tal", varde: (t) => t.tjanster, forklaring: "Antal tjänster (avtal) hos de sålda kunderna." },
  { key: "snitt", etikett: "Snitt tjänster per kund", kort: "Snitt/kund", typ: "dec", varde: (t) => kvot(t.tjanster, t.kunder), forklaring: "Tjänster delat med sålda kunder." },
  { key: "max", etikett: "Flest tjänster på en kund", kort: "Flest", typ: "tal", varde: (t) => t.max_tjanster, forklaring: "Kunden med flest tjänster i månaden." },
  { key: "kontakter", etikett: "Kontakter", kort: "Kontakter", typ: "tal", varde: (t) => t.kontakter, forklaring: "Loggade kontakter: statusbyten säljaren gjort (Såld, Scrive, Återkoppling, Inte hemma, Nej …) och knackningar. Massändringar och importer räknas inte." },
  { key: "hit_salj", etikett: "Hitrate sälj", kort: "Hitrate sälj", typ: "pct", varde: (t) => kvot(t.salj, t.kontakter), forklaring: "Andel av kontakterna som blev Såld eller Signera med Scrive." },
  { key: "hit_ater", etikett: "Hitrate återkoppling", kort: "Hitrate återk.", typ: "pct", varde: (t) => kvot(t.aterkoppling, t.kontakter), forklaring: "Andel av kontakterna som blev Återkoppling." },
  { key: "matchning", etikett: "Matchning mot Telia", kort: "Telia", typ: "pct", varde: (t) => (t.har_fil ? kvot(t.matchade, t.kunder) : null), forklaring: "Andel av de sålda kunderna som finns i Telias orderfil med samma tjänster. Tomt tills månadens orderfil är inläst." },
];

export const fmtVarde = (v: number | null | undefined, typ: MattTyp): string => {
  if (v == null || Number.isNaN(v)) return "–";
  if (typ === "pct") return `${Math.round(v * 100)} %`;
  if (typ === "dec") return v.toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return String(Math.round(v));
};
/** Förändring nu − förra: antal, eller procentenheter för procent. */
export const fmtDiff = (nu: number | null | undefined, forra: number | null | undefined, typ: MattTyp): string => {
  if (nu == null || forra == null) return "";
  const d = typ === "pct" ? (nu - forra) * 100 : nu - forra;
  const s = typ === "tal" ? String(Math.round(Math.abs(d))) : Math.abs(d).toLocaleString("sv-SE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const tecken = d > 0.049 ? "+" : d < -0.049 ? "−" : "±";
  return `${tecken}${tecken === "±" ? "0" : s}${typ === "pct" ? " p.e." : ""}`;
};

export const MANAD = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
export const manadNamn = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m] = iso.slice(0, 7).split("-");
  return `${MANAD[Number(m) - 1] ?? m} ${y}`;
};
export const flyttaManad = (iso: string, n: number) => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
export const dennaManad = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// ── Differenslistan ─────────────────────────────────────────────────────────
export type Kategori = "matchad" | "endast_saljare" | "endast_telia" | "avvikande";
export type Utredning = "oppen" | "utredd_korrekt" | "utredd_rattad";
export type DiffRad = {
  id: string; kategori: Kategori; avvikelse: string | null; matchning: string | null;
  utredning: Utredning; utredningKommentar: string | null; utreddAv: string | null; utreddAt: string | null;
  lagenhetId: string | null; saljareId: string | null; saljare: string | null;
  gata: string | null; nummer: string | null; ingang: string | null; lgh: string | null; ort: string | null; kund: string | null;
  saldDatum: string | null; tjansterSaljare: string | null; tjansterTelia: string | null;
  ordernummer: string | null; orderstatus: string | null; orderDatum: string | null; teliaAdress: string | null; csr: string | null;
};
export type DiffLista = {
  manad: string; kanUtreda: boolean; filer: string[];
  fil: { filNamn: string | null; rader: number; ordrar: number; laddadAt: string; laddadAv: string | null } | null;
  rader: DiffRad[];
};
export const KATEGORI: Record<Kategori, string> = { matchad: "Matchad", endast_saljare: "Endast säljare", endast_telia: "Endast Telia", avvikande: "Avvikande" };
export const UTREDNING: Record<Utredning, string> = { oppen: "Öppen", utredd_korrekt: "Utredd – korrekt", utredd_rattad: "Utredd – rättad" };
export const adressText = (r: Pick<DiffRad, "gata" | "nummer" | "ingang">) => [r.gata, r.nummer, r.ingang].filter(Boolean).join(" ");

// ── Excel ───────────────────────────────────────────────────────────────────
const cellVarde = (v: number | null, typ: MattTyp): Cell => (v == null ? "–" : typ === "pct" ? { procent: v } : typ === "dec" ? { tal: v, dec: 1 } : v);
const cellDiff = (nu: number | null, forra: number | null, typ: MattTyp): Cell =>
  nu == null || forra == null ? "–" : typ === "pct" ? { tal: (nu - forra) * 100, dec: 1 } : typ === "dec" ? { tal: nu - forra, dec: 1 } : nu - forra;

export function byggExcel(n: Nyckeltal, diff: DiffLista | null): SkrivBlad[] {
  const nu = manadNamn(n.manad), fo = manadNamn(n.forra);
  const rubrik: Cell[] = ["Säljare", ...MATT.flatMap((m) => [`${m.etikett} ${nu}`, `${m.etikett} ${fo}`, `Förändring (${m.typ === "pct" ? "p.e." : "antal"})`])];
  const rad = (namn: string, a: Tal | null, b: Tal | null): Cell[] => [
    { fet: namn },
    ...MATT.flatMap((m) => {
      const x = a ? m.varde(a) : null, y = b ? m.varde(b) : null;
      return [cellVarde(x, m.typ), cellVarde(y, m.typ), cellDiff(x, y, m.typ)];
    }),
  ];
  const nyckeltal: Cell[][] = [rubrik];
  if (n.team) nyckeltal.push(rad("Teamet", n.team.nu, n.team.forra));
  for (const s of n.saljare) nyckeltal.push(rad(s.namn, s.nu, s.forra));
  nyckeltal.push([]);
  nyckeltal.push([{ fet: "Flest tjänster på en kund" }, `${nu}: ${n.team?.nu?.max_kund ?? "–"} (${n.team?.nu?.max_tjanster ?? 0})`, `${fo}: ${n.team?.forra?.max_kund ?? "–"} (${n.team?.forra?.max_tjanster ?? 0})`]);
  nyckeltal.push([]);
  for (const m of MATT) nyckeltal.push([{ fet: m.etikett }, m.forklaring]);

  const blad: SkrivBlad[] = [{ namn: "Nyckeltal", rader: nyckeltal }];
  if (diff) {
    const diffRad = (r: DiffRad): Cell[] => [
      KATEGORI[r.kategori], r.saljare ?? "", adressText(r), r.lgh ?? "", r.ort ?? "", r.kund ?? "", r.saldDatum ?? "",
      r.tjansterSaljare ?? "", r.tjansterTelia ?? "", r.ordernummer ?? "", r.orderstatus ?? "", r.orderDatum ?? "", r.teliaAdress ?? "",
      r.avvikelse ?? "", UTREDNING[r.utredning], r.utredningKommentar ?? "", r.utreddAv ?? "",
    ];
    const h: Cell[] = ["Kategori", "Säljare", "Adress", "Lgh", "Ort", "Kund", "Säljdatum", "Tjänster enligt säljare", "Tjänster enligt Telia",
      "Ordernummer", "Orderstatus", "Orderdatum", "Adress enligt Telia", "Avvikelse", "Utredning", "Kommentar", "Utredd av"];
    const olika = diff.rader.filter((r) => r.kategori !== "matchad");
    const lika = diff.rader.filter((r) => r.kategori === "matchad");
    blad.push({ namn: "Differenslista", rader: [h, ...olika.map(diffRad)] });
    blad.push({ namn: "Matchade", rader: [h, ...lika.map(diffRad)] });
  }
  return blad;
}
