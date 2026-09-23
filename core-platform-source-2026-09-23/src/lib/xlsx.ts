/**
 * Minimal xlsx-läsare.
 *
 * Läser en .xlsx rakt i webbläsaren utan externt bibliotek. En xlsx är en
 * zip med XML, och vi behöver bara tre delar: bladlistan, de delade
 * strängarna och själva cellerna. DecompressionStream finns i alla moderna
 * webbläsare, så uppackningen kostar ingenting extra.
 *
 * Datumceller lagras som tal i Excel. Vi tittar på cellformatet för att
 * avgöra om ett tal ska tolkas som datum, och skriver då ut ISO-format —
 * annars hade "2026-08-14" kommit in som 46248.
 */

export type Blad = { namn: string; rader: string[][] };

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");
}

function kolumnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function serieTillDatum(n: number): string {
  // Excels epok är 1899-12-30 (skottdagsbuggen från Lotus 1-2-3 inräknad)
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000)
    .toISOString().slice(0, 10);
}

/** Packar upp en zip och ger en läsfunktion per filnamn. */
async function oppnaZip(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const dec = new TextDecoder();

  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Filen ser inte ut som en xlsx.");

  const cdOff = dv.getUint32(eocd + 16, true);
  const cdCount = dv.getUint16(eocd + 10, true);
  const poster: Record<string, { method: number; csize: number; lho: number }> = {};
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    poster[dec.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, lho };
    p += 46 + nlen + elen + clen;
  }

  return async (namn: string): Promise<string> => {
    const e = poster[namn];
    if (!e) throw new Error(`Saknar ${namn} i filen.`);
    const nlen = dv.getUint16(e.lho + 26, true);
    const elen = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + nlen + elen;
    const rå = u8.subarray(start, start + e.csize);
    if (e.method === 0) return dec.decode(rå);
    return await new Response(
      new Blob([rå]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    ).text();
  };
}

/** Läser ett namngivet blad, eller det första om inget namn anges. */
export async function lasXlsx(fil: File, bladNamn?: string): Promise<Blad> {
  const las = await oppnaZip(await fil.arrayBuffer());

  // Delade strängar
  let sst: string[] = [];
  try {
    const xml = await las("xl/sharedStrings.xml");
    sst = Array.from(xml.matchAll(/<si>([\s\S]*?)<\/si>/g)).map((m) => {
      let s = "";
      for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
      return unesc(s);
    });
  } catch { /* arbetsbok utan delade strängar */ }

  // Vilka cellformat som är datum
  const arDatum: boolean[] = [];
  try {
    const st = await las("xl/styles.xml");
    const egna: Record<string, string> = {};
    for (const m of st.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
      egna[m[1]] = m[2];
    }
    const xfs = (st.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [""])[0];
    for (const m of xfs.matchAll(/<xf[^>]*numFmtId="(\d+)"/g)) {
      const id = +m[1];
      arDatum.push((id >= 14 && id <= 22) || /yy/i.test(egna[m[1]] || ""));
    }
  } catch { /* inga format */ }

  // Bladlista
  const wb = await las("xl/workbook.xml");
  const rels = await las("xl/_rels/workbook.xml.rels");
  const relMap: Record<string, string> = {};
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap[m[1]] = m[2];
  }
  const blad: Array<{ namn: string; path: string }> = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    blad.push({
      namn: unesc(m[1]),
      path: "xl/" + relMap[m[2]].replace(/^\/?(xl\/)?/, ""),
    });
  }
  if (blad.length === 0) throw new Error("Hittade inga blad i filen.");

  const valt = bladNamn
    ? blad.find((b) => b.namn.toLowerCase() === bladNamn.toLowerCase())
    : blad[0];
  if (!valt) {
    throw new Error(
      `Bladet "${bladNamn}" finns inte. Bladen i filen: ${blad.map((b) => b.namn).join(", ")}`
    );
  }

  // Celler
  const xml = await las(valt.path);
  const rader: string[][] = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rad: string[] = [];
    for (const cm of rm[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attr = cm[1], kropp = cm[2];
      const ref = (attr.match(/r="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const t = (attr.match(/t="([^"]+)"/) || [])[1] || "n";
      const s = (attr.match(/ s="(\d+)"/) || [])[1];
      const v = (kropp.match(/<v>([\s\S]*?)<\/v>/) || [])[1];

      let värde: string | null = null;
      if (t === "s") {
        värde = v != null ? (sst[+v] ?? null) : null;
      } else if (t === "inlineStr") {
        let x = "";
        for (const tt of kropp.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) x += tt[1];
        värde = unesc(x);
      } else if (t === "str" || t === "e" || t === "b") {
        värde = v != null ? unesc(v) : null;
      } else if (v != null) {
        const tal = parseFloat(v);
        värde = (s != null && arDatum[+s] && tal > 20000 && tal < 80000)
          ? serieTillDatum(tal) : v;
      }
      if (värde !== null && värde !== "") rad[kolumnIndex(ref)] = värde;
    }
    rader[+rm[1] - 1] = rad;
  }

  return { namn: valt.namn, rader };
}

/** Alla bladnamn i filen, för att kunna välja rätt flik. */
export async function bladnamn(fil: File): Promise<string[]> {
  const las = await oppnaZip(await fil.arrayBuffer());
  const wb = await las("xl/workbook.xml");
  return Array.from(wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)).map((m) => unesc(m[1]));
}

/** Gör rader till objekt med rubrikraden som nycklar. Tomma värden utelämnas. */
export function tillObjekt(rader: string[][], rubrikrad = 0): Record<string, string>[] {
  const rubriker = (rader[rubrikrad] || []).map((h) => String(h ?? "").trim());
  const ut: Record<string, string>[] = [];
  for (let i = rubrikrad + 1; i < rader.length; i++) {
    const r = rader[i];
    if (!r) continue;
    const o: Record<string, string> = {};
    for (let c = 0; c < rubriker.length; c++) {
      const h = rubriker[c];
      if (!h) continue;
      const v = r[c];
      if (v === undefined || v === null || String(v).trim() === "") continue;
      o[h] = String(v).trim();
    }
    if (Object.keys(o).length > 0) ut.push(o);
  }
  return ut;
}
