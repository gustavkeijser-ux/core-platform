import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getMetadata } from "@/lib/data";
import { lasXlsx, tillObjekt } from "@/lib/xlsx";
import { EXCEL_RUBRIK_TILL_FALT } from "./D2DProjectBuilder";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Lägenheter: importera en adresslista UTAN projekt
   (t.ex. Total Final). Raderna grupperas per fastighetsbeteckning och varje
   grupp går till d2d_import_fastighet_rader, som matchar mot Telias lista,
   återanvänder befintlig fastighet (eller skapar en utan projekt, kopplad
   till leveransen), lägger in lägenheterna (systemets status vinner) och
   fyller på med Telias lägenheter som saknas. Lägenheterna syns direkt för
   alla säljare under "Alla lägenheter" / "Utan projekt"; väljs leveransen
   sedan i projektbyggaren följer fastigheten med in i projektet.
   ========================================================================== */

type Resultat = {
  imported: number; uppdaterade: number; telia_matchade: number; statusar_satta: number;
  okanda_status: number; saljare_saknas: number; ny_fastighet: boolean; telia_fastighet: boolean;
  telia_tillagda: number;
};

type Summa = {
  fastigheter: number; nyaFast: number; utanTelia: string[]; nya: number; uppdaterade: number;
  telia: number; teliaTillagda: number; statusar: number; okandStatus: number; saljareSaknas: number;
  utanBeteckning: number; fel: string[];
};

/** Rader per anrop och paus mellan fastigheter (håll nere lasten på databasen). */
const DEL = 40;
const PAUS_MS = 300;

