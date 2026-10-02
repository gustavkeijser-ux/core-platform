/* =============================================================================
   Minimal .xlsx-skrivare (ett blad, text och tal, fet rubrikrad).
   Ingen extern lib: filerna packas i en okomprimerad zip ("stored").
   ========================================================================== */

const enc = new TextEncoder();

let crcTabell: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!crcTabell) {
    crcTabell = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTabell[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTabell[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(filer: Array<{ namn: string; data: Uint8Array }>): Blob {
  const delar: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of filer) {
    const namn = enc.encode(f.namn);
    const crc = crc32(f.data);
    const lokal = new DataView(new ArrayBuffer(30));
    lokal.setUint32(0, 0x04034b50, true); lokal.setUint16(4, 20, true); lokal.setUint16(6, 0x0800, true);
    lokal.setUint16(8, 0, true); lokal.setUint32(14, crc, true);
    lokal.setUint32(18, f.data.length, true); lokal.setUint32(22, f.data.length, true);
    lokal.setUint16(26, namn.length, true);
    delar.push(new Uint8Array(lokal.buffer), namn, f.data);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, namn.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), namn);
    offset += 30 + namn.length + f.data.length;
  }
  const centralStorlek = central.reduce((s, b) => s + b.length, 0);
  const slut = new DataView(new ArrayBuffer(22));
  slut.setUint32(0, 0x06054b50, true); slut.setUint16(8, filer.length, true); slut.setUint16(10, filer.length, true);
  slut.setUint32(12, centralStorlek, true); slut.setUint32(16, offset, true);
  return new Blob([...delar, ...central, new Uint8Array(slut.buffer)] as BlobPart[],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const kol = (i: number) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** Rader → .xlsx. Första raden blir fet rubrikrad och låses vid skroll. */
export function skrivXlsx(rader: Array<Array<string | number | null | undefined>>, bladnamn = "Blad1", bredder?: number[]): Blob {
  const rows = rader.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
    const ref = `${kol(ci)}${ri + 1}`;
    const s = ri === 0 ? ' s="1"' : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    const t = v == null ? "" : String(v);
    return t === "" ? `<c r="${ref}"${s}/>` : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(t)}</t></is></c>`;
  }).join("") + "</row>").join("");
  const cols = bredder?.length
    ? `<cols>${bredder.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
  const filer = [
    { namn: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { namn: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { namn: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(bladnamn.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { namn: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { namn: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { namn: "xl/worksheets/sheet1.xml", data: sheet },
  ].map((f) => ({ namn: f.namn, data: enc.encode(f.data) }));
  return zip(filer);
}

export function laddaNer(namn: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = namn;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
