import "@/styles/leverans.css";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { updateRecord, DataError, type RecordFilter } from "@/lib/data";
import { loadListState, saveListState } from "@/lib/returnRow";

/**
 * Leveransöversikten → "Alla fastigheter": en rad per fastighet i projektplanen
 * med Koncernmoder, direktägande bolag, ort, fastighet, hushåll, FS/SC-portar,
 * FBL, Kundklar (CE-datum redigerbart, Telias datum under), Telias status,
 * vad som ska levereras, befintlig KO/koax/kabel-TV, LPL, entreprenör
 * (projektledare) och TeliaNow (CS).
 *
 * Varje rubrik har ett filter som i Excel (bocka i värden, sök, sortera).
 * Varje rad kan expanderas: kontakter (ägare, förvaltare) och checklista
 * (13 kryssrutor) per fastighet, sparas direkt på leveransen.
 * Data: RPC:n leverans_fastighetslista (samma behörighet, sök och filter som listan).
 */

export type Detalj = Partial<Record<string, string | boolean | null>>;

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

/** Kontaktfälten i den expanderade raden. */
const KONTAKTER: { key: string; label: string; typ: "text" | "email" | "tel"; grupp: string }[] = [
  { key: "kontakt_agare_namn", label: "För- och efternamn", typ: "text", grupp: "Ägare / primär kontakt" },
  { key: "kontakt_agare_epost", label: "E-post", typ: "email", grupp: "Ägare / primär kontakt" },
  { key: "forvaltare_namn", label: "För- och efternamn", typ: "text", grupp: "Förvaltare" },
  { key: "forvaltare_epost", label: "E-post", typ: "email", grupp: "Förvaltare" },
  { key: "forvaltare_telefon", label: "Telefon", typ: "tel", grupp: "Förvaltare" },
];

/** Checklistan per fastighet, i arbetsordning. */
export const CHECKPUNKTER: { key: string; label: string }[] = [
  { key: "chk_uppsagning_bef", label: "Uppsägning befintlig leverantör" },
  { key: "chk_avi_1", label: "Avi 1" },
  { key: "chk_avi_2", label: "Avi 2" },
  { key: "chk_avi_3", label: "Avi 3" },
  { key: "chk_projekthemsida", label: "Projekthemsida" },
  { key: "chk_adresslista", label: "Adresslista" },
  { key: "chk_leveransdatum", label: "Leveransdatum" },
  { key: "chk_torrinstallation", label: "Torrinstallation" },
  { key: "chk_uppsagningar", label: "Uppsägningar" },
  { key: "chk_levererad", label: "Levererad" },
  { key: "chk_bekraftad_projektplan", label: "Bekräftad projektplan" },
  { key: "chk_forvaltningsdokument", label: "Förvaltningsdokument" },
  { key: "chk_bommar", label: "Bommar" },
];

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
function klara(r: FastighetRad): number {
  return CHECKPUNKTER.reduce((n, c) => n + (r.detalj?.[c.key] === true ? 1 : 0), 0);
}
const tom = <span className="lev-fl__tom">–</span>;

type Kol = {
  key: string;
  label: string;
  /** Värde att sortera på. */
  sort: (r: FastighetRad) => string | number | null;
  /** Värdet som visas i filterlistan ("" = tomt). */
  varde: (r: FastighetRad) => string;
  num?: boolean;
};

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

