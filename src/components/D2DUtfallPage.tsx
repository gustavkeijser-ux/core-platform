import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { FilterPills, SkeletonRows } from "./PageChrome";

/* =============================================================================
   Door to door → Utfall. Vad som hände vid dörrarna: utfall, merförsäljning
   på sålda kunder, varför kunder säger nej och när deras bindningar löper ut
   (med återringningslista). Allt räknas i databasen (d2d_utfall).
   ========================================================================== */

type Kommentar = { id: string; adress: string; ort: string | null; kommentar: string | null; saljare: string | null };
type Rad = { id: string; adress: string; ort: string | null; status: string; bunden: string; tjanst: string[]; operator: string | null; saljare: string | null; kommentar: string | null };
type Utfall = {
  besok: number;
  statusar: Record<string, number>;
  sald: { antal: number; merAnBredband: number; kategorier: Record<string, number>; ejMer: Record<string, number>; ejMerUtanSkal: number };
  ejMerKommentarer?: Record<string, Kommentar[]>;
  ejIntresserad: Record<string, number>;
  bindningar: { hushall: number; ejSalda: number; svaradeEjSalda: number; perManad: Record<string, number>; tjanst: Record<string, number>; operator: Record<string, number> };
  perSaljare: Array<{ id: string; namn: string | null; besok: number; oppnade: number; salda: number; mer: number }>;
  aterringning: Rad[];
  projekt: Array<{ id: string; title: string | null }>;
  saljare: Array<{ id: string; namn: string | null }>;
};

const STATUS: Record<string, string> = {
  sald: "Såld", scrive: "Signera med Scrive", aterkoppling: "Återkoppling", inte_intresserad: "Inte intresserad", ovrigt: "Övrigt", inte_hemma: "Inte hemma",
};
const KATEGORI: Array<[string, string]> = [
  ["bredband", "Bredband"], ["tv", "TV"], ["mobil_huvud", "Mobil – huvudabonnemang"], ["mobil_extra", "Mobil – extra användare"],
  ["streaming_film", "Streaming film och serier"], ["streaming_sport", "Sportpaket"], ["trygghet", "Trygghetspaket"],
];
const EJ_MER: Record<string, string> = {
  tittar_lite: "Tittar lite på TV/streaming", mobil_bunden: "Mobilen är bunden", har_telia: "Har redan Telia",
  familj_betalar: "Någon annan betalar", billig_mobil: "Billig mobil, nöjd", pris: "Priset", vill_fundera: "Vill fundera",
  flodet: "Gick inte att välja i flödet", annat: "Annat",
};
const EJ_INTR: Record<string, string> = {
  bindningstid: "Bunden hos annan operatör", for_gammal: "För gammal / bara TV", saknar_behov: "Saknar behov",
  vill_inte_ha_fiber: "Vill inte ha fiber", flyttar: "Flyttar", dalig_ekonomi: "Dålig ekonomi", saknas: "Ingen anledning vald",
};
const TJANST: Record<string, string> = { mbb: "Mobilt bredband", mobil: "Mobil", bredband: "Fast bredband", tv: "TV" };
const OPERATOR: Record<string, string> = {
  telenor: "Telenor", tele2: "Tele2", tre: "Tre", comviq: "Comviq", telia: "Telia", bahnhof: "Bahnhof",
  bredband2: "Bredband2", allente: "Allente", hallon: "Hallon", annan: "Annan", okand: "Inte angivet",
};
const MANAD = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const manadStr = (m: string) => { const [y, mm] = m.split("-"); return `${MANAD[Number(mm) - 1] ?? mm} ${y}`; };
const nuManad = () => new Date().toISOString().slice(0, 7);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

type Period = "7" | "30" | "ar" | "allt";
function periodFran(p: Period): string | null {
  const d = new Date();
  if (p === "7") d.setDate(d.getDate() - 7);
  else if (p === "30") d.setDate(d.getDate() - 30);
  else if (p === "ar") return `${d.getFullYear()}-01-01`;
  else return null;
  return d.toISOString().slice(0, 10);
}

function Staplar({ rader, ton = "accent", tom = "Inget att visa ännu." }: {
  rader: Array<[string, number]>; ton?: "accent" | "warn" | "dim"; tom?: string;
}) {
  const max = Math.max(1, ...rader.map(([, n]) => n));
  if (!rader.some(([, n]) => n > 0)) return <p className="formfield__help">{tom}</p>;
  return (
    <div className="utf-bars">
      {rader.map(([lbl, n]) => (
        <div key={lbl} className={`utf-bar utf-bar--${ton}`}>
          <span className="utf-bar__lbl">{lbl}</span>
          <span className="utf-bar__track"><span className="utf-bar__fill" style={{ width: `${(n / max) * 100}%` }} /></span>
          <span className="utf-bar__n">{n}</span>
        </div>
      ))}
    </div>
  );
}

