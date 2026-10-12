import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { EmptyState, FilterPills, SkeletonRows } from "./PageChrome";
import { dagarTill } from "./MobilNummer";
import "@/styles/d2d.css";

/**
 * VT-beställningar: signerade Scrive-avtal som ska beställas i VT.
 * Skapas automatiskt när avtalet signeras (d2d_vt_sync_lagenhet).
 * Mobil: helst 45, senast 30 dagar före startdatum. Övrigt: senast 30 dagar före.
 * Säljaren ser sina i D2D-sälj → Signerade, admin ser alla under Door to door → VT-beställningar.
 * Både säljaren och admin kan markera "Beställd i VT" (d2d_vt_markera).
 */

export type VtBestallning = {
  id: string; status: "oppen" | "bestalld" | "makulerad"; kund: string | null; adress: string | null;
  lagenhetId: string | null; harMobil: boolean; startdatum: string | null; mobilStartdatum: string | null;
  helst: string | null; senast: string | null; bestalldAt: string | null; bestalldAv: string | null;
  saljare: string | null; mine: boolean;
};

type Lage = "sen" | "akut" | "helst" | "ok" | "saknas";
const LAGE: Record<Lage, { label: string; rank: number }> = {
  sen: { label: "Försenad", rank: 0 },
  saknas: { label: "Startdatum saknas", rank: 1 },
  akut: { label: "Bråttom", rank: 2 },
  helst: { label: "Beställ nu", rank: 3 },
  ok: { label: "Gott om tid", rank: 4 },
};

function lage(b: VtBestallning): Lage {
  const senast = b.senast ? dagarTill(b.senast) : null;
  const helst = b.helst ? dagarTill(b.helst) : null;
  if (senast === null) return "saknas";
  if (senast < 0) return "sen";
  if (senast <= 3) return "akut";
  if ((helst !== null && helst <= 0) || senast <= 10) return "helst";
  return "ok";
}

const fmt = (iso: string | null | undefined) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "—";
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
};

function kvarText(iso: string | null) {
  const n = iso ? dagarTill(iso.slice(0, 10)) : null;
  if (n === null) return "";
  if (n < 0) return `${-n} ${-n === 1 ? "dag" : "dagar"} sen`;
  if (n === 0) return "i dag";
  return `om ${n} ${n === 1 ? "dag" : "dagar"}`;
}

export async function hamtaVtBestallningar(): Promise<VtBestallning[]> {
  const { data, error } = await supabase.rpc("d2d_vt_mina");
  if (error) throw new Error(error.message);
  return (data ?? []) as VtBestallning[];
}

async function markera(id: string, bestalld: boolean) {
  const { error } = await supabase.rpc("d2d_vt_markera", { p_id: id, p_bestalld: bestalld });
  if (error) throw new Error(error.message);
}

function sortera(lista: VtBestallning[]) {
  return [...lista].sort((a, b) =>
    LAGE[lage(a)].rank - LAGE[lage(b)].rank || (a.senast ?? "").localeCompare(b.senast ?? ""));
}

/* ── En rad ─────────────────────────────────────────────────────────── */

function VtRad({ b, visaSaljare, onAndrad, onOpenLagenhet }: {
  b: VtBestallning; visaSaljare: boolean; onAndrad: () => void; onOpenLagenhet?: (id: string) => void;
}) {
  const [bekrafta, setBekrafta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const oppen = b.status === "oppen";
  const l = oppen ? lage(b) : null;

  const kor = async (bestalld: boolean) => {
    setBusy(true); setFel(null);
    try { await markera(b.id, bestalld); setBekrafta(false); onAndrad(); }
    catch (e) { setFel(e instanceof Error ? e.message : "Något gick fel."); }
    finally { setBusy(false); }
  };

  return (
    <li className={`vt-rad${l ? ` vt-rad--${l}` : " vt-rad--klar"}`}>
      <div className="vt-rad__text">
        {onOpenLagenhet && b.lagenhetId ? (
          <button type="button" className="linklike vt-rad__kund" onClick={() => onOpenLagenhet(b.lagenhetId!)}>{b.kund ?? "Okänd kund"}</button>
        ) : <strong className="vt-rad__kund">{b.kund ?? "Okänd kund"}</strong>}
        <span className="vt-rad__adress">{b.adress}</span>
        <span className="vt-rad__meta">
          {[`Start ${fmt(b.startdatum)}`, b.harMobil ? `Mobil ${fmt(b.mobilStartdatum ?? b.startdatum)}` : null,
            visaSaljare && b.saljare ? b.saljare : null].filter(Boolean).join(" · ")}
        </span>
      </div>

      <div className="vt-rad__datum">
        {oppen ? (
          b.senast ? (
            <>
              <span className="vt-rad__senast">Senast {fmt(b.senast)} <em>{kvarText(b.senast)}</em></span>
              {b.helst && b.helst !== b.senast && <span className="vt-rad__helst">Helst {fmt(b.helst)}</span>}
            </>
          ) : <span className="vt-rad__senast">Lägg in startdatum på avtalet</span>
        ) : (
          <span className="vt-rad__helst">
            {b.status === "bestalld" ? `Beställd ${fmt(b.bestalldAt)}${b.bestalldAv ? ` av ${b.bestalldAv}` : ""}` : "Makulerad"}
          </span>
        )}
      </div>

      <div className="vt-rad__knappar">
        {l && <span className={`vt-lage vt-lage--${l}`}>{LAGE[l].label}</span>}
        {oppen && !bekrafta && (
          <button type="button" className="btn btn--brand btn--sm" onClick={() => setBekrafta(true)}>Beställd i VT</button>
        )}
        {b.status === "bestalld" && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void kor(false)}>Ångra</button>
        )}
      </div>

      {bekrafta && (
        <div className="vt-rad__bekrafta" role="group" aria-label="Bekräfta beställning">
          <span>Är avtalet för {b.kund ?? "kunden"} inskickat i VT?</span>
          <div className="vt-rad__bekrafta-knappar">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setBekrafta(false)}>Avbryt</button>
            <button type="button" className="btn btn--brand btn--sm" disabled={busy} onClick={() => void kor(true)}>{busy ? "Sparar…" : "Ja, beställd"}</button>
          </div>
        </div>
      )}
      {fel && <span className="vt-rad__fel">{fel}</span>}
    </li>
  );
}

