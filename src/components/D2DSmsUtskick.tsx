import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import "@/styles/d2d.css";

/* =============================================================================
   Door to door → Kontaktlista → Skicka SMS.

   Urval: markerade rader (ids) eller alla som matchar sökningen (ids = null).
   1. Förhandsgranskning (d2d_sms_forhand): antal mottagare, bortvalda
      (ej mobilnummer, spärrade) och de första texterna med fälten ifyllda.
   2. Testutskick till ett eget nummer (d2d_sms_skapa med p_testnummer).
   3. Skicka: d2d_sms_skapa → edge function d2d-sms-skicka i omgångar tills
      inget är kvar. Allt skickas via LeadDesk (Original API send_sms).
   Behörighet avgörs i databasen (samma som kontaktlistan).
   ========================================================================== */

type Forhand = {
  valda: number; ej_mobil: number; sparrade: number; mottagare: number; langst: number;
  exempel: Array<{ telefon: string; text: string }>;
};
type Skapat = { id: string; antal: number; valda: number; ej_mobil?: number; sparrade?: number; dubbletter?: number; test: boolean };
type Resultat = { skickade: number; fel: number; stopp: string | null; fellista: Array<{ telefon: string; fel: string | null }> };

const FALT = [
  { kod: "{namn}", text: "Namn" },
  { kod: "{adress}", text: "Adress" },
  { kod: "{lgh}", text: "Lgh" },
  { kod: "{ort}", text: "Ort" },
];
const AVS_NYCKEL = "d2dsms.avsandare";
const STANDARD_AVS = "Connectest";

/** GSM-7 (vanliga SMS-tecken). Annat (t.ex. emoji) gör att ett SMS bara rymmer 70 tecken. */
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsDelar(text: string): { tecken: number; delar: number; unicode: boolean } {
  const unicode = !GSM.test(text);
  const tecken = unicode ? [...text].length
    : [...text].reduce((n, c) => n + ("^{}\\[~]|€".includes(c) ? 2 : 1), 0);
  const [en, fler] = unicode ? [70, 67] : [160, 153];
  return { tecken, unicode, delar: tecken === 0 ? 0 : tecken <= en ? 1 : Math.ceil(tecken / fler) };
}

function lasAvs(): string {
  try { return localStorage.getItem(AVS_NYCKEL) || STANDARD_AVS; } catch { return STANDARD_AVS; }
}
function sparaAvs(v: string) {
  try { localStorage.setItem(AVS_NYCKEL, v); } catch { /* privat läge */ }
}

const sv = (n: number) => n.toLocaleString("sv-SE");

