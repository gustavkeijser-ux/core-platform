import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lasXlsx, bladnamn, tillObjekt } from "@/lib/xlsx";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Karta. Hela fastighetsbeståndet på en karta, för att bedöma
   var det är värt att knacka. Allt räknas i databasen (d2d_karta): utfall per
   hus från dörrarna, bearbetning från knackhistoriken och dörrkvalitet
   (effektiva dörrar = säljbara dörrar × kvalitetsfaktor) enligt "Så planerar
   vi knack".

   Kartan aggregerar i fyra nivåer med fasta zoomgränser. Rutnätet ligger i
   världskoordinater (inte skärmens pixlar), så klustren ändras bara när man
   byter nivå — aldrig av att man drar i kartan. Siffran i en markör är alltid
   lägenheter (eller effektiva dörrar), aldrig antal hus.
   ============================================================================= */

const VERSION = "Karta 1.0 · 2026-11-03";

const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
let leafletLoading: Promise<void> | null = null;
function loadLeaflet(): Promise<void> {
  const w = window as unknown as { L?: unknown };
  if (w.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Kunde inte ladda kartbiblioteket."));
    document.body.appendChild(s);
  });
  return leafletLoading;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeafletAny = any;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Utfall = { s: number; t: number; a: number; r: number; x: number; e: number };
type Del = { namn: string; v: number };
export type KartHus = {
  id: string; kalla: "leverans" | "masterlista"; levId: string | null;
  kommun: string | null; ort: string | null; beteckning: string | null;
  agare: string | null; bolag: string | null; adress: string | null; postnummer: string | null;
  lgh: number; lat: number | null; lon: number | null;
  fiber: string | null; koax: string | null; losning: Losning | null;
  kundklar: string | null; avtalSlut: string | null; projektstatus: string | null;
  dorrar: number; utfall: Utfall; vandor: number; senast: string | null; uppskattad: boolean;
  saljbara: number; faktor: number; delar: Del[]; effektiva: number;
};
type KartData = { idag: string; underlag: { rader: number; kalla: string | null; uppdaterad: string | null }; fastigheter: KartHus[] };
type Losning = "last_fiber" | "oppet_fiber" | "koax" | "ingen";

const LOSNING: Record<Losning | "okand", string> = {
  last_fiber: "Låst fiber", koax: "Koax", ingen: "Ingen lösning", oppet_fiber: "Öppet fiber", okand: "Okänd",
};

/** Utfallets sex kategorier i tårtan, i ritordning. Färgerna ligger i d2d.css (--d2dk-*). */
const KAT: Array<{ k: keyof Utfall; namn: string }> = [
  { k: "s", namn: "Sålt" },
  { k: "t", namn: "Aktiv med Telia" },
  { k: "a", namn: "Kall kund" },
  { k: "r", namn: "Återkoppling" },
  { k: "x", namn: "Ej säljbar" },
  { k: "e", namn: "Ej kontaktad / okänt" },
];

// ---------------------------------------------------------------------------
// Inläsning av Masterlistan. Klassar befintlig lösning från de städade
// kolumnerna "Befintlig fiberleverantör (städad)" och "Befintlig KOAX/kabel-TV".
// ---------------------------------------------------------------------------

const OPPNA_NAT = ["öppen", "stadsnät", "utsikt", "affärsverken", "globalconnect", "wexnet", "umenet", "wetternet",
  "netatonce", "openbit", "energi", "itux", "gavlenet", "lidén", "fibra", "kurbit", "teleservice", "zitius",
  "citynätet", "mittnät", "servanet", "sandnet", "ownit"];

