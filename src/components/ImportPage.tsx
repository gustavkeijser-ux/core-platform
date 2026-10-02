import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, DataError } from "@/lib/data";
import { lasXlsx, bladnamn, tillObjekt } from "@/lib/xlsx";

type Resultat = {
  nya: number;
  uppdaterade: number;
  hoppade: number;
  slangda_varden: number;
  statusbyten?: number;
  kopplade_kunder?: number;
  torrkorning: boolean;
};

type UtanKund = {
  agare: string | null;
  antal: number;
  narmaste_kund: string | null;
  likhet: number | null;
};

const BLAD = "Projektplan";

/** Vilket blad det är avgör hur raderna läses in. */
type BladTyp = "projektplan" | "avslutade" | "flit";
const bladTyp = (namn: string): BladTyp =>
  /^avslutade/i.test(namn.trim()) ? "avslutade" : /^flit/i.test(namn.trim()) ? "flit" : "projektplan";
const RPC: Record<BladTyp, string> = {
  projektplan: "import_projektplan",
  avslutade: "import_projektplan_avslutade",
  flit: "import_flit_sdu",
};
const radNyckel = (r: Record<string, string>) =>
  `${(r["Fastighetsbeteckning"] ?? "").trim().toUpperCase()}|${(r["Ort:"] ?? "").trim().toUpperCase()}`;

type BladSumma = { rader: number; nya: number; uppdaterade: number } | null;
type PerBlad = { projektplan?: BladSumma; avslutade?: BladSumma; flit_sdu?: BladSumma };
type AutoKorning = {
  tid: string; kalla: "auto" | "manuell"; status: "ok" | "oforandrad" | "fel";
  fil_andrad: string | null; rader: number | null; resultat: (Partial<Resultat> & { blad?: PerBlad }) | null; fel: string | null;
};

/** "Projektplan 351 · Avslutade 170 · FLIT-SDU 8" */
function bladText(b?: PerBlad): string {
  if (!b) return "";
  const delar = [
    b.projektplan && `Projektplan ${b.projektplan.rader}`,
    b.avslutade && `Avslutade ${b.avslutade.rader}`,
    b.flit_sdu && `FLIT-SDU ${b.flit_sdu.rader}`,
  ].filter(Boolean);
  return delar.length ? ` (${delar.join(" · ")})` : "";
}
type AutoStatus = { senaste: AutoKorning[]; senastOk: AutoKorning | null; schema: string | null };

const tidStr = (s: string | null) => s ? new Date(s).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "–";

