import { useEffect, useMemo, useRef, useState } from "react";
import { PinnKort, type PinnOversikt } from "./D2DLon";
import "@/styles/d2d.css";

/* =============================================================================
   Säljarprofiler i Blitz → Översikt (inspirerat av SalesTracker).

   ProfilRad     — en rad med alla säljare (du först) överst i översikten;
                   klick öppnar profilen. Alla ser allas profiler — tävling.
   SaljarProfil  — profilen som helskärmsark: placering denna månad, sälj
                   idag/vecka/månad/år, sälj per dag, pinnar mot nästa delmål
                   (egen lön bara på den egna profilen), rekord och senaste sälj.
   Fyrverkeri    — animerade fyrverkerier när den inloggade leder månadens
                   topplista (antal sälj inkl. Scrive). Visas när man går in i
                   översikten (en gång per dag och session) och när man öppnar
                   sin egen profil. Respekterar "minska rörelse".
   All statistik räknas i klienten från d2d_saljstatistik (samma som översikten).
   ========================================================================== */

export type ProfilSalj = { d: Date; u: string; p: string | null; s?: boolean };

const MANADER = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const pad = (n: number) => String(n).padStart(2, "0");
const dagNyckel = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const manadNyckel = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const startAvDag = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDagar = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startAvVecka = (d: Date) => plusDagar(startAvDag(d), -((d.getDay() + 6) % 7));

