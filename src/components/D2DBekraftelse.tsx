import { useEffect, useState, type ReactNode } from "react";
import { pnrGiltigt } from "./MobilNummer";
import "@/styles/d2d.css";

/* =============================================================================
   Avsluta säljet: Bekräftad / Ej bekräftad (Gustav 26 okt).
   När tjänsterna är valda trycker säljaren "Avsluta säljet" och väljer om säljet
   är bekräftat. Ej bekräftad kräver kundens personnummer och telefon, räknas som
   väntande i pinnar/lön och ger påminnelsemejl efter 18 och 36 timmar tills
   säljaren ändrat till Bekräftad (servern: d2d_bekraftelse_*, d2d-bekraftelse-notis).
   ========================================================================== */

export type Bekraftelse = "bekraftad" | "ej_bekraftad";

const telGiltig = (v: unknown) => String(v ?? "").replace(/\D/g, "").length >= 8;

/** Vad som saknas innan säljaren får lämna kortet (null = inget).
 *  kravVal = säljet görs/ändras nu, så ett val måste finnas. */
export function bekraftelseBrist(data: Record<string, unknown>, kravVal: boolean): string | null {
  const val = data.sald_bekraftelse;
  if (val !== "bekraftad" && val !== "ej_bekraftad") {
    return kravVal ? "Tryck på Avsluta säljet och välj om säljet är Bekräftat eller Ej bekräftat." : null;
  }
  if (val === "ej_bekraftad") {
    const saknas = [!pnrGiltigt(data.personnummer) && "personnummer", !telGiltig(data.kund_telefon) && "telefonnummer"].filter(Boolean);
    if (saknas.length) return `Säljet är Ej bekräftat: fyll i kundens ${saknas.join(" och ")}.`;
  }
  return null;
}

const tid = (iso: unknown) => {
  const d = typeof iso === "string" ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString("sv-SE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
};

export function BekraftelsePanel({ lagenhetId, data, fel, kundFalt, onVal, onAvsluta }: {
  lagenhetId: string;
  data: Record<string, unknown>;
  /** Säljaren försökte lämna kortet utan att vara klar: markera panelen. */
  fel: boolean;
  /** Fälten för personnummer och telefon (renderade av kundkortet). */
  kundFalt: ReactNode;
  onVal: (v: Bekraftelse) => void;
  onAvsluta: () => void;
}) {
  const val = data.sald_bekraftelse === "bekraftad" || data.sald_bekraftelse === "ej_bekraftad"
    ? (data.sald_bekraftelse as Bekraftelse) : null;
  const [oppen, setOppen] = useState(false);
  useEffect(() => { setOppen(false); }, [lagenhetId]);
  const visaVal = oppen || !!val || fel;
  const brist = bekraftelseBrist(data, true);
  const ejSedan = val === "ej_bekraftad" ? tid(data.sald_bekraftelse_tid) : null;

  const valj = (v: Bekraftelse) => {
    onVal(v);
    // Bekräftad direkt efter "Avsluta säljet" = klart, kortet stängs.
    if (v === "bekraftad" && oppen) onAvsluta();
  };

  return (
    <div className={`d2d-bekr${fel && brist ? " d2d-bekr--fel" : ""}`}>
      {!visaVal ? (
        <button type="button" className="btn btn--brand d2d-bekr__avsluta" onClick={() => setOppen(true)}>Avsluta säljet</button>
      ) : (
        <>
          <span className="label">Är säljet bekräftat?</span>
          <div className="d2d-reason-panel__chips d2d-bekr__val">
            <button type="button" aria-pressed={val === "bekraftad"}
              className={`d2d-reason-chip d2d-bekr__chip${val === "bekraftad" ? " d2d-reason-chip--active d2d-bekr__chip--ja" : ""}`}
              onClick={() => valj("bekraftad")}>
              {val === "bekraftad" ? "✓ " : ""}Bekräftad
            </button>
            <button type="button" aria-pressed={val === "ej_bekraftad"}
              className={`d2d-reason-chip d2d-bekr__chip${val === "ej_bekraftad" ? " d2d-reason-chip--active d2d-bekr__chip--nej" : ""}`}
              onClick={() => valj("ej_bekraftad")}>
              Ej bekräftad
            </button>
          </div>
          {val === "ej_bekraftad" && (
            <>
              <p className="d2d-bekr__hint">
                Fyll i kundens personnummer och telefonnummer. Säljet räknas som väntande i pinnar och lön tills du ändrar till
                Bekräftad, och du får en påminnelse på mejlen efter 18 och 36 timmar.{ejSedan ? ` Ej bekräftat sedan ${ejSedan}.` : ""}
              </p>
              <div className="d2d-bekr__falt">{kundFalt}</div>
            </>
          )}
          {val === "bekraftad" && !oppen && <p className="d2d-bekr__hint">Säljet är bekräftat.</p>}
          {val === "ej_bekraftad" && (
            <button type="button" className="btn btn--brand d2d-bekr__avsluta" disabled={!!brist} onClick={onAvsluta}>Avsluta säljet</button>
          )}
          {fel && brist && <p className="d2d-bekr__brist" role="alert">{brist}</p>}
        </>
      )}
    </div>
  );
}
