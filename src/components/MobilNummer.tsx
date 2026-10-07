import { useEffect, useState } from "react";

/**
 * Mobilabonnemang i D2D-vyn: hur kundens nummer ska hanteras.
 *
 *   A. Befintligt nummer porteras direkt     → mobil_nummerval = portera_direkt
 *   B. Slumpat nummer
 *        – Tillfälligt (ersätts med befintligt) → tillfalligt  (kräver uppgifter)
 *        – Nytt nummer (behålls)                → nytt_nummer
 *
 * Vid "tillfalligt" är startdatum, huvudnumret och ev. extraanvändare
 * obligatoriska. När allt är ifyllt skapar servern automatiskt ett
 * nummerbytesärende + en admin-uppgift (se migration 0029). Startdatum
 * låses för säljaren när ärendet finns — bara admin kan ändra det.
 */

export type NummerRad = { typ: "huvud" | "extra"; tillfalligt: string; riktigt: string; agare: string };

type Props = {
  lagenhetId: string;
  data: Record<string, unknown>;
  isAdmin: boolean;
  /** Spara ändringar (patch av lägenhetens fält). delayMs = debounce vid inmatning. */
  onPatch: (patch: Record<string, unknown>, delayMs: number) => void;
};

const TOM_RAD = (typ: NummerRad["typ"]): NummerRad => ({ typ, tillfalligt: "", riktigt: "", agare: "" });

function rader(data: Record<string, unknown>): NummerRad[] {
  const v = data.mobil_nummer as { rows?: unknown } | null | undefined;
  const rows = Array.isArray(v?.rows) ? (v!.rows as NummerRad[]) : [];
  const huvud = rows.find((r) => r.typ === "huvud") ?? TOM_RAD("huvud");
  return [huvud, ...rows.filter((r) => r.typ === "extra")];
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

export function MobilNummerPanel({ lagenhetId, data, isAdmin, onPatch }: Props) {
  const val = (data.mobil_nummerval as string | null) ?? "";
  const [slumpat, setSlumpat] = useState(val === "tillfalligt" || val === "nytt_nummer");
  useEffect(() => { if (val === "tillfalligt" || val === "nytt_nummer") setSlumpat(true); }, [val]);

  const [rows, setRows] = useState<NummerRad[]>(() => rader(data));
  // Ny lägenhet → läs om raderna.
  useEffect(() => { setRows(rader(data)); /* eslint-disable-next-line */ }, [lagenhetId]);

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
  const setCell = (i: number, key: keyof Omit<NummerRad, "typ">, v: string) =>
    saveRows(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));

  const saknas = (v: string) => !v.trim();
  const komplett = !!start && rows.every((r) => !saknas(r.tillfalligt) && !saknas(r.riktigt) && !saknas(r.agare));

  return (
    <div className="mnr">
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

          {rows.map((r, i) => (
            <fieldset key={i} className={`mnr-card${r.typ === "huvud" ? " mnr-card--huvud" : ""}`}>
              <legend className="mnr-card__title">
                {r.typ === "huvud" ? <><span className="mnr-badge">Huvudnummer</span></> : <>Extraanvändare {i}</>}
              </legend>
              <label className="mnr-field">
                <span className="label">{r.typ === "huvud" ? "Tillfälligt/slumpat nummer *" : "Slumpat/tillfälligt nummer *"}</span>
                <input className={`input${saknas(r.tillfalligt) ? " mnr-input--missing" : ""}`} type="tel" inputMode="tel"
                  placeholder="076-111 11 11" value={r.tillfalligt} onChange={(e) => setCell(i, "tillfalligt", e.target.value)} />
              </label>
              <label className="mnr-field">
                <span className="label">{r.typ === "huvud" ? "Kundens befintliga nummer (porteras in) *" : "Riktigt nummer som ska ersätta det *"}</span>
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
                  onClick={() => saveRows(rows.filter((_, j) => j !== i), 0)}>
                  Ta bort extraanvändare
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
