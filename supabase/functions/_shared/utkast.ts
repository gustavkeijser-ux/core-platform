// =====================================================================
//  Utkast av ett Scrive-avtal för säljaren. När ett dokument har startats
//  innehåller Scrives huvudfil redan alla ifyllda fält och kryss, så här
//  läggs bara en tydlig "UTKAST"-markering på varje sida.
// =====================================================================
import { PDFDocument, StandardFonts, rgb, degrees } from "npm:pdf-lib@1.17.1";

export async function skapaUtkast(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(pdfBytes);
  const fet = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const sida of pdf.getPages()) {
    const { width: W, height: H } = sida.getSize();
    sida.drawText("UTKAST", { x: W * 0.18, y: H * 0.3, size: W * 0.18, font: fet, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(40) });
    sida.drawText("UTKAST – förhandsgranskning, inte signerat", { x: 12, y: H - 11, size: 8, font: fet, color: rgb(0.75, 0.15, 0.15) });
  }
  return await pdf.save();
}
