/**
 * Telefonnummer — samma regler som leaddesk_telefon_norm() i databasen,
 * så att det klienten skickar till LeadDesk och det servern matchar på är lika.
 *
 *   "070-123 45 67"        → "+46701234567"  (standardland SE)
 *   "0046 70 123 45 67"    → "+46701234567"
 *   "+46 (0)70 123 45 67"  → "+46701234567"
 *   "123"                  → null (färre än 5 siffror)
 */
const LANDSPREFIX: Record<string, string> = { SE: "46", FI: "358", NO: "47", DK: "45", DE: "49", GB: "44" };

export function normaliseraTelefon(v: unknown, land = "SE"): string | null {
  if (v === null || v === undefined) return null;
  const pre = LANDSPREFIX[land.toUpperCase()] ?? null;
  let s = String(v).replace(/\(0\)/g, "").replace(/[^0-9+]/g, "");
  s = s.replace(/(?!^)\+/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+") && s.startsWith("0") && pre) s = "+" + pre + s.slice(1);
  if (!s.startsWith("+") && pre && s.startsWith(pre) && s.length >= pre.length + 7) s = "+" + s;
  if (s.replace(/\D/g, "").length < 5) return null;
  return s;
}

/** "+46701234567" → "070-123 45 67" för svenska mobilnummer, annars oförändrat. */
export function visaTelefon(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+46(7\d)(\d{3})(\d{2})(\d{2})$/.exec(e164);
  return m ? `0${m[1]}-${m[2]} ${m[3]} ${m[4]}` : e164;
}
