// =====================================================================
//  Orderbekräftelse (D2D → Avtal) som PDF. Byggs av scrive-sign och
//  laddas upp i Scrive, som skickar den till kunden.
//  Innehåll: kunduppgifter, tjänster med kampanj- och ordinariepris,
//  engångskostnader, kampanjperiod, bindningstid och startdatum.
// =====================================================================
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";

export type OrderRad = { label: string; kampanj: number | null; ordinarie: number | null };
export type Order = {
  ordernummer: string;
  datum: string;                // ÅÅÅÅ-MM-DD
  kund: { namn: string; personnummer: string | null; epost: string | null; telefon: string | null };
  adress: { gata: string; lgh: string | null; postnummer: string | null; ort: string | null };
  manad: OrderRad[];
  engang: OrderRad[];
  totalKampanj: number;
  totalOrdinarie: number;
  kampanjManader: number;
  bindningManader: number;
  startdatum: string | null;
  leverantor: string;
  saljare: string | null;
  ovrigt: string | null;
};

// Standardtypsnitten klarar bara WinAnsi — byt ut annat mot närmaste tecken.
const ren = (s: string) => s
  .replace(/[\u2010-\u2012\u2212]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/\u00A0|\u202F/g, " ")
  .replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2022\u20AC]/g, "");
const kr = (n: number | null) => (n == null ? "–" : `${Math.round(n).toLocaleString("sv-SE").replace(/\s/g, " ")} kr`);
/** Personnummer visas med de fyra sista dolda. */
export const doljPnr = (s: string | null) => {
  const d = String(s ?? "").replace(/\D/g, "");
  if (d.length === 12) return `${d.slice(0, 8)}-****`;
  if (d.length === 10) return `${d.slice(0, 6)}-****`;
  return null;
};

const INK = rgb(0.11, 0.12, 0.15), MUTED = rgb(0.42, 0.44, 0.5), LINE = rgb(0.86, 0.87, 0.9), BRAND = rgb(0.13, 0.33, 0.8);

