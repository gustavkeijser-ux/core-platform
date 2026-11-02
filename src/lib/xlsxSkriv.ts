/**
 * Minimal xlsx-skrivare (motsvarigheten till lib/xlsx.ts som läser).
 *
 * Bygger en .xlsx i webbläsaren utan externt bibliotek: en zip (okomprimerad,
 * "stored") med några små XML-filer. Räcker för rapporter: flera blad, fet
 * rubrikrad med filter och fryst översta rad, tal, procent, kolumnbredder och
 * enkla stapel-/linjediagram (`diagram` på bladet) som Excel ritar från cellerna.
 *
 *   const blob = skrivXlsx([{ namn: "Sålda", rader: [["Adress", "Antal"], ["Storgatan 1", 3]] }]);
 */

/** Ett cellvärde. Procent anges som { procent: 0.42 } (visas 42 %), decimaltal som { tal, dec }. */
export type Cell = string | number | null | undefined | { procent: number } | { tal: number; dec: number } | { fet: string };

/**
 * Ett diagram på bladet. Kategorierna (x-axeln) och varje serie pekar på kolumner i
 * bladets egna rader (0-baserade index): kategorierna i kolumn `katKol`, serierna i
 * `serier[].kol`, raderna `radFran`–`radTill` (inklusive, 0-baserade). Rubriken för
 * en serie tas från raden `rubrikRad` (standard: raden före `radFran`).
 * Placeras med övre vänstra hörnet i cellen (`kol`, `rad`) och storlek i celler.
 */
export type Diagram = {
  typ: "stapel" | "linje";
  titel: string;
  katKol: number;
  serier: Array<{ kol: number; namn?: string }>;
  radFran: number;
  radTill: number;
  rubrikRad?: number;
  /** Visas värdena som procent (t.ex. attach rate)? Serierna måste då vara { procent }. */
  procent?: boolean;
  /** Placering: cell (kolumn, rad) 0-baserat, och storlek i antal kolumner och rader. */
  kol: number;
  rad: number;
  breddKol?: number;
  hojdRad?: number;
};