export function D2DSmsUtskick({ ids, sok, filter, filtertext, totalt, onClose }: {
  ids: string[] | null; sok: string; totalt: number; onClose: (skickat: boolean) => void;
  filter: { p_status: string[] | null; p_ort: string | null }; filtertext: string;
}) {
  const [mall, setMall] = useState("Hej {namn}! ");
  const [avs, setAvs] = useState(lasAvs);
  const [testnr, setTestnr] = useState("");
  const [forhand, setForhand] = useState<Forhand | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [steg, setSteg] = useState<"skriv" | "bekrafta" | "skickar" | "klart">("skriv");
  const [arbetar, setArbetar] = useState(false);
  const [progress, setProgress] = useState<{ klara: number; antal: number }>({ klara: 0, antal: 0 });
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const anrop = useRef(0);

  const urval = useMemo(() => (ids ? { p_ids: ids, p_sok: null, p_status: null, p_ort: null }
    : { p_ids: null, p_sok: sok || null, ...filter }), [ids, sok, filter]);
  const antalValda = ids ? ids.length : totalt;

  // Förhandsgranskning med fördröjning medan man skriver.
  useEffect(() => {
    const mitt = ++anrop.current;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc("d2d_sms_forhand", { p_mall: mall, ...urval });
      if (mitt !== anrop.current) return;
      if (error) { setFel(error.message); return; }
      setForhand(data as Forhand);
    }, 350);
    return () => clearTimeout(t);
  }, [mall, urval]);

  const delar = smsDelar(forhand?.exempel[0]?.text ?? mall);
  const [en, fler] = delar.unicode ? [70, 67] : [160, 153];
  const langstDelar = Math.max(delar.delar, !forhand || forhand.langst <= en ? 1 : Math.ceil(forhand.langst / fler));
  const avsOk = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,10}$/.test(avs.trim()) || /^\+?\d{7,15}$/.test(avs.trim());
  const kanSkicka = !!forhand && forhand.mottagare > 0 && mall.trim().length > 0 && avsOk && !arbetar;

  const infoga = (kod: string) => {
    const el = textRef.current;
    if (!el) { setMall((m) => m + kod); return; }
    const [a, b] = [el.selectionStart ?? mall.length, el.selectionEnd ?? mall.length];
    const ny = mall.slice(0, a) + kod + mall.slice(b);
    setMall(ny);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + kod.length, a + kod.length); });
  };

  /** Kör edge function i omgångar tills inget är kvar. */
  const korUtskick = async (id: string, antal: number): Promise<Resultat> => {
    let skickade = 0, felAntal = 0;
    let stopp: string | null = null;
    let fellista: Resultat["fellista"] = [];
    for (let varv = 0; varv < 200; varv++) {
      const { data, error } = await supabase.functions.invoke("d2d-sms-skicka", { body: { utskickId: id } });
      if (error) {
        let msg = error.message;
        try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) msg = b.error; } catch { /* */ }
        stopp = msg;
        break;
      }
      const d = data as { skickade: number; fel: number; kvar: number; stopp: string | null;
                          status?: { skickad: number; fel: number; fellista: Resultat["fellista"] } };
      skickade = d.status?.skickad ?? skickade + d.skickade;
      felAntal = d.status?.fel ?? felAntal + d.fel;
      fellista = d.status?.fellista ?? fellista;
      setProgress({ klara: skickade + felAntal, antal });
      if (d.stopp) { stopp = d.stopp; break; }
      if (!d.kvar) break;
    }
    return { skickade, fel: felAntal, stopp, fellista };
  };

  const skickaTest = async () => {
    setFel(null); setInfo(null); setArbetar(true);
    sparaAvs(avs.trim());
    const { data, error } = await supabase.rpc("d2d_sms_skapa",
      { p_mall: mall, p_avsandare: avs.trim(), ...urval, p_testnummer: testnr.trim() });
    if (error) { setArbetar(false); setFel(error.message); return; }
    const r = await korUtskick((data as Skapat).id, 1);
    setArbetar(false);
    if (r.skickade) setInfo(`Testet skickat till ${testnr.trim()}.`);
    else setFel(r.stopp ?? r.fellista[0]?.fel ?? "Testet kunde inte skickas.");
  };

  const skicka = async () => {
    setFel(null); setInfo(null); setArbetar(true); setSteg("skickar");
    sparaAvs(avs.trim());
    const { data, error } = await supabase.rpc("d2d_sms_skapa", { p_mall: mall, p_avsandare: avs.trim(), ...urval });
    if (error) { setArbetar(false); setSteg("bekrafta"); setFel(error.message); return; }
    const s = data as Skapat;
    setProgress({ klara: 0, antal: s.antal });
    const r = await korUtskick(s.id, s.antal);
    setResultat(r);
    setArbetar(false);
    setSteg("klart");
  };

  const stang = () => { if (!arbetar) onClose(steg === "klart"); };

  return (
    <div className="overlay overlay--above overlay--center" onMouseDown={(e) => e.target === e.currentTarget && stang()}>
      <div className="field-config d2dsms" role="dialog" aria-label="Skicka SMS">
        <div className="field-config__header">
          <h2>Skicka SMS</h2>
          <button className="close-btn" onClick={stang} disabled={arbetar} aria-label="Stäng">×</button>
        </div>

        <div className="field-config__body d2dsms__body">
          <p className="d2dsms__urval">
            {ids ? <><b>{sv(ids.length)}</b> markerade kontakter</>
              : <><b>Alla {sv(totalt)}</b> kontakter{filtertext ? <> ({filtertext})</> : null}</>}
            {forhand && <> → <b>{sv(forhand.mottagare)}</b> mottagare</>}
          </p>
          {forhand && (forhand.ej_mobil > 0 || forhand.sparrade > 0 || forhand.valda - forhand.ej_mobil - forhand.sparrade > forhand.mottagare) && (
            <p className="field-config__hint">
              Tas bort: {[
                forhand.ej_mobil > 0 && `${sv(forhand.ej_mobil)} utan svenskt mobilnummer`,
                forhand.sparrade > 0 && `${sv(forhand.sparrade)} spärrade`,
                forhand.valda - forhand.ej_mobil - forhand.sparrade > forhand.mottagare &&
                  `${sv(forhand.valda - forhand.ej_mobil - forhand.sparrade - forhand.mottagare)} dubbletter (samma nummer får ett SMS)`,
              ].filter(Boolean).join(", ")}.
            </p>
          )}

          {(steg === "skriv" || steg === "bekrafta") && (
            <>
              <label className="formfield">
                <span className="formfield__label">Avsändare</span>
                <input className="input" value={avs} maxLength={16} onChange={(e) => setAvs(e.target.value)} disabled={steg === "bekrafta"} />
                <small className={avsOk ? "formfield__help" : "formfield__error"}>
                  Högst 11 bokstäver/siffror (syns som avsändare, går inte att svara på) eller ett telefonnummer.
                </small>
              </label>

              <label className="formfield">
                <span className="formfield__label">Meddelande</span>
                <textarea ref={textRef} className="input d2dsms__text" rows={5} value={mall} maxLength={600}
                  onChange={(e) => setMall(e.target.value)} disabled={steg === "bekrafta"} />
              </label>
              <div className="d2dsms__falt">
                <span className="formfield__help">Infoga:</span>
                {FALT.map((f) => (
                  <button key={f.kod} type="button" className="btn btn--ghost btn--sm" disabled={steg === "bekrafta"}
                    onClick={() => infoga(f.kod)}>{f.text}</button>
                ))}
                <span className={`d2dsms__tecken${langstDelar > 2 ? " d2dsms__tecken--varn" : ""}`}>
                  {delar.tecken} tecken · {langstDelar} SMS per mottagare{delar.unicode ? " (specialtecken: 70 tecken/SMS)" : ""}
                </span>
              </div>

              {forhand && forhand.exempel.length > 0 && (
                <div className="d2dsms__exempel">
                  <span className="formfield__label">Så här blir det</span>
                  {forhand.exempel.map((x, i) => (
                    <div key={i} className="d2dsms__bubbla">
                      <small className="utf__sub">{x.telefon}</small>
                      <p>{x.text || "–"}</p>
                    </div>
                  ))}
                </div>
              )}

              {steg === "skriv" && (
                <div className="d2dsms__test">
                  <input className="input input--sm" placeholder="Ditt mobilnummer" inputMode="tel" autoComplete="tel"
                    value={testnr} onChange={(e) => setTestnr(e.target.value)} aria-label="Mobilnummer för testutskick" />
                  <button type="button" className="btn btn--ghost btn--sm" disabled={!kanSkicka || testnr.trim().length < 8}
                    onClick={() => void skickaTest()}>{arbetar ? "Skickar…" : "Skicka test till mig"}</button>
                </div>
              )}

              {steg === "bekrafta" && forhand && (
                <div className="d2dsms__bekrafta" role="alert">
                  Du skickar <b>{sv(forhand.mottagare)}</b> SMS ({sv(forhand.mottagare * langstDelar)} SMS-delar som mest)
                  från <b>{avs.trim()}</b>. Det går inte att ångra. Skickade SMS loggas på varje lägenhet.
                </div>
              )}
            </>
          )}

          {steg === "skickar" && (
            <div className="d2dsms__progress">
              <p>Skickar… {sv(progress.klara)} av {sv(progress.antal)}</p>
              <div className="d2dsms__bar"><span style={{ width: `${progress.antal ? (100 * progress.klara) / progress.antal : 0}%` }} /></div>
              <small className="formfield__help">Stäng inte fönstret förrän utskicket är klart.</small>
            </div>
          )}

          {steg === "klart" && resultat && (
            <div className="d2dsms__klart">
              <p><b>{sv(resultat.skickade)}</b> SMS skickade{resultat.fel ? <>, <b>{sv(resultat.fel)}</b> misslyckades</> : null}.</p>
              {resultat.stopp && <p className="formfield__error">Utskicket stoppades: {resultat.stopp}</p>}
              {resultat.fellista.length > 0 && (
                <ul className="d2dsms__fellista">
                  {resultat.fellista.slice(0, 20).map((f, i) => <li key={i}>{f.telefon}: {f.fel}</li>)}
                  {resultat.fellista.length > 20 && <li>… och {resultat.fellista.length - 20} till</li>}
                </ul>
              )}
            </div>
          )}

          {info && <p className="d2dsms__ok">{info}</p>}
          {fel && <div className="formfield__error">{fel}</div>}
        </div>

        <div className="field-config__footer">
          {steg === "skriv" && <>
            <button type="button" className="btn btn--ghost" onClick={stang} disabled={arbetar}>Avbryt</button>
            <button type="button" className="btn btn--brand" disabled={!kanSkicka} onClick={() => setSteg("bekrafta")}>
              Fortsätt{forhand ? ` (${sv(forhand.mottagare)})` : ""}
            </button>
          </>}
          {steg === "bekrafta" && <>
            <button type="button" className="btn btn--ghost" onClick={() => setSteg("skriv")} disabled={arbetar}>Tillbaka</button>
            <button type="button" className="btn btn--brand" disabled={!kanSkicka} onClick={() => void skicka()}>
              Skicka {forhand ? sv(forhand.mottagare) : ""} SMS
            </button>
          </>}
          {steg === "klart" && <button type="button" className="btn btn--brand" onClick={() => onClose(true)}>Stäng</button>}
        </div>
        {antalValda === 0 && <p className="formfield__help">Inga kontakter valda.</p>}
      </div>
    </div>
  );
}

