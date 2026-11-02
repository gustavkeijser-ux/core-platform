/**
 * Door to door → Utfall → Excel-rapport.
 *
 * Underlaget kommer från d2d_utfall_rapport (databasen). Här matchas det mot en
 * uppladdad VT-export (valfri) och blir en xlsx med bladen:
 *   Summering   — sålt, Scrive och gemensamt (+ VT om filen finns)
 *   Sålda       — allt som är Sålt i perioden, med "Godkänd i VT" som egen kolumn
 *   Scrive      — alla Scrive-avtal som skickats i perioden
 *   Attach rate — varje tjänst mot bredband: gemensamt, sålt, Scrive och per person
 *   Snitt       — antal avtal per kund: gemensamt och per person
 *   VT saknas i CRM — VT-ordrar utan såld/signerad lägenhet i CRM (bara med VT-fil)
 *
 * Personnummer och andra personuppgifter i VT-filen läses aldrig in — bara
 * ordernummer, datum, status, tjänster, adress och VT-säljar-id.
 */
import { lasXlsx } from "./xlsx";
import type { Cell, Diagram, SkrivBlad } from "./xlsxSkriv";

export type RapportLgh = {
  id: string; gata: string | null; nummer: string | null; ingang: string | null; lgh: string | null;
  postnummer: string | null; ort: string | null; projekt: string | null;
  saljareId: string | null; saljare: string | null; kundtjanst: string | null; status: string;
  saldTid: string | null; saldIPeriod: boolean; skickad: string | null; signerad: string | null; signeradIPeriod: boolean;
  avtalStatus: string | null; tjanster: Array<{ nyckel: string; etikett: string }>; kategorier: string[];
  avtal: number; pinnar: number; vtBestallning: string | null;
};
export type RapportAvtal = { id: string; lagenhetId: string; status: string; skickad: string; signerad: string | null; skickadAv: string | null };
export type RapportData = { fran: string | null; till: string | null; lagenheter: RapportLgh[]; avtal: RapportAvtal[] };

export type VtOrder = {
  order: string; fsg: string; status: string; tjanster: string; csr: string;
  gata: string; nr: string; upp: string; lgh: string; ort: string;
};

// ── VT-exporten ─────────────────────────────────────────────────────────────
const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[éè]/g, "e").replace(/ü/g, "u").replace(/[^a-z0-9åäö]/g, "");
const nyckel = (gata: string | null, nr: string | null, upp: string | null, lgh: string | null) =>
  [norm(gata), norm(nr), norm(upp), norm(lgh)].join("|");
const ortNorm = (s: string | null | undefined) => norm(s).replace(/^(stockholm|sthlm)$/, "stockholm");

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

/** Läser VT-exporten (xlsx, csv eller tabbseparerad text). Kastar med ett begripligt fel om kolumnerna saknas. */
export async function lasVtExport(fil: File): Promise<VtOrder[]> {
  const rader = /\.xlsx$/i.test(fil.name) ? (await lasXlsx(fil)).rader : delaText(await fil.text());
  const hi = rader.findIndex((r) => r.some((c) => /^order_number$/i.test(c.trim())));
  if (hi < 0) throw new Error("Hittar inte kolumnen order_number i VT-filen. Ladda upp exporten som den kommer från VT.");
  const h = rader[hi].map((c) => c.trim().toLowerCase());
  const k = (namn: string) => h.indexOf(namn);
  const kol = {
    order: k("order_number"), fsg: k("fsg_datum"), status: k("orderstatus"), erb: k("erbjudande"), hast: k("hastighet"),
    tvp: k("tv_paket"), tvv: k("tv_val"), tvprem: k("tv_premium"), extra: k("extra_anvandare"), mobil: k("mobil_gb"),
    gata: k("adress"), nr: k("gatnummer"), upp: k("uppgang"), lgh: k("lagenhets_nr"), ort: k("postort"), csr: k("ts_csr_id"),
  };
  if (kol.gata < 0 || kol.nr < 0 || kol.lgh < 0) throw new Error("VT-filen saknar adresskolumnerna (adress, gatnummer, lagenhets_nr).");
  const v = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  return rader.slice(hi + 1).filter((r) => v(r, kol.order)).map((r) => {
    const tj = [v(r, kol.hast), v(r, kol.tvp), v(r, kol.tvv), v(r, kol.tvprem), v(r, kol.mobil), v(r, kol.extra),
      /asus|router|wifi/i.test(v(r, kol.erb)) ? "Router" : ""].filter(Boolean).join(", ");
    const fsg = v(r, kol.fsg).replace(/\//g, "-").slice(0, 10);
    return {
      order: v(r, kol.order), fsg, status: v(r, kol.status), tjanster: tj || v(r, kol.erb), csr: v(r, kol.csr),
      gata: v(r, kol.gata), nr: v(r, kol.nr), upp: v(r, kol.upp), lgh: v(r, kol.lgh), ort: v(r, kol.ort),
    };
  });
}

/** Matchar VT-ordrar mot CRM-lägenheter: gata + nummer + uppgång + lgh, och ort när den finns i båda. */
function matchaVt(lgh: RapportLgh[], vt: VtOrder[]) {
  const perLgh = new Map<string, VtOrder[]>();
  const anvanda = new Set<VtOrder>();
  const index = new Map<string, RapportLgh[]>();
  for (const l of lgh) {
    const k = nyckel(l.gata, l.nummer, l.ingang, l.lgh);
    index.set(k, [...(index.get(k) ?? []), l]);
  }
  for (const o of vt) {
    const kand = index.get(nyckel(o.gata, o.nr, o.upp, o.lgh)) ?? [];
    const medOrt = kand.filter((l) => !l.ort || !o.ort || ortNorm(l.ort) === ortNorm(o.ort));
    const traff = medOrt.length ? medOrt : [];
    for (const l of traff) perLgh.set(l.id, [...(perLgh.get(l.id) ?? []), o]);
    if (traff.length) anvanda.add(o);
  }
  return { perLgh, ejMatchade: vt.filter((o) => !anvanda.has(o)) };
}

// ── Hjälp ───────────────────────────────────────────────────────────────────
const dag = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10)
    : d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
};
const adress = (l: RapportLgh) =>
  [l.gata, l.nummer].filter(Boolean).join(" ") + (l.ingang ? ` ${l.ingang}` : "");
