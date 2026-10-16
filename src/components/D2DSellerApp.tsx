import { VtSaljarPanel } from "./D2DVtBestallningar";
import { AngerPanel } from "./D2DAnger";
import { KundtjanstPanel, KundtjanstSaljKnapp, KundtjanstSaljSida, arKundtjanstNu } from "./D2DKundtjanst";
import { D2DAllaLagenheter } from "./D2DAllaLagenheter";
import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getMetadata, listRecords, getRecord, updateRecord, createRecord, addRelation,
  type ObjectDef, type RecordRow, type RelatedRecord, type FieldDef,
  DataError,
} from "@/lib/data";
import { FieldInput } from "@/lib/fields";
import { ThemeToggle, useTheme } from "@/lib/theme";
import { brandCssVars } from "@/lib/color";
import { FieldConfigPanel } from "./FieldConfigPanel";
import { MobilNummerPanel } from "./MobilNummer";
import { AvtalsSammanfattning } from "./D2DAvtal";
import { D2DAvtalPage } from "./D2DAvtalPage";
import { ScriveSignering } from "./D2DScrive";
import { BindningPanel, EjMerPanel } from "./D2DBindning";
import { UTAN_NETFLIX_FALT, SPORT_MED_NETFLIX, EXTRA_ANTAL_FALT, EXTRA_VAL, antalExtra } from "@/lib/d2dPris";
import { useRoute, navigate, goBack } from "@/lib/route";
import { rememberRow as rememberRowShared, useReturnToRow as useReturnToRowShared } from "@/lib/returnRow";

const rememberRow = (listKey: string, id: string) => rememberRowShared("d2d:" + listKey, id);
const useReturnToRow = (listKey: string, ready: boolean) => useReturnToRowShared("d2d:" + listKey, ready, "d2d-return-flash");
import { useUserName } from "@/lib/users";
import { D2DDashboard } from "./D2DDashboard";
import { D2DFeedbackFlik } from "./D2DFeedback";
import { FelanmalanPanel } from "./D2DFelanmalan";
import { Fyrverkeri, skjutFyrverkeri } from "./D2DFyrverkeri";
import "@/styles/d2d.css";

// =============================================================================
// Typer & hjälpfunktioner
// =============================================================================

type D2DView =
  | { kind: "oversikt" }
  | { kind: "fastigheter" }
  | { kind: "projekt"; id: string }
  | { kind: "signerade" }
  | { kind: "avtal" }
  | { kind: "aterkopplingar" }
  | { kind: "feedback" }
  | { kind: "alla" }
  | { kind: "kundtjanst" }
  | { kind: "fastighet"; id: string }
  | { kind: "lagenhet"; id: string; fastighetId: string; from?: "signerade" | "avtal" | "aterkopplingar" | "alla" | "kundtjanst" };

/** URL (#/d2d/…) ↔ vy, så en omladdning stannar på samma fastighet/adress. */
function d2dViewFromSegs(segs: string[]): D2DView {
  const [kind, id, extra, from] = segs;
  if (kind === "fastigheter") return { kind: "fastigheter" };
  if (kind === "signerade") return { kind: "signerade" };
  if (kind === "avtal") return { kind: "avtal" };
  if (kind === "aterkopplingar") return { kind: "aterkopplingar" };
  if (kind === "feedback") return { kind: "feedback" };
  if (kind === "alla") return { kind: "alla" };
  if (kind === "kundtjanst") return { kind: "kundtjanst" };
  if (kind === "projekt" && id) return { kind: "projekt", id };
  if (kind === "fastighet" && id) return { kind: "fastighet", id };
  if (kind === "lagenhet" && id) {
    // from = listan man öppnade adressen från, så Tillbaka går dit igen.
    const src = from === "signerade" || from === "avtal" || from === "aterkopplingar" || from === "alla" || from === "kundtjanst" ? from : undefined;
    return { kind: "lagenhet", id, fastighetId: extra && extra !== "-" ? extra : "", from: src };
  }
  // Startsidan när man klickar på Door to Door: dashboarden.
  return { kind: "oversikt" };
}

function d2dSegsFromView(v: D2DView): string[] {
  switch (v.kind) {
    case "projekt": return ["d2d", "projekt", v.id];
    case "fastighet": return ["d2d", "fastighet", v.id];
    case "lagenhet":
      if (v.from) return ["d2d", "lagenhet", v.id, v.fastighetId || "-", v.from];
      return v.fastighetId ? ["d2d", "lagenhet", v.id, v.fastighetId] : ["d2d", "lagenhet", v.id];
    default: return ["d2d", v.kind];
  }
}

export type KnockStatus = "ej_knackad" | "inte_hemma" | "aterkoppling" | "inte_intresserad" | "inte_saljbar" | "befintlig_telia" | "intresserad" | "sald" | "scrive" | "kall_kund" | "anger";

/** Statusfärgerna ligger som egna variabler `--d2d-st-<status>` i
 *  `styles/d2d.css` (Gustavs färgval okt 2026) och varje status har sin
 *  egen klass `d2d-status--<status>` som sätter `--lag-st`. Samma hexfärger
 *  ligger i `status_definitions.color` så CRM:ets statuspiller matchar. */
export const STATUS_CONFIG: Record<KnockStatus, { label: string; color: string; cssClass: string }> = {
  ej_knackad:       { label: "Ej knackad",       color: "var(--d2d-st-ej_knackad)",       cssClass: "d2d-status--ej_knackad" },
  inte_hemma:       { label: "Inte hemma",       color: "var(--d2d-st-inte_hemma)",       cssClass: "d2d-status--inte_hemma" },
  aterkoppling:     { label: "Återkoppling",     color: "var(--d2d-st-aterkoppling)",     cssClass: "d2d-status--aterkoppling" },
  inte_intresserad: { label: "Inte intresserad", color: "var(--d2d-st-inte_intresserad)", cssClass: "d2d-status--inte_intresserad" },
  // Dörren går inte att sälja på (tom lägenhet, lokal, …). Räknas som en
  // öppnad dörr utan sälj i Utfall, precis som Inte intresserad.
  inte_saljbar:     { label: "Inte säljbar",     color: "var(--d2d-st-inte_saljbar)",     cssClass: "d2d-status--inte_saljbar" },
  befintlig_telia:  { label: "Befintlig Telia-kund", color: "var(--d2d-st-befintlig_telia)", cssClass: "d2d-status--befintlig_telia" },
  intresserad:      { label: "Intresserad",      color: "var(--d2d-st-intresserad)",      cssClass: "d2d-status--intresserad" },
  sald:             { label: "Såld",             color: "var(--d2d-st-sald)",             cssClass: "d2d-status--sald" },
  // Som "Såld" men utan att registrera ett sälj: kunden signerar ett avtalsförslag
  // med Scrive (inte ett bindande avtal). Räknas inte som sålt i statistiken.
  scrive:           { label: "Signera med Scrive", color: "var(--d2d-st-scrive)",         cssClass: "d2d-status--scrive" },
  // Ersätter "Övrigt" (borttagen 2026-10, befintliga flyttades hit).
  kall_kund:        { label: "Kall kund",        color: "var(--d2d-st-kall_kund)",        cssClass: "d2d-status--kall_kund" },
  // Kunden har ångrat sig efter Såld/Scrive. Markeras via "Kunden har ångrat sig…" (D2DAnger.tsx),
  // inte som vanlig statusbubbla. Tjänsterna ligger kvar för statistiken.
  anger:            { label: "Ånger",            color: "var(--d2d-st-anger)",            cssClass: "d2d-status--anger" },
};

const SECTION_LABELS: Record<string, string> = {
  knackning: "Knackning",
  kunddata: "Kunddata",
  forsaljning: "Försäljning",
  salt: "Sålda tjänster",
};

// Statusar som INTE ska visas som egna bubblor i statusväljaren högst upp —
// "Intresserad" är för löst definierat för att vara en egen slutstatus
// (jfr "Såld"), så den plockas bort ur väljaren men finns kvar i
// STATUS_CONFIG eftersom befintliga poster kan ha statusen satt sedan innan.
// "Inte intresserad" togs bort 14 okt 2026 (alla blev Inte säljbar); typen finns kvar för historiken.
const HIDDEN_STATUS_PICKS = new Set<KnockStatus>(["intresserad", "anger", "inte_intresserad"]);

// Anledningar säljaren kan välja mellan när en lägenhet markeras
// "Inte intresserad" — låter statistiken brytas ner senare i CRM:et.
const EJ_INTRESSERAD_REASONS: Array<{ key: string; label: string }> = [
  { key: "for_gammal",         label: "För gammal" },
  // "Bindningstid" är borttagen som anledning (okt 2026) — bindningar
  // anges i stället per tjänst under "Vad är bundet?". Äldre poster kan ha
  // värdet kvar; då visas det som vald chip ändå (se nedan).
  { key: "flyttar",            label: "Flyttar" },
  { key: "saknar_behov",       label: "Saknar behov" },
  { key: "dalig_ekonomi",      label: "Dålig ekonomi" },
  { key: "vill_inte_ha_fiber", label: "Vill inte ha fiber" },
];

/** Fullständig adress för en lägenhetspost — gatunamn, gatunummer och
 *  lägenhetsnummer tillsammans, t.ex. "Storgatan 12, lgh 14A". Används
 *  överallt en lägenhet visas i säljarvyn så säljaren aldrig behöver gissa
 *  vilken dörr en rad i en lista syftar på. Faller tillbaka till bara
 *  lägenhetsnumret om adressfälten saknas (t.ex. äldre poster). */
export function formatLagenhetAdress(data: Record<string, unknown>, title: string | null | undefined): string {
  const gatuadress = [data.gatunamn, data.gatunummer].filter(Boolean).join(" ");
  const medIngang = data.ingang
    ? `${gatuadress}${gatuadress ? ", " : ""}ingång ${String(data.ingang)}`
    : gatuadress;
  return medIngang ? `${medIngang}, lgh ${title ?? "—"}` : `Lgh ${title ?? "—"}`;
}

/** Återkopplingar som är kopplade till en säljare (tilldelad eller säljare)
 *  visas bara för den säljaren, kundtjänst och administratörer (isAdmin = true
 *  för admin och kundtjänst). Samma regel som
 *  d2d_alla_lagenheter i databasen. */
export function doldAterkoppling(l: RecordRow, minId: string | null | undefined, isAdmin: boolean): boolean {
  if (isAdmin || l.status !== "aterkoppling") return false;
  const saljare = String((l.data as Record<string, unknown>).saljare ?? "");
  if (!l.owner_user_id && !saljare) return false;
  return !minId || (l.owner_user_id !== minId && saljare !== minId);
}

/** Sorterar lägenheter i gångordning: gatunamn, gatunummer (1, 2, 3 …),
 *  ingång (A, B, C …) och sist lägenhetsnummer (1001, 1002, 1101 …).
 *  Numerisk jämförelse så 2 < 10 och 1002 < 1101, inte strängordning. */
export function jamforLagenheter(a: RecordRow, b: RecordRow): number {
  const da = a.data as Record<string, unknown>;
  const db = b.data as Record<string, unknown>;
  const cmp = (x: unknown, y: unknown) =>
    String(x ?? "").localeCompare(String(y ?? ""), "sv", { numeric: true, sensitivity: "base" });
  return cmp(da.gatunamn, db.gatunamn)
    || cmp(da.gatunummer, db.gatunummer)
    || cmp(da.ingang, db.ingang)
    || cmp(a.title, b.title);
}

// =============================================================================
// Tillbaka till samma rad
// =============================================================================

/**
 * När säljaren öppnar en rad (fastighet/lägenhet) och sedan går tillbaka ska
 * listan landa på exakt den raden igen — inte högst upp. Senast öppnade rad
 * per lista sparas (i minnet + sessionStorage, så det överlever en omladdning)
 * och när listan laddat klart skrollas raden in mitt i vyn och blinkar till.
 */
// Delad logik: src/lib/returnRow.ts (samma beteende i hela systemet).

// =============================================================================
// Fastighets-/adressinfo (infrastruktur, TV, tillträde)
// =============================================================================

type InfoRow = { label: string; value: string };

const txt = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  // "-" / "–" används i importfiler som "inget" — behandla som tomt.
  return /^[-–—]+$/.test(s) ? "" : s;
};
const SAKNAS = "Saknas";

/** Alla infrastrukturfakta säljaren behöver, i en fast ordning. Fastighetens
 *  värden är utgångsläget; skickas en lägenhet med vinner dess egna
 *  adressvärden från importen (…_adress, koax_avslutsdatum,
 *  befintligt_kanalpaket, nytt_kanalpaket) där de finns — adresser kan avvika
 *  från fastigheten i övrigt. Tomma värden hoppas över. */
