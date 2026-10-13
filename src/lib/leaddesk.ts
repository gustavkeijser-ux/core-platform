import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { DataError } from "@/lib/data";
import { normaliseraTelefon } from "@/lib/phone";

/* =============================================================================
   LeadDesk Talk (CTI) — tillstånd och meddelanden mellan CRM:et och Talk-iframen.

   * Inställningarna (exakt inloggnings-URL, autocall, skärmpop) läses från
     databasen (leaddesk_installningar_hamta). Origin = new URL(loginUrl).origin
     och är den ENDA origin vi skickar till och tar emot meddelanden från.
   * Ringsekvensen följer LeadDesks testade referens (CTI_Demo.html enligt
     guiden): först { action: "setMetadata", metadata }, sedan
     { action: "call", number, autocall } — som objekt, aldrig JSON-sträng.
   * Ett samtal hålls i minnet per LeadDesk call-id från ringningen; posten
     det hör till bestäms då (inte av vilken post som syns när det avslutas).
   * completed → leaddesk_spara_samtal (idempotent på leaddesk:<id>). Misslyckas
     sparningen läggs samtalet i en återförsökskö (även i localStorage).
   ========================================================================== */

export type TalkConfig = {
  loginUrl: string | null;
  origin: string | null;
  autocall: boolean;
  skarmpopIn: boolean;
  skarmpopUt: boolean;
  standardland: string;
  tidszon: string;
  aktiv: boolean;
};

export type Traff = {
  id: string; objectType: string; objectLabel: string; title: string;
  field: string; fieldLabel: string; status: string | null;
};

export type AktivtSamtal = {
  callId: string | null;          // null = begärt av oss, ännu inget call-event
  direction: "in" | "out";
  nummer: string | null;          // normaliserat motpartsnummer
  ringStart: string | null;
  recordId: string | null;        // posten samtalet kopplas till
  recordTitle: string | null;
  traffar: Traff[] | null;        // null = uppslag pågår
  fas: "begart" | "ringer" | "kopplat" | "avslutat" | "sparat" | "fel";
  communicationId: string | null;
  felmeddelande: string | null;
};

export type SparatSamtal = {
  id: string; callId: string; direction: "inbound" | "outbound"; subject: string;
  comment: string | null; occurredAt: string; remote: string | null;
  answered: boolean | null; duration: number | null; reason: string | null;
  recordUrl: string | null; egen: boolean;
  poster: Array<{ id: string; title: string | null; objectType: string }>;
};

type State = {
  cfg: TalkConfig | null;
  cfgFel: string | null;
  laddad: boolean;          // iframen är monterad
  inloggad: boolean;        // bara från verifierade login/logout-meddelanden
  oppen: boolean;           // panelen syns
  samtal: AktivtSamtal | null;
  varning: string | null;
  koLangd: number;          // samtal som väntar på att sparas
};

let state: State = {
  cfg: null, cfgFel: null, laddad: false, inloggad: false, oppen: false,
  samtal: null, varning: null, koLangd: 0,
};
const lyssnare = new Set<() => void>();
/** Kontext per LeadDesk call-id (överlever att panelens "aktuella" samtal byts). */
const kontexter = new Map<string, AktivtSamtal>();
function satt(p: Partial<State>) {
  state = { ...state, ...p };
  lyssnare.forEach((l) => l());
}
function sattSamtal(p: Partial<AktivtSamtal>) {
  if (!state.samtal) return;
  const s = { ...state.samtal, ...p };
  if (s.callId && kontexter.has(s.callId)) kontexter.set(s.callId, s);
  satt({ samtal: s });
}
export function useTalk(): State {
  return useSyncExternalStore(
    (l) => { lyssnare.add(l); return () => lyssnare.delete(l); },
    () => state,
  );
}
export const talkState = () => state;

const LS_AUTOLADDA = "ce.leaddesk.autoladda";
const LS_KO = "ce.leaddesk.ko";
const lsGet = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => {
  try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch { /* privat läge */ }
};

// ── Inställningar ─────────────────────────────────────────────────────────────
function tillConfig(raw: Record<string, unknown> | null): TalkConfig | null {
  if (!raw) return null;
  const loginUrl = typeof raw.loginUrl === "string" && raw.loginUrl ? raw.loginUrl : null;
  let origin: string | null = null;
  if (loginUrl) {
    try {
      const u = new URL(loginUrl);
      // Samma krav som servern: https och *.leaddesk.com. Origin används exakt.
      if (u.protocol === "https:" && /(^|\.)leaddesk\.com$/.test(u.hostname)) origin = u.origin;
    } catch { origin = null; }
  }
  return {
    loginUrl: origin ? loginUrl : null, origin,
    autocall: raw.autocall !== false,
    skarmpopIn: raw.skarmpopIn !== false,
    skarmpopUt: raw.skarmpopUt !== false,
    standardland: typeof raw.standardland === "string" ? raw.standardland : "SE",
    tidszon: typeof raw.tidszon === "string" ? raw.tidszon : "Europe/Stockholm",
    aktiv: raw.aktiv === true && !!origin,
  };
}