const AVTALSTATUS: Record<string, string> = { signerat: "Signerat", vantar: "Väntar på signering", skapas: "Skapas", avbrutet: "Avbrutet", avvisat: "Avvisat", fel: "Fel" };
const LGHSTATUS: Record<string, string> = { sald: "Såld", scrive: "Signera med Scrive", aterkoppling: "Återkoppling", inte_intresserad: "Inte intresserad", anger: "Ånger", inte_hemma: "Inte hemma" };
const MER = new Set(["tv", "mobil_huvud", "mobil_extra", "streaming_film", "streaming_sport", "trygghet"]);
const KATEGORI: Array<[string, string]> = [
  ["tv", "TV (utöver Start/Bas)"], ["streaming_film", "Streaming film och serier"],
  ["streaming_sport", "Sportpaket"], ["trygghet", "Trygghetspaket"], ["mobil_huvud", "Mobil – huvudabonnemang"],
  ["mobil_extra", "Mobil – extraanvändare"],
];
const andel = (a: number, b: number): Cell => (b > 0 ? { procent: a / b } : "–");
const snitt = (a: number, b: number): Cell => (b > 0 ? { tal: a / b, dec: 2 } : "–");
const via = (l: RapportLgh) => !!l.kundtjanst;
const antalKat = (rader: RapportLgh[], k: string) => rader.reduce((s, l) => s + l.kategorier.filter((x) => x === k).length, 0);
const antalTj = (rader: RapportLgh[], k: string) => rader.reduce((s, l) => s + l.tjanster.filter((t) => t.nyckel === k).length, 0);
const mer = (l: RapportLgh) => l.kategorier.some((k) => MER.has(k));