function infraRows(fast: Record<string, unknown>, lag?: Record<string, unknown>): InfoRow[] {
  const l = lag ?? {};
  const pick = (lagKey: string | null, fastKey: string) =>
    (lagKey ? txt(l[lagKey]) : "") || txt(fast[fastKey]);

  const koax = pick("befintlig_koax_adress", "befintlig_koax");
  const koaxSlut = pick("koax_avslutsdatum", "avtalstid_koax");
  const fiber = pick("befintlig_fiber_adress", "befintlig_fiber");
  const fiberSlut = txt(fast.avtalstid_fiber);

  // Gamla nätet: har avslutsdatumet passerats är nätet släckt och ska inte
  // se ut som något kunden fortfarande har. ISO-datum jämförs som strängar.
  const nat = txt(fast.befintligt_nat);
  const natSlut = txt(fast.gamla_nat_avslutsdatum);
  const idag = new Date().toISOString().slice(0, 10);
  const natSlackt = !!natSlut && natSlut <= idag;
  const natText = nat
    ? (natSlut ? `${nat} (${natSlackt ? "släckt" : "släcks"} ${natSlut})` : nat)
    : "";

  const rows: Array<[string, string]> = [
    ["Fastighetsägare", txt(fast.fastighetsagare)],
    ["Förvaltare", txt(fast.forvaltare)],
    ["Portkod", pick("portkod_adress", "portkod")],
    [natSlackt ? "Tidigare nät" : "Befintligt nät", natText],
    // Fiber, koax och TV visas alltid — finns inget står det "Saknas", så
    // säljaren vet att det är kontrollerat och inte bara ej ifyllt.
    ["Befintlig fiber", fiber ? (fiberSlut ? `${fiber} (t.o.m. ${fiberSlut})` : fiber) : (nat ? "" : SAKNAS)],
    ["Fiberavtal t.o.m.", !fiber ? fiberSlut : ""],
    ["Befintlig koax", koax ? (koaxSlut ? `${koax} (t.o.m. ${koaxSlut})` : koax) : (txt(fast.kabel_tv) ? "" : SAKNAS)],
    ["Koaxavtal t.o.m.", !koax ? koaxSlut : ""],
    ["Kabel-TV", txt(fast.kabel_tv)],
    ["Befintlig TV", pick("befintligt_kanalpaket", "nuvarande_tv") || SAKNAS],
    ["Nytt kanalpaket", pick("nytt_kanalpaket", "nytt_tv_installation")],
    ["Kanalpaket efter avslut", txt(fast.nytt_tv_efter_avslut)],
    ["Installationsdatum", pick("installationsdatum_adress", "installationsdatum")],
    ["Kundklar", txt(fast.kundklar_datum)],
    ["Antal lägenheter", txt(fast.antal_lagenheter)],
    ["Gamla nätet avslutas", !nat ? natSlut : ""],
    ["Tillträde", txt(fast.tilltradesinstruktion)],
  ];
  return rows.filter(([, v]) => v).map(([label, value]) => ({ label, value }));
}

