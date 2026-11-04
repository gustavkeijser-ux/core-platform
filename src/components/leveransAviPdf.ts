/**
 * Aviseringar till hyresgäster (Leveransöversikten → Avisera).
 *
 * Reglerna följer ConnectEstates aviseringsrutin: en sida per PDF, tilltal "ni",
 * aldrig exakta besöksdatum, erbjudanderuta med QR-kod till
 * https://connectestate.se/erbjudande, ConnectEstates kontaktuppgifter,
 * hörnmärkning ÅÅMMDD + fastighetsbeteckning på Avi 1–3 (inte på Kabel-TV upphör),
 * lägenhet och lokal i separata PDF:er och inga kontaktpersoner hos ägaren i PDF:en.
 *
 * Sidan byggs som en lista ritoperationer (text, rektanglar, bild, QR) som ritas
 * både till PDF (jsPDF) och till SVG (förhandsgranskningen) — samma layout i båda.
 * Biblioteken (jsPDF, qrcode-generator, JSZip) laddas från cdnjs vid behov.
 */

import type { FastighetRad } from "./LeveransFastighetslista";

// ---------------------------------------------------------------------------
// Bibliotek från cdnjs
// ---------------------------------------------------------------------------

const JSPDF_JS = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const QR_JS = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
const JSZIP_JS = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = Window & { jspdf?: { jsPDF: any }; qrcode?: any; JSZip?: any };
const laddas: Record<string, Promise<void>> = {};

function laddaSkript(url: string): Promise<void> {
  if (!laddas[url]) {
    laddas[url] = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete laddas[url]; reject(new Error("Kunde inte ladda PDF-biblioteket. Kontrollera nätverket och försök igen.")); };
      document.body.appendChild(s);
    });
  }
  return laddas[url];
}

export async function laddaBibliotek(): Promise<void> {
  const w = window as W;
  await Promise.all([
    w.jspdf ? Promise.resolve() : laddaSkript(JSPDF_JS),
    w.qrcode ? Promise.resolve() : laddaSkript(QR_JS),
    w.JSZip ? Promise.resolve() : laddaSkript(JSZIP_JS),
  ]);
}

const jsPDF = () => (window as W).jspdf!.jsPDF;

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export type AviTyp = "avi1" | "avi2" | "avi3" | "ktv" | "forv" | "dekal";

export const AVI_TYPER: { key: AviTyp; label: string; filnamn: string; chk?: string; hint: string }[] = [
  { key: "avi1", label: "Avisering 1", filnamn: "Avisering 1", chk: "chk_avi_1", hint: "Introduktion: vad som händer och tidplan" },
  { key: "avi2", label: "Avisering 2", filnamn: "Avisering 2", chk: "chk_avi_2", hint: "Praktiskt inför installationen, tv-box och router" },
  { key: "avi3", label: "Avisering 3", filnamn: "Avisering 3", chk: "chk_avi_3", hint: "Uppgraderingen är klar – kom igång" },
  { key: "ktv", label: "Kabel-TV upphör", filnamn: "AVI Kabel-TV upphör", hint: "Datum från KTV/KOAX-avtalet, tre steg" },
  { key: "forv", label: "Förvaltningsdokument", filnamn: "Förvaltningsdokument", chk: "chk_forvaltningsdokument", hint: "Leveransen i korthet till förvaltningen" },
  { key: "dekal", label: "Fastighetsdekal", filnamn: "Fastighetsdekal", hint: "A6-dekal till entré eller fiberrum" },
];

export type Mottagare = "lgh" | "lokal" | null;

/** Fastighetsägarens profil (från koncernmoderns Leveransöversikt-post). */
export type Profil = {
  agare: string;
  farg: string | null;
  /** Logotypen som PNG (data-URL) med bredd/höjd i px. */
  logo: { src: string; w: number; h: number } | null;
  slug: string | null;
  kontakt: { namn: string; telefon: string; epost: string } | null;
};

/** Det som styr texten. Fastigheter med samma variant delar text (men får varsin PDF). */
export type Variant = {
  typ: AviTyp;
  agare: string;
  mottagare: Mottagare;
  paket: string | null;
  bredband: boolean;
  befFiber: string | null;
  befTelia: boolean;
  koax: string | null;
  entreprenor: string | null;
  manad: string | null;
  ktvDatum: string | null;
};

export type AviText = {
  rubrik: string;
  ingress: string;
  avsnitt: { rubrik: string; text: string }[];
  fakta: { etikett: string; varde: string }[];
  tidslinje: string[];
};

// ---------------------------------------------------------------------------
// Data → variant
// ---------------------------------------------------------------------------

const MANADER = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