/* ── Säljarvyn (D2D-sälj → Signerade) ───────────────────────────────── */

export function VtSaljarPanel({ onOpenLagenhet }: { onOpenLagenhet?: (id: string) => void }) {
  const [lista, setLista] = useState<VtBestallning[] | null>(null);
  const ladda = useCallback(() => { hamtaVtBestallningar().then(setLista).catch(() => setLista([])); }, []);
  useEffect(() => { ladda(); }, [ladda]);

  const oppna = useMemo(() => sortera((lista ?? []).filter((b) => b.status === "oppen")), [lista]);
  const klara = useMemo(() => (lista ?? []).filter((b) => b.status === "bestalld"), [lista]);
  if (lista === null || (oppna.length === 0 && klara.length === 0)) return null;

  return (
    <section className="vt-panel" aria-label="Att beställa i VT">
      <div className="vt-panel__head">
        <span className="vt-panel__title">Att beställa i VT</span>
        <span className="vt-panel__count">{oppna.length} kvar</span>
      </div>
      <p className="vt-panel__regel">Mobil: senast 30 dagar före startdatum, helst 45. Övrigt: senast 30 dagar före.</p>
      {oppna.length === 0 && <p className="vt-panel__tom">Allt är beställt.</p>}
      <ul className="vt-lista">
        {oppna.map((b) => <VtRad key={b.id} b={b} visaSaljare={!b.mine} onAndrad={ladda} onOpenLagenhet={onOpenLagenhet} />)}
        {klara.slice(0, 5).map((b) => <VtRad key={b.id} b={b} visaSaljare={!b.mine} onAndrad={ladda} onOpenLagenhet={onOpenLagenhet} />)}
      </ul>
    </section>
  );
}

/* ── CRM: Door to door → VT-beställningar ───────────────────────────── */

export function VtBestallningarPage({ onOpenRecord }: { onOpenRecord?: (id: string) => void }) {
  const [lista, setLista] = useState<VtBestallning[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [flik, setFlik] = useState<"oppen" | "klar">("oppen");
  const ladda = useCallback(() => {
    hamtaVtBestallningar().then((l) => { setLista(l); setFel(null); })
      .catch((e) => { setFel(e instanceof Error ? e.message : "Kunde inte hämta beställningarna."); setLista([]); });
  }, []);
  useEffect(() => { ladda(); }, [ladda]);

  const oppna = useMemo(() => sortera((lista ?? []).filter((b) => b.status === "oppen")), [lista]);
  const klara = useMemo(() => (lista ?? []).filter((b) => b.status !== "oppen"), [lista]);
  const antal = useMemo(() => {
    const c: Record<Lage, number> = { sen: 0, akut: 0, helst: 0, ok: 0, saknas: 0 };
    oppna.forEach((b) => { c[lage(b)]++; });
    return c;
  }, [oppna]);
  const visade = flik === "oppen" ? oppna : klara;

  return (
    <div className="page vt-page">
      <div className="vt-page__kpi">
        <div className="vt-kpi vt-kpi--sen"><strong>{antal.sen}</strong><span>Försenade</span></div>
        <div className="vt-kpi vt-kpi--akut"><strong>{antal.akut}</strong><span>Senast inom 3 dagar</span></div>
        <div className="vt-kpi vt-kpi--helst"><strong>{antal.helst}</strong><span>Beställ nu</span></div>
        <div className="vt-kpi"><strong>{antal.ok + antal.saknas}</strong><span>Övriga öppna</span></div>
      </div>

      <FilterPills
        items={[{ key: "oppen", label: "Att beställa", count: oppna.length }, { key: "klar", label: "Beställda senaste 14 dagarna", count: klara.length }]}
        active={flik} onSelect={(k) => setFlik(k as "oppen" | "klar")} />

      <p className="vt-panel__regel">Skapas automatiskt när ett Scrive-avtal signeras. Mobil: beställ i VT senast 30 dagar före startdatum, helst 45. Övrigt: senast 30 dagar före. Faller datumet på helg eller helgdag gäller arbetsdagen innan. Påminnelsemejl går till Lukas, ansvarig admin och säljaren 2 och 1 arbetsdag före.</p>

      {fel && <div className="formfield__error">{fel}</div>}
      <div className="card vt-page__lista">
        {lista === null ? <SkeletonRows rows={5} />
          : visade.length === 0 ? <EmptyState title={flik === "oppen" ? "Inget att beställa" : "Inga beställda de senaste 14 dagarna"} />
          : (
            <ul className="vt-lista">
              {visade.map((b) => <VtRad key={b.id} b={b} visaSaljare onAndrad={ladda} onOpenLagenhet={onOpenRecord} />)}
            </ul>
          )}
      </div>
    </div>
  );
}
