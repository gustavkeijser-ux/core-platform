import { useEffect, useMemo, useState } from "react";
import { TopbarActions } from "./PageChrome";
import { DataError } from "@/lib/data";
import {
  type CaseCategory, type LiknandeArende, PRIORITIES,
  arendeSkapa, assignableUsers, caseCategories, caseLiknande, searchLinkTargets,
} from "@/lib/cases";
import { supabase } from "@/integrations/supabase/client";

/**
 * Skapa ärende (Fas 3, skiss "Skapa ärende"): fyra steg — Vem, Var, Vad,
 * Hantering — och till höger liknande ärenden och en sammanfattning.
 * Obligatoriskt är kanal, kategori, beskrivning och någon uppgift om
 * anmälaren (eller "okänd avsändare"). Resten kan lämnas tomt.
 */

type Traff = { id: string; title: string | null; subtitle: string | null };

const KANALER: Array<[string, string]> = [["phone", "Telefon"], ["email", "E-post"], ["web", "Webb"], ["internal", "Personligt / internt"]];

export function SkapaArendePage({ onCancel, onCreated, onOpenCase }: {
  onCancel: () => void; onCreated: (id: string) => void; onOpenCase: (id: string) => void;
}) {
  const [namn, setNamn] = useState("");
  const [epost, setEpost] = useState("");
  const [telefon, setTelefon] = useState("");
  const [okand, setOkand] = useState(false);
  const [kanal, setKanal] = useState("phone");
  const [fastighet, setFastighet] = useState<Traff | null>(null);
  const [lagenhet, setLagenhet] = useState<Traff | null>(null);
  const [hittat, setHittat] = useState<Traff | null>(null);
  const [kategori, setKategori] = useState("");
  const [rubrik, setRubrik] = useState("");
  const [beskrivning, setBeskrivning] = useState("");
  const [prio, setPrio] = useState("normal");
  const [ansvarig, setAnsvarig] = useState("");
  const [deadline, setDeadline] = useState("");
  const [atgard, setAtgard] = useState("");
  const [cats, setCats] = useState<CaseCategory[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [me, setMe] = useState<string | null>(null);
  const [liknande, setLiknande] = useState<LiknandeArende[]>([]);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [visaFel, setVisaFel] = useState(false);

  useEffect(() => { caseCategories().then(setCats); assignableUsers().then(setUsers); }, []);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)); }, []);

  // Känd kund? Slå upp lägenheten på e-postadressen och föreslå den.
  useEffect(() => {
    const e = epost.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || lagenhet) { setHittat(null); return; }
    const t = window.setTimeout(() => {
      searchLinkTargets("d2d_lagenhet", e).then((h) => setHittat(h.length === 1 ? h[0] : null)).catch(() => setHittat(null));
    }, 400);
    return () => window.clearTimeout(t);
  }, [epost, lagenhet]);

  // Liknande ärenden på samma lägenhet, fastighet eller kund.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!lagenhet && !fastighet && !epost.includes("@")) { setLiknande([]); return; }
      caseLiknande({ lagenhet: lagenhet?.id, property: fastighet?.id, kundEpost: epost, category: kategori }).then(setLiknande);
    }, 300);
    return () => window.clearTimeout(t);
  }, [lagenhet, fastighet, epost, kategori]);

  const huvudkat = cats.filter((c) => !c.parent_key && !c.felanmalan); // felanmälningar skapas från säljarvyn
  const saknas = useMemo(() => {
    const s: string[] = [];
    if (!okand && !namn.trim() && !epost.trim() && !telefon.trim()) s.push("vem som anmäler (eller okänd avsändare)");
    if (!kategori) s.push("kategori");
    if (!beskrivning.trim()) s.push("beskrivning");
    return s;
  }, [okand, namn, epost, telefon, kategori, beskrivning]);

  async function skapa() {
    setVisaFel(true);
    if (saknas.length) { setFel(`Fyll i ${saknas.join(", ")}.`); return; }
    setBusy(true); setFel(null);
    try {
      const id = await arendeSkapa({
        title: rubrik.trim(), channel: kanal, kundNamn: okand ? "" : namn, kundEpost: epost, kundTelefon: telefon,
        body: beskrivning, priority: prio, category: kategori, ansvarig: ansvarig || null,
        deadline: deadline ? new Date(deadline).toISOString() : null, atgard,
        lagenhet: lagenhet?.id ?? null, property: fastighet?.id ?? null,
      });
      onCreated(id);
    } catch (e) {
      setFel(e instanceof DataError ? e.message : "Kunde inte skapa ärendet.");
      setBusy(false);
    }
  }

  const ogiltig = (villkor: boolean) => (visaFel && villkor ? " input--fel" : "");

  return (
    <div className="page ska">
      <TopbarActions>
        <button className="btn btn--ghost" onClick={onCancel}>Avbryt</button>
        <button className="btn btn--brand" disabled={busy} onClick={() => void skapa()}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
          <span className="btn__label">{busy ? "Skapar…" : "Skapa ärende"}</span>
        </button>
      </TopbarActions>

      <div className="ska__grid">
        <div className="card ska__steg">
          <Steg nr={1} titel="Vem">
            <div className="ska__rad">
              <Falt label="Namn" bred={2}>
                <input className={`input${ogiltig(!okand && !namn && !epost && !telefon)}`} value={namn} disabled={okand}
                  onChange={(e) => setNamn(e.target.value)} placeholder="Förnamn Efternamn" autoComplete="off" />
              </Falt>
              <Falt label="Kanal" req>
                <select className="input" value={kanal} onChange={(e) => setKanal(e.target.value)}>
                  {KANALER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Falt>
            </div>
            <div className="ska__rad">
              <Falt label="E-post">
                <input className="input" type="email" value={epost} onChange={(e) => setEpost(e.target.value)} placeholder="namn@exempel.se" autoComplete="off" />
              </Falt>
              <Falt label="Telefon">
                <input className="input" type="tel" value={telefon} onChange={(e) => setTelefon(e.target.value)} placeholder="070-123 45 67" autoComplete="off" />
              </Falt>
            </div>
            <label className="ska__check">
              <input type="checkbox" checked={okand} onChange={(e) => setOkand(e.target.checked)} />
              Okänd avsändare — ange e-post eller telefon om det finns
            </label>
            {hittat && !lagenhet && (
              <div className="ska__hittat">
                <span><strong>Hittat:</strong> {hittat.title}{hittat.subtitle ? ` · ${hittat.subtitle}` : ""}</span>
                <button className="linklike" onClick={() => { setLagenhet(hittat); setHittat(null); }}>Koppla lägenheten →</button>
              </div>
            )}
          </Steg>

          <Steg nr={2} titel="Var">
            <div className="ska__rad">
              <Falt label="Fastighet">
                <Sokval typ="property" valt={fastighet} onVal={setFastighet} placeholder="Sök fastighet eller adress…" />
              </Falt>
              <Falt label="Lägenhet">
                <Sokval typ="d2d_lagenhet" valt={lagenhet} onVal={setLagenhet} placeholder="Sök adress, lgh-nr eller e-post…" />
              </Falt>
            </div>
          </Steg>

          <Steg nr={3} titel="Vad">
            <div className={`ska__kat${visaFel && !kategori ? " ska__kat--fel" : ""}`} role="radiogroup" aria-label="Kategori">
              {huvudkat.map((c) => (
                <button key={c.key} type="button" role="radio" aria-checked={kategori === c.key}
                  className="chip" aria-pressed={kategori === c.key} onClick={() => setKategori(c.key)}>{c.label}</button>
              ))}
            </div>
            <Falt label="Rubrik">
              <input className="input" value={rubrik} onChange={(e) => setRubrik(e.target.value)} placeholder="T.ex. Internet fungerar inte" />
            </Falt>
            <Falt label="Beskrivning" req>
              <textarea className={`input input--area${ogiltig(!beskrivning.trim())}`} value={beskrivning}
                onChange={(e) => setBeskrivning(e.target.value)} placeholder="Vad har hänt? Sedan när? Har kunden provat något?" />
            </Falt>
            <p className="ska__hint">Bilagor och svar till kunden lägger du till i ärendet när det är skapat.</p>
          </Steg>

          <Steg nr={4} titel="Hantering">
            <div className="ska__rad ska__rad--fyra">
              <Falt label="Prioritet" req>
                <select className="input" value={prio} onChange={(e) => setPrio(e.target.value)}>
                  {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </Falt>
              <Falt label="Ansvarig">
                <select className="input" value={ansvarig} onChange={(e) => setAnsvarig(e.target.value)}>
                  <option value="">Ej tilldelad</option>
                  {me && <option value={me}>Jag</option>}
                  {users.filter((u) => u.id !== me).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Falt>
              <Falt label="Deadline">
                <input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Falt>
              <Falt label="Planerad åtgärd">
                <input className="input" value={atgard} onChange={(e) => setAtgard(e.target.value)} placeholder="T.ex. Tekniker bokas" />
              </Falt>
            </div>
            <p className="ska__hint">Utan deadline sätts den efter prioritetens svarstider.</p>
          </Steg>

          {fel && <div className="formfield__error ska__fel">{fel}</div>}
          <div className="ska__knappar">
            <button className="btn btn--ghost" onClick={onCancel}>Avbryt</button>
            <button className="btn btn--brand" disabled={busy} onClick={() => void skapa()}>{busy ? "Skapar…" : "Skapa ärende"}</button>
          </div>
        </div>

        <aside className="ska__sida">
          <div className="card ska__panel">
            <h3>Liknande ärenden</h3>
            {liknande.length === 0 ? (
              <p className="ska__tom">Visas när du angett kund, fastighet eller lägenhet.</p>
            ) : (
              <ul className="ska__lika">
                {liknande.map((l) => (
                  <li key={l.id}>
                    <button className="linklike" onClick={() => onOpenCase(l.id)}>
                      <strong>{l.caseNumber} · {l.title || "(Inget ämne)"}</strong>
                    </button>
                    <span>{l.varfor} · {l.status === "resolved" || l.status === "closed" ? "Avslutat" : "Öppet"} · {new Date(l.createdAt).toLocaleDateString("sv-SE", { day: "numeric", month: "short" })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card ska__panel">
            <h3>Sammanfattning</h3>
            <dl className="ska__summa">
              <dt>Anmälare</dt><dd>{okand ? "Okänd avsändare" : namn || epost || telefon || "—"}</dd>
              <dt>Kanal</dt><dd>{KANALER.find(([k]) => k === kanal)?.[1]}</dd>
              <dt>Plats</dt><dd>{[fastighet?.title, lagenhet?.title].filter(Boolean).join(" · ") || "—"}</dd>
              <dt>Kategori</dt><dd>{huvudkat.find((c) => c.key === kategori)?.label ?? "—"}</dd>
              <dt>Prioritet</dt><dd>{PRIORITIES.find((p) => p.key === prio)?.label}</dd>
              <dt>Ansvarig</dt><dd>{ansvarig ? (ansvarig === me ? "Jag" : users.find((u) => u.id === ansvarig)?.name) : "Ej tilldelad"}</dd>
            </dl>
          </div>
          <div className="ska__not">
            Obligatoriskt: anmälare (eller okänd avsändare), kanal, kategori, beskrivning och prioritet.
            Plats behövs för att nå fastigheten. Allt annat kan lämnas tomt.
          </div>
        </aside>
      </div>
    </div>
  );
}

function Steg({ nr, titel, children }: { nr: number; titel: string; children: React.ReactNode }) {
  return (
    <section className="ska__s">
      <span className="ska__nr" aria-hidden>{nr}</span>
      <div className="ska__innehall">
        <h2 className="ska__rubrik">{titel}</h2>
        {children}
      </div>
    </section>
  );
}

function Falt({ label, req, bred, children }: { label: string; req?: boolean; bred?: number; children: React.ReactNode }) {
  return (
    <label className="ska__falt" style={bred ? { flexGrow: bred } : undefined}>
      <span className="ska__label">{label}{req && <span className="req"> *</span>}</span>
      {children}
    </label>
  );
}

/** Sökbart val av fastighet eller lägenhet. */
function Sokval({ typ, valt, onVal, placeholder }: {
  typ: "property" | "d2d_lagenhet"; valt: Traff | null; onVal: (t: Traff | null) => void; placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [traffar, setTraffar] = useState<Traff[]>([]);
  const [oppen, setOppen] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setTraffar([]); return; }
    const t = window.setTimeout(() => { searchLinkTargets(typ, q).then(setTraffar).catch(() => setTraffar([])); }, 250);
    return () => window.clearTimeout(t);
  }, [q, typ]);

  if (valt) {
    return (
      <div className="sokval sokval--valt">
        <span><strong>{valt.title}</strong>{valt.subtitle && <span className="ink-faint"> · {valt.subtitle}</span>}</span>
        <button type="button" className="sokval__bort" aria-label="Ta bort" onClick={(e) => { e.preventDefault(); onVal(null); setQ(""); }}>×</button>
      </div>
    );
  }
  return (
    <div className="sokval">
      <input className="input" value={q} placeholder={placeholder} onChange={(e) => { setQ(e.target.value); setOppen(true); }}
        onFocus={() => setOppen(true)} onBlur={() => window.setTimeout(() => setOppen(false), 150)} autoComplete="off" />
      {oppen && traffar.length > 0 && (
        <ul className="sokval__lista">
          {traffar.map((t) => (
            <li key={t.id}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onVal(t); setOppen(false); }}>
                <span>{t.title || "—"}</span>{t.subtitle && <span className="ink-faint">{t.subtitle}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