export async function laddaTalkConfig(): Promise<TalkConfig | null> {
  const { data, error } = await supabase.rpc("leaddesk_installningar_hamta");
  if (error) { satt({ cfgFel: error.message }); return null; }
  const cfg = tillConfig(data as Record<string, unknown> | null);
  satt({ cfg, cfgFel: null, laddad: state.laddad || (!!cfg?.aktiv && lsGet(LS_AUTOLADDA) === "1") });
  return cfg;
}

export async function sparaTalkConfig(p: Partial<TalkConfig>): Promise<TalkConfig | null> {
  const { data, error } = await supabase.rpc("leaddesk_installningar_spara", { p });
  if (error) throw new DataError(error.code === "42501" ? "forbidden" : error.code === "22023" ? "invalid" : "unknown", error.message);
  const cfg = tillConfig(data as Record<string, unknown>);
  // Ny URL → ladda om iframen och börja om som utloggad.
  const byttUrl = cfg?.loginUrl !== state.cfg?.loginUrl;
  satt({ cfg, inloggad: byttUrl ? false : state.inloggad });
  return cfg;
}

// ── Panelen ───────────────────────────────────────────────────────────────────
export function oppnaTalk() { satt({ oppen: true, laddad: !!state.cfg?.aktiv || state.laddad }); }
export function stangTalk() { satt({ oppen: false }); }
export function vaxlaTalk() { if (state.oppen) stangTalk(); else oppnaTalk(); }
export function rensaVarning() { satt({ varning: null }); }
export function rensaSamtal() { satt({ samtal: null }); }

// ── Iframen ───────────────────────────────────────────────────────────────────
let ramFonster: Window | null = null;
export function registreraRam(w: Window | null) {
  ramFonster = w;
  // Ny/omladdad iframe: konservativt utloggad tills Talk säger login.
  satt({ inloggad: false });
}

function skickaTillTalk(payload: Record<string, unknown>) {
  const origin = state.cfg?.origin;
  if (!ramFonster || !origin) throw new Error("Talk är inte laddat");
  ramFonster.postMessage(payload, origin);
}

// ── Klick-för-att-ringa ───────────────────────────────────────────────────────
export type RingKontext = { recordId?: string | null; recordTitle?: string | null; namn?: string | null };

export function kanRinga(): boolean {
  return !!state.cfg?.aktiv;
}

export function ringUpp(nummer: unknown, ktx: RingKontext = {}): boolean {
  const cfg = state.cfg;
  if (!cfg?.aktiv) {
    satt({ varning: "LeadDesk Talk är inte inställt. En administratör lägger in inloggningsadressen under Inställningar → LeadDesk." });
    return false;
  }
  const nr = normaliseraTelefon(nummer, cfg.standardland);
  if (!nr) {
    satt({ varning: "Numret går inte att ringa — kontrollera telefonnumret.", oppen: true });
    return false;
  }
  if (!state.inloggad || !ramFonster) {
    satt({ varning: "Logga in i LeadDesk Talk innan du ringer.", oppen: true, laddad: true });
    return false;
  }
  if (state.samtal && (state.samtal.fas === "ringer" || state.samtal.fas === "kopplat")) {
    satt({ varning: "Det finns redan ett pågående samtal i Talk.", oppen: true });
    return false;
  }
  try {
    skickaTillTalk({
      action: "setMetadata",
      metadata: {
        source: "ConnectEstate CRM",
        customerName: ktx.namn ?? ktx.recordTitle ?? "",
        phoneNumber: nr,
      },
    });
    skickaTillTalk({ action: "call", number: nr, autocall: cfg.autocall });
  } catch {
    satt({ varning: "Kunde inte nå LeadDesk Talk. Ladda om telefonpanelen och försök igen.", oppen: true });
    return false;
  }
  satt({
    varning: null, oppen: true,
    samtal: {
      callId: null, direction: "out", nummer: nr, ringStart: null,
      recordId: ktx.recordId ?? null, recordTitle: ktx.recordTitle ?? null,
      traffar: ktx.recordId ? [] : null,
      fas: "begart", communicationId: null, felmeddelande: null,
    },
  });
  if (!ktx.recordId) void slaUpp(nr);
  return true;
}