// ── Rapporten ───────────────────────────────────────────────────────────────
export function byggUtfallRapport(data: RapportData, vt: VtOrder[] | null, filnamnVt?: string): SkrivBlad[] {
  const lgh = data.lagenheter;
  const sald = lgh.filter((l) => l.saldIPeriod);
  const gem = lgh.filter((l) => l.saldIPeriod || l.signeradIPeriod);
  const lghPerId = new Map(lgh.map((l) => [l.id, l]));
  const m = vt ? matchaVt(lgh, vt) : null;
  const vtCeller = (l: RapportLgh): Cell[] => {
    if (!m) return ["(ingen VT-fil)", "", "", "", "", ""];
    const o = m.perLgh.get(l.id) ?? [];
    if (!o.length) return ["Nej", "", "", "", "", ""];
    return ["Ja", o.map((x) => x.order).join(", "), [...new Set(o.map((x) => x.fsg))].join(", "),
      [...new Set(o.map((x) => x.status))].join(", "), o.map((x) => x.tjanster).filter(Boolean).join(" | "),
      [...new Set(o.map((x) => x.csr).filter(Boolean))].join(", ")];
  };
  const VT_RUBRIK = ["Godkänd i VT", "VT-order", "VT-datum", "VT-status", "VT-tjänster", "VT-säljar-id"];
  const tjText = (l: RapportLgh) => l.tjanster.map((t) => t.etikett).join(", ");

  // Sålda
  const saldaBlad: SkrivBlad = {
    namn: "Sålda",
    rader: [
      ["Såld datum", "Adress", "Lgh", "Postnr", "Ort", "Projekt", "Säljare", "Via kundtjänst", "Tjänster", "Antal avtal", "Pinnar",
        "Scrive", "Scrive signerat", ...VT_RUBRIK],
      ...sald.map((l): Cell[] => [dag(l.saldTid), adress(l), l.lgh, l.postnummer, l.ort, l.projekt, l.saljare ?? "Saknar säljare",
        l.kundtjanst ?? "", tjText(l), l.avtal, { tal: l.pinnar, dec: 1 },
        l.avtalStatus ? AVTALSTATUS[l.avtalStatus] ?? l.avtalStatus : "", dag(l.signerad), ...vtCeller(l)]),
    ],
  };

  // Scrive
  const scriveBlad: SkrivBlad = {
    namn: "Scrive",
    rader: [
      ["Skickat", "Status", "Signerat", "Adress", "Lgh", "Ort", "Projekt", "Säljare", "Skickat av", "Lägenhetens status",
        "Tjänster", "Antal avtal", ...VT_RUBRIK],
      ...data.avtal.map((a): Cell[] => {
        const l = lghPerId.get(a.lagenhetId);
        return [dag(a.skickad), AVTALSTATUS[a.status] ?? a.status, dag(a.signerad), l ? adress(l) : "", l?.lgh, l?.ort, l?.projekt,
          l?.saljare ?? "", a.skickadAv ?? "", l ? LGHSTATUS[l.status] ?? l.status : "", l ? tjText(l) : "", l?.avtal,
          ...(l ? vtCeller(l) : ["", "", "", "", "", ""])];
      }),
    ],
  };

  // Summering
  const sc = data.avtal;
  const signeradeIPer = lgh.filter((l) => l.signeradIPeriod);
  const sumAvtal = (r: RapportLgh[]) => r.reduce((s, l) => s + l.avtal, 0);
  const period = `${data.fran ?? "början"} – ${data.till ?? "idag"}`;
  const sum: Cell[][] = [
    [{ fet: "Utfall – rapport" }, ""],
    ["Period", period],
    ["Skapad", new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })],
    ["", ""],
    [{ fet: "Sålt" }, "Säljdatum i perioden, status Såld"],
    ["Sålda kunder", sald.length],
    ["varav via kundtjänst", sald.filter(via).length],
    ["Antal avtal (tjänster)", sumAvtal(sald)],
    ["Snitt avtal per kund", snitt(sumAvtal(sald), sald.length)],
    ["Köpte mer än bredband", sald.filter(mer).length],
    ["Pinnar (före 80/20-delning)", { tal: sald.reduce((s, l) => s + l.pinnar, 0), dec: 1 }],
    ["", ""],
    [{ fet: "Scrive" }, "Avtal skickade i perioden"],
    ["Skickade avtal", sc.length],
    ["Signerade", sc.filter((a) => a.status === "signerat").length],
    ["Väntar på signering", sc.filter((a) => a.status === "vantar" || a.status === "skapas").length],
    ["Avbrutna, avvisade eller fel", sc.filter((a) => ["avbrutet", "avvisat", "fel"].includes(a.status)).length],
    ["Signeringsgrad", andel(sc.filter((a) => a.status === "signerat").length, sc.length)],
    ["Kunder som signerat i perioden", signeradeIPer.length],
    ["", ""],
    [{ fet: "Gemensamt" }, "Såld eller Scrive-signerad i perioden – en kund räknas en gång"],
    ["Kunder", gem.length],
    ["varav både såld och signerad", gem.filter((l) => l.saldIPeriod && l.signeradIPeriod).length],
    ["varav bara såld", gem.filter((l) => l.saldIPeriod && !l.signeradIPeriod).length],
    ["varav bara signerad (ännu inte Såld)", gem.filter((l) => !l.saldIPeriod && l.signeradIPeriod).length],
    ["Antal avtal (tjänster)", sumAvtal(gem)],
    ["Snitt avtal per kund", snitt(sumAvtal(gem), gem.length)],
    ["Köpte mer än bredband", gem.filter(mer).length],
  ];
  if (m && vt) {
    const godk = (r: RapportLgh[]) => r.filter((l) => (m.perLgh.get(l.id) ?? []).length > 0).length;
    sum.push(["", ""], [{ fet: "VT" }, filnamnVt ? `Fil: ${filnamnVt}` : ""],
      ["VT-ordrar i filen", vt.length],
      ["Sålda som finns i VT", godk(sald)], ["Sålda som saknas i VT", sald.length - godk(sald)],
      ["Andel sålda godkända i VT", andel(godk(sald), sald.length)],
      ["Signerade (Scrive) som finns i VT", godk(signeradeIPer)],
      ["Gemensamt som finns i VT", godk(gem)],
      ["VT-ordrar utan såld/signerad lägenhet i CRM", m.ejMatchade.length]);
  }
  sum.push(["", ""], ["Obs", "Pinnar i lönen delas 80/20 på affärer via kundtjänst; se Löner för exakta pinnar per person."]);
  const sumBlad: SkrivBlad = { namn: "Summering", rader: sum, rubrik: false, bredd: [42, 60] };

  // Personer: säljare (egna affärer) + kundtjänst.
  const personer = [...new Set(gem.map((l) => l.saljare ?? "Saknar säljare"))].sort((a, b) => a.localeCompare(b, "sv"));
  const egna = (p: string) => gem.filter((l) => (l.saljare ?? "Saknar säljare") === p && !via(l));
  const kt = gem.filter(via);
  const grupper: Array<[string, RapportLgh[]]> = [
    ["Gemensamt", gem], ["Sålt", gem.filter((l) => l.saldIPeriod)], ["Scrive", gem.filter((l) => l.signeradIPeriod)],
    ...personer.map((p): [string, RapportLgh[]] => [p, egna(p)]),
    ...(kt.length ? [["Kundtjänst", kt] as [string, RapportLgh[]]] : []),
  ];

  // Attach rate
  const varianter = [...new Map(gem.flatMap((l) => l.tjanster).filter((t) => !t.nyckel.startsWith("salt_bredband"))
    .map((t) => [t.nyckel, t.etikett])).entries()].sort((a, b) => a[1].localeCompare(b[1], "sv"));
  const bb = (r: RapportLgh[]) => antalKat(r, "bredband");
  const attachRader: Cell[][] = [
    ["Tjänst", "Antal (gemensamt)", ...grupper.map(([n]) => `${n} (%)`)],
    ["Bredband (nämnare)", bb(gem), ...grupper.map(([, r]) => bb(r))],
    [{ fet: "Kategorier" }],
    ...KATEGORI.map(([k, lbl]): Cell[] => [lbl, antalKat(gem, k), ...grupper.map(([, r]) => andel(antalKat(r, k), bb(r)))]),
    [{ fet: "Per tjänst" }],
    ...varianter.map(([k, lbl]): Cell[] => [lbl, antalTj(gem, k), ...grupper.map(([, r]) => andel(antalTj(r, k), bb(r)))]),
    [],
    ["Attach rate = antal av tjänsten delat med antal tecknade bredband i gruppen. Extraanvändare räknas per styck och kan bli över 100 %."],
    ["Per säljare räknas säljarens egna affärer; affärer via kundtjänst ligger i kolumnen Kundtjänst."],
  ];
  const attachBlad: SkrivBlad = { namn: "Attach rate", rader: attachRader, bredd: [44, 18, ...grupper.map(() => 16)] };

  // Snitt
  const snittRad = (namn: string, r: RapportLgh[], viaKt?: number): Cell[] =>
    [namn, r.length, viaKt ?? "", sumAvtal(r), snitt(sumAvtal(r), r.length), r.filter(mer).length, andel(r.filter(mer).length, r.length),
      bb(r), { tal: r.reduce((s, l) => s + l.pinnar, 0), dec: 1 }];
  const snittBlad: SkrivBlad = {
    namn: "Snitt",
    rader: [
      ["Grupp / person", "Kunder", "Dessutom via kundtjänst", "Antal avtal", "Snitt avtal/kund", "Mer än bredband", "Andel mer än bredband", "Bredband", "Pinnar (före delning)"],
      snittRad("Gemensamt", gem),
      snittRad("Sålt", gem.filter((l) => l.saldIPeriod)),
      snittRad("Scrive (signerade)", gem.filter((l) => l.signeradIPeriod)),
      [],
      [{ fet: "Individuellt – egna affärer" }],
      ...personer.map((p) => snittRad(p, egna(p), gem.filter((l) => (l.saljare ?? "Saknar säljare") === p && via(l)).length)),
      ...(kt.length ? [snittRad("Kundtjänst", kt)] : []),
      [],
      ["Kunder = sålda eller Scrive-signerade i perioden. \"Dessutom via kundtjänst\" = affärer kundtjänst lämnat till säljaren (räknas i säljarens volym men inte i snittet)."],
    ],
  };

  const blad = [sumBlad, saldaBlad, scriveBlad, attachBlad, snittBlad];
  if (m) {
    blad.push({
      namn: "VT saknas i CRM",
      rader: [
        ["VT-order", "VT-datum", "VT-status", "Adress", "Uppgång", "Lgh", "Ort", "VT-tjänster", "VT-säljar-id"],
        ...m.ejMatchade.map((o): Cell[] => [o.order, o.fsg, o.status, `${o.gata} ${o.nr}`.trim(), o.upp, o.lgh, o.ort, o.tjanster, o.csr]),
      ],
    });
  }
  return blad;
}

