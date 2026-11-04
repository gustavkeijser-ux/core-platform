import "@/styles/leverans.css";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { updateRecord, DataError, type RecordFilter } from "@/lib/data";
import { loadListState, saveListState } from "@/lib/returnRow";
import { getUserName, useTenantUsers } from "@/lib/users";
import { LeveransAvisering } from "./LeveransAvisering";

/**
 * Leveransöversikten → "Alla fastigheter": en rad per fastighet i projektplanen
 * med Koncernmoder, direktägande bolag, ort, fastighet, hushåll, FS/SC-portar,
 * FBL, Kundklar (CE-datum redigerbart, Telias datum under), Telias status,
 * vad som ska levereras, befintlig KO/koax/kabel-TV, LPL, projektledare
 * (entreprenören under) och TeliaNow (CS).
 *
 * Varje rubrik har ett filter som i Excel (bocka i värden, sök, sortera).
 * CE-leveransansvarig (en eller två användare, fälten ce_ansvarig/ce_ansvarig_2)
 * väljs direkt i cellen.
 * Varje rad kan expanderas: checklista och kommentar per fastighet, sparas
 * direkt på leveransen. Kontakterna ligger på koncernmodern (KoncernmoderKontakter).
 * Data: RPC:n leverans_fastighetslista (samma behörighet, sök och filter som listan).
 */

export type Detalj = Partial<Record<string, unknown>>;

/** Fastighetens egen checklista (fältet chk_layout). Saknas den gäller standardordningen. */
export type ChkLayout = {
  /** Nycklar i visningsordning: standardpunkter (chk_*) och egna punkters id. */
  ordning?: string[];
  /** Punkter som bara finns på den här fastigheten. */
  egna?: { id: string; label: string; klar?: boolean }[];
  /** Standardpunkter som tagits bort från den här fastigheten. */
  dolda?: string[];
};

export type FastighetRad = {
  id: string;
  status: string | null;
  kund_id: string | null;
  kund: string | null;
  kund_kopplad: boolean;
  bolag: string | null;
  ort: string | null;
  fastighet: string | null;
  adress: string | null;
  hushall: number | string | null;
  /** Antal lokaler (projektplanen). */
  lokaler?: number | string | null;
  fs_portar: number | string | null;
  sc_portar: number | string | null;
  fbl: string | null;
  kundklar: string | null;
  kundklar_ce: string | null;
  telia_status: string | null;
  leverans: string | null;
  bef_ko: string | null;
  avtalstid_ko: string | null;
  bef_koax: string | null;
  ktv_avtal: string | null;
  lpl: string | null;
  entreprenor: string | null;
  projektledare: string | null;
  telianow_cs: string | null;
  /** CE-leveransansvarig: användar-id för ce_ansvarig och ce_ansvarig_2. */
  ce_ansvariga?: string[];
  /** Kontakter och checklista (fälten kontakt_*, forvaltare_*, chk_*). */
  detalj?: Detalj;
};

export async function hamtaFastighetslista(search: string | undefined, filters: RecordFilter[]): Promise<FastighetRad[]> {
  const { data, error } = await supabase.rpc("leverans_fastighetslista" as never, {
    p_search: search ?? null,
    p_filters: filters,
  } as never);
  if (error) throw new Error("Kunde inte hämta fastigheterna.");
  return (data as unknown as FastighetRad[]) ?? [];
}

/** Alla standardpunkter (varsitt kryssfält chk_* på leveransen). */
export const CHECKPUNKTER: { key: string; label: string }[] = [
  { key: "chk_uppsagning_bef", label: "Uppsägning befintlig leverantör" },
  { key: "chk_adresslista", label: "Adresslista" },
  { key: "chk_bekraftad_projektplan", label: "Bekräftad projektplan" },
  { key: "chk_torrinstallation", label: "Torrinstallation" },
  { key: "chk_leveransdatum", label: "Leveransdatum" },
  { key: "chk_avi_1", label: "Avi 1" },
  { key: "chk_avi_2", label: "Avi 2" },
  { key: "chk_avi_3", label: "Avi 3" },
  { key: "chk_forvaltningsdokument", label: "Förvaltningsdokument" },
  { key: "chk_bommar", label: "Bommar" },
  { key: "chk_projekthemsida", label: "Projekthemsida" },
  { key: "chk_uppsagningar", label: "Uppsägningar" },
  { key: "chk_levererad", label: "Levererad" },
];
/** Standardordningen innan någon ändrat fastighetens lista (Gustav 3 nov). */
export const STANDARDORDNING = [
  "chk_uppsagning_bef", "chk_adresslista", "chk_bekraftad_projektplan", "chk_torrinstallation",
  "chk_leveransdatum", "chk_avi_1", "chk_avi_2", "chk_avi_3", "chk_forvaltningsdokument", "chk_bommar",
];
const STD_ETIKETT = new Map(CHECKPUNKTER.map((c) => [c.key, c.label]));

type Punkt = { key: string; label: string; klar: boolean; egen: boolean };

function layoutFor(r: FastighetRad): ChkLayout | null {
  const l = r.detalj?.chk_layout;
  return l && typeof l === "object" && !Array.isArray(l) ? (l as ChkLayout) : null;
}