const KOLUMNER: Kol[] = [
  { key: "chk", label: "Checklista", sort: (r) => klara(r), varde: (r) => `${klara(r)} av ${CHECKPUNKTER.length}`, num: true },
  { key: "kund", label: "Koncernmoder", sort: (r) => r.kund, varde: (r) => txt(r.kund) },
  { key: "bolag", label: "Direktägande bolag", sort: (r) => r.bolag, varde: (r) => txt(r.bolag) },
  { key: "ort", label: "Ort", sort: (r) => r.ort, varde: (r) => txt(r.ort) },
  { key: "fastighet", label: "Fastighet", sort: (r) => r.fastighet, varde: (r) => txt(r.fastighet) },
  { key: "hushall", label: "Hushåll", sort: (r) => tal(r.hushall), varde: (r) => txt(tal(r.hushall)), num: true },
  { key: "fs", label: "FS-portar", sort: (r) => tal(r.fs_portar), varde: (r) => txt(tal(r.fs_portar)), num: true },
  { key: "sc", label: "SC", sort: (r) => tal(r.sc_portar), varde: (r) => txt(tal(r.sc_portar)), num: true },
  { key: "fbl", label: "FBL", sort: (r) => r.fbl, varde: (r) => datum(r.fbl) ?? "" },
  { key: "kundklar", label: "Kundklar", sort: (r) => r.kundklar_ce ?? r.kundklar, varde: (r) => datum(r.kundklar_ce ?? r.kundklar) ?? "" },
  { key: "telia", label: "Status Telia", sort: (r) => r.telia_status, varde: (r) => txt(r.telia_status) },
  { key: "leverans", label: "Ska levereras", sort: (r) => r.leverans, varde: (r) => txt(r.leverans) },
  { key: "ko", label: "Befintlig KO", sort: (r) => r.bef_ko, varde: (r) => txt(r.bef_ko) },
  { key: "koax", label: "Befintlig koax", sort: (r) => r.bef_koax, varde: (r) => txt(r.bef_koax) },
  { key: "ktv", label: "Befintlig kabel-TV", sort: (r) => r.ktv_avtal, varde: (r) => datum(r.ktv_avtal) ?? "" },
  { key: "lpl", label: "LPL", sort: (r) => r.lpl, varde: (r) => txt(r.lpl) },
  { key: "entr", label: "Entreprenör (projektledare)", sort: (r) => r.entreprenor, varde: (r) => txt(r.entreprenor) },
  { key: "cs", label: "TeliaNow (CS)", sort: (r) => r.telianow_cs, varde: (r) => txt(r.telianow_cs) },
];

const jamfor = new Intl.Collator("sv", { numeric: true, sensitivity: "base" });
const TOMT = "(Tomma)";
const FILTER_NYCKEL = "lev-fl:kolumnfilter";

type Sort = { key: string; dir: 1 | -1 } | null;
type Filter = Record<string, string[]>;

function jamforSort(kol: Kol, dir: 1 | -1) {
  return (a: FastighetRad, b: FastighetRad) => {
    const va = kol.sort(a), vb = kol.sort(b);
    // Tomma värden alltid sist.
    if (va === null || va === "") return vb === null || vb === "" ? 0 : 1;
    if (vb === null || vb === "") return -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : jamfor.compare(String(va), String(vb));
    return c * dir;
  };
}