/** Staplar som går att fälla ut och visar kommentarerna bakom varje skäl. */
function SkalLista({ rader, onOpen }: {
  rader: Array<{ key: string; lbl: string; n: number; poster: Kommentar[] }>;
  onOpen: (id: string) => void;
}) {
  const max = Math.max(1, ...rader.map((r) => r.n));
  if (!rader.some((r) => r.n > 0)) return <p className="formfield__help">Inga skäl ifyllda ännu.</p>;
  return (
    <div className="utf-bars">
      {rader.map((r) => (
        <details key={r.key} className="utf-skal">
          <summary className={`utf-bar utf-bar--${r.key === "saknas" ? "dim" : "warn"}`}>
            <span className="utf-bar__lbl"><span className="utf-skal__pil" aria-hidden>›</span>{r.lbl}</span>
            <span className="utf-bar__track"><span className="utf-bar__fill" style={{ width: `${(r.n / max) * 100}%` }} /></span>
            <span className="utf-bar__n">{r.n}</span>
          </summary>
          <ul className="utf-skal__lista">
            {r.poster.map((k) => (
              <li key={k.id}>
                <button type="button" className="utf-skal__adress" onClick={() => onOpen(k.id)}>
                  {k.adress}{k.ort ? `, ${k.ort}` : ""}
                </button>
                {k.saljare && <span className="utf__sub"> · {k.saljare}</span>}
                <p className={k.kommentar ? "utf-skal__text" : "utf-skal__text utf-skal__text--tom"}>{k.kommentar ?? "Ingen kommentar."}</p>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

const sortera = (o: Record<string, number>, etiketter: Record<string, string>, sist = ["saknas", "okand", "annat"]) =>
  Object.entries(o)
    .sort((a, b) => (sist.includes(a[0]) ? 1 : 0) - (sist.includes(b[0]) ? 1 : 0) || b[1] - a[1])
    .map(([k, n]) => [etiketter[k] ?? k, n] as [string, number]);

export function D2DUtfallPage({ onOpenRecord }: { onOpenRecord: (id: string) => void }) {
  const [period, setPeriod] = useState<Period>("30");
  const [projekt, setProjekt] = useState("");
  const [saljare, setSaljare] = useState("");
  const [u, setU] = useState<Utfall | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [horisont, setHorisont] = useState<"3" | "6" | "alla">("6");

  useEffect(() => {
    let on = true;
    setU(null); setFel(null);
    supabase.rpc("d2d_utfall", {
      p_projekt: projekt || null, p_saljare: saljare || null, p_fran: periodFran(period), p_till: null,
    }).then(({ data, error }) => {
      if (!on) return;
      if (error) setFel(error.message); else setU(data as Utfall);
    });
    return () => { on = false; };
  }, [period, projekt, saljare]);

  // Bindningar per kvartal (år utan månad och okända för sig).
  const kvartal = useMemo(() => {
    if (!u) return [] as Array<{ key: string; lbl: string; n: number; snart: boolean; okand: boolean }>;
    const nu = nuManad();
    const om6 = (() => { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 7); })();
    const m = new Map<string, { lbl: string; n: number; snart: boolean; okand: boolean }>();
    for (const [k, n] of Object.entries(u.bindningar.perManad)) {
      let key: string, lbl: string, snart = false, okand = false;
      if (/^\d{4}-\d{2}$/.test(k)) {
        const [y, mm] = k.split("-").map(Number);
        const q = Math.floor((mm - 1) / 3);
        key = `${y}-${q}`;
        lbl = `${MANAD[q * 3]}–${MANAD[q * 3 + 2]} ${y}`;
        snart = k <= om6;
        if (k < nu) { key = "0-passerad"; lbl = "Redan löpt ut"; snart = true; }
      } else if (/^\d{4}$/.test(k)) { key = `${k}-9`; lbl = `${k}, okänd månad`; okand = true; }
      else { key = "9999"; lbl = "Okänt datum"; okand = true; }
      const cur = m.get(key) ?? { lbl, n: 0, snart, okand };
      cur.n += n; cur.snart = cur.snart || snart;
      m.set(key, cur);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ key, ...v }));
  }, [u]);

  const lista = useMemo(() => {
    if (!u) return [];
    if (horisont === "alla") return u.aterringning;
    const d = new Date(); d.setMonth(d.getMonth() + Number(horisont));
    const grans = d.toISOString().slice(0, 7);
    return u.aterringning.filter((r) => r.bunden <= grans);
  }, [u, horisont]);

  const s = u?.statusar ?? {};
  const oppnade = u ? u.besok - (s.inte_hemma ?? 0) : 0;
  const maxKv = Math.max(1, ...kvartal.map((k) => k.n));
  const baraBredband = u ? u.sald.antal - u.sald.merAnBredband : 0;

  return (
    <div className="page utf">
      <div className="utf__filter">
        <FilterPills
          active={period}
          onSelect={(k) => setPeriod(k as Period)}
          items={[{ key: "7", label: "7 dagar" }, { key: "30", label: "30 dagar" }, { key: "ar", label: "I år" }, { key: "allt", label: "Allt" }]}
        />
        <select className="input input--sm" aria-label="Projekt" value={projekt} onChange={(e) => setProjekt(e.target.value)}>
          <option value="">Alla projekt</option>
          {u?.projekt.map((p) => <option key={p.id} value={p.id}>{p.title ?? "Namnlöst projekt"}</option>)}
        </select>
        <select className="input input--sm" aria-label="Säljare" value={saljare} onChange={(e) => setSaljare(e.target.value)}>
          <option value="">Alla säljare</option>
          {u?.saljare.map((x) => <option key={x.id} value={x.id}>{x.namn ?? "Okänd"}</option>)}
        </select>
      </div>

      {fel && <div className="formfield__error">{fel}</div>}
      {!u && !fel && <div className="card"><SkeletonRows rows={6} /></div>}

      {u && u.besok === 0 && (
        <div className="card utf__tom">Inga besök i det här urvalet. Ej knackade dörrar räknas inte.</div>
      )}

      {u && u.besok > 0 && (<>
        <div className="utf__tiles">
          <div className="utf__tile"><b>{u.besok}</b><span>knackade dörrar</span></div>
          <div className="utf__tile"><b>{oppnade}</b><span>öppnade ({pct(oppnade, u.besok)} %)</span></div>
          <div className="utf__tile"><b>{u.sald.antal}</b><span>sålda ({pct(u.sald.antal, oppnade)} % av öppnade)</span></div>
          <div className="utf__tile"><b>{u.sald.merAnBredband} av {u.sald.antal}</b><span>köpte mer än bredband</span></div>
        </div>

        <section className="card utf__sek">
          <h2>Utfall av besöken</h2>
          <div className="utf__stack" role="img" aria-label="Fördelning av utfall">
            {["sald", "scrive", "aterkoppling", "inte_intresserad", "ovrigt", "inte_hemma"].filter((k) => (s[k] ?? 0) > 0).map((k) => (
              <div key={k} className={`utf__seg utf__seg--${k}`} style={{ flex: s[k] }} title={`${STATUS[k]}: ${s[k]}`}>{s[k]}</div>
            ))}
          </div>
          <div className="utf__legend">
            {["sald", "scrive", "aterkoppling", "inte_intresserad", "ovrigt", "inte_hemma"].filter((k) => k !== "scrive" || (s[k] ?? 0) > 0).map((k) => (
              <span key={k}><i className={`utf__seg--${k}`} />{STATUS[k]} {s[k] ?? 0}</span>
            ))}
          </div>
        </section>

        <section className="card utf__sek">
          <h2>Sålda kunder</h2>
          <div className="utf__two">
            <div>
              <h3>Sålda tjänster</h3>
              <Staplar rader={KATEGORI.map(([k, l]) => [l, u.sald.kategorier[k] ?? 0])} tom="Inga tjänster ifyllda." />
              {(u.sald.kategorier.bredbandUtanUppgift ?? 0) > 0 && (
                <p className="formfield__help">{u.sald.kategorier.bredbandUtanUppgift} äldre affärer saknar ifyllda tjänster och räknas som bredband.</p>
              )}
            </div>
            <div>
              <h3>Varför {baraBredband} bara tog bredband</h3>
              <SkalLista
                onOpen={onOpenRecord}
                rader={[
                  ...Object.entries(u.sald.ejMer).sort((a, b) => (a[0] === "annat" ? 1 : 0) - (b[0] === "annat" ? 1 : 0) || b[1] - a[1])
                    .map(([k, n]) => ({ key: k, lbl: EJ_MER[k] ?? k, n, poster: u.ejMerKommentarer?.[k] ?? [] })),
                  ...(u.sald.ejMerUtanSkal > 0
                    ? [{ key: "saknas", lbl: "Inget skäl valt", n: u.sald.ejMerUtanSkal, poster: u.ejMerKommentarer?.saknas ?? [] }]
                    : []),
                ]}
              />
              <p className="formfield__help">Klicka på ett skäl för att se säljarnas kommentarer.</p>
            </div>
          </div>
        </section>

        <section className="card utf__sek">
          <h2>Bindningstider</h2>
          <p className="utf__ingress">
            {u.bindningar.ejSalda} av {u.bindningar.svaradeEjSalda} som öppnade men inte köpte är bundna hos en annan operatör
            ({pct(u.bindningar.ejSalda, u.bindningar.svaradeEjSalda)} %). Totalt {u.bindningar.hushall} hushåll med bindning.
          </p>
          {kvartal.length > 0 && (
            <div className="utf__cols-wrap">
              <div className="utf__cols" style={{ gridTemplateColumns: `repeat(${kvartal.length}, minmax(56px, 1fr))` }}>
                {kvartal.map((k) => (
                  <div key={k.key} className={`utf__col${k.snart ? " utf__col--snart" : ""}${k.okand ? " utf__col--okand" : ""}`}>
                    <span className="utf__col-v">{k.n}</span>
                    <span className="utf__col-b" style={{ height: `${(k.n / maxKv) * 100}%` }} />
                  </div>
                ))}
              </div>
              <div className="utf__xl" style={{ gridTemplateColumns: `repeat(${kvartal.length}, minmax(56px, 1fr))` }}>
                {kvartal.map((k) => <span key={k.key}>{k.lbl}</span>)}
              </div>
            </div>
          )}
          <div className="utf__two">
            <div><h3>Bunden tjänst</h3><Staplar rader={sortera(u.bindningar.tjanst, TJANST)} /></div>
            <div><h3>Operatör</h3><Staplar rader={sortera(u.bindningar.operator, OPERATOR)} /></div>
          </div>
        </section>

        <section className="card utf__sek">
          <div className="utf__sekhuvud">
            <h2>Ring när bindningen löper ut</h2>
            <FilterPills
              active={horisont}
              onSelect={(k) => setHorisont(k as "3" | "6" | "alla")}
              items={[{ key: "3", label: "3 mån" }, { key: "6", label: "6 mån" }, { key: "alla", label: "Alla" }]}
            />
          </div>
          {lista.length === 0 ? <p className="formfield__help">Inga bindningar med datum i det här urvalet.</p> : (
            <div className="rtable-scroll">
              <table className="rtable utf__tabell">
                <thead><tr><th>Löper ut</th><th>Adress</th><th>Utfall</th><th>Bundet</th><th>Säljare</th></tr></thead>
                <tbody>
                  {lista.map((r) => (
                    <tr key={r.id} className="rtable__row rtable__row--click" onClick={() => onOpenRecord(r.id)}>
                      <td data-label="Löper ut" className="rtable__title">
                        <span className={r.bunden < nuManad() ? "utf__passerad" : ""}>{manadStr(r.bunden)}</span>
                        {r.bunden < nuManad() && <small className="utf__sub"> löpt ut</small>}
                      </td>
                      <td data-label="Adress"><span>{r.adress}{r.ort && <small className="utf__sub"> {r.ort}</small>}</span></td>
                      <td data-label="Utfall">{STATUS[r.status] ?? r.status}</td>
                      <td data-label="Bundet"><span>{[r.tjanst.map((t) => TJANST[t] ?? t).join(", "), r.operator ? OPERATOR[r.operator] ?? r.operator : ""].filter(Boolean).join(" · ") || "–"}</span></td>
                      <td data-label="Säljare">{r.saljare ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card utf__sek">
          <h2>Inte intresserade</h2>
          <Staplar ton="warn" rader={sortera(u.ejIntresserad, EJ_INTR)} tom="Inga i urvalet." />
        </section>

        {u.perSaljare.length > 0 && (
          <section className="card utf__sek">
            <h2>Per säljare</h2>
            <div className="rtable-scroll">
              <table className="rtable utf__tabell">
                <thead><tr><th>Säljare</th><th>Besök</th><th>Öppnade</th><th>Sålda</th><th>Mer än bredband</th></tr></thead>
                <tbody>
                  {u.perSaljare.map((p) => (
                    <tr key={p.id} className="rtable__row">
                      <td className="rtable__title" data-label="Säljare">{p.namn ?? "Okänd"}</td>
                      <td data-label="Besök" className="utf__num">{p.besok}</td>
                      <td data-label="Öppnade" className="utf__num">{p.oppnade}</td>
                      <td data-label="Sålda" className="utf__num">{p.salda} ({pct(p.salda, p.oppnade)} %)</td>
                      <td data-label="Mer än bredband" className="utf__num">{p.mer} av {p.salda}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <p className="formfield__help">
          Period räknas på senaste kontakt. Bindningar och skäl kommer från säljarnas val i D2D-vyn; för besöken före 2 oktober 2026 är de ifyllda i efterhand ur anteckningarna.
        </p>
      </>)}
    </div>
  );
}