export function D2DTotalImport() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [oppen, setOppen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [summa, setSumma] = useState<Summa | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const filRef = useRef<HTMLInputElement>(null);

  useEffect(() => { getMetadata().then((m) => setIsAdmin(!!m.isAdmin)).catch(() => {}); }, []);
  if (!isAdmin) return null;

  async function valjFil(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = "";
    setFel(null); setSumma(null);
    setBusy("Läser filen…");
    try {
      const blad = await lasXlsx(f);
      const grupper = new Map<string, { beteckning: string; ort: string; rader: Record<string, string>[] }>();
      let utanBeteckning = 0;
      for (const o of tillObjekt(blad.rader)) {
        const rad: Record<string, string> = {};
        for (const [rubrik, varde] of Object.entries(o)) {
          const key = EXCEL_RUBRIK_TILL_FALT[rubrik.trim().toLowerCase()];
          if (key && String(varde ?? "").trim() !== "") rad[key] = String(varde).trim();
        }
        const bet = (rad.fastighetsbeteckning ?? "").replace(/\s+/g, " ").trim();
        if (!bet || !rad.gatunamn) { utanBeteckning++; continue; }
        const g = grupper.get(bet.toUpperCase());
        if (g) { g.rader.push(rad); if (!g.ort && rad.postort) g.ort = rad.postort; }
        else grupper.set(bet.toUpperCase(), { beteckning: bet, ort: rad.postort ?? "", rader: [rad] });
      }
      if (grupper.size === 0) { setFel("Hittade inga rader med fastighetsbeteckning och gatunamn."); return; }

      const s: Summa = {
        fastigheter: 0, nyaFast: 0, utanTelia: [], nya: 0, uppdaterade: 0, telia: 0, teliaTillagda: 0,
        statusar: 0, okandStatus: 0, saljareSaknas: 0, utanBeteckning, fel: [],
      };
      const lista = Array.from(grupper.values());
      let klara = 0;
      // En fastighet i taget, i små delar: databasen har 8 s gräns per anrop
      // och importen ska inte tränga undan säljarna. Importen tål att köras
      // om — redan inlagda lägenheter uppdateras i stället för att dubbleras.
      const anropa = async (g: { beteckning: string; ort: string }, rader: Record<string, string>[]) => {
        for (let forsok = 0; ; forsok++) {
          const { data, error } = await supabase.rpc("d2d_import_fastighet_rader", {
            p_beteckning: g.beteckning, p_ort: g.ort, p_rows: rader,
          });
          if (!error) return data as Resultat;
          if (forsok >= 2) throw new Error(error.message);
          await new Promise((r) => setTimeout(r, 3000 * (forsok + 1)));
        }
      };
      for (const g of lista) {
        klara++;
        setBusy(`Importerar ${klara} av ${grupper.size} fastigheter…`);
        try {
          let forsta = true;
          for (let i = 0; i < g.rader.length; i += DEL) {
            const r = await anropa(g, g.rader.slice(i, i + DEL));
            if (forsta) {
              s.fastigheter++;
              if (r.ny_fastighet) s.nyaFast++;
              if (!r.telia_fastighet) s.utanTelia.push(g.beteckning);
              forsta = false;
            }
            s.nya += r.imported; s.uppdaterade += r.uppdaterade; s.telia += r.telia_matchade;
            s.teliaTillagda += r.telia_tillagda; s.statusar += r.statusar_satta;
            s.okandStatus += r.okanda_status; s.saljareSaknas += r.saljare_saknas;
          }
        } catch (err) {
          s.fel.push(`${g.beteckning}: ${err instanceof Error ? err.message : "fel"}`);
        }
        await new Promise((r) => setTimeout(r, PAUS_MS));
      }
      setSumma(s);
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Kunde inte läsa filen.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="d2d-totalimport">
      <input ref={filRef} type="file" accept=".xlsx" onChange={valjFil} style={{ display: "none" }} data-testid="d2d-totalimport-fil" />
      <div className="d2d-totalimport__rad">
        <button className="btn btn--ghost btn--sm" onClick={() => filRef.current?.click()} disabled={!!busy}>
          {busy ?? "Importera adresslista (Excel)"}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setOppen((v) => !v)} aria-expanded={oppen}>
          {oppen ? "Dölj hjälp" : "Hur fungerar det?"}
        </button>
      </div>
      {oppen && (
        <p className="d2d-totalimport__hjalp">
          Lägenheterna läggs in utan projekt och syns direkt för alla säljare under Alla lägenheter.
          Raderna grupperas per <code>Fastighetsbeteckning</code> och matchas mot Telias adresslista; finns
          fastigheten redan används den. Systemets status vinner — filen sätter bara status där lägenheten är
          Ej knackad. Telias lägenheter som saknas i filen läggs till som Ej knackad. Väljs leveransen sedan i
          projektbyggaren följer fastigheten med lägenheterna in i projektet. Samma kolumner som projektbyggarens
          import (Status, Säljare, Gatunamn, Gatnr, Ingång, Lägenhetsnummer, Kommentar, PunktID …).
        </p>
      )}
      {fel && <div className="d2d-error">{fel}</div>}
      {summa && (
        <div className="d2d-save-ok d2d-totalimport__resultat" data-testid="d2d-totalimport-resultat">
          ✓ {summa.fastigheter} fastigheter ({summa.nyaFast} nya): {summa.nya} nya lägenheter, {summa.uppdaterade} fanns
          redan och uppdaterades, {summa.telia} matchade mot Telia, {summa.teliaTillagda} lades till från Telias lista,
          {" "}{summa.statusar} fick status
          {summa.okandStatus > 0 ? `, ${summa.okandStatus} okänd status ignorerad` : ""}
          {summa.saljareSaknas > 0 ? `, ${summa.saljareSaknas} säljare hittades inte` : ""}
          {summa.utanBeteckning > 0 ? `, ${summa.utanBeteckning} rader utan fastighetsbeteckning hoppades över` : ""}.
          {summa.utanTelia.length > 0 && <> Saknas i Telias lista: {summa.utanTelia.join(", ")}.</>}
          {summa.fel.length > 0 && <div className="d2d-error">Fel: {summa.fel.join(" · ")}</div>}
        </div>
      )}
    </div>
  );
}
