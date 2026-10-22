import { useEffect, useState } from "react";
import { mobilEnheter, antalExtra, EXTRA_VAL } from "@/lib/d2dPris";

/**
 * Mobilabonnemang i D2D-vyn: hur kundens nummer ska hanteras.
 *
 *   A. Befintligt nummer porteras direkt     → mobil_nummerval = portera_direkt
 *   B. Slumpat nummer
 *        – Tillfälligt (ersätts med befintligt) → tillfalligt  (kräver uppgifter)
 *        – Nytt nummer (behålls)                → nytt_nummer
 *
 * Vid "tillfalligt" är startdatum, kundens befintliga nummer och vem som
 * står på det obligatoriska (för huvudnumret och ev. extraanvändare). Det
 * tillfälliga/slumpade numret fylls inte i av säljaren (borttaget okt 2026 —
 * fältet finns kvar i datan för äldre poster). När allt är ifyllt skapar servern automatiskt ett
 * nummerbytesärende + en admin-uppgift (se migration 0029). Startdatum
 * låses för säljaren när ärendet finns — bara admin kan ändra det.
 *
 * Flera abonnemang (t.ex. 2 × 10 GB, okt 2026): en huvudrad per abonnemang
 * (typ "huvud", abonnemang = sorten), så att varje abonnemang får sitt eget
 * nummer att flytta. Raderna följer antalet under Mobil; ifyllda rader tas
 * aldrig bort automatiskt.
 */

export type NummerRad = { typ: "huvud" | "extra"; tillfalligt?: string; riktigt: string; agare: string; abonnemang?: string };

type Props = {
  lagenhetId: string;
  data: Record<string, unknown>;
  isAdmin: boolean;
  /** Spara ändringar (patch av lägenhetens fält). delayMs = debounce vid inmatning. */
  onPatch: (patch: Record<string, unknown>, delayMs: number) => void;
  /** Visningsnamn för ett abonnemang ("10_gb" → "10 GB"). */
  planLabel?: (key: string) => string;
  /** Visas överst när säljaren försökt lämna kundkortet med uppgifter som saknas. */
  lamnaFel?: string | null;
};

const TOM_RAD = (typ: NummerRad["typ"]): NummerRad => ({ typ, riktigt: "", agare: "" });

function rader(data: Record<string, unknown>): NummerRad[] {
  const v = data.mobil_nummer as { rows?: unknown } | null | undefined;
  const rows = Array.isArray(v?.rows) ? (v!.rows as NummerRad[]) : [];
  return [...rows.filter((r) => r.typ === "huvud"), ...rows.filter((r) => r.typ === "extra")];
}

const ifylld = (r: NummerRad) => !!(r.riktigt?.trim() || r.agare?.trim());

/** En huvudrad per sålt abonnemang (minst en) + extrarader. Ifyllda rader
 *  utöver antalet abonnemang ligger kvar tills säljaren tar bort dem. */
function justera(rows: NummerRad[], enheter: string[], antalExtraRader: number): NummerRad[] {
  const huvud = rows.filter((r) => r.typ === "huvud");
  const extra = [...rows.filter((r) => r.typ === "extra")];
  while (extra.length < antalExtraRader) extra.push(TOM_RAD("extra"));
  const n = Math.max(1, enheter.length);
  const ut: NummerRad[] = [];
  for (let i = 0; i < Math.max(n, huvud.length); i++) {
    const r = huvud[i] ?? TOM_RAD("huvud");
    if (i >= n && !ifylld(r)) continue;
    ut.push({ ...r, typ: "huvud", ...(enheter[i] ? { abonnemang: enheter[i] } : {}) });
  }
  return [...ut, ...extra];
}

/**
 * Vad som saknas i nummerhanteringen för att säljaren ska få lämna kundkortet
 * (null = inget saknas). Gäller när Mobil = Ja: abonnemang måste väljas, valet av nummer måste
 * vara gjort, och vid tillfälligt (slumpat) nummer krävs startdatum samt
 * riktigt nummer och ägare på varje rad — annars skapas inget nummerbyte.
 * Vid tillfälligt nummer (nummerbyte) är kundens personnummer obligatoriskt
 * (10 eller 12 siffror). Porteras direkt kräver inget personnummer.
 */