function relTid(t: Date): string {
  const min = Math.round((Date.now() - t.getTime()) / 60000);
  if (min < 1) return "nyss";
  if (min < 60) return `${min} min sedan`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h sedan`;
  const d = Math.round(h / 24);
  return d === 1 ? "i går" : `${d} dagar sedan`;
}

/** Initialer och en stabil färg per person (färgerna kommer från tokens.css). */
const AVATAR_HUES = ["--brand", "--hue-violet", "--hue-sky", "--hue-amber", "--hue-green", "--hue-red", "--hue-blue"];
function avatarFarg(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `var(${AVATAR_HUES[h % AVATAR_HUES.length]})`;
}
const initialer = (namn: string) => namn.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";

function Avatar({ id, namn, stor, krona }: { id: string; namn: string; stor?: boolean; krona?: boolean }) {
  return (
    <span className={`d2dp-avatar${stor ? " d2dp-avatar--stor" : ""}`} style={{ ["--av" as string]: avatarFarg(id) }} aria-hidden>
      {initialer(namn)}
      {krona && (
        <span className="d2dp-avatar__krona">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7l4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7z" /></svg>
        </span>
      )}
    </span>
  );
}

/** Månadens placering per säljare (lika antal = delad placering). */
export function manadsPlacering(salj: ProfilSalj[], nu = new Date()) {
  const man = manadNyckel(nu);
  const r = new Map<string, number>();
  for (const s of salj) if (manadNyckel(s.d) === man) r.set(s.u, (r.get(s.u) ?? 0) + 1);
  const sorterad = [...r.entries()].sort((a, b) => b[1] - a[1]);
  const plats = new Map<string, number>();
  sorterad.forEach(([u, n]) => plats.set(u, sorterad.findIndex(([, m]) => m === n) + 1));
  const max = sorterad[0]?.[1] ?? 0;
  return { antal: r, plats, ledare: max > 0 ? sorterad.filter(([, n]) => n === max).map(([u]) => u) : [], max, totalt: sorterad.length };
}

// ─── Raden med profiler ─────────────────────────────────────────────────────

export function ProfilRad({ saljare, minId, salj, onOpen }: {
  saljare: Array<{ id: string; namn: string }>; minId: string | null; salj: ProfilSalj[]; onOpen: (id: string) => void;
}) {
  const plac = useMemo(() => manadsPlacering(salj), [salj]);
  const lista = useMemo(() => {
    const ids = new Set([...saljare.map((s) => s.id), ...plac.antal.keys()]);
    const namn = new Map(saljare.map((s) => [s.id, s.namn]));
    return [...ids].map((id) => ({ id, namn: namn.get(id) ?? "Okänd", n: plac.antal.get(id) ?? 0 }))
      .sort((a, b) => (a.id === minId ? -1 : b.id === minId ? 1 : 0) || b.n - a.n || a.namn.localeCompare(b.namn, "sv"));
  }, [saljare, plac, minId]);
  if (lista.length === 0) return null;
  return (
    <section className="d2dd__section">
      <h2 className="d2dd__rubrik">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>
        Profiler
      </h2>
      <div className="d2dp-rad" role="list">
        {lista.map((p) => {
          const plats = plac.plats.get(p.id);
          return (
            <button key={p.id} type="button" role="listitem" className={`d2dp-rad__item${p.id === minId ? " d2dp-rad__item--jag" : ""}`} onClick={() => onOpen(p.id)}>
              <Avatar id={p.id} namn={p.namn} krona={plats === 1} />
              <span className="d2dp-rad__namn">{p.id === minId ? "Du" : p.namn.split(/\s+/)[0]}</span>
              <span className="d2dp-rad__plats">{plats ? `#${plats}` : "—"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ─── En säljares profil ─────────────────────────────────────────────────────

export function SaljarProfil({ id, namn, minId, salj, namnPa, pinnar, onClose, onFira }: {
  id: string; namn: string; minId: string | null; salj: ProfilSalj[]; namnPa: (id: string) => string;
  pinnar: PinnOversikt | null; onClose: () => void; onFira: () => void;
}) {
  const arJag = id === minId;
  const nu = new Date();
  const plac = useMemo(() => manadsPlacering(salj), [salj]);
  const egna = useMemo(() => salj.filter((s) => s.u === id).sort((a, b) => b.d.getTime() - a.d.getTime()), [salj, id]);

  // Esc stänger; ingen scroll bakom arket.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = prev; };
  }, [onClose]);

  const kpi = useMemo(() => {
    const dag = dagNyckel(nu), man = manadNyckel(nu), vStart = startAvVecka(nu), ar = nu.getFullYear();
    const r = { d: 0, v: 0, m: 0, a: 0, ds: 0, vs: 0, ms: 0, as: 0 };
    for (const s of egna) {
      if (dagNyckel(s.d) === dag) { r.d++; if (s.s) r.ds++; }
      if (s.d >= vStart) { r.v++; if (s.s) r.vs++; }
      if (manadNyckel(s.d) === man) { r.m++; if (s.s) r.ms++; }
      if (s.d.getFullYear() === ar) { r.a++; if (s.s) r.as++; }
    }
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [egna]);

  // Sälj per dag denna månad.
  const perDag = useMemo(() => {
    const dagar = new Date(nu.getFullYear(), nu.getMonth() + 1, 0).getDate();
    const v = Array.from({ length: dagar }, () => 0);
    const man = manadNyckel(nu);
    for (const s of egna) if (manadNyckel(s.d) === man) v[s.d.getDate() - 1]++;
    return v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [egna]);
  const maxDag = Math.max(1, ...perDag);

  // Rekord: snitt per arbetsdag, längsta streak, PB, antal #1-dagar/-månader.
  const rekord = useMemo(() => {
    if (egna.length === 0) return null;
    const stigande = [...egna].reverse();
    const dag = new Map<string, number>(), vecka = new Map<string, number>(), manad = new Map<string, number>();
    for (const s of stigande) {
      dag.set(dagNyckel(s.d), (dag.get(dagNyckel(s.d)) ?? 0) + 1);
      const vk = dagNyckel(startAvVecka(s.d));
      vecka.set(vk, (vecka.get(vk) ?? 0) + 1);
      manad.set(manadNyckel(s.d), (manad.get(manadNyckel(s.d)) ?? 0) + 1);
    }
    let arbetsdagar = 0, langst = 0, nuvarande = 0;
    const slut = startAvDag(new Date());
    for (let d = startAvDag(stigande[0].d); d <= slut; d = plusDagar(d, 1)) {
      const har = dag.has(dagNyckel(d));
      const vardag = d.getDay() !== 0 && d.getDay() !== 6;
      if (vardag) { arbetsdagar++; if (har) { nuvarande++; langst = Math.max(langst, nuvarande); } else if (d < slut) nuvarande = 0; }
      else if (har) { nuvarande++; langst = Math.max(langst, nuvarande); }
    }
    const bast = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    // #1-platser: jämför mot alla säljares dagar/månader.
    const allaDag = new Map<string, Map<string, number>>(), allaMan = new Map<string, Map<string, number>>();
    for (const s of salj) {
      for (const [k, n] of [[allaDag, dagNyckel(s.d)], [allaMan, manadNyckel(s.d)]] as const) {
        const m = k.get(n) ?? new Map<string, number>(); m.set(s.u, (m.get(s.u) ?? 0) + 1); k.set(n, m);
      }
    }
    const etta = (k: Map<string, Map<string, number>>) => {
      let n = 0;
      for (const m of k.values()) { const max = Math.max(...m.values()); if ((m.get(id) ?? 0) === max && max > 0) n++; }
      return n;
    };
    const [pdK, pdV] = bast(dag), [pvK, pvV] = bast(vecka), [pmK, pmV] = bast(manad);
    return {
      snitt: egna.length / Math.max(arbetsdagar, 1), streak: langst, totalt: egna.length,
      pbDag: { v: pdV, t: `${Number(pdK.slice(8))}/${Number(pdK.slice(5, 7))} ${pdK.slice(0, 4)}` },
      pbVecka: { v: pvV, t: `v. från ${Number(pvK.slice(8))}/${Number(pvK.slice(5, 7))}` },
      pbManad: { v: pmV, t: `${MANADER[Number(pmK.slice(5, 7)) - 1]} ${pmK.slice(0, 4)}` },
      ettaDagar: etta(allaDag), ettaManader: etta(allaMan),
    };
  }, [egna, salj, id]);

  const plats = plac.plats.get(id);
  const leder = plac.ledare.includes(id);
  const minAntal = plac.antal.get(id) ?? 0;
  const tvaa = [...plac.antal.entries()].filter(([u]) => u !== id).sort((a, b) => b[1] - a[1])[0];
  const placText = !plats ? "Inga sälj ännu denna månad"
    : leder ? (plac.ledare.length > 1 ? `Delad etta i ${MANADER[nu.getMonth()]}` : `Leder ${MANADER[nu.getMonth()]}${tvaa ? ` · ${minAntal - tvaa[1]} före ${namnPa(tvaa[0])}` : ""}`)
    : `#${plats} av ${plac.totalt} i ${MANADER[nu.getMonth()]} · ${plac.max - minAntal} sälj efter ${plac.ledare.map(namnPa).join(" & ")}`;

  // Fyrverkeri direkt när man öppnar sin egen profil och leder.
  useEffect(() => { if (arJag && leder) onFira(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const pinnRad = pinnar?.saljare.find((s) => s.id === id);
  const trappa = useMemo(() => [...(pinnar?.trappa ?? [])].sort((a, b) => a.pinnar - b.pinnar), [pinnar]);
  const idag = nu.getDate();

  return (
    <div className="d2dp-ark" role="dialog" aria-modal="true" aria-label={`Profil: ${namn}`}>
      <div className="d2dp-ark__topp">
        <button type="button" className="d2dp-ark__stang" onClick={onClose} aria-label="Stäng profilen">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
          Översikt
        </button>
      </div>

      <div className="d2dp-ark__innehall">
        <header className={`d2dp-huvud${leder ? " d2dp-huvud--ledare" : ""}`}>
          <Avatar id={id} namn={namn} stor krona={leder} />
          <div className="d2dp-huvud__text">
            <h2>{namn}{arJag && <span className="d2dd__du">du</span>}</h2>
            <span className={`d2dp-huvud__plac${leder ? " d2dp-huvud__plac--ledare" : ""}`}>{placText}</span>
          </div>
          {arJag && leder && (
            <button type="button" className="btn btn--ghost btn--sm d2dp-huvud__fira" onClick={onFira}>Fira igen</button>
          )}
        </header>

        <div className="d2dd__kpis d2dp-kpis">
          {([["Idag", kpi.d, kpi.ds], ["Vecka", kpi.v, kpi.vs], ["Månad", kpi.m, kpi.ms], ["År", kpi.a, kpi.as]] as const).map(([e, n, sc]) => (
            <div key={e} className="d2dd__kpi">
              <span className="d2dd__kpi-varde">{n}{sc > 0 && <span className="d2dd__scrive">({sc})</span>}</span>
              <span className="d2dd__kpi-etikett">{e}</span>
            </div>
          ))}
        </div>

        {pinnRad && (
          <section className="d2dd__section">
            <h3 className="d2dp-h3">Pinnar — {MANADER[nu.getMonth()]}</h3>
            <PinnKort s={pinnRad} trappa={trappa} jag={arJag} lon={arJag ? pinnar?.minLon : undefined} />
          </section>
        )}

        <section className="d2dd__section">
          <h3 className="d2dp-h3">Sälj per dag — {MANADER[nu.getMonth()]}</h3>
          <div className="d2dp-dagar" role="img" aria-label={`Sälj per dag i ${MANADER[nu.getMonth()]}: totalt ${kpi.m}`}>
            {perDag.map((n, i) => (
              <div key={i} className={`d2dp-dagar__stapel${i + 1 === idag ? " d2dp-dagar__stapel--idag" : ""}${i + 1 > idag ? " d2dp-dagar__stapel--framtid" : ""}`}
                title={`${i + 1} ${MANADER[nu.getMonth()]}: ${n} sälj`}>
                <span style={{ height: `${(n / maxDag) * 100}%` }}>{n > 0 && <em>{n}</em>}</span>
              </div>
            ))}
          </div>
          <div className="d2dp-dagar__axel"><span>1</span><span>{Math.ceil(perDag.length / 2)}</span><span>{perDag.length}</span></div>
        </section>

        {rekord && (
          <section className="d2dd__section">
            <h3 className="d2dp-h3">Rekord</h3>
            <div className="d2dp-rekord">
              <div><strong>{rekord.totalt}</strong><span>sälj totalt</span></div>
              <div><strong>{rekord.snitt.toFixed(2).replace(".", ",")}</strong><span>snitt / arbetsdag</span></div>
              <div><strong>{rekord.streak} d</strong><span>längsta streak</span></div>
              <div><strong>{rekord.pbDag.v}</strong><span>PB dag · {rekord.pbDag.t}</span></div>
              <div><strong>{rekord.pbVecka.v}</strong><span>PB vecka · {rekord.pbVecka.t}</span></div>
              <div><strong>{rekord.pbManad.v}</strong><span>PB månad · {rekord.pbManad.t}</span></div>
              <div className="d2dp-rekord--guld"><strong>{rekord.ettaDagar}</strong><span>dagar som #1</span></div>
              <div className="d2dp-rekord--guld"><strong>{rekord.ettaManader}</strong><span>månader som #1</span></div>
            </div>
          </section>
        )}

        <section className="d2dd__section">
          <h3 className="d2dp-h3">Senaste sälj</h3>
          {egna.length === 0 ? <div className="d2dd__tom">Inga sälj ännu</div> : (
            <ul className="d2dd__aktivitet">
              {egna.slice(0, 10).map((s, i) => (
                <li key={i}>
                  <span className={`d2dd__plus${s.s ? " d2dd__plus--scrive" : ""}`}>+1</span>
                  <span className="d2dd__akt-namn">{s.s && <span className="d2dd__akt-scrive">Scrive</span>}{s.p ? <span className="d2dd__akt-projekt">{s.p}</span> : "Sälj"}</span>
                  <span className="d2dd__akt-tid" title={s.d.toLocaleString("sv-SE")}>{relTid(s.d)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Fyrverkeri ─────────────────────────────────────────────────────────────

type Partikel = { x: number; y: number; vx: number; vy: number; liv: number; max: number; farg: string; storlek: number };
type Raket = { x: number; y: number; vy: number; malY: number; farg: string };

export function Fyrverkeri({ text, onDone }: { text: string; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tona, setTona] = useState(false);
  const reducera = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const slut = window.setTimeout(() => setTona(true), reducera ? 2500 : 5200);
    const bort = window.setTimeout(onDone, reducera ? 2900 : 5800);
    return () => { window.clearTimeout(slut); window.clearTimeout(bort); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (reducera) return;
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const storlek = () => { c.width = window.innerWidth * dpr; c.height = window.innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    storlek();
    window.addEventListener("resize", storlek);

    // Färger från designsystemet (tokens.css), inga hårdkodade.
    const cs = getComputedStyle(document.documentElement);
    const farger = ["--brand", "--hue-amber", "--hue-green", "--hue-red", "--hue-violet", "--hue-sky"]
      .map((v) => cs.getPropertyValue(v).trim()).filter(Boolean);
    const slump = (a: number, b: number) => a + Math.random() * (b - a);
    const raketer: Raket[] = [], partiklar: Partikel[] = [];
    let skjutna = 0, senast = 0, raf = 0;
    const start = performance.now();

    const skjut = () => {
      const w = window.innerWidth, h = window.innerHeight;
      raketer.push({ x: slump(w * 0.15, w * 0.85), y: h + 10, vy: slump(-11, -8.5), malY: slump(h * 0.15, h * 0.45), farg: farger[Math.floor(Math.random() * farger.length)] });
      skjutna++;
    };
    const small = (r: Raket) => {
      const n = 90 + Math.floor(Math.random() * 50);
      for (let i = 0; i < n; i++) {
        const v = (Math.PI * 2 * i) / n + slump(-0.05, 0.05), fart = slump(2, 6.5);
        partiklar.push({ x: r.x, y: r.y, vx: Math.cos(v) * fart, vy: Math.sin(v) * fart, liv: 0, max: slump(55, 85),
          farg: Math.random() < 0.8 ? r.farg : farger[Math.floor(Math.random() * farger.length)], storlek: slump(2.2, 3.6) });
      }
    };
    const steg = (t: number) => {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (t - start < 4200 && t - senast > (skjutna < 3 ? 220 : 420)) { skjut(); if (Math.random() < 0.4) skjut(); senast = t; }
      for (let i = raketer.length - 1; i >= 0; i--) {
        const r = raketer[i];
        r.y += r.vy; r.vy *= 0.985;
        ctx.globalAlpha = 1; ctx.fillStyle = r.farg;
        ctx.beginPath(); ctx.arc(r.x, r.y, 2.4, 0, Math.PI * 2); ctx.fill();
        if (r.y <= r.malY || r.vy > -2) { small(r); raketer.splice(i, 1); }
      }
      for (let i = partiklar.length - 1; i >= 0; i--) {
        const p = partiklar[i];
        p.liv++; p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.06; p.x += p.vx; p.y += p.vy;
        const kvar = 1 - p.liv / p.max;
        if (kvar <= 0) { partiklar.splice(i, 1); continue; }
        // Strimma bakåt längs rörelsen + ett glänsande huvud = tydlig "smäll".
        ctx.globalAlpha = kvar; ctx.strokeStyle = p.farg; ctx.fillStyle = p.farg;
        ctx.lineWidth = p.storlek * (0.5 + kvar * 0.5); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(p.x - p.vx * 4, p.y - p.vy * 4); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, p.storlek * (0.7 + kvar * 0.5), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (t - start < 6000) raf = requestAnimationFrame(steg);
    };
    raf = requestAnimationFrame(steg);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", storlek); };
  }, [reducera]);

  return (
    <div className={`d2dp-fyr${tona ? " d2dp-fyr--tona" : ""}`} onClick={onDone} role="status" aria-live="polite">
      <canvas ref={ref} className="d2dp-fyr__canvas" aria-hidden />
      <div className="d2dp-fyr__text">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M3 7l4.5 4L12 5l4.5 6L21 7l-2 11H5L3 7z" /></svg>
        <span>{text}</span>
      </div>
    </div>
  );
}