function FilterIkon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3h12l-4.6 5.6V13l-2.8 1.4V8.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Filtermenyn för en kolumn (som i Excel): sortera, sök, bocka i värden. */
function KolumnMeny({
  kol, rader, valda, sort, ankare, onSort, onFilter, onStang,
}: {
  kol: Kol;
  /** Raderna filtrerade på alla ANDRA kolumner (som i Excel). */
  rader: FastighetRad[];
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
    const m = new Map<string, { n: number; rad: FastighetRad }>();
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

/** Den expanderade raden: kontakter och checklista för fastigheten. */
function RadDetalj({ r, kanAndra, onSpara }: {
  r: FastighetRad;
  kanAndra: boolean;
  onSpara: (falt: string, varde: string | boolean | null) => Promise<void>;
}) {
  const d = r.detalj ?? {};
  const n = klara(r);
  const grupper = [...new Set(KONTAKTER.map((k) => k.grupp))];
  return (
    <div className="lev-fl-detalj">
      <section className="lev-fl-detalj__del">
        <h3 className="lev-fl-detalj__rubrik">Kontakter</h3>
        {grupper.map((g) => (
          <fieldset key={g} className="lev-fl-detalj__grupp">
            <legend>{g}</legend>
            <div className="lev-fl-detalj__falt">
              {KONTAKTER.filter((k) => k.grupp === g).map((k) => (
                <label key={k.key} className="lev-fl-detalj__etikett">
                  <span>{k.label}</span>
                  <input
                    className="input input--sm"
                    type={k.typ}
                    defaultValue={typeof d[k.key] === "string" ? (d[k.key] as string) : ""}
                    key={String(d[k.key] ?? "")}
                    disabled={!kanAndra}
                    autoComplete="off"
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim() || null;
                      if (v !== ((d[k.key] as string | undefined) ?? null)) void onSpara(k.key, v);
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </section>
      <section className="lev-fl-detalj__del">
        <div className="lev-fl-detalj__huvud">
          <h3 className="lev-fl-detalj__rubrik">Checklista</h3>
          <span className="lev-fl-detalj__antal">{n} av {CHECKPUNKTER.length}</span>
        </div>
        <div className="lev-fl-detalj__stapel" aria-hidden="true">
          <span style={{ width: `${(n / CHECKPUNKTER.length) * 100}%` }} />
        </div>
        <div className="lev-fl-detalj__checkar">
          {CHECKPUNKTER.map((c) => {
            const pa = d[c.key] === true;
            return (
              <label key={c.key} className={"lev-fl-check" + (pa ? " is-klar" : "")}>
                <input type="checkbox" checked={pa} disabled={!kanAndra}
                  onChange={(e) => void onSpara(c.key, e.target.checked)} />
                <span>{c.label}</span>
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function LeveransFastighetslista({
  rader, loading, onOpen, onRadAndrad, kanAndra,
}: {
  rader: FastighetRad[];
  loading: boolean;
  onOpen: (id: string) => void;
  /** Ändring att lägga på raden lokalt; `detalj` slås ihop med radens detalj. */
  onRadAndrad: (id: string, andring: Partial<FastighetRad>) => void;
  kanAndra: boolean;
}) {
  const sparat = useMemo(() => loadListState<{ filter: Filter; sort: Sort }>(FILTER_NYCKEL), []);
  const [sort, setSort] = useState<Sort>(sparat.sort ?? null);
  const [filter, setFilter] = useState<Filter>(sparat.filter ?? {});
  const [sparar, setSparar] = useState<string | null>(null);
  const [oppna, setOppna] = useState<Set<string>>(new Set());
  const [meny, setMeny] = useState<{ kol: string; ankare: HTMLElement } | null>(null);

  useEffect(() => { saveListState(FILTER_NYCKEL, { filter, sort }); }, [filter, sort]);

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
    [rader, filter]);

  const sorterade = useMemo(() => {
    if (!sort) return filtrerade;
    const kol = KOLUMNER.find((k) => k.key === sort.key);
    return kol ? [...filtrerade].sort(jamforSort(kol, sort.dir)) : filtrerade;
  }, [filtrerade, sort]);

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
    setOppna((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  /** Sparar ett fält direkt (visas genast; återställs om sparningen misslyckas). */
  async function spara(r: FastighetRad, falt: string, varde: string | boolean | null, lokalt: Partial<FastighetRad>, fore: Partial<FastighetRad>) {
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

  const tf = new Intl.NumberFormat("sv-SE");
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
      </div>

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
            {sorterade.map((r) => {
              const oppen = oppna.has(r.id);
              const n = klara(r);
              return (
                <Fragment key={r.id}>
                  <tr data-row-id={r.id} className={oppen ? "is-oppen" : undefined}>
                    <td data-label="Checklista" className="lev-fl__expcell">
                      <button type="button" className="lev-fl__exp" aria-expanded={oppen}
                        aria-label={`${oppen ? "Dölj" : "Visa"} kontakter och checklista för ${r.fastighet ?? "fastigheten"}`}
                        onClick={() => vaxla(r.id)}>
                        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="lev-fl__pil">
                          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className={"lev-fl__prog" + (n === CHECKPUNKTER.length ? " is-klar" : n === 0 ? " is-noll" : "")}>
                          {n}/{CHECKPUNKTER.length}
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
                    <td data-label="Entreprenör (projektledare)">
                      {r.entreprenor || r.projektledare
                        ? <div>{r.entreprenor ?? "–"}{r.projektledare && <span className="lev-fl__pl"> ({r.projektledare})</span>}</div>
                        : tom}
                    </td>
                    <td data-label="TeliaNow (CS)" className="lev-fl__cs">{r.telianow_cs ?? tom}</td>
                  </tr>
                  {oppen && (
                    <tr className="lev-fl__detaljrad">
                      <td colSpan={KOLUMNER.length}>
                        <div className="lev-fl__detaljhall" style={synBredd ? { width: synBredd } : undefined}>
                          <RadDetalj r={r} kanAndra={kanAndra}
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