export function pnrGiltigt(v: unknown): boolean {
  const n = String(v ?? "").replace(/\D/g, "").length;
  return n === 10 || n === 12;
}

export function mobilNummerBrist(data: Record<string, unknown>): string | null {
  const mobil = Array.isArray(data.salt_mobil) ? (data.salt_mobil as unknown[]).map(String) : [];
  const svar = data.salt_svar as Record<string, unknown> | null | undefined;
  if (svar?.salt_mobil === false) return null; // Mobil = Nej
  // Mobil = Ja: abonnemang måste väljas, sedan nummerhanteringen nedan.
  if (!mobil.length) return svar?.salt_mobil === true ? "Välj vilket mobilabonnemang kunden köper (under Mobil)." : null;
  const val = (data.mobil_nummerval as string | null) ?? "";
  if (!val) return "Välj hur kundens mobilnummer ska hanteras (under Mobil).";
  const pnrSaknas = val === "tillfalligt" && !pnrGiltigt(data.personnummer);
  const pnrText = "Fyll i kundens personnummer (10 eller 12 siffror) för nummerporteringen.";
  if (val !== "tillfalligt" || data.mobil_nummerbyte_id) return pnrSaknas ? pnrText : null;
  const rows = justera(rader(data), mobilEnheter(data), mobil.includes(EXTRA_VAL) ? antalExtra(data) : 0);
  const start = (data.mobil_startdatum as string | null) ?? "";
  const nummerSaknas = rows.some((r) => !r.riktigt?.trim() || !r.agare?.trim());
  if (!start && nummerSaknas) return "Fyll i startdatum, riktigt nummer och ägare för nummerporteringen.";
  if (!start) return "Fyll i startdatum för mobilabonnemanget (nummerporteringen).";
  if (nummerSaknas) return "Fyll i riktigt nummer och ägare för alla nummer som ska porteras.";
  return pnrSaknas ? pnrText : null;
}

/** Dagar från idag till ett datum (ÅÅÅÅ-MM-DD). */
export function dagarTill(datum: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
  const [y, m, d] = datum.split("-").map(Number);
  const mal = new Date(y, m - 1, d);
  const idag = new Date(); idag.setHours(0, 0, 0, 0);
  return Math.round((mal.getTime() - idag.getTime()) / 86400000);
}

/** Pedagogisk varning för startdatum — blockerar aldrig. */
export function StartdatumVarning({ datum }: { datum: string }) {
  const dagar = dagarTill(datum);
  if (dagar === null || dagar >= 45) return null;
  if (dagar < 30) {
    return (
      <div className="mnr-warn mnr-warn--hard" role="note">
        ⚠️ Startdatumet ligger mindre än 30 dagar framåt. Detta kan vara för tätt inpå för att hinna hantera
        porteringen, eftersom kundens befintliga abonnemang har 30 dagars uppsägningstid. Kontrollera datumet noggrant.
      </div>
    );
  }
  return (
    <div className="mnr-warn" role="note">
      ⚠️ Startdatumet ligger 30–44 dagar framåt. Det går att fortsätta, men vi rekommenderar starkt att lägga
      startdatum 45+ dagar framåt för att ge bättre marginal, eftersom porteringen måste hanteras minst 30 dagar
      innan startdatum.
    </div>
  );
}