export function klassaLosning(fiber: string, koax: string): Losning | null {
  const f = fiber.toLowerCase().trim(), k = koax.toLowerCase().trim();
  const harKoax = (k !== "" && k !== "saknas") || f.includes("kabel-tv");
  if (f.includes("låst") || f.includes("stängt") || f.includes("gruppavtal")) return "last_fiber";
  if (harKoax) return "koax";
  if (f === "saknas") return "ingen";
  if (f === "") return null;
  if (OPPNA_NAT.some((o) => f.includes(o))) return "oppet_fiber";
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[:\s]+/g, " ").trim();
function falt(r: Record<string, string>, ...namn: string[]): string {
  for (const n of namn) {
    const hit = Object.keys(r).find((k) => norm(k) === norm(n));
    if (hit && r[hit]) return r[hit].replace(/\s+/g, " ").trim();
  }
  return "";
}
/** ISO-datum eller null. Ogiltiga datum (t.ex. "2027-04-31") blir null. */
const datum = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = s.slice(0, 10), t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
};
const tal = (s: string) => { const n = Number(s.replace(",", ".").replace("−", "-")); return s !== "" && Number.isFinite(n) ? n : null; };

async function lasMasterlista(fil: File) {
  const namn = await bladnamn(fil);
  const blad = namn.find((n) => /leveransdata/i.test(n)) ?? namn[0];
  const { rader } = await lasXlsx(fil, blad);
  const nyckel = new Map<string, Record<string, unknown>>();
  for (const r of tillObjekt(rader)) {
    const bet = falt(r, "Fastighetsbeteckning");
    const kommun = falt(r, "Kommun") || falt(r, "Ort");
    if (!bet || !kommun) continue;
    const fiber = falt(r, "Befintlig fiberleverantör (stadad)", "Befintlig fiberleverantör (städad)", "Befintlig fiberleverantör");
    const koax = falt(r, "Befintlig KOAX/kabel-TV", "Befintlig KOAX");
    const rad = {
      kommun, ort: falt(r, "Ort") || null, fastighetsbeteckning: bet,
      fastighetsagare: falt(r, "Fastighetsägare") || null, bolagsnamn: falt(r, "Bolagsnamn") || null,
      adress: falt(r, "Adress") || null, postnummer: falt(r, "Postnummer") || null,
      lagenheter: Math.round(tal(falt(r, "Lägenheter")) ?? 0),
      befintlig_fiber: fiber || null, befintlig_koax: koax || null, kanalpaket: falt(r, "Kanalpaket") || null,
      befintlig_losning: klassaLosning(fiber, koax),
      avtalstid_ko: falt(r, "Avtalstid KO") || null, ktv_avtal: falt(r, "KTV Avtal") || null,
      avtal_ko_datum: datum(falt(r, "Avtalstid KO")), ktv_datum: datum(falt(r, "KTV Avtal")),
      kundklar: datum(falt(r, "Kundklar")), projektstatus: falt(r, "Status") || null,
      lat: tal(falt(r, "lat")), lon: tal(falt(r, "lon")),
    };
    // Samma hus två gånger (kommun + beteckning): behåll den mest kompletta raden.
    const k = `${kommun.toLowerCase()}|${bet.toLowerCase()}`;
    const fyllda = (o: Record<string, unknown>) => Object.values(o).filter((v) => v !== null && v !== "" && v !== 0).length;
    const fore = nyckel.get(k);
    if (!fore || fyllda(rad) > fyllda(fore)) nyckel.set(k, rad);
  }
  return [...nyckel.values()];
}

// ---------------------------------------------------------------------------
// Aggregering i fyra nivåer. Rutnätet räknas i världspixlar vid en fast
// referenszoom per nivå, så samma hus hamnar alltid i samma cell.
// ---------------------------------------------------------------------------

type Niva = { namn: string; fran: number; till: number; cell: number; ref: number };
const NIVAER: Niva[] = [
  { namn: "Områden", fran: 0, till: 8, cell: 170, ref: 5 },
  { namn: "Delområden", fran: 9, till: 11, cell: 120, ref: 9 },
  { namn: "Kluster", fran: 12, till: 14, cell: 88, ref: 12 },
  { namn: "Fastigheter", fran: 15, till: 22, cell: 0, ref: 15 },
];
const nivaFor = (z: number) => NIVAER.findIndex((n) => z >= n.fran && z <= n.till);