export async function skapaOrderPdf(o: Order): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(ren(`Orderbekräftelse ${o.ordernummer}`));
  pdf.setAuthor("ConnectEstate");
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const fb = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 50;
  let sida: PDFPage = pdf.addPage([W, H]);
  let y = H - M;

  const text = (s: string, x: number, yy: number, size = 10, font: PDFFont = f, color = INK) =>
    sida.drawText(ren(s), { x, y: yy, size, font, color });
  const hoger = (s: string, xr: number, yy: number, size = 10, font: PDFFont = f, color = INK) =>
    text(s, xr - font.widthOfTextAtSize(ren(s), size), yy, size, font, color);
  const linje = (yy: number) => sida.drawLine({ start: { x: M, y: yy }, end: { x: W - M, y: yy }, thickness: 0.7, color: LINE });
  const plats = (h: number) => { if (y - h < 48) { sida = pdf.addPage([W, H]); y = H - M; } };
  const radbryt = (s: string, bredd: number, size: number, font: PDFFont = f): string[] => {
    const ut: string[] = [];
    for (const stycke of ren(s).split(/\n/)) {
      let rad = "";
      for (const ord of stycke.split(/\s+/)) {
        const prov = rad ? `${rad} ${ord}` : ord;
        if (font.widthOfTextAtSize(prov, size) > bredd && rad) { ut.push(rad); rad = ord; } else rad = prov;
      }
      ut.push(rad);
    }
    return ut;
  };
  const rubrik = (s: string) => { plats(60); y -= 22; text(s.toUpperCase(), M, y, 9, fb, MUTED); y -= 8; linje(y); y -= 4; };

  // Huvud
  text("ConnectEstate", M, y - 4, 13, fb, BRAND);
  hoger(`Ordernummer ${o.ordernummer}`, W - M, y - 4, 9, f, MUTED);
  hoger(`Datum ${o.datum}`, W - M, y - 17, 9, f, MUTED);
  y -= 52;
  text("Orderbekräftelse", M, y, 24, fb);
  y -= 22;
  for (const r of radbryt(`Tack för din beställning! Här är en sammanställning av tjänsterna du har beställt via ConnectEstate. Tjänsterna levereras av ${o.leverantor}.`, W - 2 * M, 10.5)) {
    text(r, M, y, 10.5, f, MUTED); y -= 15;
  }

  // Kund och adress i två spalter
  rubrik("Kunduppgifter");
  const v = [
    ["Namn", o.kund.namn], ["Personnummer", doljPnr(o.kund.personnummer)], ["E-post", o.kund.epost], ["Telefon", o.kund.telefon],
  ].filter((x) => x[1]) as string[][];
  const h = [
    ["Adress", o.adress.gata], ["Lägenhet", o.adress.lgh], ["Postadress", [o.adress.postnummer, o.adress.ort].filter(Boolean).join(" ")],
  ].filter((x) => x[1]) as string[][];
  const mitt = M + (W - 2 * M) / 2;
  let yv = y - 14, yh = y - 14;
  for (const [k, val] of v) { text(k, M, yv, 8.5, f, MUTED); text(val, M, yv - 12, 10.5); yv -= 28; }
  for (const [k, val] of h) { text(k, mitt, yh, 8.5, f, MUTED); text(val, mitt, yh - 12, 10.5); yh -= 28; }
  y = Math.min(yv, yh) + 8;

  // Tjänster
  const kolK = W - M - 110, kolO = W - M;
  const tabell = (titel: string, rader: OrderRad[], kampanjRubrik: string, ordRubrik: string) => {
    rubrik(titel);
    y -= 14;
    text("Tjänst", M, y, 8.5, fb, MUTED); hoger(kampanjRubrik, kolK, y, 8.5, fb, MUTED); hoger(ordRubrik, kolO, y, 8.5, fb, MUTED);
    y -= 8;
    for (const r of rader) {
      const ln = radbryt(r.label, kolK - M - 110, 10.5);
      plats(ln.length * 14 + 10);
      y -= 15;
      ln.forEach((l, i) => text(l, M, y - i * 13, 10.5));
      hoger(kr(r.kampanj), kolK, y, 10.5);
      hoger(kr(r.ordinarie), kolO, y, 10.5, f, MUTED);
      y -= (ln.length - 1) * 13 + 7;
      linje(y);
    }
  };
  tabell("Månadskostnad", o.manad, `Kampanjpris/mån`, "Ordinarie/mån");
  plats(30);
  y -= 18;
  text("Totalt per månad", M, y, 11, fb);
  hoger(kr(o.totalKampanj), kolK, y, 11, fb);
  hoger(kr(o.totalOrdinarie), kolO, y, 11, fb, MUTED);
  y -= 8;
  if (o.engang.length) {
    tabell("Engångskostnader", o.engang, "Pris", "Ordinarie");
  }

  // Villkor
  rubrik("Avtalsvillkor");
  const villkor: string[][] = [
    ["Bindningstid", `${o.bindningManader} månader`],
    ["Kampanjperiod", `${o.kampanjManader} månader, därefter ordinarie pris`],
    ["Startdatum", o.startdatum ?? "Meddelas när leveransen är klar"],
    ["Leverantör", o.leverantor],
  ];
  if (o.saljare) villkor.push(["Din säljare", o.saljare]);
  for (const [k, val] of villkor) {
    plats(18); y -= 16;
    text(k, M, y, 10, f, MUTED); text(val, M + 130, y, 10.5);
  }
  if (o.ovrigt) {
    rubrik("Övrigt");
    for (const r of radbryt(o.ovrigt, W - 2 * M, 10.5)) { plats(15); y -= 15; text(r, M, y, 10.5); }
  }
  plats(40);
  y -= 24;
  for (const r of radbryt("Kontrollera gärna att uppgifterna stämmer. Om något är fel eller om du har frågor om din beställning, kontakta ConnectEstate.", W - 2 * M, 9.5)) {
    text(r, M, y, 9.5, f, MUTED); y -= 13;
  }

  // Sidfot
  const sidor = pdf.getPages();
  sidor.forEach((s, i) => {
    const t = ren(`ConnectEstate · Orderbekräftelse ${o.ordernummer} · Sida ${i + 1} av ${sidor.length}`);
    s.drawText(t, { x: M, y: 28, size: 8, font: f, color: MUTED });
  });
  return await pdf.save();
}