/** Spärrlista: nummer som aldrig får SMS från kontaktlistan. */
export function D2DSmsSparr({ onClose }: { onClose: () => void }) {
  const [lista, setLista] = useState<Array<{ telefon: string; orsak: string | null; skapad: string; vem: string | null }> | null>(null);
  const [nr, setNr] = useState("");
  const [orsak, setOrsak] = useState("");
  const [fel, setFel] = useState<string | null>(null);

  const hamta = async () => {
    const { data, error } = await supabase.rpc("d2d_sms_sparrlista");
    if (error) { setFel(error.message); return; }
    setLista((data as typeof lista) ?? []);
  };
  useEffect(() => { void hamta(); }, []);

  const sparra = async (telefon: string, pa: boolean, varfor?: string) => {
    setFel(null);
    const { error } = await supabase.rpc("d2d_sms_sparra", { p_telefon: telefon, p_sparra: pa, p_orsak: varfor ?? null });
    if (error) { setFel(error.message); return; }
    if (pa) { setNr(""); setOrsak(""); }
    void hamta();
  };

  return (
    <section className="card utf__sek d2dkl__logg">
      <div className="utf__sekhuvud">
        <h2>Spärrade nummer</h2>
        <small className="utf__sub">får aldrig SMS från kontaktlistan</small>
        <button type="button" className="btn btn--ghost btn--sm d2dsms__dolj" onClick={onClose}>Dölj</button>
      </div>
      <form className="d2dsms__test" onSubmit={(e) => { e.preventDefault(); void sparra(nr, true, orsak); }}>
        <input className="input input--sm" placeholder="Mobilnummer" inputMode="tel" value={nr} onChange={(e) => setNr(e.target.value)} aria-label="Mobilnummer att spärra" />
        <input className="input input--sm" placeholder="Orsak (valfritt)" value={orsak} onChange={(e) => setOrsak(e.target.value)} aria-label="Orsak" />
        <button type="submit" className="btn btn--sm" disabled={nr.trim().length < 8}>Spärra</button>
      </form>
      {fel && <div className="formfield__error">{fel}</div>}
      {!lista ? null : lista.length === 0 ? <p className="formfield__help">Inga spärrade nummer.</p> : (
        <ul className="d2dkl__logglista">
          {lista.map((s) => (
            <li key={s.telefon}>
              <span className="d2dkl__loggtid">{s.telefon}</span>
              <span>{s.orsak ?? "–"} <small className="utf__sub">{s.vem ?? ""}</small></span>
              <button type="button" className="btn btn--ghost btn--sm d2dsms__dolj" onClick={() => void sparra(s.telefon, false)}>Häv</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