export type SkrivBlad = {
  namn: string;
  rader: Cell[][];
  /** Kolumnbredder i tecken. Saknas → räknas fram från innehållet. */
  bredd?: number[];
  /** Första raden är rubrikrad (fet, fryst, filter). Standard: true. */
  rubrik?: boolean;
  /** Diagram som ritas på bladet (utifrån bladets egna celler). */
  diagram?: Diagram[];
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
   // tecken som inte är tillåtna i XML 1.0
   .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

function kolumn(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Stilar i styles.xml: 0 normal, 1 rubrik, 2 procent, 3 två decimaler, 4 fet text, 5 en decimal. */
function cellXml(ref: string, v: Cell, rubrik: boolean): string {
  if (v == null || v === "") return "";
  if (typeof v === "number") {
    return Number.isFinite(v) ? `<c r="${ref}"${rubrik ? ' s="1"' : ""}><v>${v}</v></c>` : "";
  }
  if (typeof v === "object" && "procent" in v) {
    return Number.isFinite(v.procent) ? `<c r="${ref}" s="2"><v>${v.procent}</v></c>` : "";
  }
  if (typeof v === "object" && "tal" in v) {
    return Number.isFinite(v.tal) ? `<c r="${ref}" s="${v.dec === 1 ? 5 : 3}"><v>${v.tal}</v></c>` : "";
  }
  const text = typeof v === "object" ? v.fet : v;
  const stil = rubrik ? ' s="1"' : typeof v === "object" ? ' s="4"' : "";
  return `<c r="${ref}" t="inlineStr"${stil}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function textLangd(v: Cell): number {
  if (v == null) return 0;
  if (typeof v === "number") return String(v).length;
  if (typeof v === "object") return "fet" in v ? v.fet.length : 6;
  return Math.max(...v.split("\n").map((r) => r.length));
}

function bladXml(b: SkrivBlad): string {
  const rubrik = b.rubrik !== false;
  const antalKol = Math.max(1, ...b.rader.map((r) => r.length));
  const bredd = b.bredd ?? Array.from({ length: antalKol }, (_, k) =>
    Math.min(60, Math.max(8, ...b.rader.slice(0, 500).map((r) => textLangd(r[k]) + 2))));
  const cols = bredd.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join("");
  const rader = b.rader.map((r, i) =>
    `<row r="${i + 1}">${r.map((v, k) => cellXml(`${kolumn(k)}${i + 1}`, v, rubrik && i === 0)).join("")}</row>`).join("");
  const frys = rubrik && b.rader.length > 1
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const filter = rubrik && b.rader.length > 1 ? `<autoFilter ref="A1:${kolumn(antalKol - 1)}${b.rader.length}"/>` : "";
  const ritning = b.diagram?.length ? `<drawing r:id="rId1"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${frys}<cols>${cols}</cols><sheetData>${rader}</sheetData>${filter}${ritning}</worksheet>`;
}

// ── Diagram ──────────────────────────────────────────────────────────────────
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** Seriefärger (ritas av Excel; filen har inga egna teman). */
const SERIE_FARG = ["2F5597", "C55A11", "548235", "7F6000", "7030A0", "2E75B6"];

const cellTal = (v: Cell): number | null => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") { if ("procent" in v) return v.procent; if ("tal" in v) return v.tal; }
  return null;
};
const cellText = (v: Cell): string =>
  v == null ? "" : typeof v === "object" ? ("fet" in v ? v.fet : String(cellTal(v) ?? "")) : String(v);

/** chartN.xml: ett stapel- eller linjediagram med serier från bladets celler (referenser + cache). */
function diagramXml(d: Diagram, bladnamn: string, rader: Cell[][]): string {
  const ref = (kol: number, r1: number, r2: number) =>
    `'${bladnamn.replace(/'/g, "''")}'!$${kolumn(kol)}$${r1 + 1}:$${kolumn(kol)}$${r2 + 1}`;
  const cell = (kol: number, rad: number) => `'${bladnamn.replace(/'/g, "''")}'!$${kolumn(kol)}$${rad + 1}`;
  const rubrikRad = d.rubrikRad ?? d.radFran - 1;
  const n = d.radTill - d.radFran + 1;
  const pt = (i: number, v: string) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`;
  const katCache = Array.from({ length: n }, (_, i) => pt(i, cellText(rader[d.radFran + i]?.[d.katKol]))).join("");
  const fmt = d.procent ? "0%" : "General";
  const serier = d.serier.map((s, si) => {
    const namn = s.namn ?? cellText(rader[rubrikRad]?.[s.kol]);
    const tx = s.namn || rubrikRad < 0
      ? `<c:tx><c:v>${esc(namn)}</c:v></c:tx>`
      : `<c:tx><c:strRef><c:f>${esc(cell(s.kol, rubrikRad))}</c:f><c:strCache><c:ptCount val="1"/>${pt(0, namn)}</c:strCache></c:strRef></c:tx>`;
    const vals = Array.from({ length: n }, (_, i) => cellTal(rader[d.radFran + i]?.[s.kol]))
      .map((v, i) => (v == null || !Number.isFinite(v) ? "" : pt(i, String(v)))).join("");
    const farg = SERIE_FARG[si % SERIE_FARG.length];
    const utseende = d.typ === "stapel"
      ? `<c:spPr><a:solidFill><a:srgbClr val="${farg}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`
      : `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${farg}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${farg}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="${farg}"/></a:solidFill></a:ln></c:spPr></c:marker>`;
    return `<c:ser><c:idx val="${si}"/><c:order val="${si}"/>${tx}${utseende}` +
      `<c:cat><c:strRef><c:f>${esc(ref(d.katKol, d.radFran, d.radTill))}</c:f><c:strCache><c:ptCount val="${n}"/>${katCache}</c:strCache></c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>${esc(ref(s.kol, d.radFran, d.radTill))}</c:f><c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${n}"/>${vals}</c:numCache></c:numRef></c:val>` +
      (d.typ === "linje" ? `<c:smooth val="0"/>` : "") + `</c:ser>`;
  }).join("");
  const typXml = d.typ === "stapel"
    ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${serier}<c:gapWidth val="150"/><c:axId val="10"/><c:axId val="20"/></c:barChart>`
    : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${serier}<c:marker val="1"/><c:axId val="10"/><c:axId val="20"/></c:lineChart>`;
  const axText = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="sv-SE"/></a:p></c:txPr>`;
  const katAx = `<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axText}<c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const valAx = `<c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/>${d.procent ? `<c:min val="0"/>` : ""}</c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${fmt}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axText}<c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="${d.typ === "stapel" ? "between" : "midCat"}"/></c:valAx>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>` +
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="sv-SE" sz="1200" b="1"/><a:t>${esc(d.titel)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` +
    `<c:plotArea><c:layout/>${typXml}${katAx}${valAx}</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${axText}</c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:chartSpace>`;
}

/** drawingN.xml: ett ankare per diagram på bladet; rId1… pekar på diagrammen i bladets ritningsrelationer. */
function ritningXml(diagram: Diagram[]): string {
  const ankare = diagram.map((d, i) => {
    const bk = d.breddKol ?? 8, hr = d.hojdRad ?? 16;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${d.kol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${d.rad}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>${d.kol + bk}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${d.rad + hr}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Diagram ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">${ankare}</xdr:wsDr>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ── zip (stored) ─────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(filer: Array<[string, string]>): Blob {
  const enc = new TextEncoder();
  const delar: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let off = 0;
  for (const [namn, text] of filer) {
    const n = enc.encode(namn) as Uint8Array<ArrayBuffer>, d = enc.encode(text) as Uint8Array<ArrayBuffer>, crc = crc32(d);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, d.length, true); lh.setUint32(22, d.length, true); lh.setUint16(26, n.length, true);
    delar.push(new Uint8Array(lh.buffer), n, d);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, d.length, true); ch.setUint32(24, d.length, true);
    ch.setUint16(28, n.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), n);
    off += 30 + n.length + d.length;
  }
  const cdLen = central.reduce((s, b) => s + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, filer.length, true); eocd.setUint16(10, filer.length, true);
  eocd.setUint32(12, cdLen, true); eocd.setUint32(16, off, true);
  return new Blob([...delar, ...central, new Uint8Array(eocd.buffer)],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** Bladnamn: max 31 tecken, inga \ / ? * [ ] :, unika. */
function bladNamn(namn: string[], ): string[] {
  const sedda = new Set<string>();
  return namn.map((n) => {
    let s = n.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Blad";
    for (let i = 2; sedda.has(s.toLowerCase()); i++) s = `${s.slice(0, 28)} ${i}`;
    sedda.add(s.toLowerCase());
    return s;
  });
}

export function skrivXlsx(blad: SkrivBlad[]): Blob {
  const namn = bladNamn(blad.map((b) => b.namn));
  // Ritningar och diagram: bladet i → drawing{i+1}.xml, diagrammen numreras löpande över hela boken.
  const ritningar: Array<[string, string]> = [];
  const typerExtra: string[] = [];
  let diagramNr = 0;
  blad.forEach((b, i) => {
    if (!b.diagram?.length) return;
    const dn = i + 1;
    ritningar.push([`xl/worksheets/_rels/sheet${dn}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${dn}.xml"/></Relationships>`]);
    ritningar.push([`xl/drawings/drawing${dn}.xml`, ritningXml(b.diagram)]);
    typerExtra.push(`<Override PartName="/xl/drawings/drawing${dn}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    const rels = b.diagram.map((d, k) => {
      const nr = ++diagramNr;
      ritningar.push([`xl/charts/chart${nr}.xml`, diagramXml(d, namn[i], b.rader)]);
      typerExtra.push(`<Override PartName="/xl/charts/chart${nr}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      return `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${nr}.xml"/>`;
    }).join("");
    ritningar.push([`xl/drawings/_rels/drawing${dn}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`]);
  });
  const filer: Array<[string, string]> = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
      blad.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${typerExtra.join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      namn.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${
      blad.some((b) => b.rubrik !== false && b.rader.length > 1)
        ? `<definedNames>${blad.map((b, i) => b.rubrik !== false && b.rader.length > 1
            ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(namn[i]).replace(/'/g, "''")}'!$A$1:$${kolumn(Math.max(1, ...b.rader.map((r) => r.length)) - 1)}$${b.rader.length}</definedName>` : "").join("")}</definedNames>`
        : ""}</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      blad.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    }<Relationship Id="rId${blad.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ...blad.map((b, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, bladXml(b)]),
    ...ritningar,
  ];
  return zip(filer);
}

/** Laddar ned en blob som fil. */
export function laddaNed(blob: Blob, filnamn: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filnamn;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
