import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/* =============================================================================
   "Signera med Scrive" — under avtalsförslaget i "Vad såldes?".
   Avtalet skapas från Scrive-mallen och fylls i på servern (scrive-sign) med
   kunduppgifter, valda tjänster och priser. Scrive skickar länken till
   kunden via e-post/sms, och ett utkast av avtalet öppnas i en ny flik så
   att säljaren ser exakt vad kunden fått. Signerat avtal sparas som PDF.
   ========================================================================== */

type AvtalStatus = "skapas" | "vantar" | "signerat" | "avvisat" | "avbrutet" | "fel";
type Avtal = {
  id: string; status: AvtalStatus; leverans: "plats" | "skickat"; kundNamn: string | null;
  harPdf: boolean; fel: string | null; skapad: string; signerad: string | null; skapadAv: string | null;
};

const STATUS_TEXT: Record<AvtalStatus, string> = {
  skapas: "Avtalet skapas…",
  vantar: "Väntar på kundens signatur",
  signerat: "Signerat",
  avvisat: "Kunden avvisade avtalet",
  avbrutet: "Avbrutet",
  fel: "Något gick fel",
};

async function anropa<T = any>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("scrive-sign", { body });
  if (error) {
    let j: any = null;
    try { j = await (error as { context?: Response }).context?.json(); } catch { /* */ }
    const e = new Error(j?.error ?? "Kunde inte nå Scrive-kopplingen.") as Error & { info?: any };
    e.info = j;
    throw e;
  }
  return data as T;
}

let kollad: Promise<{ configured: boolean }> | null = null;
const kollaKoppling = () => (kollad ??= anropa<{ configured: boolean }>({ action: "check" }).catch(() => { kollad = null; return { configured: false }; }));

const datum = (s: string | null) => (s ? new Date(s).toLocaleString("sv-SE", { dateStyle: "medium", timeStyle: "short" }) : "");