// ── Uppslag och skärmpop ──────────────────────────────────────────────────────
type Navigator = (recordId: string) => void;
let oppnaPost: Navigator = () => {};
let visadPost: () => string | null = () => null;
export function registreraNavigering(oppna: Navigator, visad: () => string | null) {
  oppnaPost = oppna; visadPost = visad;
}

async function slaUpp(nr: string) {
  const { data, error } = await supabase.rpc("hitta_poster_pa_telefon", { p_nummer: nr });
  const traffar = error ? [] : ((data ?? []) as Traff[]);
  // Svaret hör bara till samtalet om det fortfarande gäller samma nummer.
  if (state.samtal?.nummer !== nr) return traffar;
  const s = state.samtal;
  const en = traffar.length === 1 ? traffar[0] : null;
  sattSamtal({
    traffar,
    recordId: s.recordId ?? en?.id ?? null,
    recordTitle: s.recordTitle ?? (en ? en.title || en.objectLabel : null),
  });
  return traffar;
}

function skarmpop(dir: "in" | "out") {
  const cfg = state.cfg;
  const pop = dir === "in" ? cfg?.skarmpopIn : cfg?.skarmpopUt;
  if (!pop || !state.samtal) return;
  const id = state.samtal.recordId;
  if (id && visadPost() !== id) oppnaPost(id);
  // Flera eller inga träffar: panelen visar val / "Skapa kontakt".
  if (!id) satt({ oppen: true });
}

export function valjPost(t: { id: string; title?: string | null }) {
  if (!state.samtal) return;
  sattSamtal({ recordId: t.id, recordTitle: t.title ?? null });
  // Redan sparat utan koppling → koppla nu.
  if (state.samtal?.communicationId && state.samtal.fas === "sparat") {
    void kopplaSamtal(state.samtal.communicationId, t.id).catch((e) =>
      sattSamtal({ felmeddelande: e instanceof Error ? e.message : "Kunde inte koppla samtalet." }));
  }
}

export async function kopplaSamtal(communicationId: string, recordId: string) {
  const { error } = await supabase.rpc("leaddesk_koppla_samtal", {
    p_communication_id: communicationId, p_record_id: recordId,
  });
  if (error) throw new DataError("unknown", error.message);
}