/** Automatisk import varje timme från Projektplan CE.xlsx på SharePoint. */
function AutoImport() {
  const [st, setSt] = useState<AutoStatus | null>(null);
  const [kor, setKor] = useState(false);
  const [svar, setSvar] = useState<string | null>(null);
  const ladda = useCallback(async () => {
    const { data } = await supabase.rpc("projektplan_import_status", { p_antal: 8 });
    if (data) setSt(data as AutoStatus);
  }, []);
  useEffect(() => { void ladda(); }, [ladda]);

  async function hamtaNu() {
    setKor(true); setSvar(null);
    try {
      const { data, error } = await supabase.functions.invoke("projektplan-import", { body: { tvinga: true } });
      const d = (data ?? {}) as { status?: string; fel?: string; rader?: number; nya?: number; uppdaterade?: number; blad?: PerBlad };
      if (error && !d.status) throw error;
      setSvar(d.status === "ok" ? `Klart: ${d.rader} rader${bladText(d.blad)}, ${d.nya ?? 0} nya leveranser, ${d.uppdaterade ?? 0} uppdaterade.`
        : d.fel ?? "Importen misslyckades.");
    } catch (e) {
      setSvar(e instanceof Error ? e.message : "Importen misslyckades.");
    } finally { setKor(false); void ladda(); }
  }

  const sist = st?.senaste[0];
  const ok = st?.senastOk;
  return (
    <div className="card imp__auto">
      <div className="imp__autohuvud">
        <div>
          <h2>Automatisk import</h2>
          <p className="imp__not">
            <code>Projektplan CE.xlsx</code> på SharePoint läses in varje timme (20 över): bladen Projektplan, Avslutade och FLIT-SDU. Har filen inte ändrats händer ingenting.
          </p>
        </div>
        <button className="btn btn--brand btn--sm" onClick={() => void hamtaNu()} disabled={kor}>
          {kor ? "Hämtar…" : "Hämta nu"}
        </button>
      </div>
      {sist?.status === "fel" && <div className="formfield__error">Senaste körningen misslyckades: {sist.fel}</div>}
      {svar && <p className="imp__not">{svar}</p>}
      <div className="imp__autorad">
        <span>Senast inläst: <b>{ok ? tidStr(ok.tid) : "aldrig"}</b>{ok?.rader ? ` · ${ok.rader} rader` : ""}</span>
        <span>Filen ändrad: <b>{tidStr(ok?.fil_andrad ?? null)}</b></span>
        <span>Senaste kontroll: <b>{tidStr(sist?.tid ?? null)}</b></span>
      </div>
      {st && st.senaste.length > 0 && (
        <details className="imp__autologg">
          <summary>Senaste körningarna</summary>
          <ul>
            {st.senaste.map((k, i) => (
              <li key={i} className={`imp__autologg--${k.status}`}>
                {tidStr(k.tid)} · {k.kalla === "auto" ? "automatiskt" : "manuellt"} ·{" "}
                {k.status === "ok" ? `${k.rader} rader${bladText(k.resultat?.blad)}, ${k.resultat?.nya ?? 0} nya, ${k.resultat?.uppdaterade ?? 0} uppdaterade`
                  : k.status === "oforandrad" ? "filen oförändrad" : `fel: ${k.fel}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ImportPage() {
  const [fil, setFil] = useState<File | null>(null);
  const [blad, setBlad] = useState<string[]>([]);
  const [valtBlad, setValtBlad] = useState(BLAD);
  const [iProjektplan, setIProjektplan] = useState(0);
  const typ = bladTyp(valtBlad);
  const [rader, setRader] = useState<Record<string, string>[] | null>(null);
  const [rubriker, setRubriker] = useState<string[]>([]);
  const [kanda, setKanda] = useState<Set<string>>(new Set());
  const [forhands, setForhands] = useState<Resultat | null>(null);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [utanKund, setUtanKund] = useState<UtanKund[] | null>(null);
  const [arbetar, setArbetar] = useState<string | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const filRef = useRef<HTMLInputElement>(null);

  function nollstall() {
    setRader(null); setRubriker([]); setForhands(null); setResultat(null);
    setUtanKund(null); setFel(null); setIProjektplan(0);
  }

  async function valjFil(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    nollstall();
    setFil(f);
    setArbetar("Öppnar filen…");
    try {
      const namn = await bladnamn(f);
      setBlad(namn);
      const traff = namn.find((n) => n.toLowerCase() === BLAD.toLowerCase()) ?? namn[0];
      setValtBlad(traff);
      await lasIn(f, traff);
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Kunde inte öppna filen.");
    } finally {
      setArbetar(null);
    }
  }

  async function lasIn(f: File, bladet: string) {
    setArbetar("Läser bladet…");
    setFel(null);
    try {
      const t = bladTyp(bladet);
      const b = await lasXlsx(f, bladet);
      let objekt = tillObjekt(b.rader);
      setIProjektplan(0);
      // Står fastigheten kvar i Projektplan gäller den, inte Avslutade.
      if (t === "avslutade") {
        const alla = await bladnamn(f);
        const pp = alla.find((n) => n.toLowerCase() === BLAD.toLowerCase());
        if (pp) {
          const aktiva = new Set(tillObjekt((await lasXlsx(f, pp)).rader).map(radNyckel));
          const kvar = objekt.filter((r) => !aktiva.has(radNyckel(r)));
          setIProjektplan(objekt.length - kvar.length);
          objekt = kvar;
        }
      }
      setRader(objekt);
      setRubriker((b.rader[0] || []).map((h) => String(h ?? "").trim()).filter(Boolean));

      const { data } = await supabase.rpc("projektplan_kanda_rubriker");
      const k = new Set<string>(((t === "flit" ? data?.flit : data?.falt) ?? []) as string[]);
      if (t !== "flit") { k.add("Fastighetsbeteckning"); k.add("Ort:"); }
      setKanda(k);

      await kor(objekt, true, t);
    } catch (err) {
      setFel(err instanceof Error ? err.message : "Kunde inte läsa bladet.");
      setRader(null);
    } finally {
      setArbetar(null);
    }
  }

  /** Kör i omgångar så att en stor fil inte blir ett enda långt anrop. */
  async function kor(objekt: Record<string, string>[], torrt: boolean, t: BladTyp = typ) {
    setArbetar(torrt ? "Räknar ut vad som skulle hända…" : "Läser in…");
    setFel(null);
    const summa: Resultat = {
      nya: 0, uppdaterade: 0, hoppade: 0, slangda_varden: 0,
      statusbyten: 0, kopplade_kunder: 0, torrkorning: torrt,
    };
    try {
      for (let i = 0; i < objekt.length; i += 60) {
        const { data, error } = await supabase.rpc(RPC[t], {
          p_rows: objekt.slice(i, i + 60),
          p_dry_run: torrt,
        });
        if (error) throw new DataError(error.code === "42501" ? "forbidden" : "unknown", error.message);
        const r = data as Resultat;
        summa.nya += r.nya ?? 0;
        summa.uppdaterade += r.uppdaterade ?? 0;
        summa.hoppade += r.hoppade ?? 0;
        summa.slangda_varden += r.slangda_varden ?? 0;
        summa.statusbyten = (summa.statusbyten ?? 0) + (r.statusbyten ?? 0);
        summa.kopplade_kunder = (summa.kopplade_kunder ?? 0) + (r.kopplade_kunder ?? 0);
      }
      if (torrt) setForhands(summa);
      else {
        setResultat(summa); setForhands(null);
        if (t === "flit") return;
        // Vilka leveranser fick ingen kund? Det är den lista någon behöver gå igenom.
        const { data } = await supabase.rpc("leveranser_utan_kund");
        setUtanKund((data ?? []) as UtanKund[]);
      }
    } catch (err) {
      setFel(err instanceof DataError ? err.message
        : err instanceof Error ? err.message : "Inläsningen misslyckades.");
    } finally {
      setArbetar(null);
    }
  }

  const okanda = rubriker.filter((h) => !kanda.has(h));

  return (
    <div className="page imp">
      <AutoImport />

      <div className="card imp__intro">
        <h2>Importera fil manuellt</h2>
        <p>
          Ladda upp <code>Projektplan CE.xlsx</code> och välj blad. <strong>{BLAD}</strong> och
          <strong> Avslutade</strong> blir leveranser (Avslutade får status 99. Avslutad) och matchas
          på fastighetsbeteckning och ort. <strong>FLIT-SDU</strong> läses in under Leveransprocess →
          FLIT-SDU och matchas på GA1-nr. Befintliga uppdateras, nya skapas. Att köra om samma
          fil ändrar ingenting, så du kan importera så ofta du vill.
        </p>

        <div className="imp__valj">
          <input ref={filRef} type="file" accept=".xlsx" onChange={valjFil} style={{ display: "none" }} />
          <button className="btn btn--brand" onClick={() => filRef.current?.click()} disabled={!!arbetar}>
            {fil ? "Välj en annan fil" : "Välj fil"}
          </button>
          {fil && <span className="imp__filnamn">{fil.name}</span>}

          {blad.length > 1 && (
            <select
              className="input" style={{ maxWidth: 220 }}
              value={valtBlad}
              onChange={(e) => { setValtBlad(e.target.value); if (fil) void lasIn(fil, e.target.value); }}
              disabled={!!arbetar}
            >
              {blad.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
        </div>

        {arbetar && <div className="imp__arbetar">{arbetar}</div>}
        {fel && <div className="formfield__error">{fel}</div>}
      </div>

      {rader && !fel && (
        <div className="card imp__forhands">
          <h3>Så här blir det</h3>

          <div className="imp__tal">
            <div className="imp__ruta">
              <span className="imp__n">{rader.length}</span>
              <span className="imp__l">Rader i bladet</span>
            </div>
            <div className="imp__ruta imp__ruta--ny">
              <span className="imp__n">{forhands?.nya ?? "–"}</span>
              <span className="imp__l">{typ === "flit" ? "Nya FLIT-SDU" : "Nya leveranser"}</span>
            </div>
            <div className="imp__ruta">
              <span className="imp__n">{forhands?.uppdaterade ?? "–"}</span>
              <span className="imp__l">Uppdateras</span>
            </div>
            <div className="imp__ruta">
              <span className="imp__n">{forhands?.hoppade ?? "–"}</span>
              <span className="imp__l">Hoppas över</span>
            </div>
          </div>

          {typ === "avslutade" && (
            <p className="imp__not">
              Alla rader i bladet får status <strong>99. Avslutad</strong>
              {iProjektplan > 0 && <> — {iProjektplan} fastigheter finns också i bladet {BLAD} och
              hoppas över, där gäller Projektplan</>}.
            </p>
          )}

          {forhands && forhands.hoppade > 0 && (
            <p className="imp__not">
              {typ === "flit"
                ? `${forhands.hoppade} rader saknar både GA1-nr, CS-nr, A-/KO-nr och fastighetsbeteckning och hoppas över.`
                : `${forhands.hoppade} rader saknar fastighetsbeteckning och hoppas över — utan den går de inte att matcha.`}
            </p>
          )}

          {forhands && forhands.slangda_varden > 0 && (
            <p className="imp__not">
              {forhands.slangda_varden} värden passar inte sitt fälts typ och skrivs inte in.
              Det är oftast nollor i datumkolumner och formelfel som <code>#REF!</code>.
            </p>
          )}

          {okanda.length > 0 && (
            <details className="imp__okanda">
              <summary>{okanda.length} kolumner känns inte igen och ignoreras</summary>
              <div className="imp__chips">
                {okanda.map((h) => <span key={h} className="imp__chip">{h || "(namnlös)"}</span>)}
              </div>
            </details>
          )}

          <div className="imp__fot">
            <button
              className="btn btn--brand"
              onClick={() => rader && kor(rader, false)}
              disabled={!!arbetar || !forhands}
            >
              Kör importen
            </button>
            <button className="btn btn--ghost" onClick={nollstall} disabled={!!arbetar}>
              Avbryt
            </button>
          </div>
        </div>
      )}

      {resultat && (
        <div className="card imp__klart">
          <h3>Klart</h3>
          <p>
            {resultat.nya} {typ === "flit" ? "nya FLIT-SDU" : "nya leveranser"}, {resultat.uppdaterade} uppdaterade
            {resultat.statusbyten ? `, varav ${resultat.statusbyten} bytte status` : ""}.
            {resultat.hoppade > 0 && ` ${resultat.hoppade} rader hoppades över.`}
            {resultat.kopplade_kunder
              ? ` ${resultat.kopplade_kunder} leveranser kopplades till kund.`
              : ""}
          </p>
          <p className="imp__not">
            Öppna {typ === "flit" ? "FLIT-SDU" : "Leveranser"} för att se dem. Listan uppdaterar sig själv, så har du
            den öppen i en annan flik har den redan hunnit ikapp.
          </p>
        </div>
      )}

      {utanKund && utanKund.length > 0 && (
        <div className="card imp__utankund">
          <h3>Leveranser utan kund</h3>
          <p className="imp__not">
            Kopplingen görs på fastighetsägarens namn. Dessa ägare finns inte som
            kundkort, så leveranserna ligger löst. Skapa kunden — nästa import
            kopplar dem själv.
          </p>
          <table className="imp__tabell">
            <thead>
              <tr><th>Fastighetsägare</th><th>Leveranser</th><th>Liknande kund</th></tr>
            </thead>
            <tbody>
              {utanKund.map((u, i) => (
                <tr key={i}>
                  <td>{u.agare ?? <em>saknar ägare i projektplanen</em>}</td>
                  <td>{u.antal}</td>
                  <td>
                    {u.narmaste_kund && (u.likhet ?? 0) >= 0.5
                      ? <>{u.narmaste_kund} <span className="imp__likhet">
                          {Math.round((u.likhet ?? 0) * 100)} %</span></>
                      : <span className="imp__likhet">ingen</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