// ── Månadsrapport ───────────────────────────────────────────────────────────
/**
 * Månadsrapporten (Gustav 2 nov): nyckeltal för en kalendermånad jämfört med
 * föregående månad, utveckling vecka för vecka (med diagram) och resultat per
 * säljare. Kund = såld eller Scrive-signerad i månaden (en kund räknas en gång),
 * samma som bladen Attach rate och Snitt.
 *
 *   Total försäljning  antal sålda tjänster (avtal) hos månadens kunder
 *   Snitt              tjänster per kund
 *   Attach rate        andel bredbandskunder som köpt minst en tilläggstjänst
 *   Antal bredband     kunder med bredband
 *   Antal kunder       sålda eller signerade kunder
 */
type Nyckeltal = { kunder: number; tjanster: number; bredband: number; tillagg: number; snitt: number | null; attach: number | null; pinnar: number };

const harBb = (l: RapportLgh) => l.kategorier.includes("bredband");
function nyckeltal(r: RapportLgh[]): Nyckeltal {
  const bb = r.filter(harBb);
  const tjanster = r.reduce((s, l) => s + l.avtal, 0);
  const tillagg = bb.filter(mer).length;
  return {
    kunder: r.length, tjanster, bredband: bb.length, tillagg,
    snitt: r.length ? tjanster / r.length : null,
    attach: bb.length ? tillagg / bb.length : null,
    pinnar: r.reduce((s, l) => s + l.pinnar, 0),
  };
}
const kunder = (d: RapportData) => d.lagenheter.filter((l) => l.saldIPeriod || l.signeradIPeriod);
/** Kundens datum i månaden: säljdatumet om Såld i perioden, annars signeringsdatumet. */
const kundDatum = (l: RapportLgh) => (l.saldIPeriod && l.saldTid ? l.saldTid : l.signerad ?? l.saldTid);
/** ÅÅÅÅ-MM-DD i svensk tid. */
const lokalDag = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
};
const utcDag = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
/** ISO-vecka och måndagen i veckan för en ÅÅÅÅ-MM-DD. */
function isoVecka(ymd: string): { vecka: number; mandag: string } {
  const d = utcDag(ymd);
  const dag = d.getUTCDay() || 7;
  const mandag = new Date(d); mandag.setUTCDate(d.getUTCDate() - dag + 1);
  const torsdag = new Date(d); torsdag.setUTCDate(d.getUTCDate() + 4 - dag);
  const arStart = new Date(Date.UTC(torsdag.getUTCFullYear(), 0, 1));
  const vecka = Math.ceil(((torsdag.getTime() - arStart.getTime()) / 86400000 + 1) / 7);
  return { vecka, mandag: mandag.toISOString().slice(0, 10) };
}
const plusDagar = (ymd: string, n: number) => { const d = utcDag(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const kortDatum = (ymd: string) => utcDag(ymd).toLocaleDateString("sv-SE", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
/** "november 2026" */
export const manadNamn = (manad: string) =>
  utcDag(`${manad}-01`).toLocaleDateString("sv-SE", { month: "long", year: "numeric", timeZone: "UTC" });
/** Första och sista dagen i en ÅÅÅÅ-MM. */
export function manadGranser(manad: string): { fran: string; till: string } {
  const [y, m] = manad.split("-").map(Number);
  return { fran: `${manad}-01`, till: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
/** Föregående ÅÅÅÅ-MM. */
export const foregaendeManad = (manad: string) => {
  const [y, m] = manad.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

const diffTal = (a: number, b: number): Cell => a - b;
const diffProc = (a: number, b: number): Cell => (b > 0 ? { procent: (a - b) / b } : "–");
const diffSnitt = (a: number | null, b: number | null): Cell => (a != null && b != null ? { tal: a - b, dec: 2 } : "–");
const diffPE = (a: number | null, b: number | null): Cell => (a != null && b != null ? { tal: (a - b) * 100, dec: 1 } : "–");
const snittC = (v: number | null): Cell => (v == null ? "–" : { tal: v, dec: 2 });
const procC = (v: number | null): Cell => (v == null ? "–" : { procent: v });

/** De tre grupperna i månadsrapporten (Gustav 2 nov: "dela upp sålda och scrive – samt en summerad"). */
const GRUPPER: Array<{ namn: string; urval: (l: RapportLgh) => boolean; text: string }> = [
  { namn: "Sålda", urval: (l) => l.saldIPeriod, text: "status Såld med säljdatum i månaden" },
  { namn: "Scrive", urval: (l) => l.signeradIPeriod, text: "Scrive-avtal signerade i månaden" },
  { namn: "Summerat", urval: (l) => l.saldIPeriod || l.signeradIPeriod, text: "såld eller signerad – en kund räknas en gång" },
];

/** Bladen Månadsrapport, Veckor och Säljare. `data` är månaden, `fg` föregående månad (samma filter). */
export function byggManadsrapport(manad: string, data: RapportData, fg: RapportData): SkrivBlad[] {
  const { fran, till } = manadGranser(manad);
  const alla = kunder(data), allaForra = kunder(fg);
  const fgManad = foregaendeManad(manad);
  const G = GRUPPER.map((g) => ({ ...g, nu: alla.filter(g.urval), forra: allaForra.filter(g.urval) }));
  const sumG = G[2];

  // Veckor: ISO-veckor som rör månaden, avgränsade till månadens dagar. Sålda räknas på säljdatumet,
  // Scrive på signeringsdatumet; i Summerat gäller säljdatumet om kunden är Såld, annars signeringsdatumet.
  type Vecka = { vecka: number; fran: string; till: string };
  const veckor = new Map<string, Vecka>();
  for (let dag = fran; dag <= till; dag = plusDagar(dag, 1)) {
    const { vecka, mandag } = isoVecka(dag);
    const v = veckor.get(mandag) ?? { vecka, fran: dag, till: dag };
    v.till = dag; veckor.set(mandag, v);
  }
  const veckoLista = [...veckor.entries()].sort((a, b) => a[1].fran.localeCompare(b[1].fran));
  const veckaFor = (l: RapportLgh, g: string) => {
    const dt = g === "Sålda" ? l.saldTid : g === "Scrive" ? l.signerad : kundDatum(l);
    return dt ? isoVecka(lokalDag(dt)).mandag : null;
  };
  const veckoRaderFor = (g: typeof G[number]): Cell[][] => veckoLista.map(([mandag, v], i) => {
    const k = nyckeltal(g.nu.filter((l) => veckaFor(l, g.namn) === mandag));
    return [`Vecka ${i + 1} (v. ${v.vecka})`, `${kortDatum(v.fran)} – ${kortDatum(v.till)}`, k.kunder, k.tjanster, k.bredband,
      snittC(k.snitt), procC(k.attach), k.tillagg, { tal: k.pinnar, dec: 1 }];
  });
  const helaRad = (g: typeof G[number]): Cell[] => {
    const N = nyckeltal(g.nu);
    return [`Hela månaden – ${g.namn}`, `${kortDatum(fran)} – ${kortDatum(till)}`, N.kunder, N.tjanster, N.bredband, snittC(N.snitt), procC(N.attach), N.tillagg, { tal: N.pinnar, dec: 1 }];
  };
  const VECKO_RUBRIK: Cell[] = ["Vecka", "Dagar", "Antal kunder", "Total försäljning (tjänster)", "Antal bredband", "Snitt tjänster/kund", "Attach rate", "Bredbandskunder med tillägg", "Pinnar"];
  const nV = veckoLista.length;
  const blockH = nV + 4; // fet rubrik + kolumnrubrik + veckor + hela månaden + blankrad
  const veckoRader: Cell[][] = [];
  const veckoDiagram: Diagram[] = [];
  const veckoBlock: Record<string, Cell[][]> = {};
  G.forEach((g, gi) => {
    const start = gi * blockH; // 0-baserad rad för gruppens feta rubrik
    const rader = veckoRaderFor(g);
    veckoBlock[g.namn] = rader;
    veckoRader.push([{ fet: `${g.namn} – ${g.text}` }], VECKO_RUBRIK, ...rader, helaRad(g), []);
    // start = fet-rubrik, start+1 = kolumnrubrik, start+2 … start+1+nV = veckorna
    veckoDiagram.push({ typ: "stapel", titel: `${g.namn}: kunder, tjänster och bredband per vecka`, katKol: 0,
      serier: [{ kol: 2 }, { kol: 3 }, { kol: 4 }], rubrikRad: start + 1, radFran: start + 2, radTill: start + 1 + nV,
      kol: 10, rad: start, breddKol: 5, hojdRad: blockH });
  });
  // Jämförelsediagram: kunder per vecka för de tre grupperna, på en egen liten tabell under blocken.
  const jamfStart = veckoRader.length;
  veckoRader.push([{ fet: "Kunder per vecka – jämförelse" }], ["Vecka", "Dagar", "Sålda", "Scrive", "Summerat"],
    ...veckoLista.map(([, v], i): Cell[] => [`Vecka ${i + 1} (v. ${v.vecka})`, `${kortDatum(v.fran)} – ${kortDatum(v.till)}`,
      veckoBlock.Sålda[i][2], veckoBlock.Scrive[i][2], veckoBlock.Summerat[i][2]]),
    [],
    ["Veckorna är kalenderveckor (måndag–söndag) avgränsade till månaden. Sålda räknas på säljdatumet, Scrive på signeringsdatumet; Summerat på säljdatumet om kunden är Såld, annars signeringsdatumet."],
    ["Attach rate = andel bredbandskunder som köpt minst en tilläggstjänst (TV utöver Start/Bas, mobil, streaming, sport eller trygghet)."]);
  veckoDiagram.push(
    { typ: "stapel", titel: "Kunder per vecka – Sålda, Scrive och Summerat", katKol: 0, serier: [{ kol: 2 }, { kol: 3 }, { kol: 4 }],
      rubrikRad: jamfStart + 1, radFran: jamfStart + 2, radTill: jamfStart + 1 + nV, kol: 10, rad: jamfStart, breddKol: 5, hojdRad: nV + 10 },
    { typ: "linje", titel: "Summerat: snitt tjänster per kund per vecka", katKol: 0, serier: [{ kol: 5 }],
      rubrikRad: 2 * blockH + 1, radFran: 2 * blockH + 2, radTill: 2 * blockH + 1 + nV, kol: 15, rad: 0, breddKol: 4, hojdRad: 16 },
    { typ: "linje", titel: "Summerat: attach rate per vecka", katKol: 0, procent: true, serier: [{ kol: 6 }],
      rubrikRad: 2 * blockH + 1, radFran: 2 * blockH + 2, radTill: 2 * blockH + 1 + nV, kol: 15, rad: 17, breddKol: 4, hojdRad: 16 },
  );
  const veckoBlad: SkrivBlad = { namn: "Veckor", rader: veckoRader, rubrik: false, bredd: [26, 16, 14, 26, 16, 18, 12, 26, 10], diagram: veckoDiagram };

  // Säljare: egna affärer (affärer via kundtjänst på egen rad), månaden mot föregående, per grupp.
  const namnAv = (l: RapportLgh) => l.saljare ?? "Saknar säljare";
  const personer = [...new Set([...alla, ...allaForra].filter((l) => !via(l)).map(namnAv))].sort((a, b) => a.localeCompare(b, "sv"));
  const egna = (r: RapportLgh[], p: string) => r.filter((l) => namnAv(l) === p && !via(l));
  const saljRad = (namn: string, a: RapportLgh[], b: RapportLgh[]): Cell[] => {
    const A = nyckeltal(a), B = nyckeltal(b);
    return [namn, A.kunder, A.tjanster, A.bredband, snittC(A.snitt), procC(A.attach), { tal: A.pinnar, dec: 1 },
      B.kunder, B.tjanster, snittC(B.snitt), procC(B.attach),
      diffTal(A.kunder, B.kunder), diffTal(A.tjanster, B.tjanster), diffSnitt(A.snitt, B.snitt), diffPE(A.attach, B.attach)];
  };
  const SALJ_RUBRIK: Cell[] = ["Säljare", "Kunder", "Tjänster", "Bredband", "Snitt tjänster/kund", "Attach rate", "Pinnar",
    `Kunder ${fgManad}`, `Tjänster ${fgManad}`, `Snitt ${fgManad}`, `Attach rate ${fgManad}`,
    "Δ kunder", "Δ tjänster", "Δ snitt", "Δ attach rate (p.e.)"];
  const saljRader: Cell[][] = [];
  const saljDiagram: Diagram[] = [];
  const saljBlock: Record<string, Cell[][]> = {};
  for (const g of G) {
    const rader = personer.map((p) => saljRad(p, egna(g.nu, p), egna(g.forra, p)));
    saljBlock[g.namn] = rader;
    const ktNu = g.nu.filter(via), ktForra = g.forra.filter(via);
    const start = saljRader.length;
    saljRader.push([{ fet: `${g.namn} – ${g.text}` }], SALJ_RUBRIK, ...rader,
      ...(ktNu.length || ktForra.length ? [saljRad("Kundtjänst", ktNu, ktForra)] : []),
      saljRad(`Totalt ${g.namn}`, g.nu, g.forra), []);
    saljDiagram.push({ typ: "stapel", titel: `${g.namn}: kunder per säljare – månaden mot föregående`, katKol: 0,
      serier: [{ kol: 1 }, { kol: 7 }], rubrikRad: start + 1, radFran: start + 2, radTill: start + 1 + Math.max(1, rader.length),
      kol: 16, rad: start, breddKol: 6, hojdRad: rader.length + 5 });
  }
  saljRader.push(["Per säljare räknas säljarens egna affärer; affärer via kundtjänst ligger på raden Kundtjänst. Δ = månaden jämfört med föregående månad; attach rate i procentenheter."]);
  const saljBlad: SkrivBlad = { namn: "Säljare", rader: saljRader, rubrik: false, bredd: [26, 10, 10, 10, 18, 12, 10, 16, 16, 16, 18, 10, 10, 10, 20], diagram: saljDiagram };

  // Månadsrapport: nyckeltal mot föregående månad per grupp + veckotabell och säljare i kort form.
  const rad = (kpi: string, inneh: string, a: Cell, b: Cell, d: Cell, dp: Cell): Cell[] => [kpi, inneh, a, b, d, dp];
  const kpiBlock = (g: typeof G[number]): Cell[][] => {
    const N = nyckeltal(g.nu), F = nyckeltal(g.forra);
    return [
      [{ fet: `${g.namn} – ${g.text}` }],
      [{ fet: "KPI" }, { fet: "Innehåll" }, { fet: manadNamn(manad) }, { fet: manadNamn(fgManad) }, { fet: "Förändring" }, { fet: "Förändring %" }],
      rad("Total försäljning", "Totalt antal sålda tjänster (avtal)", N.tjanster, F.tjanster, diffTal(N.tjanster, F.tjanster), diffProc(N.tjanster, F.tjanster)),
      rad("Snitt", "Genomsnittligt antal tjänster per kund", snittC(N.snitt), snittC(F.snitt), diffSnitt(N.snitt, F.snitt), N.snitt != null && F.snitt ? { procent: (N.snitt - F.snitt) / F.snitt } : "–"),
      rad("Attach rate", "Andel bredbandskunder som köpt minst en tilläggstjänst (förändring i procentenheter)", procC(N.attach), procC(F.attach), diffPE(N.attach, F.attach), N.attach != null && F.attach ? { procent: (N.attach - F.attach) / F.attach } : "–"),
      rad("Antal bredband", "Kunder med bredbandsabonnemang", N.bredband, F.bredband, diffTal(N.bredband, F.bredband), diffProc(N.bredband, F.bredband)),
      rad("Antal kunder", g.namn === "Sålda" ? "Kunder med status Såld" : g.namn === "Scrive" ? "Kunder som signerat i Scrive" : "Sålda eller Scrive-signerade kunder", N.kunder, F.kunder, diffTal(N.kunder, F.kunder), diffProc(N.kunder, F.kunder)),
      rad("Bredbandskunder med tillägg", "Antal bredbandskunder som köpt minst en tilläggstjänst", N.tillagg, F.tillagg, diffTal(N.tillagg, F.tillagg), diffProc(N.tillagg, F.tillagg)),
      rad("Pinnar", "Före 80/20-delning med kundtjänst", { tal: N.pinnar, dec: 1 }, { tal: F.pinnar, dec: 1 }, { tal: N.pinnar - F.pinnar, dec: 1 }, diffProc(N.pinnar, F.pinnar)),
      [],
    ];
  };
  const sum: Cell[][] = [
    [{ fet: `Månadsrapport Door to door – ${manadNamn(manad)}` }],
    ["Period", `${fran} – ${till}`, "", "", "", ""],
    ["Jämförs med", manadNamn(fgManad)],
    ["Skapad", new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })],
    [],
    ...G.flatMap(kpiBlock),
    [{ fet: "Veckovis utveckling" }, "", "", "", "", ""],
    [{ fet: "Vecka" }, { fet: "Dagar" }, { fet: "Kunder Sålda" }, { fet: "Kunder Scrive" }, { fet: "Kunder Summerat" }, { fet: "Tjänster Summerat" }, { fet: "Snitt Summerat" }, { fet: "Attach rate Summerat" }],
  ];
  const veckoStart = sum.length;
  sum.push(...veckoLista.map(([, v], i): Cell[] => [`Vecka ${i + 1} (v. ${v.vecka})`, `${kortDatum(v.fran)} – ${kortDatum(v.till)}`,
    veckoBlock.Sålda[i][2], veckoBlock.Scrive[i][2], veckoBlock.Summerat[i][2], veckoBlock.Summerat[i][3], veckoBlock.Summerat[i][5], veckoBlock.Summerat[i][6]]));
  sum.push([],
    [{ fet: "Säljare" }, "", { fet: "Kunder Sålda" }, { fet: "Kunder Scrive" }, { fet: "Kunder Summerat" }, { fet: "Tjänster Summerat" }, { fet: "Snitt Summerat" }, { fet: "Attach rate Summerat" }],
    ...personer.map((p, i): Cell[] => [p, "", saljBlock.Sålda[i][1], saljBlock.Scrive[i][1], saljBlock.Summerat[i][1], saljBlock.Summerat[i][2], saljBlock.Summerat[i][4], saljBlock.Summerat[i][5]]),
    [],
    ["Sålda = status Såld med säljdatum i månaden. Scrive = signerade i månaden. Summerat = såld eller signerad, en kund räknas en gång. Diagrammen finns på bladen Veckor och Säljare; detaljer per kund på Sålda och Scrive."]);
  const sumBlad: SkrivBlad = {
    namn: "Månadsrapport", rader: sum, rubrik: false, bredd: [30, 52, 18, 18, 18, 18, 14, 20],
    diagram: [
      { typ: "stapel", titel: "Kunder per vecka – Sålda, Scrive och Summerat", katKol: 0, serier: [{ kol: 2 }, { kol: 3 }, { kol: 4 }],
        rubrikRad: veckoStart - 1, radFran: veckoStart, radTill: veckoStart + nV - 1, kol: 8, rad: 5, breddKol: 7, hojdRad: 18 },
    ],
  };
  return [sumBlad, veckoBlad, saljBlad];
}