type Agg = {
  id: string; lat: number; lon: number; hus: KartHus[];
  lgh: number; effektiva: number; saljbara: number; utfall: Utfall; namn: string;
  syd: number; nord: number; vast: number; ost: number;
};

/** Web Mercator till världspixlar vid zoom z (samma som Leaflets project). */
function varldsPx(lat: number, lon: number, z: number) {
  const s = 256 * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
}

function aggregera(hus: KartHus[], niva: Niva): Agg[] {
  const celler = new Map<string, KartHus[]>();
  for (const h of hus) {
    if (h.lat == null || h.lon == null) continue;
    let key = h.id;
    if (niva.cell > 0) {
      const p = varldsPx(h.lat, h.lon, niva.ref);
      key = `${Math.floor(p.x / niva.cell)}:${Math.floor(p.y / niva.cell)}`;
    }
    const l = celler.get(key);
    if (l) l.push(h); else celler.set(key, [h]);
  }
  const ut: Agg[] = [];
  for (const [id, lista] of celler) {
    const u: Utfall = { s: 0, t: 0, a: 0, r: 0, x: 0, e: 0 };
    let lgh = 0, eff = 0, slj = 0, lat = 0, lon = 0, vikt = 0;
    let syd = 90, nord = -90, vast = 180, ost = -180;
    const orter = new Map<string, number>();
    for (const h of lista) {
      const w = Math.max(h.lgh, 1);
      lgh += h.lgh; eff += h.effektiva; slj += h.saljbara;
      lat += h.lat! * w; lon += h.lon! * w; vikt += w;
      for (const k of KAT) u[k.k] += h.utfall[k.k];
      syd = Math.min(syd, h.lat!); nord = Math.max(nord, h.lat!); vast = Math.min(vast, h.lon!); ost = Math.max(ost, h.lon!);
      const o = h.ort || h.kommun || "";
      orter.set(o, (orter.get(o) ?? 0) + h.lgh);
    }
    const tyngst = [...orter.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    ut.push({ id, hus: lista, lgh, effektiva: eff, saljbara: slj, utfall: u, lat: lat / vikt, lon: lon / vikt,
      namn: lista.length === 1 ? [lista[0].beteckning, tyngst].filter(Boolean).join(", ") : tyngst, syd, nord, vast, ost });
  }
  return ut;
}

// ---------------------------------------------------------------------------
// Markörer
// ---------------------------------------------------------------------------

type Lage = "utfall" | "kvalitet";

/** Snittfaktor → färgsteg (klass i d2d.css). */
function kvalitetSteg(f: number): string {
  if (f >= 1.6) return "q5";
  if (f >= 1.2) return "q4";
  if (f >= 0.9) return "q3";
  if (f >= 0.6) return "q2";
  return "q1";
}

function tartaSvg(u: Utfall, d: number): string {
  const tot = KAT.reduce((s, k) => s + u[k.k], 0);
  const r = d / 2;
  if (tot <= 0) return `<circle cx="${r}" cy="${r}" r="${r}" class="d2dk-e"/>`;
  let a0 = -Math.PI / 2, ut = "";
  for (const k of KAT) {
    const n = u[k.k];
    if (!n) continue;
    if (n === tot) return `<circle cx="${r}" cy="${r}" r="${r}" class="d2dk-${k.k}"/>`;
    const a1 = a0 + (n / tot) * 2 * Math.PI;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    ut += `<path class="d2dk-${k.k}" d="M${r},${r} L${r + r * Math.cos(a0)},${r + r * Math.sin(a0)} A${r},${r} 0 ${big} 1 ${r + r * Math.cos(a1)},${r + r * Math.sin(a1)} Z"/>`;
    a0 = a1;
  }
  return ut;
}

function markorHtml(a: Agg, lage: Lage, maxLgh: number): { html: string; d: number } {
  const d = Math.round(24 + 30 * Math.sqrt(Math.min(a.lgh, maxLgh) / Math.max(maxLgh, 1)));
  const siffra = lage === "utfall" ? a.lgh : a.effektiva;
  const txt = siffra >= 10000 ? `${Math.round(siffra / 1000)}k` : siffra >= 1000 ? `${(siffra / 1000).toFixed(1).replace(".", ",")}k` : String(siffra);
  const inner = lage === "utfall"
    ? `<svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}" aria-hidden="true">${tartaSvg(a.utfall, d)}</svg>`
    : `<span class="d2dk-q ${kvalitetSteg(a.saljbara ? a.effektiva / a.saljbara : 0)}"></span>`;
  return { d, html: `<div class="d2dk-m" style="width:${d}px;height:${d}px">${inner}<b>${txt}</b></div>` };
}

// ---------------------------------------------------------------------------
// Hjälpare
// ---------------------------------------------------------------------------

const heltal = (n: number) => n.toLocaleString("sv-SE");
const fak = (n: number) => `×${n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dag = (s: string | null) => (s ? s.slice(0, 10) : "–");
function manader(fran: string, till: string) {
  return Math.round(((new Date(till).getTime() - new Date(fran).getTime()) / 86400000 / 30.44) * 10) / 10;
}

type InstFilter = "alla" | "fonster" | "kommande" | "installerat" | "saknas";
const INST: Record<InstFilter, string> = {
  alla: "Alla", fonster: "Inom fönstret", kommande: "Kommande", installerat: "Installerat", saknas: "Datum saknas",
};
function instKlass(h: KartHus, idag: string): InstFilter {
  if (!h.kundklar) return "saknas";
  const m = manader(idag, h.kundklar);
  if (m >= -2 && m <= 1) return "fonster";
  return m > 1 ? "kommande" : "installerat";
}

// ---------------------------------------------------------------------------
// Sidan
// ---------------------------------------------------------------------------

export function D2DKarta({ isAdmin = false, onOpenRecord }: { isAdmin?: boolean; onOpenRecord?: (id: string) => void }) {
  const [data, setData] = useState<KartData | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [lage, setLage] = useState<Lage>("kvalitet");
  const [sok, setSok] = useState("");
  const [losningar, setLosningar] = useState<Set<string>>(new Set());
  const [inst, setInst] = useState<InstFilter>("alla");
  const [minFaktor, setMinFaktor] = useState(0);
  const [valt, setValt] = useState<string | null>(null);
  const [zoom, setZoom] = useState(5);
  const [vy, setVy] = useState<{ s: number; n: number; v: number; o: number } | null>(null);
  const [importInfo, setImportInfo] = useState<string | null>(null);
  const [importar, setImportar] = useState(false);
  const [visaKvalitet, setVisaKvalitet] = useState(false);
  const [klar, setKlar] = useState(false);

  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletAny>(null);
  const lagerRef = useRef<LeafletAny>(null);
  const passadRef = useRef(false);
  const kortRef = useRef<HTMLDivElement | null>(null);

  async function ladda() {
    setFel(null);
    const { data: d, error } = await supabase.rpc("d2d_karta");
    if (error) { setFel(error.message); return; }
    setData(d as KartData);
  }
  useEffect(() => { ladda(); }, []);

  const idag = data?.idag ?? new Date().toISOString().slice(0, 10);

  const filtrerade = useMemo(() => {
    if (!data) return [];
    const q = sok.trim().toLowerCase();
    return data.fastigheter.filter((h) => {
      if (q && ![h.kommun, h.ort, h.agare, h.bolag, h.beteckning, h.adress].some((x) => x?.toLowerCase().includes(q))) return false;
      if (losningar.size && !losningar.has(h.losning ?? "okand")) return false;
      if (inst !== "alla" && instKlass(h, idag) !== inst) return false;
      if (minFaktor && h.faktor < minFaktor) return false;
      return true;
    });
  }, [data, sok, losningar, inst, minFaktor, idag]);

  // Aggregaten räknas en gång per nivå och filter, inte vid varje kartrörelse.
  const perNiva = useMemo(() => NIVAER.map((n) => aggregera(filtrerade, n)), [filtrerade]);
  const niva = Math.max(0, nivaFor(zoom));

  // Kartan
  useEffect(() => {
    let avbruten = false;
    loadLeaflet().then(() => {
      if (avbruten || !mapEl.current || mapRef.current) return;
      const L = (window as unknown as { L: LeafletAny }).L;
      const map = L.map(mapEl.current, { zoomSnap: 1, zoomDelta: 1, minZoom: 5, maxZoom: 18 }).setView([62, 16], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap-bidragsgivare", maxZoom: 19,
      }).addTo(map);
      const uppdatera = () => {
        const b = map.getBounds();
        setZoom(map.getZoom());
        setVy({ s: b.getSouth(), n: b.getNorth(), v: b.getWest(), o: b.getEast() });
      };
      map.on("moveend", uppdatera);
      mapRef.current = map;
      uppdatera();
      setKlar(true);
    }).catch((e) => setFel(e.message));
    return () => { avbruten = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // Passa in hela beståndet första gången data finns.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data || passadRef.current) return;
    const pts = data.fastigheter.filter((h) => h.lat != null && h.lon != null);
    if (pts.length) {
      const L = (window as unknown as { L: LeafletAny }).L;
      map.fitBounds(L.latLngBounds(pts.map((h) => [h.lat, h.lon])), { padding: [20, 20] });
      passadRef.current = true;
    }
  }, [data, klar]);

  // Rita markörerna för aktuell nivå. Byts bara när nivån, filtret eller läget ändras.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !klar) return;
    const L = (window as unknown as { L: LeafletAny }).L;
    // Hela det gamla lagret tas bort, så inga osynliga markörer kan ta emot klick.
    if (lagerRef.current) { map.removeLayer(lagerRef.current); lagerRef.current = null; }
    const aggs = perNiva[niva] ?? [];
    const maxLgh = Math.max(1, ...aggs.map((a) => a.lgh));
    const lager = L.layerGroup();
    for (const a of aggs) {
      const { html, d } = markorHtml(a, lage, maxLgh);
      const m = L.marker([a.lat, a.lon], {
        icon: L.divIcon({ html, className: "d2dk-ikon", iconSize: [d, d], iconAnchor: [d / 2, d / 2] }),
        title: a.hus.length > 1 ? `${a.namn}: ${a.hus.length} hus, ${a.lgh} lgh` : `${a.namn} (${a.lgh} lgh)`,
        keyboard: true,
      });
      m.on("click", () => {
        if (a.hus.length === 1) { setValt(a.hus[0].id); return; }
        if (a.syd === a.nord && a.vast === a.ost) { map.setView([a.lat, a.lon], NIVAER[Math.min(niva + 1, 3)].fran); return; }
        map.fitBounds([[a.syd, a.vast], [a.nord, a.ost]], { padding: [40, 40], maxZoom: NIVAER[Math.min(niva + 1, 3)].till });
      });
      lager.addLayer(m);
    }
    lager.addTo(map);
    lagerRef.current = lager;
  }, [perNiva, niva, lage, klar]);

  // Bästa gångavståndsområdena i vyn (klusternivån, celler på ca 1 km).
  const basta = useMemo(() => {
    const kluster = perNiva[2] ?? [];
    return kluster
      .filter((a) => !vy || (a.lat >= vy.s && a.lat <= vy.n && a.lon >= vy.v && a.lon <= vy.o))
      .sort((a, b) => b.effektiva - a.effektiva)
      .slice(0, 12);
  }, [perNiva, vy]);

  const iVy = useMemo(() => {
    const l = filtrerade.filter((h) => h.lat != null && (!vy || (h.lat! >= vy.s && h.lat! <= vy.n && h.lon! >= vy.v && h.lon! <= vy.o)));
    return { hus: l.length, lgh: l.reduce((s, h) => s + h.lgh, 0), eff: l.reduce((s, h) => s + h.effektiva, 0), slj: l.reduce((s, h) => s + h.saljbara, 0) };
  }, [filtrerade, vy]);

  const kvalitet = useMemo(() => {
    const f = data?.fastigheter ?? [];
    return [
      { namn: "Saknar läge (syns inte på kartan)", lista: f.filter((h) => h.lat == null || h.lon == null) },
      { namn: "Saknar kundklar (installationsdatum)", lista: f.filter((h) => !h.kundklar) },
      { namn: "Befintlig lösning okänd", lista: f.filter((h) => !h.losning) },
      { namn: "Bara i Masterlistan (ingen leverans)", lista: f.filter((h) => h.kalla === "masterlista") },
      { namn: "Saknar antal lägenheter", lista: f.filter((h) => !h.lgh) },
    ];
  }, [data]);

  const valtHus = valt ? data?.fastigheter.find((h) => h.id === valt) ?? null : null;
  useEffect(() => { if (valt) kortRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [valt]);

  async function importera(fil: File | null) {
    if (!fil) return;
    setImportar(true); setImportInfo(null);
    try {
      const rader = await lasMasterlista(fil);
      if (!rader.length) throw new Error("Hittade inga rader med fastighetsbeteckning och kommun.");
      let n = 0;
      for (let i = 0; i < rader.length; i += 300) {
        const { data: r, error } = await supabase.rpc("d2d_karta_importera", { p_rader: rader.slice(i, i + 300), p_kalla: fil.name });
        if (error) throw error;
        n += (r as { rader: number }).rader;
      }
      const okand = rader.filter((r) => !r.befintlig_losning).length;
      setImportInfo(`${heltal(n)} hus inlästa från ${fil.name}.${okand ? ` ${okand} har okänd befintlig lösning.` : ""}`);
      await ladda();
    } catch (e) {
      setImportInfo(`Fel: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportar(false);
    }
  }

  const vaxla = (k: string) => setLosningar((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="d2dk">
      <div className="d2dk-karta-wrap">
        <div ref={mapEl} className="d2dk-karta" />
        <div className="d2dk-niva">{NIVAER[niva]?.namn} · zoom {zoom}</div>
        <div className="d2dk-legend">
          {lage === "utfall"
            ? KAT.map((k) => <span key={k.k}><i className={`d2dk-dot d2dk-${k.k}`} />{k.namn}</span>)
            : (<><span><i className="d2dk-dot q1" />under ×0,6</span><span><i className="d2dk-dot q3" />×0,9–1,2</span><span><i className="d2dk-dot q5" />över ×1,6</span></>)}
        </div>
      </div>

      <aside className="d2dk-panel">
        {fel && <div className="d2d-error">{fel}</div>}
        {!data && !fel && <div className="d2dk-tom">Laddar beståndet…</div>}

        {data && (
          <>
            <div className="d2dk-lage" role="tablist">
              <button role="tab" aria-selected={lage === "kvalitet"} className={lage === "kvalitet" ? "on" : ""} onClick={() => setLage("kvalitet")}>Dörrkvalitet</button>
              <button role="tab" aria-selected={lage === "utfall"} className={lage === "utfall" ? "on" : ""} onClick={() => setLage("utfall")}>Utfall</button>
            </div>
            <p className="d2dk-hjalp">
              {lage === "kvalitet"
                ? "Siffran är effektiva dörrar: säljbara dörrar × kvalitetsfaktor. Färgen är snittfaktorn."
                : "Siffran är lägenheter. Tårtan visar utfallet vid dörrarna."}
            </p>

            <div className="d2dk-tiles">
              <div><b>{heltal(iVy.hus)}</b><span>hus i vyn</span></div>
              <div><b>{heltal(iVy.lgh)}</b><span>lägenheter</span></div>
              <div><b>{heltal(iVy.eff)}</b><span>effektiva dörrar</span></div>
            </div>

            <div className="d2dk-filter">
              <input className="input" placeholder="Sök kommun, ort, ägare, beteckning…" value={sok} onChange={(e) => setSok(e.target.value)} />
              <div className="d2dk-chips">
                {(Object.keys(LOSNING) as Array<keyof typeof LOSNING>).map((k) => (
                  <button key={k} className={`d2dk-chip${losningar.has(k) ? " on" : ""}`} onClick={() => vaxla(k)}>{LOSNING[k]}</button>
                ))}
              </div>
              <div className="d2dk-rad">
                <label>Installation
                  <select className="input" value={inst} onChange={(e) => setInst(e.target.value as InstFilter)}>
                    {(Object.keys(INST) as InstFilter[]).map((k) => <option key={k} value={k}>{INST[k]}</option>)}
                  </select>
                </label>
                <label>Faktor minst
                  <select className="input" value={minFaktor} onChange={(e) => setMinFaktor(Number(e.target.value))}>
                    <option value={0}>Alla</option><option value={0.9}>×0,9</option><option value={1.2}>×1,2</option><option value={1.6}>×1,6</option>
                  </select>
                </label>
              </div>
            </div>

            <div ref={kortRef} />
            {valtHus && <Fastighetskort h={valtHus} idag={idag} onStang={() => setValt(null)} onOpenRecord={onOpenRecord}
              onVisa={() => valtHus.lat != null && mapRef.current?.setView([valtHus.lat, valtHus.lon], 16)} />}

            <section className="d2dk-sek">
              <h3>Bästa områdena i vyn</h3>
              <p className="d2dk-hjalp">Hus inom ett par kilometer från varandra, rangordnade efter effektiva dörrar.</p>
              {basta.length === 0 && <div className="d2dk-tom">Inga hus i vyn med nuvarande filter.</div>}
              <ol className="d2dk-lista">
                {basta.map((a) => (
                  <li key={a.id}>
                    <button onClick={() => {
                      if (a.hus.length === 1) { setValt(a.hus[0].id); mapRef.current?.setView([a.lat, a.lon], 16); }
                      else mapRef.current?.fitBounds([[a.syd, a.vast], [a.nord, a.ost]], { padding: [40, 40], maxZoom: 16 });
                    }}>
                      <span className="d2dk-lista__namn">{a.namn || "Okänd ort"}</span>
                      <span className="d2dk-lista__sub">{a.hus.length} hus · {heltal(a.lgh)} lgh · snitt {fak(a.saljbara ? a.effektiva / a.saljbara : 0)}</span>
                      <b>{heltal(a.effektiva)}</b>
                    </button>
                  </li>
                ))}
              </ol>
            </section>

            <section className="d2dk-sek">
              <button className="d2dk-sek__knapp" onClick={() => setVisaKvalitet((v) => !v)} aria-expanded={visaKvalitet}>
                Datakvalitet {visaKvalitet ? "▾" : "▸"}
              </button>
              <ul className="d2dk-kval">
                {kvalitet.map((k) => (
                  <li key={k.namn}>
                    <span>{k.namn}</span><b>{heltal(k.lista.length)}</b>
                    {visaKvalitet && k.lista.length > 0 && (
                      <div className="d2dk-kval__rader">
                        {k.lista.slice(0, 40).map((h) => (
                          <button key={h.id} onClick={() => setValt(h.id)}>{h.beteckning} · {h.kommun ?? h.ort ?? "?"}</button>
                        ))}
                        {k.lista.length > 40 && <span>… och {k.lista.length - 40} till</span>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <p className="d2dk-hjalp">
                Underlag: {data.underlag.rader ? `${heltal(data.underlag.rader)} rader från ${data.underlag.kalla ?? "Masterlistan"} (${dag(data.underlag.uppdaterad)})` : "Masterlistan är inte inläst — befintlig lösning saknas."}
              </p>
              {isAdmin && (
                <label className="d2dk-import">
                  <span className="btn btn--ghost btn--sm">{importar ? "Läser in…" : "Läs in Masterlistan (.xlsx)"}</span>
                  <input type="file" accept=".xlsx" disabled={importar} onChange={(e) => { importera(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                </label>
              )}
              {importInfo && <div className={importInfo.startsWith("Fel") ? "d2d-error" : "d2d-save-ok"}>{importInfo}</div>}
            </section>
            <div className="d2dk-version">{VERSION}</div>
          </>
        )}
      </aside>
    </div>
  );
}

function Fastighetskort({ h, idag, onStang, onVisa, onOpenRecord }: {
  h: KartHus; idag: string; onStang: () => void; onVisa: () => void; onOpenRecord?: (id: string) => void;
}) {
  const tot = KAT.reduce((s, k) => s + h.utfall[k.k], 0);
  return (
    <section className="d2dk-kort card">
      <div className="d2dk-kort__head">
        <div>
          <h3>{h.beteckning}</h3>
          <div className="d2dk-kort__sub">{[h.adress, h.kommun].filter(Boolean).join(" · ")}</div>
          <div className="d2dk-kort__sub">{h.agare}{h.bolag && h.bolag !== h.agare ? ` (${h.bolag})` : ""}</div>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onStang} aria-label="Stäng">✕</button>
      </div>

      <div className="d2dk-tiles">
        <div><b>{heltal(h.lgh)}</b><span>lägenheter</span></div>
        <div><b>{heltal(h.saljbara)}</b><span>säljbara</span></div>
        <div><b>{heltal(h.effektiva)}</b><span>effektiva ({fak(h.faktor)})</span></div>
      </div>

      <h4>Varför {fak(h.faktor)}</h4>
      <ul className="d2dk-delar">
        {h.delar.map((d, i) => (
          <li key={i} className={d.v > 1 ? "upp" : d.v < 1 ? "ner" : ""}><span>{d.namn}</span><b>{fak(d.v)}</b></li>
        ))}
      </ul>

      <dl className="d2dk-fakta">
        <dt>Installation (kundklar)</dt><dd>{dag(h.kundklar)}{h.kundklar ? ` (${manader(idag, h.kundklar) > 0 ? "om " : "för "}${Math.abs(manader(idag, h.kundklar))} mån${manader(idag, h.kundklar) > 0 ? "" : " sedan"})` : ""}</dd>
        <dt>Befintlig lösning</dt><dd>{LOSNING[h.losning ?? "okand"]}{h.fiber ? ` · fiber: ${h.fiber}` : ""}{h.koax ? ` · koax: ${h.koax}` : ""}</dd>
        <dt>Gamla avtalet upphör</dt><dd>{dag(h.avtalSlut)}</dd>
        <dt>Bearbetning</dt><dd>{h.vandor ? `${h.vandor} vändor, senast ${dag(h.senast)}${h.uppskattad ? " (uppskattat)" : ""}` : "Aldrig knackat"}</dd>
        <dt>Projektplan</dt><dd>{h.projektstatus ?? "–"}{h.kalla === "masterlista" ? " · bara i Masterlistan" : ""}</dd>
      </dl>

      {tot > 0 && h.dorrar > 0 && (
        <>
          <h4>Utfall ({heltal(h.dorrar)} dörrar)</h4>
          <div className="d2dk-stapel">
            {KAT.map((k) => h.utfall[k.k] ? <span key={k.k} className={`d2dk-${k.k}`} style={{ flexGrow: h.utfall[k.k] }} title={`${k.namn}: ${h.utfall[k.k]}`} /> : null)}
          </div>
          <div className="d2dk-stapel__leg">
            {KAT.filter((k) => h.utfall[k.k]).map((k) => <span key={k.k}><i className={`d2dk-dot d2dk-${k.k}`} />{k.namn} {h.utfall[k.k]}</span>)}
          </div>
        </>
      )}

      <div className="d2dk-kort__knappar">
        <button className="btn btn--ghost btn--sm" onClick={onVisa}>Visa på kartan</button>
        {h.levId && onOpenRecord && <button className="btn btn--ghost btn--sm" onClick={() => onOpenRecord(h.levId!)}>Öppna leveransen</button>}
      </div>
    </section>
  );
}