export function ScriveSignering({ lagenhetId, data, sparaForst }: {
  lagenhetId: string;
  data: Record<string, unknown>;
  /** Spara väntande ändringar innan avtalet skapas. */
  sparaForst: () => Promise<void>;
}) {
  const [kopplad, setKopplad] = useState<boolean | null>(null);
  const [avtal, setAvtal] = useState<Avtal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const ladda = useCallback(async () => {
    const { data: d, error } = await supabase.rpc("d2d_avtal_for", { p_lagenhet: lagenhetId });
    if (!error) setAvtal((d ?? []) as Avtal[]);
  }, [lagenhetId]);

  useEffect(() => {
    let on = true;
    kollaKoppling().then((r) => { if (on) setKopplad(!!r.configured); });
    void ladda();
    return () => { on = false; };
  }, [ladda]);

  const senaste = avtal?.[0] ?? null;

  // Väntar på signatur → fråga Scrive regelbundet (och när man kommer tillbaka till fliken).
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    if (!senaste || senaste.status !== "vantar" || !kopplad) return;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try { await anropa({ action: "status", avtalId: senaste.id }); await ladda(); } catch { /* nästa varv */ }
    };
    pollRef.current = window.setInterval(tick, 10_000);
    const onVis = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [senaste?.id, senaste?.status, kopplad, ladda]);

  const saknas: string[] = [];
  if (!String(data.kund_namn ?? "").trim()) saknas.push("namn");
  const pnrSiffror = String(data.personnummer ?? "").replace(/\D/g, "");
  if (pnrSiffror.length !== 10 && pnrSiffror.length !== 12) saknas.push("personnummer");
  if (!String(data.kund_epost ?? "").includes("@")) saknas.push("e-post");

  async function starta(nytt = false) {
    setFel(null); setInfo(null);
    // Fliken för utkastet öppnas direkt vid klicket (annars stoppas den av popup-skyddet på mobilen).
    const flik = window.open("", "_blank");
    setBusy("skickat");
    try {
      await sparaForst();
      const r = await anropa<{ utkast?: string | null }>({ action: "start", lagenhetId, leverans: "skickat", nytt });
      if (r.utkast && flik) flik.location.href = r.utkast;
      else flik?.close();
      setInfo(r.utkast ? "Avtalet är skickat till kunden. Utkastet är öppnat i en ny flik." : "Avtalet är skickat till kunden.");
      await ladda();
    } catch (e) {
      flik?.close();
      const ex = e as Error & { info?: any };
      if (ex.info?.pagaende && !nytt) {
        if (confirm("Det finns redan ett avtal som väntar på signering. Vill du avbryta det och skapa ett nytt med de uppgifter som står nu?")) {
          setBusy(null);
          return starta(true);
        }
      } else {
        setFel(ex.message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function atgard(action: "status" | "avbryt" | "lank" | "pdf" | "utkast") {
    if (!senaste) return;
    setFel(null);
    if (action === "avbryt" && !confirm("Avbryta avtalet? Kunden kan då inte längre signera det.")) return;
    const flik = action === "lank" || action === "pdf" || action === "utkast" ? window.open("", "_blank") : null;
    setBusy(action);
    try {
      const r = await anropa<{ url?: string | null }>({ action, avtalId: senaste.id });
      if (flik) { if (r.url) flik.location.href = r.url; else { flik.close(); setFel("Länken kunde inte hämtas."); } }
      await ladda();
    } catch (e) {
      flik?.close();
      setFel((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const kanStarta = kopplad === true && saknas.length === 0 && !busy;
  const pagar = senaste?.status === "vantar" || senaste?.status === "skapas";

  return (
    <div className="d2d-scrive">
      <div className="d2d-scrive__head">
        <span className="d2d-avtal__title">Signering</span>
        {senaste && <span className={`d2d-scrive__status d2d-scrive__status--${senaste.status}`}>{STATUS_TEXT[senaste.status]}</span>}
      </div>

      {senaste?.status === "signerat" && (
        <div className="d2d-scrive__klar">
          <span>✓ {senaste.kundNamn ?? "Kunden"} signerade {datum(senaste.signerad)}</span>
          {senaste.harPdf && (
            <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void atgard("pdf")}>Visa avtal (PDF)</button>
          )}
        </div>
      )}

      {pagar && senaste && (
        <div className="d2d-scrive__vantar">
          <span className="d2d-scrive__meta">
            {senaste.leverans === "plats" ? "Signering på plats" : "Skickat till kunden"} · {datum(senaste.skapad)}{senaste.skapadAv ? ` · ${senaste.skapadAv}` : ""}
          </span>
          <div className="d2d-scrive__knappar">
            {senaste.leverans === "plats" && (
              <button type="button" className="btn btn--brand btn--sm" disabled={!!busy} onClick={() => void atgard("lank")}>Öppna signeringen igen</button>
            )}
            <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void atgard("utkast")}>
              {busy === "utkast" ? "Hämtar…" : "Visa utkast"}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => void atgard("status")}>
              {busy === "status" ? "Kollar…" : "Uppdatera status"}
            </button>
            <button type="button" className="btn btn--ghost btn--sm btn--danger" disabled={!!busy} onClick={() => void atgard("avbryt")}>Avbryt avtalet</button>
          </div>
        </div>
      )}

      {senaste?.status === "fel" && senaste.fel && <p className="d2d-scrive__fel">{senaste.fel}</p>}

      {senaste?.status !== "signerat" && !pagar && (
        <>
          <div className="d2d-scrive__knappar">
            <button type="button" className="btn btn--brand d2d-scrive__primar" disabled={!kanStarta} onClick={() => void starta()}>
              {busy === "skickat" ? "Skickar…" : "Skicka avtalet till kunden"}
            </button>
          </div>
          {kopplad === false && <p className="d2d-scrive__hint">Scrive är inte kopplat än. När kopplingen är klar fungerar knapparna direkt.</p>}
          {kopplad && saknas.length > 0 && <p className="d2d-scrive__hint">Fyll i kundens {saknas.length > 1 ? `${saknas.slice(0, -1).join(", ")} och ${saknas[saknas.length - 1]}` : saknas[0]} ovan för att kunna skicka avtalet.</p>}
        </>
      )}

      {info && <p className="d2d-scrive__info">{info}</p>}
      {fel && <p className="d2d-scrive__fel">{fel}</p>}
    </div>
  );
}
