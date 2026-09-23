/**
 * Hjälpfunktioner för att härleda varumärkesfärgens accentnyanser
 * (hover, mjuk bakgrundston, skugga, glöd i hörnet) från en enda hex-
 * färg som admin väljer i Inställningar → Utseende. Ett ställe för den
 * här logiken — både Sidebar.tsx och App.tsx (för de globala --brand-*-
 * tokens) ska referera hit, inte räkna själva.
 */

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Mörk eller ljus text/ikonfärg mot en given hex-bakgrund, så en
 *  godtycklig varumärkesfärg alltid ger läsbar kontrast. */
export function inkFor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#ffffff";
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#ffffff";
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Lite ljusare/mörkare variant av färgen för hover-state — samma roll
 *  som violet-500 → violet-400 i standardpaletten. Blandar mot vitt i
 *  mörkt läge (ljusare hover, som originalpaletten) och mot svart i
 *  ljust läge (mörkare hover, bättre kontrast mot ljus botten). */
function hoverShade(rgb: { r: number; g: number; b: number }, lightTheme: boolean): string {
  const target = lightTheme ? 0 : 255;
  const t = 0.18;
  const r = mix(rgb.r, target, t), g = mix(rgb.g, target, t), b = mix(rgb.b, target, t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Alla CSS-variabler som --brand-familjen och --canvas-glow (glöden i
 * sidans övre hörn) består av, härledda från en enda hex-färg. Sprids
 * som inline style på .app-shell, vilket gör att den ärvs av allt under
 * den — inklusive ::before-glöden — utan att röra document.documentElement
 * (LoginPage, som renderas innan branding är inläst, ska inte påverkas).
 */
export function brandCssVars(hex: string, lightTheme: boolean): Record<string, string> | undefined {
  const rgb = hexToRgb(hex);
  if (!rgb) return undefined;
  const { r, g, b } = rgb;
  const glowAlpha = lightTheme ? 0.14 : 0.3;
  return {
    "--brand": hex,
    "--brand-hover": hoverShade(rgb, lightTheme),
    "--brand-soft": `rgba(${r}, ${g}, ${b}, .16)`,
    "--brand-on": inkFor(hex),
    "--shadow-brand": `0 6px 20px rgba(${r}, ${g}, ${b}, .38)`,
    "--canvas-glow": `radial-gradient(46% 38% at 82% 6%, rgba(${r}, ${g}, ${b}, ${glowAlpha}), transparent 70%)`,
  };
}