/** Fastighetens checklista i visningsordning. */
export function punkter(r: FastighetRad): Punkt[] {
  const d = r.detalj ?? {};
  const l = layoutFor(r);
  const std = (key: string): Punkt => ({ key, label: STD_ETIKETT.get(key) ?? key, klar: d[key] === true, egen: false });
  if (!l) {
    // Standardordningen, plus övriga standardpunkter som redan är ibockade (inget tappas).
    return [...STANDARDORDNING, ...CHECKPUNKTER.map((c) => c.key).filter((k) => !STANDARDORDNING.includes(k) && d[k] === true)]
      .map(std);
  }
  const dolda = new Set(l.dolda ?? []);
  const egna = new Map((l.egna ?? []).map((e) => [e.id, e]));
  const ut: Punkt[] = [];
  const sett = new Set<string>();
  for (const k of l.ordning ?? []) {
    if (sett.has(k)) continue;
    if (STD_ETIKETT.has(k) && !dolda.has(k)) { ut.push(std(k)); sett.add(k); }
    else if (egna.has(k)) { const e = egna.get(k)!; ut.push({ key: e.id, label: e.label, klar: !!e.klar, egen: true }); sett.add(k); }
  }
  for (const k of STANDARDORDNING) if (!sett.has(k) && !dolda.has(k)) { ut.push(std(k)); sett.add(k); }
  for (const e of l.egna ?? []) if (!sett.has(e.id)) { ut.push({ key: e.id, label: e.label, klar: !!e.klar, egen: true }); sett.add(e.id); }
  return ut;
}

const datumFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", year: "numeric" });
function datum(s?: string | null): string | null {
  if (!s) return null;
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  return Number.isNaN(d.getTime()) ? s : datumFmt.format(d);
}
function tal(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
/** Högst två CE-leveransansvariga per fastighet (fälten ce_ansvarig, ce_ansvarig_2). */
const MAX_ANSVARIGA = 2;
export const ansvarigNamn = (r: FastighetRad) => (r.ce_ansvariga ?? []).map((id) => getUserName(id)).join(", ");

/** Avisering: Avi 1 ska alltid gå ut först, sedan Avi 2 och Avi 3. */
export const AVI_NYCKLAR = ["chk_avi_1", "chk_avi_2", "chk_avi_3"] as const;
export type AviLage = {
  /** Nästa avi som ska gå ut (1–3), null om alla är klara eller fastigheten inte har några. */
  nasta: number | null;
  /** Någon avi är ibockad fast en tidigare saknas. */
  felOrdning: boolean;
  /** Fastigheten har minst en avi i sin checklista. */
  harAvi: boolean;
};
export function aviLage(r: FastighetRad): AviLage {
  const lista = punkter(r);
  const finns = AVI_NYCKLAR.map((k) => lista.find((p) => p.key === k));
  let nasta: number | null = null;
  let felOrdning = false;
  finns.forEach((p, i) => {
    if (!p) return;
    if (!p.klar && nasta === null) nasta = i + 1;
    if (p.klar && nasta !== null) felOrdning = true;
  });
  return { nasta, felOrdning, harAvi: finns.some(Boolean) };
}
export function aviText(a: AviLage): string {
  if (!a.harAvi) return "";
  return a.nasta ? `Avi ${a.nasta} saknas` : "Alla aviserade";
}

export function klara(r: FastighetRad): number {
  return punkter(r).filter((p) => p.klar).length;
}
const tom = <span className="lev-fl__tom">–</span>;

export type Kol<T = FastighetRad> = {
  key: string;
  label: string;
  /** Värde att sortera på. */
  sort: (r: T) => string | number | null;
  /** Värdet som visas i filterlistan ("" = tomt). */
  varde: (r: T) => string;
  num?: boolean;
};

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

const KOLUMNER: Kol[] = [
  { key: "chk", label: "Checklista", sort: (r) => klara(r), varde: (r) => `${klara(r)} av ${punkter(r).length}`, num: true },
  { key: "kund", label: "Koncernmoder", sort: (r) => r.kund, varde: (r) => txt(r.kund) },
  { key: "bolag", label: "Direktägande bolag", sort: (r) => r.bolag, varde: (r) => txt(r.bolag) },
  { key: "ort", label: "Ort", sort: (r) => r.ort, varde: (r) => txt(r.ort) },
  { key: "fastighet", label: "Fastighet", sort: (r) => r.fastighet, varde: (r) => txt(r.fastighet) },
  { key: "ce", label: "CE-leveransansvarig", sort: (r) => ansvarigNamn(r), varde: (r) => ansvarigNamn(r) },
  { key: "hushall", label: "Hushåll", sort: (r) => tal(r.hushall), varde: (r) => txt(tal(r.hushall)), num: true },
  { key: "fs", label: "FS-portar", sort: (r) => tal(r.fs_portar), varde: (r) => txt(tal(r.fs_portar)), num: true },
  { key: "sc", label: "SC", sort: (r) => tal(r.sc_portar), varde: (r) => txt(tal(r.sc_portar)), num: true },
  { key: "fbl", label: "FBL", sort: (r) => r.fbl, varde: (r) => datum(r.fbl) ?? "" },
  { key: "kundklar", label: "Kundklar", sort: (r) => r.kundklar_ce ?? r.kundklar, varde: (r) => datum(r.kundklar_ce ?? r.kundklar) ?? "" },
  { key: "avi", label: "Avisering", sort: (r) => { const a = aviLage(r); return a.harAvi ? (a.nasta ?? 9) : null; }, varde: (r) => aviText(aviLage(r)) },
  { key: "telia", label: "Status Telia", sort: (r) => r.telia_status, varde: (r) => txt(r.telia_status) },
  { key: "leverans", label: "Ska levereras", sort: (r) => r.leverans, varde: (r) => txt(r.leverans) },
  { key: "ko", label: "Befintlig KO", sort: (r) => r.bef_ko, varde: (r) => txt(r.bef_ko) },
  { key: "koax", label: "Befintlig koax", sort: (r) => r.bef_koax, varde: (r) => txt(r.bef_koax) },
  { key: "ktv", label: "Befintlig kabel-TV", sort: (r) => r.ktv_avtal, varde: (r) => datum(r.ktv_avtal) ?? "" },
  { key: "lpl", label: "LPL", sort: (r) => r.lpl, varde: (r) => txt(r.lpl) },
  { key: "pl", label: "Projektledare", sort: (r) => r.projektledare, varde: (r) => txt(r.projektledare) },
  { key: "cs", label: "TeliaNow (CS)", sort: (r) => r.telianow_cs, varde: (r) => txt(r.telianow_cs) },
];

const jamfor = new Intl.Collator("sv", { numeric: true, sensitivity: "base" });
export const TOMT = "(Tomma)";
const FILTER_NYCKEL = "lev-fl:kolumnfilter";

export type Sort = { key: string; dir: 1 | -1 } | null;
export type Filter = Record<string, string[]>;

export function jamforSort<T>(kol: Kol<T>, dir: 1 | -1) {
  return (a: T, b: T) => {
    const va = kol.sort(a), vb = kol.sort(b);
    // Tomma värden alltid sist.
    if (va === null || va === "") return vb === null || vb === "" ? 0 : 1;
    if (vb === null || vb === "") return -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : jamfor.compare(String(va), String(vb));
    return c * dir;
  };
}

export function FilterIkon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3h12l-4.6 5.6V13l-2.8 1.4V8.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Filtermenyn för en kolumn (som i Excel): sortera, sök, bocka i värden. */
export function KolumnMeny<T>({
  kol, rader, valda, sort, ankare, onSort, onFilter, onStang,
}: {
  kol: Kol<T>;
  /** Raderna filtrerade på alla ANDRA kolumner (som i Excel). */
  rader: T[];
  valda: string[] | undefined;
  sort: Sort;
  ankare: HTMLElement;
  onSort: (s: Sort) => void;
  onFilter: (v: string[] | null) => void;
  onStang: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sok, setSok] = useState("");
  const varden = useMemo(() => {
    const m = new Map<string, { n: number; rad: T }>();
    for (const r of rader) {
      const v = kol.varde(r);
      const x = m.get(v);
      if (x) x.n++; else m.set(v, { n: 1, rad: r });
    }
    const s = jamforSort(kol, 1);
    return [...m.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : s(a[1].rad, b[1].rad)))
      .map(([v, x]) => ({ v, n: x.n }));
  }, [rader, kol]);
  const [bockade, setBockade] = useState<Set<string>>(() => new Set(valda ?? varden.map((x) => x.v)));
  const synliga = varden.filter((x) => !sok || (x.v || TOMT).toLowerCase().includes(sok.toLowerCase()));
  const allaSynligaValda = synliga.every((x) => bockade.has(x.v));

  // Placera menyn under rubriken (fast position, så den inte klipps av tabellens rullning).
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 280 });
  useLayoutEffect(() => {
    const r = ankare.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    setPos({ top: r.bottom + 4, left, width });
  }, [ankare]);

  useEffect(() => {
    const klick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !ankare.contains(e.target as Node)) onStang();
    };
    const tangent = (e: KeyboardEvent) => { if (e.key === "Escape") onStang(); };
    // Stäng när sidan rullas (menyn ligger fast) — men inte av rullningen som öppnandet själv ger.
    const oppnad = Date.now();
    const rulla = (e: Event) => {
      if (Date.now() - oppnad < 500) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onStang();
    };
    document.addEventListener("mousedown", klick);
    document.addEventListener("keydown", tangent);
    window.addEventListener("scroll", rulla, true);
    return () => {
      document.removeEventListener("mousedown", klick);
      document.removeEventListener("keydown", tangent);
      window.removeEventListener("scroll", rulla, true);
    };
  }, [ankare, onStang]);

  function verkstall() {
    // Sökning som i Excel: OK med sökord gäller bara de synliga, ibockade värdena.
    const urval = sok ? synliga.filter((x) => bockade.has(x.v)).map((x) => x.v) : [...bockade];
    const allaMed = !sok && varden.every((x) => bockade.has(x.v));
    onFilter(allaMed ? null : urval);
    onStang();
  }

  return (
    <div ref={ref} className="lev-fl-meny" role="dialog" aria-label={`Filter för ${kol.label}`}
      style={{ top: pos.top, left: pos.left, width: pos.width }}>
      <div className="lev-fl-meny__rubrik">{kol.label}</div>
      <div className="lev-fl-meny__sort">
        <button type="button" className="lev-fl-meny__knapp" aria-pressed={sort?.key === kol.key && sort.dir === 1}
          onClick={() => { onSort({ key: kol.key, dir: 1 }); onStang(); }}>
          {kol.num ? "Sortera minst → störst" : "Sortera A → Ö"}
        </button>
        <button type="button" className="lev-fl-meny__knapp" aria-pressed={sort?.key === kol.key && sort.dir === -1}
          onClick={() => { onSort({ key: kol.key, dir: -1 }); onStang(); }}>
          {kol.num ? "Sortera störst → minst" : "Sortera Ö → A"}
        </button>
      </div>
      <input className="input input--sm lev-fl-meny__sok" placeholder="Sök…" value={sok} autoFocus
        onChange={(e) => setSok(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") verkstall(); }} />
      <div className="lev-fl-meny__lista">
        <label className="lev-fl-meny__val lev-fl-meny__val--alla">
          <input type="checkbox" checked={synliga.length > 0 && allaSynligaValda}
            onChange={(e) => setBockade((b) => {
              const n = new Set(b);
              for (const x of synliga) { if (e.target.checked) n.add(x.v); else n.delete(x.v); }
              return n;
            })} />
          <span>{sok ? "(Markera alla sökresultat)" : "(Markera alla)"}</span>
        </label>
        {synliga.map((x) => (
          <label key={x.v} className="lev-fl-meny__val">
            <input type="checkbox" checked={bockade.has(x.v)}
              onChange={(e) => setBockade((b) => {
                const n = new Set(b);
                if (e.target.checked) n.add(x.v); else n.delete(x.v);
                return n;
              })} />
            <span className={x.v ? undefined : "lev-fl__tom"}>{x.v || TOMT}</span>
            <span className="lev-fl-meny__antal">{x.n}</span>
          </label>
        ))}
        {synliga.length === 0 && <div className="lev-fl-meny__inga">Inga värden</div>}
      </div>
      <div className="lev-fl-meny__fot">
        <button type="button" className="btn btn--ghost btn--sm" disabled={!valda}
          onClick={() => { onFilter(null); onStang(); }}>Rensa filter</button>
        <button type="button" className="btn btn--brand btn--sm" onClick={verkstall}>OK</button>
      </div>
    </div>
  );
}

/** Aviseringsläget som märke: nästa avi som ska ut, eller klart. */
export function AviCell({ a }: { a: AviLage }) {
  if (!a.harAvi) return <span className="lev-fl__tom">–</span>;
  return (
    <span className="lev-fl__avi">
      <span className={"lev-fl__avipill" + (a.nasta ? ` is-avi${a.nasta}` : " is-klar")}>{aviText(a)}</span>
      {a.felOrdning && <span className="lev-fl__avifel" title="En senare avi är ibockad fast en tidigare saknas. Avi 1 ska alltid gå ut först.">Fel ordning</span>}
    </span>
  );
}

/** Väljare för CE-leveransansvarig (en eller två användare). */
function AnsvarigMeny({ valda, ankare, onSpara, onStang }: {
  valda: string[];
  ankare: HTMLElement;
  onSpara: (ids: string[]) => void;
  onStang: () => void;
}) {
  const users = useTenantUsers();
  const ref = useRef<HTMLDivElement>(null);
  const [val, setVal] = useState<string[]>(valda);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 260 });
  useLayoutEffect(() => {
    const r = ankare.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const top = r.bottom + 4 + 360 > window.innerHeight ? Math.max(12, r.top - 364) : r.bottom + 4;
    setPos({ top, left, width });
  }, [ankare]);
  useEffect(() => {
    const klick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !ankare.contains(e.target as Node)) onStang();
    };
    const tangent = (e: KeyboardEvent) => { if (e.key === "Escape") onStang(); };
    document.addEventListener("mousedown", klick);
    document.addEventListener("keydown", tangent);
    return () => { document.removeEventListener("mousedown", klick); document.removeEventListener("keydown", tangent); };
  }, [ankare, onStang]);
  // Valda som inte finns i listan (t.ex. borttagna användare) visas ändå.
  const lista = [...users, ...val.filter((id) => !users.some((u) => u.id === id)).map((id) => ({ id, name: getUserName(id) }))];
  const fullt = val.length >= MAX_ANSVARIGA;
  return (
    <div ref={ref} className="lev-fl-meny" role="dialog" aria-label="Välj CE-leveransansvarig"
      style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 360 }}>
      <div className="lev-fl-meny__rubrik">CE-leveransansvarig</div>
      <div className="lev-fl-meny__lista">
        {lista.map((u) => {
          const pa = val.includes(u.id);
          return (
            <label key={u.id} className="lev-fl-meny__val">
              <input type="checkbox" checked={pa} disabled={!pa && fullt}
                onChange={(e) => setVal((v) => (e.target.checked ? [...v, u.id] : v.filter((x) => x !== u.id)))} />
              <span>{u.name}</span>
              {pa && val.length > 1 && <span className="lev-fl-meny__antal">{val.indexOf(u.id) + 1}</span>}
            </label>
          );
        })}
        {lista.length === 0 && <div className="lev-fl-meny__inga">Hämtar användare…</div>}
      </div>
      <div className="lev-fl-meny__tips">Högst {MAX_ANSVARIGA} personer.</div>
      <div className="lev-fl-meny__fot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onStang}>Avbryt</button>
        <button type="button" className="btn btn--brand btn--sm" onClick={() => { onSpara(val); onStang(); }}>Spara</button>
      </div>
    </div>
  );
}