function datum(s: string | null | undefined): Date | null {
  const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
export const datumText = (d: Date) => `${d.getDate()} ${MANADER[d.getMonth()]} ${d.getFullYear()}`;
const manadText = (d: Date) => `${MANADER[d.getMonth()]} ${d.getFullYear()}`;

export function datumKod(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export const tal = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** "ABSALON 19" → "Absalon 19", "Domaren12" → "Domaren 12". */
export function normBeteckning(s: string | null | undefined): string {
  let t = (s ?? "").trim().replace(/\s+/g, " ").replace(/([A-Za-zÅÄÖåäöÉé])(\d)/g, "$1 $2");
  if (!t) return "";
  if (t === t.toUpperCase()) {
    t = t.toLowerCase().replace(/(^|[\s-])([a-zåäöé])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function slugAv(s: string): string {
  return s.toLowerCase()
    .replace(/[åä]/g, "a").replace(/ö/g, "o").replace(/é/g, "e")
    .replace(/\b(ab|hb|kb|fastigheter|fastighets|fastighet|förvaltning|i sverige)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "").slice(0, 30) || "fastighet";
}

function paketAv(lev: string | null): { paket: string | null; bredband: boolean } {
  const s = (lev ?? "").toLowerCase().trim();
  if (!s || s === "n/a") return { paket: null, bredband: false };
  const paket = /start/.test(s) ? "Start" : /lagom/.test(s) ? "Lagom" : /bas|was/.test(s) ? "Bas" : null;
  const bredband = /\bbb\b|\bbb\s*\d|bb\+|bredband|internet/.test(s);
  return { paket, bredband };
}

const TOMT_VARDE = /^[\s\-–—”"'.]*$|^\d+$|^(finns ej|saknas|nej|ingen|n\/a)$/i;

function fiberAv(v: string | null): { befFiber: string | null; befTelia: boolean } {
  const s = (v ?? "").trim();
  if (TOMT_VARDE.test(s)) return { befFiber: null, befTelia: false };
  const delar = s.split(/[,/&]|\boch\b/)
    .map((d) => d.replace(/\b(låst|låsta|stängt|stängd|öppet|öppen)\b/gi, "").replace(/\(.*?\)/g, "").trim())
    .filter((d) => d && !TOMT_VARDE.test(d));
  const andra = delar.filter((d) => !/^telia/i.test(d));
  if (andra.length) return { befFiber: andra.join(" och "), befTelia: false };
  return { befFiber: delar.length ? "Telia" : null, befTelia: delar.length > 0 };
}

export function mottagareFor(r: FastighetRad): { lista: Mottagare[]; saknas: boolean } {
  const lgh = tal(r.hushall);
  const lok = tal(r.lokaler);
  const lista: Mottagare[] = [];
  if (lgh > 0) lista.push("lgh");
  if (lok > 0) lista.push("lokal");
  if (!lista.length) return { lista: ["lgh"], saknas: true };
  return { lista, saknas: false };
}

export function variantFor(r: FastighetRad, typ: AviTyp, mottagare: Mottagare, agare: string): Variant {
  const { paket, bredband } = paketAv(r.leverans);
  const fiber = fiberAv(r.bef_ko);
  const koax = TOMT_VARDE.test((r.bef_koax ?? "").trim()) ? null : (r.bef_koax ?? "").trim();
  const kk = datum(r.kundklar_ce) ?? datum(r.kundklar);
  const ktv = datum(r.ktv_avtal);
  const per = typ === "avi1" || typ === "avi2" || typ === "forv";
  return {
    typ, agare, mottagare,
    paket: paket ?? "Bas",
    bredband,
    befFiber: fiber.befFiber,
    befTelia: fiber.befTelia,
    koax,
    entreprenor: (r.entreprenor ?? "").trim() || null,
    manad: per && kk ? manadText(kk) : null,
    ktvDatum: typ === "ktv" || typ === "forv" ? (ktv ? datumText(ktv) : null) : null,
  };
}

/** Flaggor för en fastighet och typ (visas i förhandsgranskningen och i Excel). */
export function flaggorFor(r: FastighetRad, typ: AviTyp): string[] {
  const f: string[] = [];
  const pk = paketAv(r.leverans);
  if (!pk.paket) f.push(r.leverans ? `Kanalpaket "${r.leverans}" tolkat som Telia TV Bas` : "Kanalpaket saknas – antaget Telia TV Bas");
  if (!normBeteckning(r.fastighet)) f.push("Fastighetsbeteckning saknas – adressen används");
  if (mottagareFor(r).saknas && typ !== "forv" && typ !== "dekal") f.push("Antal lägenheter/lokaler saknas – antaget lägenhet");
  if (typ === "ktv" && !datum(r.ktv_avtal)) f.push("Datum för kabel-tv saknas (KTV/KOAX-avtal) – skriv in datum i texten");
  if ((typ === "avi1" || typ === "avi2") && !r.entreprenor) f.push("Entreprenör saknas");
  if (typ === "forv" || typ === "dekal") f.push("Utkast – ingen förlaga finns ännu");
  return f;
}

export function nyckelFor(v: Variant): string {
  return JSON.stringify(v);
}

export function variantEtikett(v: Variant): string {
  const delar = [
    AVI_TYPER.find((t) => t.key === v.typ)!.label,
    v.agare,
    `${v.bredband ? "Kollektiv" : "Öppet nät"} ${v.paket ?? ""}`.trim(),
  ];
  if (v.befFiber && !v.befTelia) delar.push(`från ${v.befFiber}`);
  if (v.koax) delar.push(`koax ${v.koax}`);
  if (v.manad) delar.push(v.manad);
  if (v.ktvDatum) delar.push(v.ktvDatum);
  if (v.mottagare) delar.push(v.mottagare === "lgh" ? "Lägenhet" : "Lokal");
  return delar.join(" · ");
}

// ---------------------------------------------------------------------------
// Mallar
// ---------------------------------------------------------------------------

export const CE_TELEFON = "010-330 26 55";
export const CE_EPOST = "hyresgast@connectestate.se";
export const ERBJUDANDE_URL = "https://connectestate.se/erbjudande";
const TELIA_AKTIVERA = "telia.se/kollektivatjanster/aktivera";
const TELIA_TELEFON = "020-20 20 70";

export function standardText(v: Variant): AviText {
  const lok = v.mottagare === "lokal";
  const er = lok ? "er lokal" : "er lägenhet";
  const ingar = lok ? "ingår i hyresavtalet" : "ingår i ert boende";
  const paket = `Telia TV ${v.paket ?? "Bas"}`;
  const tvInternet = v.bredband ? "Tv och bredband ingår" : "Tv ingår – fritt val av bredband";
  const besok = v.bredband
    ? `I de flesta fall behövs inget besök i ${er}. Om ett besök behövs meddelas det i god tid av entreprenören.`
    : `En fiberdosa monteras i ${er}, så ett besök behövs. Tiden för besöket meddelas i god tid av entreprenören.`;
  const profil = "Personalen bär alltid profilkläder och id-bricka.";
  const entr = v.entreprenor ? `Arbetet utförs av ${v.entreprenor} på uppdrag av Telia.` : "Arbetet utförs av Telias entreprenör.";
  const fran = v.befFiber && !v.befTelia
    ? `Fastighetens nuvarande fiberleverantör ${v.befFiber} ersätts av Telia.`
    : v.befTelia ? "Fastigheten har redan Telia – nu uppgraderas nätet." : "";
  const koaxText = v.koax ? ` Den nuvarande kabel-tv:n via ${v.koax} upphör när uppgraderingen är klar – ni får information om det i god tid.` : "";
  const fakta = [
    { etikett: "Kanalpaket", varde: paket },
    { etikett: "Tv & internet", varde: tvInternet },
    { etikett: v.befFiber && !v.befTelia ? "Ny fiberleverantör" : "Leverantör", varde: "Telia" },
  ];

  switch (v.typ) {
    case "avi1":
      return {
        rubrik: "Fastighetens fibernät uppgraderas",
        ingress: `${v.agare} uppgraderar tillsammans med Telia fastighetens nät för tv och internet. Efter uppgraderingen ${v.bredband ? `${ingar} både tv (${paket}) och bredband` : `${ingar} tv (${paket}) och ni väljer själva bredbandsleverantör`}.`,
        avsnitt: [
          { rubrik: "Vad händer?", text: [fran, entr, koaxText.trim()].filter(Boolean).join(" ") },
          { rubrik: lok ? "Behöver lokalen vara tillgänglig?" : "Behöver ni vara hemma?", text: `${besok} ${profil}` },
          { rubrik: "Tidplan", text: v.manad ? `Uppgraderingen beräknas vara klar under ${v.manad}. Exakta tider meddelas i god tid.` : "Tidplanen meddelas i god tid av entreprenören." },
          { rubrik: "Frågor om projektet", text: `ConnectEstate hanterar frågor om projektet – kontakta oss i stället för förvaltningens växel på ${CE_TELEFON} eller ${CE_EPOST}.` },
        ],
        fakta,
        tidslinje: ["Denna avisering – information om uppgraderingen", "Nästa avisering – praktisk information inför installationen"],
      };
    case "avi2":
      return {
        rubrik: "Snart dags – så kommer ni igång",
        ingress: `Uppgraderingen av fastighetens nät närmar sig${v.manad ? ` och beräknas vara klar under ${v.manad}` : ""}. Här är det ni behöver veta inför installationen.`,
        avsnitt: [
          { rubrik: "Inför installationen", text: `${besok} ${entr} ${profil}` },
          { rubrik: "Beställ tv-box", text: `Tv-boxen beställer ni på ${TELIA_AKTIVERA} eller på ${TELIA_TELEFON}. Ha BankID till hands – saknar ni BankID hjälper Telias kundservice er.` },
          v.bredband
            ? { rubrik: "Internet", text: `Router ${ingar}. Anslut den till uttaget i ${er} när uppgraderingen är klar.` }
            : { rubrik: "Internet", text: "Ni väljer själva bredbandsleverantör när fiberdosan är monterad. Jämför tjänsteleverantörer på bredbandswebben.se." },
          { rubrik: lok ? "Vid flytt" : "Vid utflytt", text: `Lämna kvar fiberdosa${v.bredband ? ", router" : ""} och kablar i ${er}.` },
        ],
        fakta,
        tidslinje: ["Denna avisering – praktisk information", "Nästa avisering – när uppgraderingen är klar"],
      };
    case "avi3":
      return {
        rubrik: "Uppgraderingen är klar!",
        ingress: `Nu är fastighetens nya nät klart och ni kan börja använda tv${v.bredband ? " och internet" : ""} från Telia.`,
        avsnitt: [
          { rubrik: "Kom igång med tv", text: `Har ni inte beställt tv-box ännu gör ni det på ${TELIA_AKTIVERA} eller på ${TELIA_TELEFON}. ${paket} ${ingar}.` },
          v.bredband
            ? { rubrik: "Internet", text: `Anslut routern till uttaget i ${er} så är ni igång. Bredband ${ingar}.` }
            : { rubrik: "Välj bredband", text: "Fastigheten har ett öppet nät – ni väljer fritt bland tjänsteleverantörerna på bredbandswebben.se." },
          ...(v.koax ? [{ rubrik: "Kabel-tv", text: `Den tidigare kabel-tv:n via ${v.koax} upphör. Byt till Telias tv-box så snart som möjligt.` }] : []),
          { rubrik: "ConnectEstate besöker fastigheten", text: `Vi besöker fastigheten för att svara på frågor och hjälpa er igång. ${profil} Frågor om projektet går till ConnectEstate, inte förvaltningens växel.` },
        ],
        fakta,
        tidslinje: [],
      };
    case "ktv":
      return {
        rubrik: v.ktvDatum ? `Er kabel-tv upphör den ${v.ktvDatum}` : "Er kabel-tv upphör snart",
        ingress: `Fastigheten har fått Telias fibernät och den gamla kabel-tv:n${v.koax ? ` via ${v.koax}` : ""} stängs därför av. Följ stegen nedan så att ni kan fortsätta titta på tv – ${paket} ${ingar}.`,
        avsnitt: [
          { rubrik: "1. Kontakta ConnectEstate först", text: `Ring ${CE_TELEFON} eller mejla ${CE_EPOST} så hjälper vi er att komma igång.` },
          { rubrik: "2. Beställ tv-box", text: `Beställ tv-boxen på ${TELIA_AKTIVERA} eller på ${TELIA_TELEFON}.` },
          { rubrik: "3. Behöver ni hjälp?", text: `Telias kundservice hjälper till med installationen. ConnectEstate besöker även fastigheten, främst kvällar och helger. ${profil}` },
        ],
        fakta: [
          { etikett: "Kabel-tv upphör", varde: v.ktvDatum ?? "Meddelas separat" },
          { etikett: "Kanalpaket", varde: paket },
          { etikett: "Leverantör", varde: "Telia" },
        ],
        tidslinje: [],
      };
    case "forv":
      return {
        rubrik: "Information till förvaltningen",
        ingress: `Sammanfattning av fastighetens leverans av tv och internet från Telia, som ${v.agare} har avtalat. Kontakta ConnectEstate vid frågor om projektet.`,
        avsnitt: [
          { rubrik: "Leveransen", text: `${paket}${v.bredband ? " och kollektivt bredband ingår för alla hyresgäster." : " ingår för alla hyresgäster. Bredband väljs fritt i det öppna nätet (bredbandswebben.se)."}` },
          { rubrik: "Tidigare leverantörer", text: [
            v.befFiber ? (v.befTelia ? "Fiber: Telia (uppgraderas)." : `Fiber: ${v.befFiber} (ersätts av Telia).`) : "Fiber: ingen tidigare leverantör registrerad.",
            v.koax ? `Kabel-tv: ${v.koax}${v.ktvDatum ? `, avtalet upphör ${v.ktvDatum}` : ""}.` : v.ktvDatum ? `Kabel-tv-avtalet upphör ${v.ktvDatum}.` : "",
          ].filter(Boolean).join(" ") },
          { rubrik: "Entreprenör och tidplan", text: `${v.entreprenor ? `Installationen utförs av ${v.entreprenor} på uppdrag av Telia.` : "Installationen utförs av Telias entreprenör."} ${v.manad ? `Leveransen beräknas vara klar under ${v.manad}.` : "Tidplanen meddelas av ConnectEstate."}` },
          { rubrik: "Support och felanmälan", text: `Hyresgästernas frågor om tv och internet: Telia ${TELIA_TELEFON}. Frågor om projektet: ConnectEstate ${CE_TELEFON}, ${CE_EPOST}.` },
        ],
        fakta,
        tidslinje: [],
      };
    case "dekal":
      return {
        rubrik: "Fastigheten är ansluten till Telias fibernät",
        ingress: v.bredband ? `${paket} och bredband ingår.` : `${paket} ingår. Välj bredband på bredbandswebben.se.`,
        avsnitt: [],
        fakta: [
          { etikett: "Tv & internet", varde: `Telia ${TELIA_TELEFON}` },
          { etikett: "Frågor om projektet", varde: `ConnectEstate ${CE_TELEFON}` },
        ],
        tidslinje: [],
      };
  }
}

// ---------------------------------------------------------------------------
// Layout → ritoperationer
// ---------------------------------------------------------------------------

export type Op =
  | { t: "rect"; x: number; y: number; w: number; h: number; fill: string; r?: number }
  | { t: "text"; x: number; y: number; s: string; size: number; bold?: boolean; color: string; align?: "left" | "right" | "center" }
  | { t: "img"; x: number; y: number; w: number; h: number; src: string }
  | { t: "qr"; x: number; y: number; size: number; mod: boolean[][]; color: string };

export type Sida = { w: number; h: number; ops: Op[] };

const PT = 0.3528; // mm per punkt
const NEUTRAL = "#334155";
const INK = "#1e293b";
const GRA = "#64748b";

function hexOk(h: string | null | undefined): string | null {
  return h && /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : null;
}
function rgb(h: string) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function blanda(h: string, andel: number): string {
  const c = rgb(h).map((v) => Math.round(v + (255 - v) * andel));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function mork(h: string): boolean {
  const [r, g, b] = rgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
}
/** Profilfärgen; ljusa färger mörkas för text så att rubriker går att läsa. */
function fargerFor(p: Profil) {
  const prim = hexOk(p.farg) ?? NEUTRAL;
  const text = mork(prim) ? prim : INK;
  return { prim, text, pa: mork(prim) ? "#ffffff" : INK, platta: blanda(prim, 0.9) };
}

let matDoc: any = null;
function matare() {
  if (!matDoc) matDoc = new (jsPDF())({ unit: "mm", format: "a4" });
  return matDoc;
}
function radbryt(s: string, size: number, bold: boolean, bredd: number): string[] {
  const d = matare();
  d.setFont("helvetica", bold ? "bold" : "normal");
  d.setFontSize(size);
  return s.trim() ? (d.splitTextToSize(s.trim(), bredd) as string[]) : [];
}
function bredd(s: string, size: number, bold: boolean): number {
  const d = matare();
  d.setFont("helvetica", bold ? "bold" : "normal");
  d.setFontSize(size);
  return d.getTextWidth(s);
}

let qrCache: { url: string; mod: boolean[][] } | null = null;
function qrModuler(url: string): boolean[][] {
  if (qrCache?.url === url) return qrCache.mod;
  const q = (window as W).qrcode(0, "M");
  q.addData(url);
  q.make();
  const n = q.getModuleCount();
  const mod = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => !!q.isDark(r, c)));
  qrCache = { url, mod };
  return mod;
}

export type SidInfo = { v: Variant; text: AviText; profil: Profil; beteckning: string; kod: string };

/** Textblock: rader med radhöjd; returnerar ny y. */
function textblock(ops: Op[], rader: string[], x: number, y: number, size: number, bold: boolean, color: string, lh = 1.3): number {
  const steg = size * PT * lh;
  rader.forEach((r, i) => ops.push({ t: "text", x, y: y + size * PT + i * steg, s: r, size, bold, color }));
  return y + (rader.length ? size * PT + (rader.length - 1) * steg + size * PT * 0.35 : 0);
}

function logo(ops: Op[], p: Profil, x: number, y: number, maxW: number, maxH: number, color: string) {
  if (p.logo) {
    const k = Math.min(maxW / p.logo.w, maxH / p.logo.h);
    ops.push({ t: "img", x, y, w: p.logo.w * k, h: p.logo.h * k, src: p.logo.src });
  } else {
    const rader = radbryt(p.agare, 15, true, maxW).slice(0, 2);
    textblock(ops, rader, x, y, 15, true, color, 1.1);
  }
}

function a4(info: SidInfo, s: number): { ops: Op[]; slut: number; grans: number } {
  const { v, text, profil } = info;
  const f = fargerFor(profil);
  const W = 210, H = 297, M = 16, B = W - 2 * M;
  const ops: Op[] = [{ t: "rect", x: 0, y: 0, w: W, h: H, fill: "#ffffff" }];

  // Sidhuvud: logotyp till vänster, hörnmärkning till höger.
  logo(ops, profil, M, M - 2, 62, 20, f.text);
  const visaHorn = v.typ !== "ktv";
  if (visaHorn) {
    const hx = W - M;
    ops.push({ t: "text", x: hx, y: M + 1.5, s: info.kod, size: 9, bold: true, color: GRA, align: "right" });
    ops.push({ t: "text", x: hx, y: M + 6.5, s: info.beteckning, size: 11, bold: true, color: INK, align: "right" });
    const roll = v.typ === "forv" ? "Förvaltning" : v.mottagare === "lokal" ? "Lokalhyresgäst" : "Lägenhetsinnehavare";
    ops.push({ t: "text", x: hx, y: M + 11, s: roll, size: 8.5, color: GRA, align: "right" });
  }
  let y = M + 22;
  ops.push({ t: "rect", x: M, y, w: B, h: 1.2, fill: f.prim });
  y += 8;

  // Rubrik och ingress.
  y = textblock(ops, radbryt(text.rubrik, 25 * s, true, B), M, y, 25 * s, true, f.text, 1.12);
  y += 2.5 * s;
  y = textblock(ops, radbryt(text.ingress, 12.5 * s, false, B), M, y, 12.5 * s, false, INK, 1.35);
  y += 5 * s;

  // Faktaruta.
  const fakta = text.fakta.filter((x) => x.etikett.trim() || x.varde.trim());
  if (fakta.length) {
    const cw = B / fakta.length;
    const celler = fakta.map((x) => ({
      e: radbryt(x.etikett.toUpperCase(), 7.5, true, cw - 8),
      v: radbryt(x.varde, 10.5 * s, true, cw - 8),
    }));
    const hojd = 8 + Math.max(...celler.map((c) => c.e.length * 7.5 * PT * 1.25 + c.v.length * 10.5 * s * PT * 1.3)) + 2;
    ops.push({ t: "rect", x: M, y, w: B, h: hojd, fill: f.platta, r: 2 });
    celler.forEach((c, i) => {
      const x = M + i * cw + 5;
      let yy = textblock(ops, c.e, x, y + 4.5, 7.5, true, GRA, 1.25);
      yy += 0.8;
      textblock(ops, c.v, x, yy, 10.5 * s, true, INK, 1.3);
      if (i > 0) ops.push({ t: "rect", x: M + i * cw, y: y + 4, w: 0.3, h: hojd - 8, fill: blanda(f.prim, 0.7) });
    });
    y += hojd + 7 * s;
  }

  // Avsnitt i två spalter (i ordning: vänster först).
  const av = text.avsnitt.filter((a) => a.rubrik.trim() || a.text.trim());
  const gap = 9;
  const kw = (B - gap) / 2;
  const block = av.map((a) => ({
    r: radbryt(a.rubrik, 12 * s, true, kw),
    t: radbryt(a.text, 10.5 * s, false, kw),
  }));
  const hojdAv = (b: { r: string[]; t: string[] }) =>
    (b.r.length ? 12 * s * PT * (1 + (b.r.length - 1) * 1.2) + 2 : 0) + (b.t.length ? 10.5 * s * PT * (1 + (b.t.length - 1) * 1.38) : 0) + 6.5 * s;
  const total = block.reduce((n, b) => n + hojdAv(b), 0);
  let vansterH = 0;
  let delning = block.length;
  for (let i = 0; i < block.length; i++) {
    if (vansterH + hojdAv(block[i]) / 2 > total / 2 && i > 0) { delning = i; break; }
    vansterH += hojdAv(block[i]);
  }
  let maxY = y;
  [block.slice(0, delning), block.slice(delning)].forEach((kol, k) => {
    let yy = y;
    const x = M + k * (kw + gap);
    kol.forEach((b) => {
      yy = textblock(ops, b.r, x, yy, 12 * s, true, f.text, 1.2);
      if (b.r.length) yy += 0.6;
      yy = textblock(ops, b.t, x, yy, 10.5 * s, false, INK, 1.38);
      yy += 5 * s;
    });
    maxY = Math.max(maxY, yy);
  });
  y = maxY;

  // Tidslinje.
  const tl = text.tidslinje.filter((t) => t.trim());
  if (tl.length) {
    y += 1;
    const tw = B / tl.length;
    let h = 0;
    tl.forEach((t, i) => {
      const x = M + i * tw;
      ops.push({ t: "rect", x, y, w: 7, h: 7, fill: i === 0 ? f.prim : blanda(f.prim, 0.75), r: 3.5 });
      ops.push({ t: "text", x: x + 3.5, y: y + 4.9, s: String(i + 1), size: 9.5, bold: true, color: i === 0 ? f.pa : INK, align: "center" });
      const rader = radbryt(t, 9.5 * s, i === 0, tw - 12);
      const yy = textblock(ops, rader, x + 10, y + 0.6, 9.5 * s, i === 0, INK, 1.3);
      h = Math.max(h, yy - y, 7);
    });
    y += h + 4;
  }

  // Botten: erbjudande med QR och support.
  const bh = 46;
  const by = H - M - bh;
  const ew = 76;
  const qs = 31;
  ops.push({ t: "rect", x: M, y: by, w: ew, h: bh, fill: f.prim, r: 2.5 });
  ops.push({ t: "text", x: M + 6, y: by + 9, s: "ERT ERBJUDANDE", size: 8.5, bold: true, color: f.pa });
  textblock(ops, radbryt("Skanna för att ta del av fastighetens erbjudande", 10, false, ew - qs - 14), M + 6, by + 12.5, 10, false, f.pa, 1.3);
  ops.push({ t: "text", x: M + 6, y: by + bh - 6, s: "connectestate.se/", size: 7, color: f.pa });
  ops.push({ t: "text", x: M + 6, y: by + bh - 3, s: "erbjudande", size: 7, color: f.pa });
  ops.push({ t: "rect", x: M + ew - qs - 6, y: by + (bh - qs) / 2, w: qs, h: qs, fill: "#ffffff", r: 1.5 });
  ops.push({ t: "qr", x: M + ew - qs - 6 + 2.5, y: by + (bh - qs) / 2 + 2.5, size: qs - 5, mod: qrModuler(ERBJUDANDE_URL), color: "#000000" });

  const sx = M + ew + 5, sw = B - ew - 5;
  ops.push({ t: "rect", x: sx, y: by, w: sw, h: bh, fill: f.platta, r: 2.5 });
  ops.push({ t: "text", x: sx + 5, y: by + 8, s: "Hitta rätt support – beroende på vad frågan gäller", size: 9, bold: true, color: f.text });
  const cw2 = (sw - 10) / 2;
  const slug = profil.slug || slugAv(profil.agare);
  const kol = [
    { r: "Frågor om projektet", l: ["ConnectEstate", CE_TELEFON, CE_EPOST, `connectestate.se/${slug}`] },
    { r: "Tv och internet", l: ["Telias kundservice", TELIA_TELEFON, "telia.se", ...(v.bredband ? [] : ["Bredband: bredbandswebben.se"])] },
  ];
  kol.forEach((k, i) => {
    const x = sx + 5 + i * cw2;
    ops.push({ t: "text", x, y: by + 15, s: k.r.toUpperCase(), size: 7, bold: true, color: GRA });
    k.l.forEach((l, j) => {
      const size = j === 0 ? 9.5 : 8.6;
      let txt = l;
      while (bredd(txt, size, j === 0) > cw2 - 2 && txt.length > 4) txt = txt.slice(0, -2) + "…";
      ops.push({ t: "text", x, y: by + 20.5 + j * 4.6, s: txt, size, bold: j === 0, color: INK });
    });
  });

  return { ops, slut: y, grans: by - 5 };
}

function a6(info: SidInfo, s: number): { ops: Op[]; slut: number; grans: number } {
  const { text, profil } = info;
  const f = fargerFor(profil);
  const W = 148, H = 105, M = 9;
  const ops: Op[] = [{ t: "rect", x: 0, y: 0, w: W, h: H, fill: "#ffffff" }];
  ops.push({ t: "rect", x: 0, y: 0, w: 5, h: H, fill: f.prim });
  logo(ops, profil, M + 2, M - 2, 45, 13, f.text);
  ops.push({ t: "text", x: W - M, y: M + 2, s: info.beteckning, size: 8.5, bold: true, color: GRA, align: "right" });
  const tb = W - 2 * M - 2 - 36;
  let y = M + 16;
  y = textblock(ops, radbryt(text.rubrik, 15 * s, true, tb), M + 2, y, 15 * s, true, f.text, 1.12);
  y += 1.5;
  y = textblock(ops, radbryt(text.ingress, 9.5 * s, false, tb), M + 2, y, 9.5 * s, false, INK, 1.3);
  y += 3;
  text.fakta.filter((x) => x.etikett.trim() || x.varde.trim()).forEach((x) => {
    y = textblock(ops, radbryt(x.etikett.toUpperCase(), 6.5, true, tb), M + 2, y, 6.5, true, GRA, 1.2);
    y = textblock(ops, radbryt(x.varde, 10 * s, true, tb), M + 2, y, 10 * s, true, INK, 1.25);
    y += 1.5;
  });
  const qs = 30, qx = W - M - qs, qy = H - M - qs - 7;
  ops.push({ t: "rect", x: qx - 2, y: qy - 9, w: qs + 4, h: qs + 18, fill: f.platta, r: 2 });
  ops.push({ t: "text", x: qx + qs / 2, y: qy - 3.5, s: "ERT ERBJUDANDE", size: 7.5, bold: true, color: f.text, align: "center" });
  ops.push({ t: "rect", x: qx, y: qy, w: qs, h: qs, fill: "#ffffff" });
  ops.push({ t: "qr", x: qx + 2, y: qy + 2, size: qs - 4, mod: qrModuler(ERBJUDANDE_URL), color: "#000000" });
  ops.push({ t: "text", x: qx + qs / 2, y: qy + qs + 5, s: "Skanna för erbjudandet", size: 6.5, color: GRA, align: "center" });
  return { ops, slut: y, grans: H - M };
}

/** Bygger sidan och krymper texten tills allt får plats på en sida. */
export function byggSida(info: SidInfo): Sida & { krympt: boolean; forLang: boolean } {
  const dekal = info.v.typ === "dekal";
  let s = 1;
  for (;;) {
    const r = dekal ? a6(info, s) : a4(info, s);
    if (r.slut <= r.grans || s <= 0.66) {
      return { w: dekal ? 148 : 210, h: dekal ? 105 : 297, ops: r.ops, krympt: s < 1, forLang: r.slut > r.grans };
    }
    s = Math.round((s - 0.04) * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Ritning: PDF och SVG
// ---------------------------------------------------------------------------

export function sidaTillPdf(sida: Sida): Blob {
  const J = jsPDF();
  const doc = new J({ unit: "mm", format: sida.w > sida.h ? [sida.h, sida.w] : [sida.w, sida.h], orientation: sida.w > sida.h ? "landscape" : "portrait", compress: true });
  for (const o of sida.ops) {
    if (o.t === "rect") {
      doc.setFillColor(o.fill);
      if (o.r) doc.roundedRect(o.x, o.y, o.w, o.h, o.r, o.r, "F");
      else doc.rect(o.x, o.y, o.w, o.h, "F");
    } else if (o.t === "text") {
      doc.setFont("helvetica", o.bold ? "bold" : "normal");
      doc.setFontSize(o.size);
      doc.setTextColor(o.color);
      doc.text(o.s, o.x, o.y, { align: o.align ?? "left" });
    } else if (o.t === "img") {
      doc.addImage(o.src, "PNG", o.x, o.y, o.w, o.h, undefined, "FAST");
    } else {
      const n = o.mod.length;
      const m = o.size / n;
      doc.setFillColor(o.color);
      o.mod.forEach((rad, r) => {
        let c = 0;
        while (c < n) {
          if (!rad[c]) { c++; continue; }
          let e = c;
          while (e + 1 < n && rad[e + 1]) e++;
          doc.rect(o.x + c * m, o.y + r * m, (e - c + 1) * m + 0.02, m + 0.02, "F");
          c = e + 1;
        }
      });
    }
  }
  return doc.output("blob") as Blob;
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function sidaTillSvg(sida: Sida): string {
  const delar: string[] = [];
  for (const o of sida.ops) {
    if (o.t === "rect") {
      delar.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="${o.r ?? 0}" fill="${o.fill}"/>`);
    } else if (o.t === "text") {
      const anchor = o.align === "right" ? "end" : o.align === "center" ? "middle" : "start";
      delar.push(`<text x="${o.x}" y="${o.y}" font-size="${(o.size * PT).toFixed(3)}" font-weight="${o.bold ? 700 : 400}" fill="${o.color}" text-anchor="${anchor}">${xmlEsc(o.s)}</text>`);
    } else if (o.t === "img") {
      delar.push(`<image x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" href="${o.src}" preserveAspectRatio="xMinYMin meet"/>`);
    } else {
      const n = o.mod.length;
      const m = o.size / n;
      let d = "";
      o.mod.forEach((rad, r) => rad.forEach((on, c) => { if (on) d += `M${(o.x + c * m).toFixed(3)} ${(o.y + r * m).toFixed(3)}h${m.toFixed(3)}v${m.toFixed(3)}h${(-m).toFixed(3)}z`; }));
      delar.push(`<path d="${d}" fill="${o.color}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sida.w} ${sida.h}" font-family="Helvetica, Arial, sans-serif">${delar.join("")}</svg>`;
}

// ---------------------------------------------------------------------------
// Logotyp → PNG
// ---------------------------------------------------------------------------

/** Läser en bildfil/blob och ritar om den som PNG (högst 900 px bred) för PDF:en. */
export function bildTillPng(blob: Blob): Promise<{ src: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / (img.naturalWidth || 900));
      const w = Math.max(1, Math.round((img.naturalWidth || 600) * k));
      const h = Math.max(1, Math.round((img.naturalHeight || 200) * k));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve({ src: c.toDataURL("image/png"), w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Logotypen gick inte att läsa.")); };
    img.src = url;
  });
}

export function nyZip(): any {
  return new ((window as W).JSZip)();
}