export function MobilNummerPanel({ lagenhetId, data, isAdmin, onPatch, planLabel = (k) => k, lamnaFel }: Props) {
  const val = (data.mobil_nummerval as string | null) ?? "";
  const [slumpat, setSlumpat] = useState(val === "tillfalligt" || val === "nytt_nummer");
  useEffect(() => { if (val === "tillfalligt" || val === "nytt_nummer") setSlumpat(true); }, [val]);

  const [sparade, setRows] = useState<NummerRad[]>(() => rader(data));
  // Ny lägenhet → läs om raderna.
  useEffect(() => { setRows(rader(data)); /* eslint-disable-next-line */ }, [lagenhetId]);
  const enheter = mobilEnheter(data);
  const valdaMobil = Array.isArray(data.salt_mobil) ? (data.salt_mobil as unknown[]).map(String) : [];
  const rows = justera(sparade, enheter, valdaMobil.includes(EXTRA_VAL) ? antalExtra(data) : 0);
  const antalAbb = Math.max(1, enheter.length);
  const huvudRader = rows.filter((r) => r.typ === "huvud").length;

  const registrerat = !!data.mobil_nummerbyte_id;
  const startLast = registrerat && !isAdmin;
  const start = (data.mobil_startdatum as string | null) ?? "";

  const setVal = (v: string | null) => onPatch({ mobil_nummerval: v }, 0);
  const saveRows = (next: NummerRad[], delay = 800) => {
    setRows(next);
    const patch: Record<string, unknown> = { mobil_nummer: { rows: next } };
    // En extraanvändare bland numren är också en såld extraanvändare: markera
    // valet "Extra användare" så att avtalsförslag, Scrive och Utfall tar med den.
    const mobil = Array.isArray(data.salt_mobil) ? (data.salt_mobil as unknown[]).map(String) : [];
    if (next.some((r) => r.typ === "extra") && !mobil.includes("extra_anvandare")) {
      patch.salt_mobil = [...mobil, "extra_anvandare"];
    }
    // Fler extrarader än angivet antal extraanvändare → antalet följer med.
    const extra = next.filter((r) => r.typ === "extra").length;
    const angivet = Number(data.mobil_extra_antal) || 0;
    if (extra > angivet) patch.mobil_extra_antal = extra;
    onPatch(patch, delay);
  };
  /** Ta bort en extraanvändare: antalet extraanvändare minskar (sista bort = valet bort). */
  const taBortExtra = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    const kvar = next.filter((r) => r.typ === "extra").length;
    setRows(next);
    const patch: Record<string, unknown> = { mobil_nummer: { rows: next }, mobil_extra_antal: kvar || null };
    if (!kvar) { const m = valdaMobil.filter((v) => v !== EXTRA_VAL); patch.salt_mobil = m.length ? m : null; }
    onPatch(patch, 0);
  };
  const setCell = (i: number, key: "riktigt" | "agare", v: string) =>
    saveRows(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));

  const saknas = (v: string) => !v.trim();
  const komplett = !!start && rows.every((r) => !saknas(r.riktigt) && !saknas(r.agare));
  const pnr = (data.personnummer as string | null) ?? "";
  const pnrFalt = (
    <label className="mnr-field">
      <span className="label">Kundens personnummer *</span>
      <input
        className={`input${!pnrGiltigt(pnr) ? " mnr-input--missing" : ""}`}
        inputMode="numeric"
        autoComplete="off"
        placeholder="ÅÅÅÅMMDD-XXXX"
        value={pnr}
        onChange={(e) => onPatch({ personnummer: e.target.value || null }, 800)}
      />
      {!!pnr.trim() && !pnrGiltigt(pnr) && <span className="formfield__help">Personnumret ska ha 10 eller 12 siffror.</span>}
    </label>
  );

  return (
    <div className="mnr">
      {lamnaFel && (
        <div className="mnr-warn mnr-warn--hard" role="alert">
          Du kan inte lämna kundkortet förrän detta är ifyllt: {lamnaFel}
        </div>
      )}
      <span className="d2d-sold-panel__hint">Välj först hur kundens nummer ska hanteras</span>
      <div className="d2d-reason-panel__chips">
        <button
          type="button"
          className={`d2d-reason-chip d2d-sold-chip${val === "portera_direkt" ? " d2d-sold-chip--active" : ""}`}
          aria-pressed={val === "portera_direkt"}
          onClick={() => { setSlumpat(false); setVal(val === "portera_direkt" ? null : "portera_direkt"); }}
        >
          Befintligt nummer porteras direkt
        </button>
        <button
          type="button"
          className={`d2d-reason-chip d2d-sold-chip${slumpat ? " d2d-sold-chip--active" : ""}`}
          aria-pressed={slumpat}
          onClick={() => { setSlumpat(true); if (val === "portera_direkt") setVal(null); }}
        >
          Slumpat nummer
        </button>
      </div>

      {slumpat && (
        <>
          <span className="d2d-sold-panel__hint">Ska det slumpade numret vara kvar?</span>
          <div className="d2d-reason-panel__chips">
            <button
              type="button"
              className={`d2d-reason-chip d2d-sold-chip${val === "tillfalligt" ? " d2d-sold-chip--active" : ""}`}
              aria-pressed={val === "tillfalligt"}
              onClick={() => setVal("tillfalligt")}
            >
              Tillfälligt – ersätts med befintligt
            </button>
            <button
              type="button"
              className={`d2d-reason-chip d2d-sold-chip${val === "nytt_nummer" ? " d2d-sold-chip--active" : ""}`}
              aria-pressed={val === "nytt_nummer"}
              onClick={() => setVal("nytt_nummer")}
            >
              Nytt nummer – behålls
            </button>
          </div>
        </>
      )}

      {val === "portera_direkt" && (
        <p className="mnr-info">Kunden behåller sitt nummer — ingen manuell nummerbyte behövs.</p>
      )}
      {val === "nytt_nummer" && (
        <p className="mnr-info">Kunden behåller det slumpade numret — ingen manuell portering behövs.</p>
      )}

      {val === "tillfalligt" && (
        <div className="mnr-form">
          {registrerat ? (
            <div className="mnr-ok">✓ Nummerbytet är registrerat — admin har fått en uppgift.</div>
          ) : !komplett ? (
            <div className="mnr-warn mnr-warn--hard">
              Fyll i alla fält nedan. Först då skapas uppgiften till admin — annars riskerar numret att glömmas bort.
            </div>
          ) : null}

          <label className="mnr-field">
            <span className="label">Startdatum för mobilabonnemanget *</span>
            <input
              className={`input${!start ? " mnr-input--missing" : ""}`}
              type="date"
              value={start}
              disabled={startLast}
              onChange={(e) => onPatch({ mobil_startdatum: e.target.value || null }, 0)}
            />
            {startLast && <span className="formfield__help">Startdatum kan inte ändras efter registrering — kontakta admin.</span>}
          </label>
          {start && <StartdatumVarning datum={start} />}

          {pnrFalt}

          {rows.map((r, i) => (
            <fieldset key={i} className={`mnr-card${r.typ === "huvud" ? " mnr-card--huvud" : ""}`}>
              <legend className="mnr-card__title">
                {r.typ === "extra" ? <>Extraanvändare {i - huvudRader + 1}</>
                  : huvudRader === 1 ? <><span className="mnr-badge">Huvudnummer</span>{r.abonnemang && enheter.length > 0 ? ` ${planLabel(r.abonnemang)}` : ""}</>
                  : <><span className="mnr-badge">Abonnemang {i + 1}</span>{r.abonnemang ? ` ${planLabel(r.abonnemang)}` : ""}</>}
              </legend>
              <label className="mnr-field">
                <span className="label">{r.typ === "extra" ? "Extraanvändarens befintliga nummer (porteras in) *"
                  : huvudRader === 1 ? "Kundens befintliga nummer (porteras in) *" : `Befintligt nummer för abonnemang ${i + 1} (porteras in) *`}</span>
                <input className={`input${saknas(r.riktigt) ? " mnr-input--missing" : ""}`} type="tel" inputMode="tel"
                  placeholder="073-331 71 42" value={r.riktigt} onChange={(e) => setCell(i, "riktigt", e.target.value)} />
              </label>
              <label className="mnr-field">
                <span className="label">Vem står på numret idag? *</span>
                <input className={`input${saknas(r.agare) ? " mnr-input--missing" : ""}`}
                  placeholder="För- och efternamn" value={r.agare} onChange={(e) => setCell(i, "agare", e.target.value)} />
              </label>
              {r.typ === "extra" && (
                <button type="button" className="btn btn--ghost btn--sm mnr-remove"
                  onClick={() => taBortExtra(i)}>
                  Ta bort extraanvändare
                </button>
              )}
              {r.typ === "huvud" && i >= antalAbb && (
                <button type="button" className="btn btn--ghost btn--sm mnr-remove"
                  onClick={() => saveRows(rows.filter((_, j) => j !== i), 0)}>
                  Ta bort nummer (fler nummer än abonnemang)
                </button>
              )}
            </fieldset>
          ))}

          <button type="button" className="btn btn--ghost btn--sm" onClick={() => saveRows([...rows, TOM_RAD("extra")], 0)}>
            + Lägg till extraanvändare
          </button>
        </div>
      )}
    </div>
  );
}