// ── Talk-händelser ────────────────────────────────────────────────────────────
type CompletedCall = Record<string, unknown> & { id?: unknown; direction?: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/** Anropas av panelens message-lyssnare med ett REDAN verifierat meddelande. */
export function hanteraTalkMeddelande(data: unknown) {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  switch (d.action) {
    case "login":
      lsSet(LS_AUTOLADDA, "1");
      satt({ inloggad: true, varning: null });
      void tomKo();
      return;
    case "logout":
      satt({ inloggad: false });
      if (state.samtal?.fas === "begart") satt({ samtal: null });
      return;
    case "call":
      ringer(d);
      return;
    case "connected":
      // Saknar call-id enligt dokumentationen — bara visning.
      if (state.samtal && (state.samtal.fas === "ringer" || state.samtal.fas === "begart")) sattSamtal({ fas: "kopplat" });
      return;
    case "disconnected":
      if (state.samtal && state.samtal.fas !== "sparat") sattSamtal({ fas: "avslutat" });
      return;
    case "completed": {
      const call = (d.call && typeof d.call === "object" ? d.call : d) as CompletedCall;
      void avslutat(call);
      return;
    }
    case "error":
      satt({ varning: "LeadDesk Talk rapporterade ett fel — samtalet startades kanske inte." });
      if (state.samtal?.fas === "begart") sattSamtal({ fas: "fel", felmeddelande: "Talk kunde inte starta samtalet." });
      return;
  }
}

function ringer(d: Record<string, unknown>) {
  const dir = d.direction === "in" || d.direction === "out" ? d.direction : null;
  const callId = str(d.id);
  if (!dir || !callId) return;
  const nr = normaliseraTelefon(d.number, state.cfg?.standardland ?? "SE") ?? str(d.number);
  const ringStart = str(d.ringStart);

  // Utgående som vi själva begärde: behåll posten vi ringde från.
  const begart = state.samtal && state.samtal.fas === "begart" && state.samtal.direction === "out"
    && dir === "out" && (!nr || !state.samtal.nummer || state.samtal.nummer === nr)
    ? state.samtal : null;

  const s: AktivtSamtal = begart
    ? { ...begart, callId, ringStart, fas: "ringer" }
    : {
        callId, direction: dir, nummer: nr, ringStart, recordId: null, recordTitle: null,
        traffar: null, fas: "ringer", communicationId: null, felmeddelande: null,
      };
  kontexter.set(callId, s);
  satt({ samtal: s, varning: null, ...(dir === "in" ? { oppen: true } : {}) });

  if (s.recordId) { skarmpop(dir); return; }
  if (!nr) { sattSamtal({ traffar: [] }); skarmpop(dir); return; }
  void slaUpp(nr).then(() => {
    if (state.samtal?.callId === callId) {
      kontexter.set(callId, state.samtal);
      skarmpop(dir);
    }
  });
}

type KoPost = { call: CompletedCall; recordId: string | null; forsok: number };
let ko: KoPost[] = (() => {
  try { return JSON.parse(lsGet(LS_KO) ?? "[]") as KoPost[]; } catch { return []; }
})();
function sparaKo() { lsSet(LS_KO, ko.length ? JSON.stringify(ko) : null); satt({ koLangd: ko.length }); }

async function sparaSamtal(call: CompletedCall, recordId: string | null) {
  const { data, error } = await supabase.rpc("leaddesk_spara_samtal", { p_samtal: call, p_record_id: recordId });
  if (error) throw new DataError(error.code === "22023" ? "invalid" : "unknown", error.message);
  return data as { communicationId: string; ny: boolean; kopplad: boolean };
}

async function avslutat(call: CompletedCall) {
  const callId = str(call.id);
  if (!callId) return;
  // Posten bestämdes vid ringningen. Missades ringningen: rekonstruera minimalt.
  const ktx = kontexter.get(callId)
    ?? (state.samtal?.callId === callId ? state.samtal : null);
  const recordId = ktx?.recordId ?? null;
  if (!ktx && !state.samtal) {
    const dir = call.direction === "in" ? "in" : "out";
    const nr = normaliseraTelefon(dir === "in" ? call.from : call.to, state.cfg?.standardland ?? "SE");
    satt({ samtal: {
      callId, direction: dir, nummer: nr, ringStart: null, recordId: null, recordTitle: null,
      traffar: null, fas: "avslutat", communicationId: null, felmeddelande: null,
    } });
    if (nr) void slaUpp(nr);
  }
  try {
    const res = await sparaSamtal(call, recordId);
    kontexter.delete(callId);
    if (state.samtal?.callId === callId) {
      sattSamtal({ fas: "sparat", communicationId: res.communicationId, felmeddelande: null });
    }
    // Valde användaren post efter att ringningen var klar men innan sparningen? Koppla nu.
    const nu = state.samtal?.callId === callId ? state.samtal : null;
    if (nu?.recordId && nu.recordId !== recordId) await kopplaSamtal(res.communicationId, nu.recordId).catch(() => {});
    window.dispatchEvent(new CustomEvent("leaddesk:samtal-sparat", { detail: { recordId: nu?.recordId ?? recordId } }));
  } catch (e) {
    // Lägg i kö — kontexten släpps först när samtalet ligger säkert i kön.
    ko = [...ko.filter((k) => str(k.call.id) !== callId), { call, recordId, forsok: 1 }];
    sparaKo();
    kontexter.delete(callId);
    if (state.samtal?.callId === callId) {
      sattSamtal({ fas: "fel", felmeddelande: (e instanceof Error ? e.message : "Kunde inte spara samtalet") + " — försöker igen automatiskt." });
    }
  }
}

let koPagar = false;
export async function tomKo() {
  if (koPagar || ko.length === 0) { satt({ koLangd: ko.length }); return; }
  koPagar = true;
  try {
    const kvar: KoPost[] = [];
    for (const k of ko) {
      try { await sparaSamtal(k.call, k.recordId); }
      catch (e) {
        // Ogiltig data blir inte bättre av fler försök.
        if (!(e instanceof DataError && e.kind === "invalid") && k.forsok < 20) kvar.push({ ...k, forsok: k.forsok + 1 });
      }
    }
    ko = kvar;
    sparaKo();
  } finally { koPagar = false; }
}

export async function hamtaSenasteSamtal(limit = 20): Promise<SparatSamtal[]> {
  const { data, error } = await supabase.rpc("leaddesk_mina_samtal", { p_limit: limit });
  if (error) throw new DataError("unknown", error.message);
  return (data ?? []) as SparatSamtal[];
}

/** Bara för test (Playwright-harness): nollställ allt. */
export function _aterstallTalk() {
  kontexter.clear(); ko = []; ramFonster = null;
  state = { cfg: null, cfgFel: null, laddad: false, inloggad: false, oppen: false, samtal: null, varning: null, koLangd: 0 };
  lyssnare.forEach((l) => l());
}