function InfraBox({ title, rows, emptyText }: { title: string; rows: InfoRow[]; emptyText: string }) {
  return (
    <div className="d2d-infobox">
      <div className="d2d-infobox__header">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="10" cy="10" r="7"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r=".8" fill="currentColor" stroke="none"/></svg>
        <span>{title}</span>
      </div>
      <div className="d2d-infobox__grid">
        {rows.map((r) => (
          <div key={r.label} className="d2d-infobox__row">
            <span className="d2d-infobox__label">{r.label}</span>
            <span>{r.value}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="d2d-infobox__empty">{emptyText}</div>}
      </div>
    </div>
  );
}

// =============================================================================
// Tillfälliga fastigheter och lägenheter
// =============================================================================
//
// I specialsituationer (en port som saknas i underlaget, en lägenhet som
// inte finns i Telias lista …) kan säljaren själv lägga upp en fastighet
// eller lägenhet direkt i telefonen. Allt säljaren skapar är *tillfälligt*
// (data.tillfallig = true) tills en administratör godkänner det — i
// projektbyggaren (fliken "Att godkänna") eller här i säljarvyn. Tillfälliga
// lägenheter räknas inte i Utfall/topplistan förrän de godkänts.
// Databasen: d2d_skapa_tillfallig_fastighet, d2d_skapa_tillfallig_lagenhet,
// d2d_godkann_tillfallig.

const arTillfallig = (data: Record<string, unknown> | undefined | null) => data?.tillfallig === true;

function TillfalligBadge() {
  return <span className="d2d-tillf-badge" title="Skapad av säljare — väntar på att en administratör godkänner">Tillfällig</span>;
}

/** Banderoll högst upp i en tillfällig fastighet/lägenhet. Admin får en
 *  Godkänn-knapp; efter godkännande anropas onGodkand så vyn laddas om. */
function TillfalligBanner({ id, typ, isAdmin, onGodkand }: {
  id: string; typ: "fastighet" | "lagenhet"; isAdmin: boolean; onGodkand: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const godkann = async () => {
    setBusy(true); setFel(null);
    const { error } = await supabase.rpc("d2d_godkann_tillfallig", { p_id: id });
    setBusy(false);
    if (error) { setFel(error.message || "Kunde inte godkänna."); return; }
    onGodkand();
  };
  return (
    <div className="d2d-tillf-banner" role="status">
      <svg className="d2d-tillf-banner__icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" /><path d="M10 6v4.5l3 1.5" />
      </svg>
      <div className="d2d-tillf-banner__text">
        <strong>{typ === "fastighet" ? "Tillfällig fastighet" : "Tillfällig lägenhet"}</strong>
        <span>
          {fel ?? (typ === "fastighet"
            ? "Skapad av säljare. Fastigheten och dess lägenheter blir ordinarie när en administratör godkänt den."
            : "Skapad av säljare. Räknas i statistiken när en administratör godkänt den.")}
        </span>
      </div>
      {isAdmin && (
        <button className="btn btn--brand btn--sm" onClick={() => { void godkann(); }} disabled={busy}>
          {busy ? "Godkänner…" : "Godkänn"}
        </button>
      )}
    </div>
  );
}

/** Formulär för att skapa en tillfällig fastighet i ett projekt — bara det
 *  säljaren rimligen vet: gatuadress, ort och (om känd) beteckning. */
function TillfalligFastighetForm({ projektId, onCreated, onCancel }: {
  projektId: string; onCreated: (id: string) => void; onCancel: () => void;
}) {
  const [adress, setAdress] = useState("");
  const [ort, setOrt] = useState("");
  const [beteckning, setBeteckning] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const ok = adress.trim().length > 0 && ort.trim().length > 0;

  const skapa = async () => {
    if (!ok || busy) return;
    setBusy(true); setFel(null);
    urvalCache = null; // ny fastighet ska synas direkt i listorna
    const { data, error } = await supabase.rpc("d2d_skapa_tillfallig_fastighet", {
      p_projekt_id: projektId === UTAN_PROJEKT ? null : projektId,
      p_gatuadress: adress.trim(),
      p_ort: ort.trim(),
      p_fastighetsbeteckning: beteckning.trim() || null,
    });
    setBusy(false);
    if (error || !data) { setFel(error?.message || "Kunde inte skapa fastigheten."); return; }
    onCreated(String(data));
  };

  return (
    <form className="d2d-tillf-form" onSubmit={(e) => { e.preventDefault(); void skapa(); }}>
      <h3>Ny tillfällig fastighet</h3>
      <p>Fastigheten blir tillfällig tills en administratör godkänt den. Lägenheter lägger du till inne i fastigheten.</p>
      <label className="d2d-tillf-form__falt">
        <span className="label">Gatuadress *</span>
        <input className="input" value={adress} onChange={(e) => setAdress(e.target.value)} placeholder="t.ex. Storgatan 12" autoFocus autoComplete="off" />
      </label>
      <label className="d2d-tillf-form__falt">
        <span className="label">Ort *</span>
        <input className="input" value={ort} onChange={(e) => setOrt(e.target.value)} placeholder="t.ex. Umeå" autoComplete="off" />
      </label>
      <label className="d2d-tillf-form__falt">
        <span className="label">Fastighetsbeteckning (om du vet)</span>
        <input className="input" value={beteckning} onChange={(e) => setBeteckning(e.target.value)} placeholder="t.ex. Falken 9" autoComplete="off" />
      </label>
      {fel && <span className="d2d-tillf-form__fel">{fel}</span>}
      <div className="d2d-tillf-form__knappar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>Avbryt</button>
        <button type="submit" className="btn btn--brand btn--sm" disabled={!ok || busy}>{busy ? "Skapar…" : "Skapa fastighet"}</button>
      </div>
    </form>
  );
}

/** Formulär för en tillfällig lägenhet i en fastighet. Ort, postnummer,
 *  beteckning och portkod hämtas från fastigheten i databasen. Adressen kan
 *  skilja sig inom samma fastighet, så gatunamn, gatunummer och ingång
 *  fylls i av säljaren (gatunamn/nummer förifyllda från fastigheten), plus
 *  lägenhetsnummer (Skatteverket) och ev. internt nummer/alias. */
function TillfalligLagenhetForm({ fastighetId, fastData, onCreated, onCancel }: {
  fastighetId: string; fastData: Record<string, unknown>; onCreated: (id: string) => void; onCancel: () => void;
}) {
  // "Storgatan 12B" → gatunamn "Storgatan", gatunummer "12B" som förslag.
  const fastAdress = String(fastData.adress ?? fastData.name ?? "").trim();
  const m = fastAdress.match(/^(.*\S)\s+(\d+\s?[A-Za-z]?)$/);
  const [gatunamn, setGatunamn] = useState(m ? m[1] : fastAdress);
  const [gatunummer, setGatunummer] = useState(m ? m[2] : "");
  const [ingang, setIngang] = useState("");
  const [nummer, setNummer] = useState("");
  const [alias, setAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const ok = nummer.trim().length > 0 && gatunamn.trim().length > 0;

  const skapa = async () => {
    if (!ok || busy) return;
    setBusy(true); setFel(null);
    urvalCache = null;
    const { data, error } = await supabase.rpc("d2d_skapa_tillfallig_adress", {
      p_fastighet_id: fastighetId,
      p_lgh_nummer: nummer.trim(),
      p_alias: alias.trim() || null,
      p_gatunamn: gatunamn.trim(),
      p_gatunummer: gatunummer.trim() || null,
      p_ingang: ingang.trim() || null,
    });
    setBusy(false);
    if (error || !data) { setFel(error?.message || "Kunde inte skapa lägenheten."); return; }
    onCreated(String(data));
  };

  return (
    <form className="d2d-tillf-form" onSubmit={(e) => { e.preventDefault(); void skapa(); }}>
      <h3>Ny tillfällig lägenhet</h3>
      <p>Ort och fastighetsinfo hämtas från fastigheten. Ändra adressen om den skiljer sig från fastighetens. Lägenheten blir tillfällig tills en administratör godkänt den.</p>
      <div className="d2d-tillf-form__rad">
        <label className="d2d-tillf-form__falt d2d-tillf-form__falt--bred">
          <span className="label">Gatunamn *</span>
          <input className="input" value={gatunamn} onChange={(e) => setGatunamn(e.target.value)} placeholder="t.ex. Storgatan" autoComplete="off" />
        </label>
        <label className="d2d-tillf-form__falt">
          <span className="label">Gatunr</span>
          <input className="input" value={gatunummer} onChange={(e) => setGatunummer(e.target.value)} placeholder="12B" autoComplete="off" />
        </label>
        <label className="d2d-tillf-form__falt">
          <span className="label">Ingång</span>
          <input className="input" value={ingang} onChange={(e) => setIngang(e.target.value)} placeholder="A" autoComplete="off" />
        </label>
      </div>
      <label className="d2d-tillf-form__falt">
        <span className="label">Lägenhetsnummer (Skatteverket) *</span>
        <input className="input" value={nummer} onChange={(e) => setNummer(e.target.value)} placeholder="t.ex. 1101" inputMode="numeric" autoFocus autoComplete="off" />
      </label>
      <label className="d2d-tillf-form__falt">
        <span className="label">Internt lgh-nummer / alias</span>
        <input className="input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="t.ex. 3 tr vänster" autoComplete="off" />
      </label>
      {fel && <span className="d2d-tillf-form__fel">{fel}</span>}
      <div className="d2d-tillf-form__knappar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>Avbryt</button>
        <button type="submit" className="btn btn--brand btn--sm" disabled={!ok || busy}>{busy ? "Skapar…" : "Skapa lägenhet"}</button>
      </div>
    </form>
  );
}

// =============================================================================
// Fastighetslista
// =============================================================================

/** Projekt-id för fastigheter som inte ligger i något projekt. */
const UTAN_PROJEKT = "utan";

type D2DUrval = {
  fastigheter: RecordRow[];
  /** fastighet-id → projekt-id (UTAN_PROJEKT om den saknar projekt) */
  projektFor: Map<string, string>;
  projekt: RecordRow[];
};

/**
 * Fastigheterna med lägenheter (alla säljare ser alla), plus egna tillfälliga
 * fastigheter utan lägenheter, och vilka projekt de hör till. Ett anrop
 * (d2d_saljar_urval) i stället för att bläddra igenom alla
 * lägenhet→fastighet-relationer — det tog många sekunder med ~10 000
 * lägenheter. Svaret cachas en kort stund så att projekt → fastigheter
 * inte hämtar samma sak två gånger.
 */
let urvalCache: { at: number; p: Promise<D2DUrval> } | null = null;
const URVAL_TTL = 60_000;

function hamtaUrval(): Promise<D2DUrval> {
  if (urvalCache && Date.now() - urvalCache.at < URVAL_TTL) return urvalCache.p;
  const p = (async (): Promise<D2DUrval> => {
    const { data, error } = await supabase.rpc("d2d_saljar_urval");
    if (error) throw error;
    const svar = (data ?? {}) as { fastigheter?: Array<RecordRow & { projekt_id: string | null }>; projekt?: RecordRow[] };
    const fastigheter: RecordRow[] = [];
    const projektFor = new Map<string, string>();
    for (const f of svar.fastigheter ?? []) {
      fastigheter.push(f);
      projektFor.set(f.id, f.projekt_id ?? UTAN_PROJEKT);
    }
    return { fastigheter, projektFor, projekt: svar.projekt ?? [] };
  })();
  urvalCache = { at: Date.now(), p };
  p.catch(() => { urvalCache = null; });
  return p;
}

// =============================================================================
// Projektval — första steget: välj projekt, sedan fastigheterna i det
// =============================================================================

function ProjektLista({ onOpen, onAlla, onKundtjanst }: { onOpen: (id: string) => void; onAlla: () => void; onKundtjanst: () => void }) {
  const [urval, setUrval] = useState<D2DUrval | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    hamtaUrval().then(setUrval).catch(() => setError(true));
  }, []);

  const returnRow = useReturnToRow("projekt", !!urval);

  if (error) return <div className="d2d-empty">Kunde inte hämta projekten. Försök igen.</div>;
  if (!urval) return <div className="d2d-loading">Laddar projekt…</div>;

  const antal = new Map<string, number>();
  for (const pid of urval.projektFor.values()) antal.set(pid, (antal.get(pid) ?? 0) + 1);
  const rader: Array<{ id: string; namn: string }> = urval.projekt
    .map((p) => ({ id: p.id, namn: p.title ?? "Namnlöst projekt" }))
    .sort((a, b) => a.namn.localeCompare(b.namn, "sv", { numeric: true }));
  if (antal.has(UTAN_PROJEKT)) rader.push({ id: UTAN_PROJEKT, namn: "Utan projekt" });

  return (
    <div className="d2d-list">
      {/* Alla lägenheter i en tabell, oavsett projekt — med filter. Klick på en
          rad fäller ut kortet (namn, telefon, kommentar, status). */}
      <button type="button" className="btn btn--brand d2d-alla__knapp" onClick={onAlla}>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 8l7-5 7 5v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M8 17v-5h4v5"/>
        </svg>
        Alla lägenheter
      </button>
      {/* Sälj från kundtjänst: affärer kundtjänst lämnat till en säljare, med antal nya. */}
      <KundtjanstSaljKnapp onOpen={onKundtjanst} />
      <div className="d2d-list__header">
        <h2>Välj projekt</h2>
        <span className="d2d-list__count">{rader.length} st</span>
      </div>

      {rader.length === 0 && (
        <div className="d2d-empty">Inga fastigheter tilldelade ännu.</div>
      )}

      {rader.map((p) => {
        const n = antal.get(p.id) ?? 0;
        return (
          <button key={p.id} className="d2d-card" {...returnRow(p.id)} onClick={() => { rememberRow("projekt", p.id); onOpen(p.id); }}>
            <div className="d2d-card__main">
              <span className="d2d-card__title">{p.namn}</span>
              <span className="d2d-card__sub">{n} {n === 1 ? "fastighet" : "fastigheter"}</span>
            </div>
            <svg className="d2d-card__chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 4l4 4-4 4"/></svg>
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Fastighetslista (inom ett projekt)
// =============================================================================

function FastighetsLista({
  projektId,
  onBack,
  onOpen,
}: {
  projektId: string;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [projektNamn, setProjektNamn] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [nyTillfallig, setNyTillfallig] = useState(false);

  useEffect(() => {
    setLoading(true);
    hamtaUrval()
      .then(({ fastigheter, projektFor, projekt }) => {
        setProjektNamn(projektId === UTAN_PROJEKT ? "Utan projekt"
          : projekt.find((p) => p.id === projektId)?.title ?? "Projekt");
        // Turordning först (så säljaren går i planerad ordning), sedan
        // fastighetsbeteckning numeriskt (Falken 9 < Falken 10).
        const tur = (r: RecordRow) => {
          const t = Number((r.data as Record<string, unknown>).turordning);
          return Number.isFinite(t) && t > 0 ? t : Number.MAX_SAFE_INTEGER;
        };
        const bet = (r: RecordRow) => String((r.data as Record<string, unknown>).fastighetsbeteckning ?? r.title ?? "");
        setItems(fastigheter
          .filter((f) => projektFor.get(f.id) === projektId)
          .sort((a, b) => tur(a) - tur(b) || bet(a).localeCompare(bet(b), "sv", { numeric: true })));
      })
      .catch(() => { /* tyst */ })
      .finally(() => setLoading(false));
  }, [projektId]);

  const returnRow = useReturnToRow("fastigheter:" + projektId, !loading);

  if (loading) return <div className="d2d-loading">Laddar fastigheter…</div>;

  return (
    <div className="d2d-detail">
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack} aria-label="Tillbaka till projekt">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>{projektNamn}</h2>
          <span className="d2d-topbar__sub">{items.length} {items.length === 1 ? "fastighet" : "fastigheter"}</span>
        </div>
      </div>

      <div className="d2d-list">
        {items.length === 0 && (
          <div className="d2d-empty">Inga fastigheter i det här projektet.</div>
        )}

        {items.map((item) => {
          const data = item.data as Record<string, unknown>;
          return (
            <button key={item.id} className="d2d-card" {...returnRow(item.id)} onClick={() => { rememberRow("fastigheter:" + projektId, item.id); onOpen(item.id); }}>
              <div className="d2d-card__main">
                <span className="d2d-card__title">
                  {data.fastighetsbeteckning ? String(data.fastighetsbeteckning) : (item.title ?? "Namnlös")}
                  {arTillfallig(data) && <> <TillfalligBadge /></>}
                </span>
                {!!(item.title || data.fastighetsagare) && (
                  <span className="d2d-card__sub">
                    {[item.title, data.fastighetsagare].filter(Boolean).map(String).join(" · ")}
                  </span>
                )}
              </div>
              <svg className="d2d-card__chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 4l4 4-4 4"/></svg>
            </button>
          );
        })}
      </div>

      {/* Specialsituation: en fastighet som saknas i underlaget. Säljaren
          lägger upp den tillfälligt i det här projektet och går direkt in
          i den för att lägga till lägenheter. */}
      {nyTillfallig ? (
        <TillfalligFastighetForm
          projektId={projektId}
          onCancel={() => setNyTillfallig(false)}
          onCreated={(id) => { setNyTillfallig(false); rememberRow("fastigheter:" + projektId, id); onOpen(id); }}
        />
      ) : (
        <div className="d2d-tillf-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => setNyTillfallig(true)}>+ Tillfällig fastighet</button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Fastighetsöversikt med knackvy (lägenhetslista)
// =============================================================================

/** Namnet på säljaren som fått adressen tilldelad (eller "—"). Är adressen
 *  såld/signerad av en annan säljare än den som har den nu (säljaren byttes
 *  på fastigheten efteråt) visas även "såld av …". */
/** Skrivskyddat kort: vems lägenheten är. */
function SaljareInfo({ id }: { id: string | null }) {
  const name = useUserName(id);
  return (
    <span className="d2d-lag-panel__info">
      {id ? <>Tilldelad <strong>{name}</strong> – du kan se men inte ändra den.</> : "Ingen säljare tilldelad – du kan se men inte ändra den."}
    </span>
  );
}

function SaljareCell({ id, saldAv, signerad }: { id: string | null; saldAv?: string | null; signerad?: boolean }) {
  const name = useUserName(id);
  const saldAvNamn = useUserName(saldAv ?? null);
  return (
    <span className={`d2d-lag-row__cell d2d-lag-row__cell--saljare${id ? "" : " d2d-lag-row__cell--empty"}`} title={id ? name : undefined}>
      {id ? name : "—"}
      {!!saldAv && <span className="d2d-lag-row__saldav">{signerad ? "signerad av" : "såld av"} {saldAvNamn}</span>}
    </span>
  );
}

/** "Såld av …" / "Signerad av …" på en såld adress. Säljaren som sålde
 *  (data.saljare) är låst; har adressen sedan flyttats till en annan säljare
 *  (owner_user_id) visas även vem som har den nu. */
function SaldAvRad({ status, saljare, agare }: { status: string | null; saljare: string | null; agare: string | null }) {
  const saljareNamn = useUserName(saljare);
  const agareNamn = useUserName(agare);
  if (!saljare || (status !== "sald" && status !== "scrive")) return null;
  return (
    <div className="d2d-saldav">
      <strong>{status === "scrive" ? "Signerad av" : "Såld av"} {saljareNamn}</strong>
      {!!agare && agare !== saljare && <span className="d2d-saldav__agare"> · tilldelad {agareNamn}</span>}
    </div>
  );
}

/** tel:-länk av ett inskrivet nummer: behåller siffror och inledande +,
 *  svenskt nummer med inledande 0 blir +46. Tomt/ogiltigt → null. */
function telefonLank(nr: string): string | null {
  const s = nr.trim();
  if (!s) return null;
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  else if (d.startsWith("0")) d = "+46" + d.slice(1);
  const siffror = d.replace(/\D/g, "");
  if (siffror.length < 5) return null;
  return `tel:${d}`;
}

function RingIkon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6.2 6.2l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>
    </svg>
  );
}

/** Ordning för segmenten i fastighetens progressbar — mest "klart" först
 *  (Såld, Scrive) så den gröna delen växer från vänster när man säljer.
 *  "Ej knackad" ritas inte som segment utan är den tomma delen av baren. */
const PROGRESS_ORDNING: KnockStatus[] = [
  "sald", "scrive", "intresserad", "aterkoppling", "befintlig_telia", "inte_hemma", "kall_kund", "inte_intresserad", "inte_saljbar", "anger",
];

/** Progressbar för en fastighet: "knackade/antal lägenheter". Varje
 *  lägenhet med en annan status än "Ej knackad" är en bit av baren i
 *  statusens färg; Såld = grön. Under baren en förklaring med antal per
 *  status (bara de som finns). */
export function FastighetProgress({ lagenheter }: { lagenheter: RecordRow[] }) {
  const total = lagenheter.length;
  if (total === 0) return null;
  const antal: Partial<Record<KnockStatus, number>> = {};
  for (const l of lagenheter) {
    const st = (l.status ?? "ej_knackad") as KnockStatus;
    const key: KnockStatus = STATUS_CONFIG[st] ? st : "ej_knackad";
    antal[key] = (antal[key] ?? 0) + 1;
  }
  const knackade = total - (antal.ej_knackad ?? 0);
  const salda = antal.sald ?? 0;
  const delar = PROGRESS_ORDNING.filter((k) => (antal[k] ?? 0) > 0);
  return (
    <div className="d2d-fprog" role="group" aria-label="Framsteg i fastigheten">
      <div className="d2d-fprog__rad">
        <span className="d2d-fprog__tal"><strong>{knackade}</strong>/{total} lägenheter</span>
        <span className="d2d-fprog__sald">{salda} sålda</span>
      </div>
      <div
        className="d2d-fprog__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={knackade}
        aria-valuetext={`${knackade} av ${total} lägenheter knackade, ${salda} sålda`}
      >
        {delar.map((k) => (
          <span
            key={k}
            className={`d2d-fprog__del d2d-fprog__del--${k}`}
            style={{ width: `${((antal[k] ?? 0) / total) * 100}%`, background: STATUS_CONFIG[k].color }}
            title={`${STATUS_CONFIG[k].label}: ${antal[k]}`}
          />
        ))}
      </div>
      {delar.length > 0 && (
        <div className="d2d-fprog__legend">
          {delar.map((k) => (
            <span key={k} className="d2d-fprog__item">
              <i style={{ background: STATUS_CONFIG[k].color }} />
              {STATUS_CONFIG[k].label} {antal[k]}
            </span>
          ))}
          {!!antal.ej_knackad && (
            <span className="d2d-fprog__item d2d-fprog__item--tom">
              <i />Ej knackad {antal.ej_knackad}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Lägenhetslistan som kort: huvudrad (ikon, adress, ingång, lgh, namn,
 *  kommentar, status, ring) + alltid utfälld snabbpanel med namn, telefon,
 *  Inte hemma och −/+ knackningar. Används både på en fastighet och i
 *  "Alla adresser". Namn/telefon/knackningar sparas direkt härifrån och
 *  speglas i `lagenheter` via `setLagenheter` (progressbaren följer med). */
export function LagenhetTabell({
  lagenheter,
  setLagenheter,
  isAdmin,
  fastData,
  listKey,
  ready,
  onOpenLagenhet,
  fastighetNamn,
  medKommentar = false,
  expanderbar = false,
  onSalj,
  kanAndra,
  visaSaljare = false,
}: {
  lagenheter: RecordRow[];
  setLagenheter: Dispatch<SetStateAction<RecordRow[]>>;
  isAdmin: boolean;
  /** Fastighetens data (för "tillfällig"-märkning av enskilda adresser). */
  fastData: Record<string, unknown>;
  listKey: string;
  ready: boolean;
  onOpenLagenhet: (id: string) => void;
  /** Visas som egen rad under adressen (t.ex. fastighet · ort i "Alla adresser"). */
  fastighetNamn?: (lagId: string) => string;
  /** Visa även ett kommentarsfält i snabbpanelen. */
  medKommentar?: boolean;
  /** Tabell där klick på raden fäller ut kortet (namn, telefon, kommentar,
   *  status) i stället för att öppna lägenheten — "Alla lägenheter". */
  expanderbar?: boolean;
  /** Anropas när status sätts till Såld/Scrive i det utfällda kortet, så
   *  att tjänster och kunduppgifter kan fyllas i (fönster med lägenheten). */
  onSalj?: (lagId: string) => void;
  /** Får användaren ändra lägenheten? Nej → det utfällda kortet visas
   *  skrivskyddat (andra säljares lägenheter i "Alla lägenheter"). */
  kanAndra?: (lag: RecordRow) => boolean;
  /** Visa säljarkolumnen även för säljare (när listan har andras lägenheter). */
  visaSaljare?: boolean;
}) {
  const medSaljare = isAdmin || visaSaljare;
  const [utfalld, setUtfalld] = useState<string | null>(null);
  // Namn och telefon per lägenhet (kund_namn, kund_telefon) — redigeras
  // direkt i kortet. Lokalt värde medan säljaren skriver; sparas när fältet
  // lämnas.
  const [telefoner, setTelefoner] = useState<Record<string, string>>({});
  const [namn, setNamn] = useState<Record<string, string>>({});
  const [kommentarer, setKommentarer] = useState<Record<string, string>>({});
  // Fyll de lokala fälten när listan laddas (nya id:n) eller när det
  // sparade värdet ändrats utifrån (t.ex. inne på lägenheten) — pågående
  // inmatning i rader vars sparade värde är oförändrat rörs inte.
  const sparatRef = useRef<Record<string, { namn: string; tel: string; komm: string }>>({});
  useEffect(() => {
    const nyNamn: Record<string, string> = {}, nyTel: Record<string, string> = {}, nyKomm: Record<string, string> = {};
    for (const l of lagenheter) {
      const d = l.data as Record<string, unknown>;
      const nu = { namn: d.kund_namn ? String(d.kund_namn) : "", tel: d.kund_telefon ? String(d.kund_telefon) : "", komm: d.kommentar ? String(d.kommentar) : "" };
      const forra = sparatRef.current[l.id];
      if (!forra || forra.namn !== nu.namn) nyNamn[l.id] = nu.namn;
      if (!forra || forra.tel !== nu.tel) nyTel[l.id] = nu.tel;
      if (!forra || forra.komm !== nu.komm) nyKomm[l.id] = nu.komm;
      sparatRef.current[l.id] = nu;
    }
    if (Object.keys(nyNamn).length) setNamn((prev) => ({ ...prev, ...nyNamn }));
    if (Object.keys(nyTel).length) setTelefoner((prev) => ({ ...prev, ...nyTel }));
    if (Object.keys(nyKomm).length) setKommentarer((prev) => ({ ...prev, ...nyKomm }));
  }, [lagenheter]);
  const [sparFel, setSparFel] = useState<string | null>(null);

  /** Uppdatera en lägenhet i listan lokalt (så progressbaren och raden
   *  följer med utan omladdning). */
  const patchaLokalt = useCallback((lagId: string, patch: Record<string, unknown>, status?: string | null) => {
    setLagenheter((prev) => prev.map((l) =>
      l.id === lagId
        ? { ...l, status: status === undefined ? l.status : status, data: { ...(l.data as Record<string, unknown>), ...patch } }
        : l
    ));
  }, []);

  const sparaText = useCallback(async (lagId: string, key: "kund_telefon" | "kund_namn" | "kommentar", varde: string, tidigare: string) => {
    const nytt = varde.trim();
    if (nytt === tidigare.trim()) return;
    try {
      await updateRecord(lagId, { [key]: nytt || null });
      patchaLokalt(lagId, { [key]: nytt || null });
      setSparFel(null);
    } catch (e) {
      // Återställ till det sparade värdet om det inte gick
      const setter = key === "kund_telefon" ? setTelefoner : key === "kommentar" ? setKommentarer : setNamn;
      setter((prev) => ({ ...prev, [lagId]: tidigare }));
      setSparFel(e instanceof DataError ? e.message : "Kunde inte spara — kontrollera uppkopplingen.");
    }
  }, [patchaLokalt]);

  /** Antal knackningar: sätt siffran direkt från −/+ i kortet. */
  const sparaKnack = useCallback(async (lag: RecordRow, antal: number) => {
    const v = Math.max(0, Math.min(99, antal)) || null;
    const tidigare = (lag.data as Record<string, unknown>).antal_knackningar ?? null;
    patchaLokalt(lag.id, { antal_knackningar: v });
    try {
      await updateRecord(lag.id, { antal_knackningar: v });
      setSparFel(null);
    } catch (e) {
      patchaLokalt(lag.id, { antal_knackningar: tidigare });
      setSparFel(e instanceof DataError ? e.message : "Kunde inte spara — kontrollera uppkopplingen.");
    }
  }, [patchaLokalt]);

  /** "Inte hemma" direkt från kortet: en knackning till, statusen Inte
   *  hemma och Senast kontakt = nu — samma som när statusen sätts inne
   *  på lägenheten. */
  const inteHemma = useCallback(async (lag: RecordRow) => {
    const d = lag.data as Record<string, unknown>;
    const n = Number(d.antal_knackningar);
    const patch: Record<string, unknown> = {
      antal_knackningar: (Number.isFinite(n) && n > 0 ? n : 0) + 1,
      senast_kontakt: new Date().toISOString(),
    };
    const tidigareStatus = lag.status;
    patchaLokalt(lag.id, patch, "inte_hemma");
    try {
      await updateRecord(lag.id, patch, "inte_hemma");
      setSparFel(null);
    } catch (e) {
      patchaLokalt(lag.id, { antal_knackningar: d.antal_knackningar ?? null, senast_kontakt: d.senast_kontakt ?? null }, tidigareStatus);
      setSparFel(e instanceof DataError ? e.message : "Kunde inte spara — kontrollera uppkopplingen.");
    }
  }, [patchaLokalt]);

  /** Status direkt från det utfällda kortet. Senast kontakt = nu, som inne
   *  på lägenheten. Såld/Scrive öppnar fönstret för tjänster och kunduppgifter. */
  const andraStatus = useCallback(async (lag: RecordRow, nyStatus: string) => {
    if (nyStatus === lag.status) { if (nyStatus === "sald" || nyStatus === "scrive") onSalj?.(lag.id); return; }
    const d = lag.data as Record<string, unknown>;
    const patch: Record<string, unknown> = nyStatus === "ej_knackad" ? {} : { senast_kontakt: new Date().toISOString() };
    const tidigare = lag.status;
    patchaLokalt(lag.id, patch, nyStatus);
    try {
      await updateRecord(lag.id, patch, nyStatus);
      setSparFel(null);
      if (nyStatus === "sald" || nyStatus === "scrive") onSalj?.(lag.id);
    } catch (e) {
      patchaLokalt(lag.id, { senast_kontakt: d.senast_kontakt ?? null }, tidigare);
      setSparFel(e instanceof DataError ? e.message : "Kunde inte spara — kontrollera uppkopplingen.");
    }
  }, [patchaLokalt, onSalj]);

  const returnRow = useReturnToRow(listKey, ready);

  return (
    <>
            {/* Kolumnvy: (admin: tilldelad säljare,) adress (gatunamn + nummer),
                ingång, lgh-nr, namn och kommentar i egna kolumner, så listan går
                att skanna uppifrån och ned per dörr. Statusen syns som färgad
                ikon längst till vänster + etikett längst till höger. På mobil
                hamnar kommentaren på en egen rad under i stället för i en kolumn.
                Säljarkolumnen visas bara för admin — en ren säljare ser ändå
                bara sina egna adresser.
                Varje rad är ett öppet kort: under huvudraden ligger alltid en
                snabbpanel med namn, telefon, knappen Inte hemma och −/+ för
                antal knackningar — så säljaren slipper öppna lägenheten för
                det vanligaste. Klick på huvudraden öppnar lägenheten som förut. */}
            {sparFel && <div className="d2d-lag-fel" role="alert">{sparFel}</div>}
            {lagenheter.length > 0 && (
              <div className={`d2d-lag-table${medSaljare ? " d2d-lag-table--admin" : ""}${expanderbar ? " d2d-lag-table--expander" : ""}`}>
                <div className="d2d-lag-table__head" aria-hidden="true">
                  <span />
                  {medSaljare && <span>Säljare</span>}
                  <span>Adress</span>
                  <span>Ingång</span>
                  <span>Lgh</span>
                  <span className="d2d-lag-table__namn-col">Namn</span>
                  <span className="d2d-lag-table__komm-col">Kommentar</span>
                  <span className="d2d-lag-table__status-col">Status</span>
                  <span className="d2d-lag-table__ring-col" />
                </div>

                {lagenheter.map((lag) => {
                  const lagData = lag.data as Record<string, unknown>;
                  const st = (lag.status ?? "ej_knackad") as KnockStatus;
                  const cfg = STATUS_CONFIG[st] ?? STATUS_CONFIG.ej_knackad;
                  const gatuadress = [lagData.gatunamn, lagData.gatunummer].filter(Boolean).join(" ");
                  const kommentar = lagData.kommentar ? String(lagData.kommentar) : "";
                  // Tilldelad säljare = ägaren; den som sålde ligger i data.saljare.
                  const soldeId = lagData.saljare ? String(lagData.saljare) : null;
                  const saljareId = lag.owner_user_id ?? soldeId;
                  const saldAv = (st === "sald" || st === "scrive") && soldeId && soldeId !== saljareId ? soldeId : null;
                  const sparadTelefon = lagData.kund_telefon ? String(lagData.kund_telefon) : "";
                  const sparatNamn = lagData.kund_namn ? String(lagData.kund_namn) : "";
                  const telefon = telefoner[lag.id] ?? sparadTelefon;
                  const namnVarde = namn[lag.id] ?? sparatNamn;
                  const kommVarde = kommentarer[lag.id] ?? kommentar;
                  const telHref = telefonLank(telefon);
                  const adressText = formatLagenhetAdress(lagData, lag.title);
                  const nKnack = Number(lagData.antal_knackningar);
                  const knack = Number.isFinite(nKnack) && nKnack > 0 ? nKnack : 0;
                  const oppna = () => { rememberRow(listKey, lag.id); onOpenLagenhet(lag.id); };
                  const arUtfalld = !expanderbar || utfalld === lag.id;
                  const skrivbar = !kanAndra || kanAndra(lag);
                  const klickRad = expanderbar ? () => { rememberRow(listKey, lag.id); setUtfalld((u) => (u === lag.id ? null : lag.id)); } : oppna;
                  // Raden är en div (inte button) eftersom den innehåller
                  // interaktiva element (ringknappen) — de får inte ligga
                  // inuti en knapp.
                  return (
                    <div key={lag.id} className={`d2d-lag-kort ${cfg.cssClass}${expanderbar && arUtfalld ? " d2d-lag-kort--utfalld" : ""}`}>
                    <div
                      {...returnRow(lag.id)}
                      role="button"
                      tabIndex={0}
                      className="d2d-lag-row"
                      onClick={klickRad}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); klickRad(); } }}
                      aria-label={adressText}
                      aria-expanded={expanderbar ? arUtfalld : undefined}
                    >
                      <span className="d2d-lag-row__icon" style={{ "--st": cfg.color } as CSSProperties} aria-hidden="true">
                        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="2.5" width="10" height="15" rx="1.5" />
                          <circle cx="12" cy="10.5" r=".9" fill="currentColor" stroke="none" />
                        </svg>
                      </span>
                      {medSaljare && <SaljareCell id={saljareId} saldAv={saldAv} signerad={st === "scrive"} />}
                      <span className="d2d-lag-row__cell d2d-lag-row__cell--addr">{gatuadress || "—"}</span>
                      <span className="d2d-lag-row__cell">{lagData.ingang ? String(lagData.ingang) : "—"}</span>
                      <span className="d2d-lag-row__cell d2d-lag-row__cell--lgh">
                        {lag.title ?? "—"}
                        {arTillfallig(lagData) && !arTillfallig(fastData) && <TillfalligBadge />}
                      </span>
                      <span className={`d2d-lag-row__cell d2d-lag-row__cell--namn${sparatNamn ? "" : " d2d-lag-row__cell--empty"}`}>
                        {sparatNamn || "—"}
                        {knack > 0 && (
                          <span className="d2d-lag-row__knack" title={`Knackat ${knack} ${knack === 1 ? "gång" : "gånger"}`}>
                            {knack}×
                          </span>
                        )}
                      </span>
                      <span
                        className={`d2d-lag-row__cell d2d-lag-row__cell--komm d2d-lag-table__komm-col${kommentar ? "" : " d2d-lag-row__cell--empty"}`}
                        title={kommentar || undefined}
                      >
                        {kommentar || "—"}
                      </span>
                      <span className="d2d-lag-card__badge d2d-lag-table__status-col">{cfg.label}</span>
                      {/* Ringknapp — grön, till höger om status. tel:-länk så
                          telefonen ringer upp direkt; nedtonad utan nummer. */}
                      {telHref ? (
                        <a
                          href={telHref}
                          className="d2d-lag-ring d2d-lag-table__ring-col"
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Ring ${telefon}`}
                          title={`Ring ${telefon}`}
                        >
                          <RingIkon />
                        </a>
                      ) : (
                        <span className="d2d-lag-ring d2d-lag-ring--tom d2d-lag-table__ring-col" aria-hidden="true" title="Inget telefonnummer">
                          <RingIkon />
                        </span>
                      )}
                      {!!fastighetNamn?.(lag.id) && (
                        <span className="d2d-lag-row__fast">{fastighetNamn(lag.id)}</span>
                      )}
                      {!!kommentar && (
                        <span className="d2d-lag-row__comment">
                          {kommentar.slice(0, 80)}{kommentar.length > 80 ? "…" : ""}
                        </span>
                      )}
                    </div>

                    {arUtfalld && !skrivbar && (
                      <div className="d2d-lag-panel d2d-lag-panel--las">
                        <SaljareInfo id={saljareId} />
                        {knack > 0 && <span className="d2d-lag-panel__info">Knackat {knack} {knack === 1 ? "gång" : "gånger"}</span>}
                        {!!kommentar && <span className="d2d-lag-panel__info d2d-lag-panel__info--komm">{kommentar}</span>}
                      </div>
                    )}
                    {arUtfalld && skrivbar && <div className={`d2d-lag-panel${medKommentar ? " d2d-lag-panel--komm" : ""}`}>
                      <label className="d2d-lag-panel__falt">
                        <span>Namn</span>
                        <input
                          type="text"
                          autoComplete="off"
                          className="d2d-lag-tel__input"
                          value={namnVarde}
                          placeholder="Kundens namn"
                          onChange={(e) => setNamn((prev) => ({ ...prev, [lag.id]: e.target.value }))}
                          onBlur={(e) => { void sparaText(lag.id, "kund_namn", e.target.value, sparatNamn); }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        />
                      </label>
                      <label className="d2d-lag-panel__falt">
                        <span>Telefon</span>
                        <input
                          type="tel"
                          inputMode="tel"
                          autoComplete="off"
                          className="d2d-lag-tel__input"
                          value={telefon}
                          placeholder="Telefonnummer"
                          onChange={(e) => setTelefoner((prev) => ({ ...prev, [lag.id]: e.target.value }))}
                          onBlur={(e) => { void sparaText(lag.id, "kund_telefon", e.target.value, sparadTelefon); }}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        />
                      </label>
                      <div className="d2d-lag-panel__knack">
                        <button
                          type="button"
                          className={`d2d-lag-panel__hemma${st === "inte_hemma" ? " d2d-lag-panel__hemma--aktiv" : ""}`}
                          onClick={() => { void inteHemma(lag); }}
                          title="Sätter statusen Inte hemma och räknar upp en knackning"
                        >
                          {st === "inte_hemma" ? "Inte hemma igen" : "Inte hemma"}
                        </button>
                        <div className="d2d-knack__rad" role="group" aria-label="Antal knackningar">
                          <button type="button" className="d2d-knack__btn" aria-label="En färre" disabled={knack <= 0}
                            onClick={() => { void sparaKnack(lag, knack - 1); }}>−</button>
                          <span className="d2d-lag-panel__antal" aria-live="polite">{knack}</span>
                          <button type="button" className="d2d-knack__btn" aria-label="En till" disabled={knack >= 99}
                            onClick={() => { void sparaKnack(lag, knack + 1); }}>+</button>
                          <span className="d2d-knack__text">{knack === 1 ? "knackning" : "knackningar"}</span>
                        </div>
                      </div>
                      {medKommentar && (
                        <label className="d2d-lag-panel__falt d2d-lag-panel__komm">
                          <span>Kommentar</span>
                          <textarea
                            className="d2d-lag-tel__input d2d-lag-panel__textarea"
                            rows={2}
                            value={kommVarde}
                            placeholder="Kommentar"
                            onChange={(e) => setKommentarer((prev) => ({ ...prev, [lag.id]: e.target.value }))}
                            onBlur={(e) => { void sparaText(lag.id, "kommentar", e.target.value, kommentar); }}
                          />
                        </label>
                      )}
                      {/* Utfällt kort: status direkt. Såld/Scrive öppnar fönstret för
                          tjänster och kunduppgifter. Vid ånger byter bara admin status. */}
                      {expanderbar && (st !== "anger" || isAdmin) && (
                        <div className="d2d-status-picker d2d-lag-panel__status" role="group" aria-label="Status">
                          {(Object.keys(STATUS_CONFIG) as KnockStatus[]).filter((k) => !HIDDEN_STATUS_PICKS.has(k)).map((k) => (
                            <button key={k} type="button"
                              className={`d2d-status-btn ${STATUS_CONFIG[k].cssClass}${st === k ? " d2d-status-btn--active" : ""}`}
                              onClick={() => { void andraStatus(lag, k); }}>
                              {STATUS_CONFIG[k].label}
                            </button>
                          ))}
                        </div>
                      )}
                      {expanderbar && st === "anger" && (
                        <span className="d2d-anger-tag d2d-lag-panel__anger">Kunden har ångrat sig</span>
                      )}
                      <button type="button" className="btn btn--ghost btn--sm d2d-lag-panel__oppna" onClick={oppna}>
                        Öppna lägenheten →
                      </button>
                    </div>}
                    </div>
                  );
                })}
              </div>
            )}
    </>
  );
}

function FastighetsDetalj({
  fastighetId,
  isAdmin = false,
  onBack,
  onOpenLagenhet,
}: {
  fastighetId: string;
  isAdmin?: boolean;
  onBack: () => void;
  onOpenLagenhet: (id: string) => void;
}) {
  const [fastighet, setFastighet] = useState<RecordRow | null>(null);
  const [related, setRelated] = useState<RelatedRecord[]>([]);
  const [lagenheter, setLagenheter] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nyTillfallig, setNyTillfallig] = useState(false);
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getRecord(fastighetId);
      setFastighet(res.record);
      setRelated(res.related);

      // Hämta lägenhet-IDn från relationer (d2d_lag_fastighet incoming)
      const lagIds = res.related
        .filter((r) => r.record.objectType === "d2d_lagenhet")
        .map((r) => r.record.id);

      if (lagIds.length > 0) {
        // Hämta alla lägenheter med data
        const { data: lagData } = await supabase
          .from("records")
          .select("id,object_type,data,status,owner_user_id,title,created_at,updated_at")
          .in("id", lagIds)
          .order("title");
        const { data: session } = await supabase.auth.getSession();
        const minId = session.session?.user.id ?? null;
        // Kundtjänst ser alla adresser, även andras återkopplingar (som admin).
        const allaAterkopplingar = isAdmin || await arKundtjanstNu();
        setLagenheter(((lagData ?? []) as RecordRow[])
          .filter((l) => !doldAterkoppling(l, minId, allaAterkopplingar))
          .sort(jamforLagenheter));
      } else {
        setLagenheter([]);
      }
    } catch {
      // tyst
    } finally {
      setLoading(false);
    }
  }, [fastighetId, isAdmin]);

  useEffect(() => { loadData(); }, [loadData]);

  const total = lagenheter.length;
  const listKey = `fastighet:${fastighetId}`;

  if (loading) return <div className="d2d-loading">Laddar…</div>;
  if (!fastighet) return <div className="d2d-empty">Fastigheten hittades inte.</div>;

  const data = fastighet.data as Record<string, unknown>;

  return (
    <div className="d2d-detail">
      {/* Topbar */}
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>{fastighet.title ?? "Fastighet"}</h2>
          {!!(data.fastighetsbeteckning || data.ort) && (
            <span className="d2d-topbar__sub">{[data.fastighetsbeteckning, data.ort].filter(Boolean).map(String).join(" · ")}</span>
          )}
        </div>
      </div>

      {arTillfallig(data) && (
        <TillfalligBanner id={fastighet.id} typ="fastighet" isAdmin={isAdmin} onGodkand={() => { void loadData(); }} />
      )}

      {/* Viktig info (varning) */}
      {!!data.viktigt_info && (
        <div className="d2d-warning">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" className="d2d-warning__icon"><path d="M10 2.5l7 3.2v4c0 4.2-2.9 7.6-7 8.8-4.1-1.2-7-4.6-7-8.8v-4l7-3.2Z"/></svg>
          <div>
            <strong>Viktigt inför knackning</strong>
            <p>{String(data.viktigt_info)}</p>
          </div>
        </div>
      )}

      {/* Fastighetsinfo — alla ifyllda infrastruktur-/TV-fakta om
          fastigheten (utgångsläget; enskilda adresser kan avvika). */}
      <InfraBox title="Fastighetsinfo" rows={infraRows(data)} emptyText="Ingen fastighetsinfo ifylld ännu." />

      {/* Felanmälan på adressen → Ärenden → Felanmälningar (leveransansvarig + Lukas). */}
      <FelanmalanPanel
        fastighetId={fastighetId}
        lagenheter={lagenheter.map((l) => ({ id: l.id, label: formatLagenhetAdress(l.data as Record<string, unknown>, l.title) }))}
      />

      {/* Lägenhetslista */}
      <div className="d2d-lag-list">
        <div className="d2d-lag-list__header">
          <h3>Lägenheter</h3>
          <span>{total} st</span>
        </div>

        {/* Progressbar: knackade/antal lägenheter, en färgad bit per status
            (Såld grön). Uppdateras när statusen ändras — listan laddas om
            när säljaren kommer tillbaka från lägenheten. */}
        <FastighetProgress lagenheter={lagenheter} />

        {lagenheter.length === 0 && (
          <div className="d2d-empty">Inga lägenheter registrerade.</div>
        )}

        <LagenhetTabell
          lagenheter={lagenheter}
          setLagenheter={setLagenheter}
          isAdmin={isAdmin}
          fastData={data}
          listKey={listKey}
          ready={!loading}
          onOpenLagenhet={onOpenLagenhet}
        />
      </div>

      {/* Specialsituation: en dörr som saknas i listan. Säljaren lägger upp
          den tillfälligt; adressen hämtas från fastigheten. */}
      {nyTillfallig ? (
        <TillfalligLagenhetForm
          fastighetId={fastighetId}
          fastData={data}
          onCancel={() => setNyTillfallig(false)}
          onCreated={(id) => { setNyTillfallig(false); rememberRow(listKey, id); onOpenLagenhet(id); }}
        />
      ) : (
        <div className="d2d-tillf-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => setNyTillfallig(true)}>+ Tillfällig lägenhet</button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Alla adresser — säljarens alla lägenheter, med filter på status/ort/fastighet
// =============================================================================

/** Ordning i statusfiltret: det som kräver handling först. */
export const ALLA_STATUS_ORDNING: KnockStatus[] = [
  "ej_knackad", "inte_hemma", "aterkoppling", "scrive", "sald", "anger", "intresserad", "befintlig_telia", "kall_kund", "inte_intresserad", "inte_saljbar",
];

// =============================================================================
// Lägenhetformulär (knackvy)
// =============================================================================

export function LagenhetForm({
  lagenhetId,
  fastighetId,
  objectDef,
  onBack,
  isAdmin = false,
  onFieldsChanged,
}: {
  lagenhetId: string;
  fastighetId: string;
  objectDef: ObjectDef | undefined;
  onBack: () => void;
  isAdmin?: boolean;
  onFieldsChanged?: () => void;
}) {
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [fastData, setFastData] = useState<Record<string, unknown>>({});
  const [showFieldConfig, setShowFieldConfig] = useState(false);
  // Tid på adressen: från att adressen öppnas tills säljaren sätter en
  // status. Sparas i tid_pa_adress (minuter) och syns bara för admin.
  const oppnadRef = useRef(Date.now());
  const tidSparadRef = useRef(false);
  useEffect(() => { oppnadRef.current = Date.now(); tidSparadRef.current = false; }, [lagenhetId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await getRecord(lagenhetId);
        setRecord(res.record);
        setData({ ...res.record.data });
        setStatus(res.record.status);

        // Fastighetens infrastrukturdata som utgångsläge för infon nedan.
        // fastighetId saknas när man kommer från Signerade/Återkoppling —
        // slå då upp den via relationen.
        const fid = fastighetId
          || res.related.find((r) => r.record.objectType === "d2d_fastighet")?.record.id;
        if (fid) {
          const { data: f } = await supabase.from("records").select("data").eq("id", fid).maybeSingle();
          setFastData(((f?.data ?? {}) as Record<string, unknown>));
        }
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, [lagenhetId, fastighetId]);

  // ── Autospara ────────────────────────────────────────────────────────────
  // Varje ändring sparas direkt — ingen Spara-knapp. Ändringar samlas i en
  // väntande patch (bara de nycklar som ändrats; servern slår ihop dem med
  // resten av posten) och skickas efter en kort paus när man skriver, eller
  // direkt vid klick (status, val, ja/nej, datum). Sparas även när man går
  // tillbaka, byter app eller stänger sidan.
  const pendingRef = useRef<{ data: Record<string, unknown>; status: string | null }>({ data: {}, status: null });
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const hasPending = () =>
    Object.keys(pendingRef.current.data).length > 0 || pendingRef.current.status !== null;

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    while (inflightRef.current) await inflightRef.current;
    if (!hasPending()) return;

    const p = pendingRef.current;
    pendingRef.current = { data: {}, status: null };
    setSaveState("saving");
    setError(null);

    const run = (async () => {
      try {
        await updateRecord(lagenhetId, Object.keys(p.data).length ? p.data : undefined, p.status);
        setSaveState(hasPending() ? "pending" : "saved");
        // Servern skapar nummerbytesärendet i efterhand (trigger) — hämta
        // kopplingen så att "registrerat" + låst startdatum syns direkt.
        // Vid Såld/Scrive sätter servern också säljaren (den som klickade) —
        // hämta den och ägaren så "Såld av …" visas direkt.
        if (p.status || Object.keys(p.data).some((k) => k.startsWith("mobil_") || k === "salt_mobil")) {
          const { data: row } = await supabase.from("records").select("data,owner_user_id").eq("id", lagenhetId).maybeSingle();
          const rd = (row?.data as Record<string, unknown> | undefined) ?? {};
          const nb = rd.mobil_nummerbyte_id ?? null;
          const sj = rd.saljare ?? null;
          setData((d) => (d.mobil_nummerbyte_id === nb && d.saljare === sj ? d : { ...d, mobil_nummerbyte_id: nb, saljare: sj }));
          if (row && p.status) setRecord((r) => (r && r.owner_user_id !== row.owner_user_id ? { ...r, owner_user_id: row.owner_user_id } : r));
        }
      } catch (e) {
        // Lägg tillbaka det som inte gick igenom (nyare väntande värden vinner)
        // så nästa försök skickar allt.
        pendingRef.current = {
          data: { ...p.data, ...pendingRef.current.data },
          status: pendingRef.current.status ?? p.status,
        };
        setSaveState("error");
        setError(e instanceof DataError ? e.message : "Kunde inte spara — kontrollera uppkopplingen.");
      }
    })();
    inflightRef.current = run;
    try { await run; } finally { inflightRef.current = null; }
  }, [lagenhetId]);

  const queueSave = (patch: Record<string, unknown>, nextStatus: string | null, delayMs: number) => {
    pendingRef.current = {
      data: { ...pendingRef.current.data, ...patch },
      status: nextStatus ?? pendingRef.current.status,
    };
    setSaveState("pending");
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flush(); }, delayMs);
  };

  // Spara det som väntar när vyn lämnas, appen hamnar i bakgrunden
  // (vanligt på mobil) eller sidan stängs.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") void flush(); };
    const onPageHide = () => { void flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      void flush();
    };
  }, [flush]);

  const handleBack = async () => {
    await flush();
    // Lämnar säljaren en såld lägenhet firas det med fyrverkerier (2 s).
    if (status === "sald") skjutFyrverkeri();
    onBack();
  };

  // Fälttyper där varje tangenttryck ger en ändring väntar lite innan de
  // sparas; övriga (val, ja/nej, datum) sparas direkt.
  const TYPING_TYPES = new Set(["text", "long_text", "phone", "email", "url", "number", "currency", "percent"]);

  const set = (key: string, delayMs = 800) => (value: unknown) => {
    setData((d) => ({ ...d, [key]: value }));
    queueSave({ [key]: value }, null, delayMs);
  };

  /** Nu, som ISO-tidpunkt i UTC (servern sparar datum/tid i UTC; fälten
   *  visar den i lokal tid). */
  const nuLokalTid = () => new Date().toISOString();

  const changeStatus = (key: string) => {
    if (key === status) return;
    setStatus(key);
    // Så fort en dörr fått en annan status än "Ej knackad" har säljaren
    // varit där — "Senast kontakt" sätts automatiskt till nu.
    const patch: Record<string, unknown> = {};
    if (key !== "ej_knackad") {
      patch.senast_kontakt = nuLokalTid();
      setData((d) => ({ ...d, senast_kontakt: patch.senast_kontakt }));
    }
    // Första statusbytet under besöket: spara hur länge adressen var öppen.
    if (!tidSparadRef.current) {
      tidSparadRef.current = true;
      patch.tid_pa_adress = Math.round((Date.now() - oppnadRef.current) / 6000) / 10;
    }
    // Inte hemma: räkna upp antalet knackningar (säljaren kan ändra siffran).
    if (key === "inte_hemma") {
      const n = Number(data.antal_knackningar);
      patch.antal_knackningar = (Number.isFinite(n) && n > 0 ? n : 0) + 1;
      setData((d) => ({ ...d, antal_knackningar: patch.antal_knackningar }));
    }
    queueSave(patch, key, 0);
  };

  if (loading) return <div className="d2d-loading">Laddar…</div>;
  if (!record) return <div className="d2d-empty">Lägenheten hittades inte.</div>;

  // Adress-header — statisk text, inte redigerbar. Ger säljaren snabb
  // kontext om vilken lägenhet/adress hen faktiskt står i just nu. Rubriken
  // visar alltid fullständig adress: gatunamn, gatunummer OCH lägenhetsnummer
  // tillsammans, aldrig bara ett av dem.
  const fullAdress = formatLagenhetAdress(data, record.title);
  const ortRad = [data.postnummer, data.postort].filter(Boolean).join(" ");
  const headerUndertext = [
    ortRad || null,
    data.fastighetsbeteckning ? String(data.fastighetsbeteckning) : null,
    data.alias ? `alias ${String(data.alias)}` : null,
  ].filter(Boolean).join(" · ");

  // Gruppera fält per sektion (dölj ai-sektionen samt de interna fälten för
  // "inte intresserad"-anledning, som hanteras av sitt eget UI nedan i
  // stället för att dyka upp som ett generiskt formulärfält).
  // Fält som hanteras av eget UI (eller är interna) och aldrig ska dyka upp
  // som generiska formulärfält — och inte heller i "Anpassa fält".
  const configurableFields = objectDef?.fields.filter((f) =>
    f.options.section !== "ai"
    && f.key !== "ej_intresserad_anledning"
    && f.key !== "ej_intresserad_bindningstid"
    && !f.options.sold_panel
    && f.key !== "salt_svar"
    && !f.options.d2d_eget_ui // bindningstid och "varför inte mer" har egna paneler
    && f.key !== UTAN_NETFLIX_FALT // eget val under Sport i "Vad såldes?"
    // Mobilnummer/portering har egen panel under Mobil i "Vad såldes?".
    && !["mobil_nummerval", "mobil_startdatum", "mobil_nummer", "mobil_nummerbyte_id"].includes(f.key)
  ) ?? [];
  // Kategorierna i "Vad såldes?" — ett fält per kategori (select = ett val,
  // multi_select = flera). Styrs helt av fältdefinitionerna, så kategorier
  // och alternativ ändras under "Anpassa fält" i CRM:et.
  const soldFields = (objectDef?.fields ?? [])
    // Boolean-kategorier (t.ex. Trygghetspaket) har bara Ja/Nej, inga alternativ.
    .filter((f) => f.options.sold_panel && f.visibility !== "hidden"
      && (f.fieldType === "boolean" || (f.options.choices?.length ?? 0) > 0))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const pickSold = (f: FieldDef, choice: string) => {
    if (f.fieldType === "multi_select") {
      const cur: string[] = Array.isArray(data[f.key]) ? (data[f.key] as unknown[]).map(String) : [];
      const next = cur.includes(choice) ? cur.filter((c) => c !== choice) : [...cur, choice];
      if (f.key === "salt_mobil" && choice === EXTRA_VAL) {
        // Extra användare: antalet följer valet (1 när det väljs, bort när det avmarkeras).
        const patch = { [f.key]: next.length ? next : null, [EXTRA_ANTAL_FALT]: next.includes(EXTRA_VAL) ? 1 : null };
        setData((d) => ({ ...d, ...patch }));
        queueSave(patch, null, 0);
        return;
      }
      set(f.key, 0)(next.length ? next : null);
    } else {
      // Tryck igen på valt alternativ = avmarkera.
      set(f.key, 0)(data[f.key] === choice ? null : choice);
    }
  };
  // Ja/Nej per kategori sparas i salt_svar ({ salt_bredband: true, ... }).
  // Saknas svar men ett alternativ redan är valt räknas det som Ja.
  const svar = (data.salt_svar && typeof data.salt_svar === "object" ? data.salt_svar : {}) as Record<string, boolean>;
  const answer = (f: FieldDef): boolean | undefined => {
    const v = data[f.key];
    if (f.fieldType === "boolean") return typeof v === "boolean" ? v : undefined;
    if (typeof svar[f.key] === "boolean") return svar[f.key];
    return (Array.isArray(v) ? v.length > 0 : !!v) ? true : undefined;
  };
  const setAnswer = (f: FieldDef, ja: boolean) => {
    const nextSvar = { ...svar, [f.key]: ja };
    const patch: Record<string, unknown> = { salt_svar: nextSvar };
    if (f.fieldType === "boolean") patch[f.key] = ja; // Ja/Nej är själva värdet
    // Mobil = Nej → inget nummerval heller (ett ev. öppet nummerbyte makuleras).
    if (f.key === "salt_mobil" && !ja) patch.mobil_nummerval = null;
    else if (!ja) patch[f.key] = null; // Nej = inget valt i kategorin
    setData((d) => ({ ...d, ...patch }));
    queueSave(patch, null, 0);
  };
  const isPicked = (f: FieldDef, choice: string) =>
    f.fieldType === "multi_select"
      ? Array.isArray(data[f.key]) && (data[f.key] as unknown[]).map(String).includes(choice)
      : data[f.key] === choice;
  // Admin väljer via "Anpassa fält" vilka av dem säljarna ser (seller_hidden).
  const fields = configurableFields.filter((f) => !f.options.seller_hidden);
  // Signera med Scrive: kundens uppgifter ligger mellan avtalsförslaget och
  // signeringen (och visas då inte en gång till i formuläret nedanför).
  const KUND_FALT = ["kund_namn", "personnummer", "kund_epost", "kund_telefon", "startdatum_tjanst", "scrive_ovrigt"];
  const kundFalt = status === "scrive"
    ? KUND_FALT.map((k) => configurableFields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f)
    : [];
  const formFalt = kundFalt.length ? fields.filter((f) => !KUND_FALT.includes(f.key)) : fields;

  // Fält med fast plats i flödet (ordningen Status → Kommentar → Vad är
  // bundet → Namn → Telefon → E-post). Återkopplingsdatum visas bara vid
  // statusen Återkoppling, så det hämtas oberoende av seller_hidden.
  const kommentarFalt = formFalt.find((f) => f.key === "kommentar");
  const aterkopplingFalt = configurableFields.find((f) => f.key === "aterkoppling_datum");
  const KUND_FORST = ["kund_namn", "kund_telefon", "kund_epost"];
  const kundFaltForst = KUND_FORST.map((k) => formFalt.find((f) => f.key === k)).filter((f): f is FieldDef => !!f);
  const ovrigaFalt = formFalt.filter((f) => f.key !== "kommentar" && f.key !== "aterkoppling_datum" && !KUND_FORST.includes(f.key));

  type FieldGroup = { section: string | null; label: string | null; fields: FieldDef[] };
  const groups: FieldGroup[] = [];
  let current: FieldGroup | null = null;
  for (const f of ovrigaFalt) {
    const sec = f.options.section ?? null;
    if (!current || current.section !== sec) {
      current = { section: sec, label: sec ? (SECTION_LABELS[sec] ?? sec) : null, fields: [] };
      groups.push(current);
    }
    current.fields.push(f);
  }

  return (
    <div className="d2d-detail">
      {/* Topbar — adress/lägenhet som statisk text, inte en redigerbar
          ruta, bara kontext om var säljaren står just nu. */}
      <div className="d2d-topbar">
        <button className="d2d-back" onClick={() => { void handleBack(); }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 4l-6 6 6 6"/></svg>
        </button>
        <div className="d2d-topbar__title">
          <h2>{fullAdress}</h2>
          {!!headerUndertext && <span className="d2d-topbar__sub">{headerUndertext}</span>}
        </div>
        {isAdmin && (
          <button
            className="btn btn--ghost btn--sm d2d-topbar__admin"
            onClick={() => setShowFieldConfig(true)}
            title="Välj vilka fält säljarna ser på adresser, och lägg till nya"
            aria-label="Anpassa fält"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 5.5h8M15 5.5h2M3 14.5h2M9 14.5h8" />
              <circle cx="13" cy="5.5" r="2" />
              <circle cx="7" cy="14.5" r="2" />
            </svg>
            <span className="d2d-topbar__admin-label">Anpassa fält</span>
          </button>
        )}
        <span className={`d2d-autosave d2d-autosave--${saveState}`} aria-live="polite">
          {saveState === "pending" || saveState === "saving" ? "Sparar…"
            : saveState === "saved" ? "✓ Sparat"
            : saveState === "error" ? "Ej sparat" : ""}
        </span>
      </div>

      {error && (
        <div className="d2d-error d2d-error--row">
          <span>{error}</span>
          <button className="btn btn--ghost btn--sm" onClick={() => { void flush(); }}>Försök igen</button>
        </div>
      )}

      <SaldAvRad
        status={status}
        saljare={data.saljare ? String(data.saljare) : null}
        agare={record.owner_user_id}
      />

      {/* Tillfällig lägenhet (skapad av säljare). Ligger den i en tillfällig
          fastighet godkänns den tillsammans med fastigheten — då visas
          ingen egen Godkänn-knapp här. */}
      {arTillfallig(data) && (
        <TillfalligBanner
          id={lagenhetId}
          typ="lagenhet"
          isAdmin={isAdmin && !arTillfallig(fastData)}
          onGodkand={() => setData((d) => ({ ...d, tillfallig: false }))}
        />
      )}

      {showFieldConfig && (
        <FieldConfigPanel
          mode="seller"
          objectType="d2d_lagenhet"
          objectLabel="adresser (säljarvyn)"
          fields={configurableFields}
          sections={Object.entries(SECTION_LABELS).map(([key, label]) => ({ key, label }))}
          onClose={() => setShowFieldConfig(false)}
          onChanged={() => onFieldsChanged?.()}
        />
      )}

      {/* Adressens förutsättningar — fastighetens värden, överskrivna av
          adressens egna där importen hade sådana. */}
      <InfraBox title="Förutsättningar" rows={infraRows(fastData, data)} emptyText="Ingen info om nät/TV ifylld för den här adressen." />

      {/* Statusväljare — stora knappar. Vid ånger kan bara admin byta status. */}
      {(status !== "anger" || isAdmin) && <div className="d2d-status-picker">
        {Object.entries(STATUS_CONFIG)
          .filter(([key]) => !HIDDEN_STATUS_PICKS.has(key as KnockStatus))
          .map(([key, cfg]) => (
            <button
              key={key}
              className={`d2d-status-btn ${cfg.cssClass}${status === key ? " d2d-status-btn--active" : ""}`}
              onClick={() => changeStatus(key)}
            >
              {cfg.label}
            </button>
          ))}
      </div>}

      {/* Inte hemma: hur många gånger dörren har knackats. */}
      {status === "inte_hemma" && (() => {
        const n = Number(data.antal_knackningar);
        const antal = Number.isFinite(n) && n > 0 ? n : 0;
        const satt = (v: number) => set("antal_knackningar", 600)(Math.max(0, Math.min(99, v)) || null);
        return (
          <div className="d2d-reason-panel d2d-knack">
            <span className="label">Hur många gånger har dörren knackats?</span>
            <div className="d2d-knack__rad">
              <button type="button" className="d2d-knack__btn" aria-label="En färre" onClick={() => satt(antal - 1)}>−</button>
              <input className="input d2d-knack__input" type="number" inputMode="numeric" min={0} max={99}
                aria-label="Antal knackningar" value={antal || ""}
                onChange={(e) => satt(Number(e.target.value))} />
              <button type="button" className="d2d-knack__btn" aria-label="En till" onClick={() => satt(antal + 1)}>+</button>
              <span className="d2d-knack__text">{antal === 1 ? "gång" : "gånger"}</span>
            </div>
          </div>
        );
      })()}

      {/* Anledning — visas så fort statusen är "Inte säljbar" (eller äldre "Inte intresserad"), så
          säljaren måste (eller i alla fall enkelt kan) ange varför. */}
      {(status === "inte_intresserad" || status === "inte_saljbar") && (
        <div className="d2d-reason-panel">
          <span className="label">Anledning</span>
          <div className="d2d-reason-panel__chips">
            {[
              ...EJ_INTRESSERAD_REASONS,
              // Äldre poster med den borttagna anledningen visar den tills säljaren väljer en annan.
              ...(data.ej_intresserad_anledning === "bindningstid" ? [{ key: "bindningstid", label: "Bindningstid (äldre)" }] : []),
            ].map((r) => (
              <button
                key={r.key}
                type="button"
                className={`d2d-reason-chip${data.ej_intresserad_anledning === r.key ? " d2d-reason-chip--active" : ""}`}
                onClick={() => set("ej_intresserad_anledning", 0)(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Återkopplingsdatum — bara när säljaren valt Återkoppling. */}
      {status === "aterkoppling" && aterkopplingFalt && (
        <div className="d2d-reason-panel d2d-aterkoppling">
          <FieldInput field={aterkopplingFalt} value={data[aterkopplingFalt.key]} onChange={set(aterkopplingFalt.key, 0)} />
        </div>
      )}

      {/* Vad såldes? — visas när statusen är "Såld" eller "Signera med Scrive".
          En rubrik per kategori; ett val per kategori, utom där flera går (t.ex. Mobil). */}
      {(status === "sald" || status === "scrive") && soldFields.length > 0 && (
        <div className="d2d-reason-panel d2d-sold-panel">
          <span className="label">{status === "scrive" ? "Vad ska kunden signera?" : "Vad såldes?"}</span>
          {/* TV-box frågas inte: den ingår alltid i TV-paketet. */}
          {soldFields.filter((f) => f.key !== "salt_tvbox").map((f) => (
            <div key={f.key} className="d2d-sold-panel__group">
              <div className="d2d-sold-panel__head">
                <span className="d2d-sold-panel__title">{f.label}</span>
                <div className="d2d-yesno" role="group" aria-label={f.label}>
                  <button
                    type="button"
                    aria-pressed={answer(f) === true}
                    className={`d2d-yesno__btn${answer(f) === true ? " d2d-yesno__btn--ja" : ""}`}
                    onClick={() => setAnswer(f, true)}
                  >Ja</button>
                  <button
                    type="button"
                    aria-pressed={answer(f) === false}
                    className={`d2d-yesno__btn${answer(f) === false ? " d2d-yesno__btn--nej" : ""}`}
                    onClick={() => setAnswer(f, false)}
                  >Nej</button>
                </div>
              </div>
              {answer(f) === true && f.key === "salt_mobil" && record && (
                <MobilNummerPanel
                  lagenhetId={record.id}
                  data={data}
                  isAdmin={isAdmin}
                  onPatch={(patch, delay) => { setData((d) => ({ ...d, ...patch })); queueSave(patch, null, delay); }}
                />
              )}
              {answer(f) === true && f.fieldType !== "boolean" && (<>
              {f.fieldType === "multi_select" && <span className="d2d-sold-panel__hint">Välj en eller flera</span>}
              {f.key === "salt_tv" && <span className="d2d-sold-panel__hint">TV-box ingår i alla TV-paket</span>}
              <div className="d2d-reason-panel__chips">
                {f.options.choices!.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={isPicked(f, c.key)}
                    className={`d2d-reason-chip d2d-sold-chip${isPicked(f, c.key) ? " d2d-sold-chip--active" : ""}`}
                    onClick={() => pickSold(f, c.key)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {f.key === "salt_mobil" && isPicked(f, EXTRA_VAL) && (() => {
                const antal = antalExtra(data);
                const satt = (n: number) => set(EXTRA_ANTAL_FALT, 0)(Math.max(1, Math.min(20, Math.floor(n) || 1)));
                return (
                  <div className="d2d-extra">
                    <span className="d2d-sold-panel__hint">Antal extraanvändare</span>
                    <div className="d2d-knack__rad">
                      <button type="button" className="d2d-knack__btn" aria-label="En färre" disabled={antal <= 1}
                        onClick={() => satt(antal - 1)}>−</button>
                      <input className="input d2d-knack__input" type="number" inputMode="numeric" min={1} max={20}
                        aria-label="Antal extraanvändare" value={antal}
                        onChange={(e) => { if (e.target.value !== "") satt(Number(e.target.value)); }} />
                      <button type="button" className="d2d-knack__btn" aria-label="En till" onClick={() => satt(antal + 1)}>+</button>
                      <span className="d2d-knack__text">st</span>
                    </div>
                  </div>
                );
              })()}
              {f.key === "salt_streaming_sport" && SPORT_MED_NETFLIX.has(String(data[f.key] ?? "")) && (
                <button
                  type="button"
                  aria-pressed={data[UTAN_NETFLIX_FALT] === true}
                  className={`d2d-reason-chip d2d-sold-chip d2d-sold-chip--toggle${data[UTAN_NETFLIX_FALT] === true ? " d2d-sold-chip--active" : ""}`}
                  onClick={() => set(UTAN_NETFLIX_FALT, 0)(data[UTAN_NETFLIX_FALT] === true ? null : true)}
                >
                  {data[UTAN_NETFLIX_FALT] === true ? "✓ " : ""}Utan Netflix (lägre pris)
                </button>
              )}
              </>)}
            </div>
          ))}
          {status === "sald" && answer(soldFields.find((sf) => sf.key === "salt_bredband") ?? soldFields[0]) !== false
            && !soldFields.some((sf) => !["salt_bredband", "salt_router", "salt_tvbox"].includes(sf.key) && answer(sf) === true) && (
            <EjMerPanel fields={objectDef?.fields ?? []} data={data} set={set} />
          )}
          <AvtalsSammanfattning data={data} soldFields={soldFields} isAdmin={isAdmin} />
          {kundFalt.length > 0 && (
            <div className="d2d-kunduppgifter">
              <span className="label">Kunduppgifter</span>
              {kundFalt.map((f) => (
                <FieldInput key={f.key} field={f} value={data[f.key]} onChange={set(f.key, TYPING_TYPES.has(f.fieldType) ? 800 : 0)} />
              ))}
              {kundFalt.some((f) => f.key === "startdatum_tjanst") && !data.startdatum_tjanst && (
                <span className="d2d-sold-panel__hint">Utan startdatum står det "Enligt orderbekräftelse" i avtalet.</span>
              )}
            </div>
          )}
          {status === "scrive" && (
            <ScriveSignering lagenhetId={record.id} data={data} sparaForst={flush}
              onKopplad={async () => {
                // Ett avtal från Scrive kopplades: servern skrev kunduppgifter och
                // tjänster på lägenheten — hämta om så att formuläret visar dem.
                await flush();
                const { data: row } = await supabase.from("records").select("data, status").eq("id", lagenhetId).maybeSingle();
                if (row) { setData((row.data ?? {}) as Record<string, unknown>); if (row.status) setStatus(row.status); }
              }} />
          )}
        </div>
      )}

      {/* Kundtjänst: lämna affären till en säljare / banner om att den kom via kundtjänst. */}
      {record && (
        <KundtjanstPanel lagenhetId={record.id} status={status} data={data} sparaForst={flush}
          onLamnad={() => onBack()} />
      )}

      {/* Ånger: markera (på Såld/Scrive) eller visa (status Ånger). */}
      {record && !!status && (
        <AngerPanel lagenhetId={record.id} status={status} data={data} isAdmin={isAdmin} sparaForst={flush}
          onAndrad={(st, d) => { setStatus(st); setData(d); }} />
      )}

      {/* Ordningen i flödet: Status → Kommentar → Vad är bundet → Namn,
          Telefon, E-post → övriga fält. */}
      {kommentarFalt && (
        <div className="d2d-form">
          <div className="d2d-form-section">
            <FieldInput field={kommentarFalt} value={data[kommentarFalt.key]} onChange={set(kommentarFalt.key, 800)} />
          </div>
        </div>
      )}

      {/* Vad är bundet? — per tjänst: när bindningen löper ut och operatör.
          På alla besök där någon öppnade. */}
      {!!status && ["sald", "scrive", "aterkoppling", "inte_intresserad", "inte_saljbar", "kall_kund", "befintlig_telia"].includes(status) && (
        <BindningPanel
          fields={objectDef?.fields ?? []}
          data={data}
          onPatch={(patch) => { setData((d) => ({ ...d, ...patch })); queueSave(patch, null, 0); }}
        />
      )}

      {/* Formulärfält */}
      <div className="d2d-form">
        {kundFaltForst.length > 0 && (
          <div className="d2d-form-section">
            <h3 className="d2d-form-section__title">{SECTION_LABELS.kunddata}</h3>
            {kundFaltForst.map((f) => (
              <FieldInput key={f.key} field={f} value={data[f.key]} onChange={set(f.key, TYPING_TYPES.has(f.fieldType) ? 800 : 0)} />
            ))}
          </div>
        )}
        {groups.map((group, gi) => (
          <div key={group.section ?? gi} className="d2d-form-section">
            {group.label && <h3 className="d2d-form-section__title">{group.label}</h3>}
            {group.fields.map((f) => (
              <FieldInput key={f.key} field={f} value={data[f.key]} onChange={set(f.key, TYPING_TYPES.has(f.fieldType) ? 800 : 0)} />
            ))}
          </div>
        ))}
      </div>

    </div>
  );
}

// =============================================================================
// Signerade kunder (filtrerad vy)
// =============================================================================

function SigneradeLista({
  onOpenLagenhet,
}: {
  onOpenLagenhet: (id: string, fastighetId: string) => void;
}) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // Både sålda och Scrive-signerade (status scrive) räknas som signerade kunder.
        const res = await listRecords({ objectType: "d2d_lagenhet", filters: [{ field: "__status", op: "in", value: ["sald", "scrive", "anger"] }], limit: 200 });
        setItems(res.items);
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const returnRow = useReturnToRow("signerade", !loading);

  if (loading) return <div className="d2d-loading">Laddar…</div>;

  return (
    <div className="d2d-list">
      {/* Signerade avtal som ska beställas i VT (mobil helst 45 / senast 30 dagar före start, övrigt 30). */}
      <VtSaljarPanel onOpenLagenhet={(id) => onOpenLagenhet(id, "")} />
      <div className="d2d-list__header">
        <h2>Signerade kunder</h2>
        <span className="d2d-list__count">{items.length} st</span>
      </div>

      {items.length === 0 && (
        <div className="d2d-empty">Inga signerade kunder ännu.</div>
      )}

      {items.map((item) => {
        const data = item.data as Record<string, unknown>;
        return (
          <button key={item.id} className={`d2d-card d2d-card--signed${item.status === "anger" ? " d2d-card--anger" : ""}`} {...returnRow(item.id)} onClick={() => { rememberRow("signerade", item.id); onOpenLagenhet(item.id, ""); }}>
            <div className="d2d-card__main">
              <span className="d2d-card__title">{formatLagenhetAdress(data, item.title)}{item.status === "anger" && <span className="d2d-anger-tag">Ånger</span>}</span>
              {!!data.kund_namn && <span className="d2d-card__sub">{String(data.kund_namn)}</span>}
              {!!data.produkt && <span className="d2d-card__meta-text">{String(data.produkt)}</span>}
            </div>
            {!!data.sald_datum && <span className="d2d-card__date">{String(data.sald_datum)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Återkopplingslista
// =============================================================================

function AterkopplingarLista({
  onOpenLagenhet,
}: {
  onOpenLagenhet: (id: string, fastighetId: string) => void;
}) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await listRecords({ objectType: "d2d_lagenhet", status: "aterkoppling", limit: 200 });
        setItems(res.items);
      } catch {
        // tyst
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const returnRow = useReturnToRow("aterkoppling", !loading);

  if (loading) return <div className="d2d-loading">Laddar…</div>;

  return (
    <div className="d2d-list">
      <div className="d2d-list__header">
        <h2>Återkopplingar</h2>
        <span className="d2d-list__count">{items.length} st</span>
      </div>

      {items.length === 0 && (
        <div className="d2d-empty">Inga återkopplingar att visa.</div>
      )}

      {items.map((item) => {
        const data = item.data as Record<string, unknown>;
        return (
          <button key={item.id} className="d2d-card d2d-card--callback" {...returnRow(item.id)} onClick={() => { rememberRow("aterkoppling", item.id); onOpenLagenhet(item.id, ""); }}>
            <div className="d2d-card__main">
              <span className="d2d-card__title">{formatLagenhetAdress(data, item.title)}</span>
              {!!data.kund_namn && <span className="d2d-card__sub">{String(data.kund_namn)}</span>}
              {!!data.kommentar && (
                <span className="d2d-card__comment">{String(data.kommentar).slice(0, 80)}{String(data.kommentar).length > 80 ? "…" : ""}</span>
              )}
            </div>
            {!!data.aterkoppling_datum && <span className="d2d-card__date">{String(data.aterkoppling_datum)}</span>}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Huvudkomponent — D2D Seller App
// =============================================================================

export function D2DSellerApp({ onExitD2D }: { onExitD2D?: () => void }) {
  const route = useRoute();
  const view: D2DView = d2dViewFromSegs(route.segs[0] === "d2d" ? route.segs.slice(1) : []);
  const setView = (v: D2DView) => navigate(d2dSegsFromView(v));
  const [objects, setObjects] = useState<ObjectDef[]>([]);
  const [brandColor, setBrandColor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [minId, setMinId] = useState<string | null>(null);
  const { theme } = useTheme();
  useEffect(() => { supabase.auth.getSession().then(({ data }) => setMinId(data.session?.user.id ?? null)); }, []);

  const loadMetadata = useCallback(() =>
    getMetadata()
      .then((res) => {
        setObjects(res.objects);
        setBrandColor(res.tenant?.brandColor ?? undefined);
        setIsAdmin(!!res.isAdmin);
      })
      .catch(() => {}), []);

  useEffect(() => {
    loadMetadata().finally(() => setLoading(false));
  }, [loadMetadata]);

  // Samma varumärkesfärg som resten av CRM:et (satt av admin i Inställningar
  // → Utseende) — annars föll D2D-säljarvyn tillbake på standardlila, vilket
  // stack ut mot resten av appen.
  const brandVars = brandColor ? brandCssVars(brandColor, theme === "light") : undefined;

  const lagDef = objects.find((o) => o.key === "d2d_lagenhet");

  // ── Navigering
  const navTab = view.kind === "signerade" ? "signerade" : view.kind === "avtal" ? "avtal" : view.kind === "aterkopplingar" ? "aterkopplingar"
    : view.kind === "feedback" ? "feedback" : view.kind === "oversikt" ? "oversikt" : "fastigheter";

  function renderContent() {
    switch (view.kind) {
      case "oversikt":
        return <D2DDashboard minId={minId} />;

      case "fastigheter":
        return (
          <ProjektLista onOpen={(id) => setView({ kind: "projekt", id })} onAlla={() => setView({ kind: "alla" })}
            onKundtjanst={() => setView({ kind: "kundtjanst" })} />
        );

      case "projekt":
        return (
          <FastighetsLista
            projektId={view.id}
            onBack={() => goBack(() => setView({ kind: "fastigheter" }))}
            onOpen={(id) => setView({ kind: "fastighet", id })}
          />
        );

      case "fastighet":
        return (
          <FastighetsDetalj
            fastighetId={view.id}
            isAdmin={isAdmin}
            onBack={() => goBack(() => setView({ kind: "fastigheter" }))}
            onOpenLagenhet={(id) => setView({ kind: "lagenhet", id, fastighetId: view.id })}
          />
        );

      case "lagenhet":
        return (
          <LagenhetForm
            lagenhetId={view.id}
            fastighetId={view.fastighetId}
            objectDef={lagDef}
            isAdmin={isAdmin}
            onFieldsChanged={loadMetadata}
            onBack={() => goBack(() => {
              // Tillbaka till listan man kom ifrån (Återkopplingar/Signerade),
              // annars fastigheten adressen ligger i.
              if (view.from) {
                setView({ kind: view.from });
              } else if (view.fastighetId) {
                setView({ kind: "fastighet", id: view.fastighetId });
              } else {
                setView({ kind: "fastigheter" });
              }
            })}
          />
        );

      case "signerade":
        return (
          <SigneradeLista
            onOpenLagenhet={(id, fId) => setView({ kind: "lagenhet", id, fastighetId: fId, from: "signerade" })}
          />
        );

      case "avtal":
        // Samma vy som Door to door → Avtal i CRM:et, men bara säljarens egna avtal.
        return (
          <D2DAvtalPage
            saljarvy
            lagFields={lagDef?.fields ?? []}
            onOpenRecord={(id) => setView({ kind: "lagenhet", id, fastighetId: "", from: "avtal" })}
          />
        );

      case "aterkopplingar":
        return (
          <AterkopplingarLista
            onOpenLagenhet={(id, fId) => setView({ kind: "lagenhet", id, fastighetId: fId, from: "aterkopplingar" })}
          />
        );

      case "feedback":
        // Säljarens feedback → Lukas granskar i CRM:et (D2DFeedback.tsx).
        return <D2DFeedbackFlik />;

      case "kundtjanst":
        return (
          <KundtjanstSaljSida
            onBack={() => goBack(() => setView({ kind: "fastigheter" }))}
            onOpenLagenhet={(id) => setView({ kind: "lagenhet", id, fastighetId: "", from: "kundtjanst" })}
          />
        );

      case "alla":
        return (
          <D2DAllaLagenheter
            minId={minId}
            isAdmin={isAdmin}
            objectDef={lagDef}
            onFieldsChanged={loadMetadata}
            onBack={() => goBack(() => setView({ kind: "fastigheter" }))}
            onOpenLagenhet={(id) => setView({ kind: "lagenhet", id, fastighetId: "", from: "alla" })}
          />
        );
    }
  }

  if (loading) return <div className="d2d-loading">Laddar D2D-sälj…</div>;

  // Är vi i en detaljvy? Visa inte bottom-nav
  const inDetail = view.kind === "fastighet" || view.kind === "lagenhet";
  // Projektets fastighetslista behåller bottenmenyn (den är en lista, inte en detaljvy).

  return (
    <div className={`d2d-app${inDetail ? " d2d-app--detalj" : ""}`} style={brandVars as CSSProperties}>
      <Fyrverkeri />
      {/* Top header */}
      <div className="d2d-header">
        <div className="d2d-header__left">
          {/* Tillbaka till CRM:et ligger till vänster, som en tillbakaknapp. */}
          {onExitD2D && (
            <button className="d2d-header__crm" onClick={onExitD2D} aria-label="Tillbaka till CRM">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 6l-6 6 6 6" />
              </svg>
              CRM
            </button>
          )}
          <div className="d2d-header__brand">
            <span className="d2d-header__mark">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 11l9-8 9 8" />
                <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
              </svg>
            </span>
            D2D-sälj
          </div>
        </div>
        <div className="d2d-header__actions">
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={() => supabase.auth.signOut()}>Logga ut</button>
        </div>
      </div>

      {/* Innehåll */}
      <div className="d2d-content">
        {renderContent()}
      </div>

      {/* Menyn: bottenmeny på mobil (döljs i detaljvy), sidomeny på dator
          (syns alltid — se styles/d2d.css, "D2D-sälj på dator"). */}
      <nav className={`d2d-bottom-nav${inDetail ? " d2d-bottom-nav--detalj" : ""}`} aria-label="D2D-meny">
          <button
            className={`d2d-nav-btn${navTab === "oversikt" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "oversikt" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 17V9M8 17V4M13 17v-6M18 17H2"/>
            </svg>
            Översikt
          </button>
          <button
            className={`d2d-nav-btn${navTab === "fastigheter" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "fastigheter" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="14" height="14" rx="2"/>
              <line x1="3" y1="10" x2="17" y2="10"/>
              <line x1="10" y1="3" x2="10" y2="17"/>
            </svg>
            Projekt
          </button>
          <button
            className={`d2d-nav-btn${navTab === "signerade" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "signerade" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M5 10l3 3 7-7"/>
            </svg>
            Signerade
          </button>
          <button
            className={`d2d-nav-btn${navTab === "avtal" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "avtal" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 2h7l4 4v12H5z"/>
              <path d="M12 2v4h4M8 10h5M8 13h5"/>
            </svg>
            Avtal
          </button>
          <button
            className={`d2d-nav-btn${navTab === "aterkopplingar" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "aterkopplingar" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 10a7 7 0 0114 0"/>
              <path d="M3 10l3-3m-3 3l3 3"/>
            </svg>
            Återkoppling
          </button>
          <button
            className={`d2d-nav-btn${navTab === "feedback" ? " d2d-nav-btn--active" : ""}`}
            onClick={() => setView({ kind: "feedback" })}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 4h14v9H8l-4 3v-3H3z"/>
            </svg>
            Feedback
          </button>
        </nav>
    </div>
  );
}