/** Checklistan i den expanderade raden: bocka i, ändra ordning, egna punkter. */
function Checklista({ r, kanAndra, onSpara, ovan, onKopiera }: {
  r: FastighetRad;
  kanAndra: boolean;
  onSpara: (falt: string, varde: unknown) => Promise<void>;
  /** Fastigheten raden ovanför i listan (som den är sorterad och filtrerad). */
  ovan?: FastighetRad;
  onKopiera?: (fran: FastighetRad) => void;
}) {
  const lista = punkter(r);
  const n = lista.filter((p) => p.klar).length;
  const [redigera, setRedigera] = useState(false);
  const [ny, setNy] = useState("");
  const [drar, setDrar] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const l = layoutFor(r);

  /** Sparar hela listans uppställning (ordning, egna punkter, borttagna standardpunkter). */
  function sparaLayout(nyLista: Punkt[], dolda: string[], egnaKlar?: Map<string, boolean>) {
    const egnaFore = new Map((l?.egna ?? []).map((e) => [e.id, e]));
    const layout: ChkLayout = {
      ordning: nyLista.map((p) => p.key),
      egna: nyLista.filter((p) => p.egen).map((p) => ({
        id: p.key, label: p.label, klar: egnaKlar?.get(p.key) ?? egnaFore.get(p.key)?.klar ?? p.klar,
      })),
      dolda,
    };
    void onSpara("chk_layout", layout);
  }
  const doldaNu = () => {
    const visas = new Set(lista.map((p) => p.key));
    return CHECKPUNKTER.map((c) => c.key).filter((k) => !visas.has(k));
  };
  function flytta(fran: number, till: number) {
    if (till < 0 || till >= lista.length || fran === till) return;
    const nyLista = [...lista];
    const [p] = nyLista.splice(fran, 1);
    nyLista.splice(till, 0, p);
    sparaLayout(nyLista, doldaNu());
  }
  function taBort(i: number) {
    const p = lista[i];
    const nyLista = lista.filter((_, x) => x !== i);
    const dolda = p.egen ? doldaNu() : [...doldaNu(), p.key];
    sparaLayout(nyLista, [...new Set(dolda)]);
  }
  function laggTill(label: string) {
    const t = label.trim();
    if (!t) return;
    const id = "egen_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    sparaLayout([...lista, { key: id, label: t, klar: false, egen: true }], doldaNu());
    setNy("");
  }
  function laggTillbaka(key: string) {
    sparaLayout([...lista, { key, label: STD_ETIKETT.get(key) ?? key, klar: r.detalj?.[key] === true, egen: false }],
      doldaNu().filter((k) => k !== key));
  }
  function vaxla(p: Punkt, klar: boolean) {
    if (!p.egen) { void onSpara(p.key, klar); return; }
    sparaLayout(lista, doldaNu(), new Map([[p.key, klar]]));
  }
  const saknas = doldaNu();

  return (
    <section className="lev-fl-detalj__del lev-fl-detalj__del--chk">
      <div className="lev-fl-detalj__huvud">
        <h3 className="lev-fl-detalj__rubrik">Checklista</h3>
        <span className="lev-fl-detalj__antal">{n} av {lista.length}</span>
        {kanAndra && ovan && onKopiera && (
          <button type="button" className="btn btn--ghost btn--sm lev-fl-detalj__kopiera"
            title={`Kopiera checklistan från ${ovan.fastighet ?? "fastigheten ovan"}${ovan.ort ? ", " + ovan.ort : ""}`}
            onClick={() => {
              const namn = ovan.fastighet ?? "fastigheten ovan";
              if (confirm(`Kopiera checklistan från ${namn}?\n\nPunkternas ordning, egna punkter och vilka som är ibockade ersätts med ${namn}s. Kommentar och kontakter rörs inte.`)) onKopiera(ovan);
            }}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" />
            </g></svg>
            Kopiera från ovan
          </button>
        )}
        {kanAndra && (
          <button type="button" className="btn btn--ghost btn--sm lev-fl-detalj__andra" aria-pressed={redigera}
            onClick={() => setRedigera((x) => !x)}>
            {redigera ? "Klar" : "Ändra listan"}
          </button>
        )}
      </div>
      <div className="lev-fl-detalj__stapel" aria-hidden="true">
        <span style={{ width: `${lista.length ? (n / lista.length) * 100 : 0}%` }} />
      </div>
      <ol className={"lev-fl-chk" + (redigera ? " is-redigera" : "")}>
        {lista.map((p, i) => (
          <li key={p.key}
            className={"lev-fl-chk__rad" + (p.klar ? " is-klar" : "") + (drar === i ? " is-drar" : "")
              + (over === i && drar !== null && drar !== i ? (drar < i ? " is-over-efter" : " is-over-fore") : "")}
            draggable={redigera}
            onDragStart={(e) => { setDrar(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
            onDragOver={(e) => { if (drar === null) return; e.preventDefault(); setOver(i); }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => { e.preventDefault(); if (drar !== null) flytta(drar, i); setDrar(null); setOver(null); }}
            onDragEnd={() => { setDrar(null); setOver(null); }}>
            {redigera && (
              <span className="lev-fl-chk__handtag" aria-hidden="true" title="Dra för att flytta">
                <svg width="10" height="14" viewBox="0 0 10 14"><g fill="currentColor">
                  <circle cx="2.5" cy="2.5" r="1.3" /><circle cx="7.5" cy="2.5" r="1.3" />
                  <circle cx="2.5" cy="7" r="1.3" /><circle cx="7.5" cy="7" r="1.3" />
                  <circle cx="2.5" cy="11.5" r="1.3" /><circle cx="7.5" cy="11.5" r="1.3" />
                </g></svg>
              </span>
            )}
            <label className="lev-fl-chk__val">
              <input type="checkbox" checked={p.klar} disabled={!kanAndra} onChange={(e) => vaxla(p, e.target.checked)} />
              <span>{p.label}</span>
              {p.egen && <span className="lev-fl-chk__egen">Egen</span>}
            </label>
            {redigera && (
              <span className="lev-fl-chk__verktyg">
                <button type="button" aria-label={`Flytta upp ${p.label}`} disabled={i === 0} onClick={() => flytta(i, i - 1)}>↑</button>
                <button type="button" aria-label={`Flytta ned ${p.label}`} disabled={i === lista.length - 1} onClick={() => flytta(i, i + 1)}>↓</button>
                <button type="button" aria-label={`Ta bort ${p.label} från fastighetens lista`} onClick={() => taBort(i)}>×</button>
              </span>
            )}
          </li>
        ))}
        {lista.length === 0 && <li className="lev-fl-chk__tom">Inga punkter. Lägg till nedan.</li>}
      </ol>
      {redigera && (
        <div className="lev-fl-chk__ny">
          <div className="lev-fl-chk__nyrad">
            <input className="input input--sm" placeholder="Ny punkt för den här fastigheten…" value={ny}
              onChange={(e) => setNy(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") laggTill(ny); }} />
            <button type="button" className="btn btn--brand btn--sm" disabled={!ny.trim()} onClick={() => laggTill(ny)}>Lägg till</button>
          </div>
          {saknas.length > 0 && (
            <div className="lev-fl-chk__forslag">
              <span>Lägg tillbaka:</span>
              {saknas.map((k) => (
                <button key={k} type="button" className="chip" onClick={() => laggTillbaka(k)}>+ {STD_ETIKETT.get(k)}</button>
              ))}
            </div>
          )}
          {l && (
            <button type="button" className="lev-fl__lank lev-fl-chk__aterstall"
              onClick={() => { if (confirm("Återställ checklistan till standard? Egna punkter tas bort; ibockade standardpunkter ligger kvar.")) void onSpara("chk_layout", null); }}>
              Återställ standardlistan
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Den expanderade raden: checklista och kommentar för fastigheten (kontakterna ligger på koncernmodern). */
function RadDetalj({ r, kanAndra, onSpara, ovan, onKopiera }: {
  r: FastighetRad;
  kanAndra: boolean;
  onSpara: (falt: string, varde: unknown) => Promise<void>;
  ovan?: FastighetRad;
  onKopiera?: (fran: FastighetRad) => void;
}) {
  const d = r.detalj ?? {};
  const kommentar = typeof d.checklista_kommentar === "string" ? d.checklista_kommentar : "";
  return (
    <div className="lev-fl-detalj">
      <Checklista r={r} kanAndra={kanAndra} onSpara={onSpara} ovan={ovan} onKopiera={onKopiera} />
      <section className="lev-fl-detalj__del">
        <h3 className="lev-fl-detalj__rubrik">Kommentar</h3>
        <textarea
          className="input lev-fl-detalj__kommentar"
          placeholder="Skriv en kommentar om fastigheten…"
          defaultValue={kommentar}
          key={kommentar}
          disabled={!kanAndra}
          rows={8}
          aria-label={`Kommentar för ${r.fastighet ?? "fastigheten"}`}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim() ? e.currentTarget.value : null;
            if (v !== (kommentar || null)) void onSpara("checklista_kommentar", v);
          }}
        />
        <span className="lev-fl-detalj__tips">Sparas när du lämnar fältet.</span>
      </section>
    </div>
  );
}

export function LeveransFastighetslista({
  rader, loading, onOpen, onRadAndrad, kanAndra, filterNyckel = FILTER_NYCKEL,
}: {
  /** Var kolumnfiltren sparas (egna för koncernmoderns vy). */
  filterNyckel?: string;
  rader: FastighetRad[];
  loading: boolean;
  onOpen: (id: string) => void;
  /** Ändring att lägga på raden lokalt; `detalj` slås ihop med radens detalj. */
  onRadAndrad: (id: string, andring: Partial<FastighetRad>) => void;
  kanAndra: boolean;
}) {
  const sparat = useMemo(() => loadListState<{ filter: Filter; sort: Sort }>(filterNyckel), [filterNyckel]);
  const [sort, setSort] = useState<Sort>(sparat.sort ?? null);
  const [filter, setFilter] = useState<Filter>(sparat.filter ?? {});
  const [sparar, setSparar] = useState<string | null>(null);
  const [oppna, setOppna] = useState<Set<string>>(new Set());
  const [meny, setMeny] = useState<{ kol: string; ankare: HTMLElement } | null>(null);
  const [ansvMeny, setAnsvMeny] = useState<{ id: string; ankare: HTMLElement } | null>(null);
  // Laddar användarna (namnen i kolumnen CE-leveransansvarig) och ritar om när de finns.
  const users = useTenantUsers();

  useEffect(() => { saveListState(filterNyckel, { filter, sort }); }, [filterNyckel, filter, sort]);

  // Den expanderade panelen ska ligga i synfältet även när tabellen rullats i sidled.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [synBredd, setSynBredd] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSynBredd(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const passar = (r: FastighetRad, utom?: string) => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === utom) continue;
      const kol = KOLUMNER.find((x) => x.key === k);
      if (kol && !v.includes(kol.varde(r))) return false;
    }
    return true;
  };

  const filtrerade = useMemo(() => rader.filter((r) => passar(r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rader, filter, users]);

  const sorterade = useMemo(() => {
    if (!sort) return filtrerade;
    const kol = KOLUMNER.find((k) => k.key === sort.key);
    return kol ? [...filtrerade].sort(jamforSort(kol, sort.dir)) : filtrerade;
  }, [filtrerade, sort, users]);

  const summa = useMemo(() => {
    let hushall = 0, fs = 0, sc = 0;
    for (const r of filtrerade) { hushall += tal(r.hushall) ?? 0; fs += tal(r.fs_portar) ?? 0; sc += tal(r.sc_portar) ?? 0; }
    return { hushall, fs, sc };
  }, [filtrerade]);

  const aktivaFilter = KOLUMNER.filter((k) => filter[k.key]);

  function sattFilter(key: string, v: string[] | null) {
    setFilter((f) => {
      const n = { ...f };
      if (v === null) delete n[key]; else n[key] = v;
      return n;
    });
  }

  function vaxla(id: string) {
    const oppnas = !oppna.has(id);
    setOppna((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    // Hela panelen ska synas direkt när raden expanderas.
    if (oppnas) {
      setTimeout(() => {
        document.querySelector(`[data-detalj="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 60);
    }
  }

  /** Sparar ett fält direkt (visas genast; återställs om sparningen misslyckas). */
  async function spara(r: FastighetRad, falt: string, varde: unknown, lokalt: Partial<FastighetRad>, fore: Partial<FastighetRad>) {
    setSparar(r.id + falt);
    onRadAndrad(r.id, lokalt);
    try {
      await updateRecord(r.id, { [falt]: varde });
    } catch (e) {
      onRadAndrad(r.id, fore);
      alert(e instanceof DataError ? e.message : "Kunde inte spara.");
    } finally {
      setSparar(null);
    }
  }

  /** Kopierar checklistan (ordning, egna punkter, ibockade) från en annan fastighet. */
  async function kopieraChecklista(r: FastighetRad, fran: FastighetRad) {
    const k = fran.detalj ?? {};
    const patch: Record<string, unknown> = {};
    for (const c of CHECKPUNKTER) patch[c.key] = k[c.key] === true ? true : null;
    const l = layoutFor(fran);
    patch.chk_layout = l ? JSON.parse(JSON.stringify(l)) : null;
    const fore: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) fore[key] = r.detalj?.[key] ?? null;
    setSparar(r.id + "chk_kopiera");
    onRadAndrad(r.id, { detalj: patch });
    try {
      await updateRecord(r.id, patch);
    } catch (e) {
      onRadAndrad(r.id, { detalj: fore });
      alert(e instanceof DataError ? e.message : "Kunde inte kopiera checklistan.");
    } finally {
      setSparar(null);
    }
  }

  async function sparaAnsvariga(r: FastighetRad, ids: string[]) {
    const nya = ids.slice(0, MAX_ANSVARIGA);
    const fore = r.ce_ansvariga ?? [];
    if (nya.join() === fore.join()) return;
    setSparar(r.id + "ce_ansvarig");
    onRadAndrad(r.id, { ce_ansvariga: nya });
    try {
      await updateRecord(r.id, { ce_ansvarig: nya[0] ?? null, ce_ansvarig_2: nya[1] ?? null });
    } catch (e) {
      onRadAndrad(r.id, { ce_ansvariga: fore });
      alert(e instanceof DataError ? e.message : "Kunde inte spara CE-leveransansvarig.");
    } finally {
      setSparar(null);
    }
  }

  const [avisera, setAvisera] = useState(false);
  const tf = new Intl.NumberFormat("sv-SE");
  const ansvRad = ansvMeny ? rader.find((x) => x.id === ansvMeny.id) : undefined;
  const menyKol = meny ? KOLUMNER.find((k) => k.key === meny.kol) : undefined;
  const filterVisning = (v: string[]) => {
    const t = v.map((x) => x || TOMT);
    return t.length <= 2 ? t.join(", ") : `${t.slice(0, 2).join(", ")} +${t.length - 2}`;
  };

  return (
    <div className={"card lev-fl" + (loading ? " is-loading" : "")}>
      <div className="lev-fl__summa">
        <span>
          <b>{tf.format(filtrerade.length)}</b>
          {filtrerade.length !== rader.length && <> av {tf.format(rader.length)}</>} fastigheter
        </span>
        <span><b>{tf.format(summa.hushall)}</b> hushåll</span>
        <span><b>{tf.format(summa.fs)}</b> FS-portar</span>
        <span><b>{tf.format(summa.sc)}</b> SC-portar</span>
        <button type="button" className="btn btn--brand btn--sm lev-fl__avisera" onClick={() => setAvisera(true)} disabled={!filtrerade.length}>
          Avisera
        </button>
      </div>
      {avisera && (
        <LeveransAvisering
          rader={sorterade}
          forvaljAlla={filterNyckel !== FILTER_NYCKEL}
          kanAndra={kanAndra}
          onStang={() => setAvisera(false)}
          onRadAndrad={onRadAndrad}
        />
      )}

      {/* Mobil: rubrikerna syns inte, så filtren nås härifrån. */}
      <div className="lev-fl__mobilfilter" aria-label="Filtrera kolumner">
        {KOLUMNER.map((k) => (
          <button key={k.key} type="button" className="chip" aria-pressed={!!filter[k.key]}
            onClick={(e) => setMeny({ kol: k.key, ankare: e.currentTarget })}>
            {k.label}{sort?.key === k.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
          </button>
        ))}
      </div>

      {aktivaFilter.length > 0 && (
        <div className="lev-fl__aktiva">
          {aktivaFilter.map((k) => (
            <span key={k.key} className="lev-fl__aktivt">
              <b>{k.label}:</b> {filterVisning(filter[k.key])}
              <button type="button" aria-label={`Ta bort filtret på ${k.label}`} onClick={() => sattFilter(k.key, null)}>×</button>
            </span>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFilter({})}>Rensa alla filter</button>
        </div>
      )}

      <div className="lev-fl__scroll" ref={scrollRef}>
        <table className="lev-fl__tabell">
          <thead>
            <tr>
              {KOLUMNER.map((k) => (
                <th key={k.key} className={k.num ? "lev-fl__num" : undefined}
                  aria-sort={sort?.key === k.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  <div className="lev-fl__thrad">
                    <button type="button" className="lev-fl__th"
                      onClick={() => setSort((s) => (!s || s.key !== k.key ? { key: k.key, dir: 1 } : s.dir === 1 ? { key: k.key, dir: -1 } : null))}>
                      {k.label}
                      {sort?.key === k.key && <span aria-hidden>{sort.dir === 1 ? " ↑" : " ↓"}</span>}
                    </button>
                    <button type="button"
                      className={"lev-fl__filterknapp" + (filter[k.key] ? " is-aktiv" : "")}
                      aria-label={`Filtrera ${k.label}`} aria-haspopup="dialog"
                      aria-expanded={meny?.kol === k.key}
                      onClick={(e) => setMeny(meny?.kol === k.key ? null : { kol: k.key, ankare: e.currentTarget })}>
                      <FilterIkon />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorterade.map((r, radIndex) => {
              const oppen = oppna.has(r.id);
              const n = klara(r);
              const tot = punkter(r).length;
              return (
                <Fragment key={r.id}>
                  <tr data-row-id={r.id} className={oppen ? "is-oppen" : undefined}>
                    <td data-label="Checklista" className="lev-fl__expcell">
                      <button type="button" className="lev-fl__exp" aria-expanded={oppen}
                        aria-label={`${oppen ? "Dölj" : "Visa"} checklista och kommentar för ${r.fastighet ?? "fastigheten"}`}
                        onClick={() => vaxla(r.id)}>
                        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="lev-fl__pil">
                          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className={"lev-fl__prog" + (tot > 0 && n === tot ? " is-klar" : n === 0 ? " is-noll" : "")}>
                          {n}/{tot}
                        </span>
                      </button>
                    </td>
                    <td data-label="Koncernmoder" className="lev-fl__kund">
                      {r.kund ? <span className={r.kund_kopplad ? undefined : "lev-fl__okopplad"} title={r.kund_kopplad ? undefined : "Ingen Kund kopplad – fastighetsägare enligt projektplanen"}>{r.kund}</span> : tom}
                    </td>
                    <td data-label="Direktägande bolag">{r.bolag ?? tom}</td>
                    <td data-label="Ort">{r.ort ?? tom}</td>
                    <td data-label="Fastighet" className="lev-fl__fastighet"><div>
                      <button type="button" className="lev-fl__lank" onClick={() => onOpen(r.id)}>{r.fastighet ?? "Utan beteckning"}</button>
                      {r.adress && <span className="lev-fl__under">{r.adress}</span>}
                    </div></td>
                    <td data-label="CE-leveransansvarig" className="lev-fl__ce">
                      {kanAndra ? (
                        <button type="button"
                          className={"lev-fl__ceknapp" + ((r.ce_ansvariga ?? []).length ? "" : " is-tom")}
                          aria-haspopup="dialog" aria-expanded={ansvMeny?.id === r.id}
                          disabled={sparar === r.id + "ce_ansvarig"}
                          aria-label={`Välj CE-leveransansvarig för ${r.fastighet ?? "fastigheten"}`}
                          onClick={(e) => setAnsvMeny(ansvMeny?.id === r.id ? null : { id: r.id, ankare: e.currentTarget })}>
                          {(r.ce_ansvariga ?? []).length ? ansvarigNamn(r) : "Välj"}
                          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      ) : (ansvarigNamn(r) || tom)}
                    </td>
                    <td data-label="Hushåll" className="lev-fl__num">{tal(r.hushall) ?? tom}</td>
                    <td data-label="FS-portar" className="lev-fl__num">{tal(r.fs_portar) ?? tom}</td>
                    <td data-label="SC" className="lev-fl__num">{tal(r.sc_portar) ?? tom}</td>
                    <td data-label="FBL" className="lev-fl__datum">{datum(r.fbl) ?? tom}</td>
                    <td data-label="Kundklar" className="lev-fl__kundklar"><div>
                      {kanAndra ? (
                        <input
                          type="date"
                          className="input input--sm lev-fl__datuminput"
                          defaultValue={r.kundklar_ce ?? ""}
                          key={(r.kundklar_ce ?? "") + r.id}
                          disabled={sparar === r.id + "kundklar_ce"}
                          aria-label={`Kundklar CE för ${r.fastighet ?? "fastigheten"}`}
                          onBlur={(e) => {
                            const v = e.currentTarget.value || null;
                            if (v !== (r.kundklar_ce ?? null)) void spara(r, "kundklar_ce", v, { kundklar_ce: v }, { kundklar_ce: r.kundklar_ce });
                          }}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        />
                      ) : (datum(r.kundklar_ce) ?? (r.kundklar ? null : tom))}
                      {r.kundklar && (
                        <span className={"lev-fl__under" + (r.kundklar_ce && r.kundklar_ce !== r.kundklar ? " lev-fl__avvik" : "")}>
                          Telia: {datum(r.kundklar)}
                        </span>
                      )}
                    </div></td>
                    <td data-label="Avisering"><AviCell a={aviLage(r)} /></td>
                    <td data-label="Status Telia">{r.telia_status ? <span className="lev-fl__status">{r.telia_status}</span> : tom}</td>
                    <td data-label="Ska levereras">{r.leverans ?? tom}</td>
                    <td data-label="Befintlig KO"><div>
                      {r.bef_ko ?? (r.avtalstid_ko ? null : tom)}
                      {r.avtalstid_ko && <span className="lev-fl__under">Avtal t.o.m. {datum(r.avtalstid_ko)}</span>}
                    </div></td>
                    <td data-label="Befintlig koax">{r.bef_koax ?? tom}</td>
                    <td data-label="Befintlig kabel-TV">
                      {r.ktv_avtal ? <div>Avtal t.o.m. {datum(r.ktv_avtal)}</div> : tom}
                    </td>
                    <td data-label="LPL">{r.lpl ?? tom}</td>
                    <td data-label="Projektledare">
                      {r.projektledare
                        ? <div>{r.projektledare}{r.entreprenor && <span className="lev-fl__under">{r.entreprenor}</span>}</div>
                        : r.entreprenor ? <div>{tom}<span className="lev-fl__under">{r.entreprenor}</span></div> : tom}
                    </td>
                    <td data-label="TeliaNow (CS)" className="lev-fl__cs">{r.telianow_cs ?? tom}</td>
                  </tr>
                  {oppen && (
                    <tr className="lev-fl__detaljrad" data-detalj={r.id}>
                      <td colSpan={KOLUMNER.length}>
                        <div className="lev-fl__detaljhall" style={synBredd ? { width: synBredd } : undefined}>
                          <RadDetalj r={r} kanAndra={kanAndra}
                            ovan={radIndex > 0 ? sorterade[radIndex - 1] : undefined}
                            onKopiera={(fran) => void kopieraChecklista(r, fran)}
                            onSpara={(falt, varde) => spara(r, falt, varde,
                              { detalj: { [falt]: varde } }, { detalj: { [falt]: r.detalj?.[falt] ?? null } })} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {sorterade.length === 0 && (
              <tr className="lev-fl__ingen"><td colSpan={KOLUMNER.length}>
                Inga fastigheter matchar kolumnfiltren. <button type="button" className="lev-fl__lank" onClick={() => setFilter({})}>Rensa alla filter</button>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {ansvMeny && ansvRad && (
        <AnsvarigMeny
          key={ansvRad.id}
          valda={ansvRad.ce_ansvariga ?? []}
          ankare={ansvMeny.ankare}
          onSpara={(ids) => void sparaAnsvariga(ansvRad, ids)}
          onStang={() => setAnsvMeny(null)}
        />
      )}

      {meny && menyKol && (
        <KolumnMeny
          key={menyKol.key}
          kol={menyKol}
          rader={rader.filter((r) => passar(r, menyKol.key))}
          valda={filter[menyKol.key]}
          sort={sort}
          ankare={meny.ankare}
          onSort={setSort}
          onFilter={(v) => sattFilter(menyKol.key, v)}
          onStang={() => setMeny(null)}
        />
      )}
    </div>
  );
}
