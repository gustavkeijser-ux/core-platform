import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { type CaseCategory, caseCategories } from "@/lib/cases";
import "@/styles/d2d.css";

/**
 * Felanmälan i säljarvyn (på adressen). Ärendet hamnar i Ärenden → Felanmälningar
 * hos adressens leveransansvarig (annars reservansvarig) med Lukas som bevakare.
 * Säljare har ingen behörighet till Ärenden, så allt går via d2d_felanmalan_skapa,
 * d2d_felanmalningar och d2d_felanmalan_kommentar.
 */

export type FelLagenhet = { id: string; label: string };

type Felanmalan = {
  id: string; caseNumber: string | null; kategori: string | null;
  underkategori: string | null; underkategoriLabel: string | null;
  lagenhetId: string | null; lagenhet: string | null;
  status: string; statusLabel: string; oppen: boolean; telia: string | null;
  createdAt: string; mine: boolean; anmaldAv: string | null; antalKommentarer: number;
};

const fmtDatum = (iso: string) =>
  new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short" });

export function FelanmalanPanel({ fastighetId, lagenheter }: { fastighetId: string; lagenheter: FelLagenhet[] }) {
  const [lista, setLista] = useState<Felanmalan[]>([]);
  const [laddar, setLaddar] = useState(true);
  const [form, setForm] = useState(false);
  const [kvitto, setKvitto] = useState<string | null>(null);
  const [kommentera, setKommentera] = useState<Felanmalan | null>(null);

  const ladda = useCallback(async () => {
    const { data, error } = await supabase.rpc("d2d_felanmalningar", { p_fastighet: fastighetId });
    setLista(error ? [] : ((data ?? []) as Felanmalan[]));
    setLaddar(false);
  }, [fastighetId]);
  useEffect(() => { void ladda(); }, [ladda]);

  const oppna = lista.filter((f) => f.oppen);

  return (
    <section className="d2d-fel" aria-label="Felanmälningar">
      <div className="d2d-fel__head">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 3 2.5 16.5h15L10 3Z" /><path d="M10 8.5v3.5" /><circle cx="10" cy="14.2" r=".8" fill="currentColor" stroke="none" />
        </svg>
        <span className="d2d-fel__title">Felanmälningar</span>
        {oppna.length > 0 && <span className="d2d-fel__count">{oppna.length} öppna</span>}
        {!form && !kommentera && (
          <button className="btn btn--brand btn--sm d2d-fel__ny" onClick={() => { setForm(true); setKvitto(null); }}>Felanmäl</button>
        )}
      </div>

      {kvitto && <div className="d2d-fel__kvitto" role="status">{kvitto}</div>}

      {form && (
        <FelanmalanForm
          fastighetId={fastighetId}
          lagenheter={lagenheter}
          oppna={oppna}
          onCancel={() => setForm(false)}
          onKommentera={(f) => { setForm(false); setKommentera(f); }}
          onSkapad={(text) => { setForm(false); setKvitto(text); void ladda(); }}
        />
      )}

      {kommentera && (
        <KommentarForm
          fel={kommentera}
          onCancel={() => setKommentera(null)}
          onKlar={() => { setKvitto(`Din kommentar har lagts till på ${kommentera.caseNumber ?? "felanmälan"}.`); setKommentera(null); void ladda(); }}
        />
      )}

      {!laddar && lista.length === 0 && !form && (
        <p className="d2d-fel__tom">Inga felanmälningar på adressen.</p>
      )}

      {lista.length > 0 && (
        <ul className="d2d-fel__lista">
          {lista.map((f) => (
            <li key={f.id} className={`d2d-fel__rad${f.oppen ? "" : " d2d-fel__rad--klar"}`}>
              <div className="d2d-fel__rad-text">
                <strong>{f.underkategoriLabel ?? f.kategori ?? "Felanmälan"}</strong>
                <span>
                  {[f.caseNumber, f.lagenhet ?? "Hela adressen", fmtDatum(f.createdAt), f.mine ? "du" : f.anmaldAv]
                    .filter(Boolean).join(" · ")}
                </span>
              </div>
              <span className={`d2d-fel__status d2d-fel__status--${f.oppen ? (f.status === "waiting_telia" ? "vantar" : "oppen") : "klar"}`}>
                {f.statusLabel}
              </span>
              {f.oppen && !form && !kommentera && (
                <button className="linklike d2d-fel__plus" onClick={() => { setKommentera(f); setKvitto(null); }}>
                  Kommentera
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FelanmalanForm({ fastighetId, lagenheter, oppna, onCancel, onKommentera, onSkapad }: {
  fastighetId: string; lagenheter: FelLagenhet[]; oppna: Felanmalan[];
  onCancel: () => void; onKommentera: (f: Felanmalan) => void; onSkapad: (kvitto: string) => void;
}) {
  const [cats, setCats] = useState<CaseCategory[]>([]);
  const [lagenhet, setLagenhet] = useState("");
  const [kat, setKat] = useState<string | null>(null);
  const [sub, setSub] = useState<string | null>(null);
  const [kommentar, setKommentar] = useState("");
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [nyAnda, setNyAnda] = useState(false);

  useEffect(() => { void caseCategories().then((c) => setCats(c.filter((x) => x.felanmalan))); }, []);

  const huvud = cats.filter((c) => !c.parent_key);
  const under = cats.filter((c) => c.parent_key === kat);
  const kravKommentar = sub === "fel_ovr_annat";
  // Samma fel redan anmält (på samma lägenhet, eller på hela adressen)?
  const dubblett = useMemo(() => sub ? oppna.find((f) => f.underkategori === sub
    && (!lagenhet || !f.lagenhetId || f.lagenhetId === lagenhet)) ?? null : null, [sub, oppna, lagenhet]);
  const ok = !!sub && (!kravKommentar || kommentar.trim().length > 0);

  const skicka = async () => {
    if (!ok || busy) return;
    setBusy(true); setFel(null);
    const { data, error } = await supabase.rpc("d2d_felanmalan_skapa", {
      p_fastighet: fastighetId, p_lagenhet: lagenhet || null, p_underkategori: sub, p_kommentar: kommentar.trim() || null,
    });
    setBusy(false);
    if (error || !data) { setFel(error?.message || "Kunde inte skicka felanmälan."); return; }
    const r = data as { caseNumber: string | null; ansvarig: string | null };
    onSkapad(`Felanmälan ${r.caseNumber ?? ""} är skickad${r.ansvarig ? ` till ${r.ansvarig}` : ""}. Du ser status här.`);
  };

  return (
    <form className="d2d-tillf-form d2d-fel__form" onSubmit={(e) => { e.preventDefault(); void skicka(); }}>
      <h3>Ny felanmälan</h3>

      <label className="d2d-tillf-form__falt">
        <span className="label">Gäller</span>
        <select className="input" value={lagenhet} onChange={(e) => setLagenhet(e.target.value)}>
          <option value="">Hela adressen</option>
          {lagenheter.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </label>

      <div className="d2d-tillf-form__falt">
        <span className="label">Vad är fel?</span>
        <div className="d2d-fel__val" role="group" aria-label="Kategori">
          {huvud.map((c) => (
            <button key={c.key} type="button" className="d2d-fel__chip" aria-pressed={kat === c.key}
              onClick={() => { setKat(c.key); setSub(null); setNyAnda(false); }}>{c.label}</button>
          ))}
        </div>
      </div>

      {kat && (
        <div className="d2d-tillf-form__falt">
          <span className="label">Välj det som stämmer bäst</span>
          <div className="d2d-fel__val d2d-fel__val--under" role="group" aria-label="Underkategori">
            {under.map((c) => (
              <button key={c.key} type="button" className="d2d-fel__chip" aria-pressed={sub === c.key}
                onClick={() => { setSub(c.key); setNyAnda(false); }}>{c.label}</button>
            ))}
          </div>
        </div>
      )}

      {dubblett && !nyAnda && (
        <div className="d2d-fel__dubblett" role="status">
          <span>
            Det finns redan en öppen felanmälan om detta ({dubblett.caseNumber}
            {dubblett.lagenhet ? `, ${dubblett.lagenhet}` : ", hela adressen"}). Lägg hellre till din kommentar på den.
          </span>
          <div className="d2d-tillf-form__knappar">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNyAnda(true)}>Skapa ny ändå</button>
            <button type="button" className="btn btn--brand btn--sm" onClick={() => onKommentera(dubblett)}>Kommentera den</button>
          </div>
        </div>
      )}

      {(!dubblett || nyAnda) && (
        <>
          <label className="d2d-tillf-form__falt">
            <span className="label">Kommentar{kravKommentar ? " *" : ""}</span>
            <textarea className="input d2d-fel__text" rows={3} value={kommentar} onChange={(e) => setKommentar(e.target.value)}
              placeholder="T.ex. vilken trappuppgång, vad du ser, vad kunden säger" />
          </label>
          {fel && <span className="d2d-tillf-form__fel">{fel}</span>}
          <div className="d2d-tillf-form__knappar">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>Avbryt</button>
            <button type="submit" className="btn btn--brand btn--sm" disabled={!ok || busy}>{busy ? "Skickar…" : "Skicka felanmälan"}</button>
          </div>
        </>
      )}
      {dubblett && !nyAnda && (
        <div className="d2d-tillf-form__knappar">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Avbryt</button>
        </div>
      )}
    </form>
  );
}

function KommentarForm({ fel, onCancel, onKlar }: { fel: Felanmalan; onCancel: () => void; onKlar: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const spara = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("d2d_felanmalan_kommentar", { p_case: fel.id, p_text: text.trim() });
    setBusy(false);
    if (error) { setErr(error.message || "Kunde inte spara kommentaren."); return; }
    onKlar();
  };
  return (
    <form className="d2d-tillf-form d2d-fel__form" onSubmit={(e) => { e.preventDefault(); void spara(); }}>
      <h3>Kommentera {fel.caseNumber}</h3>
      <p>{fel.underkategoriLabel}{fel.lagenhet ? ` · ${fel.lagenhet}` : " · hela adressen"}</p>
      <label className="d2d-tillf-form__falt">
        <span className="label">Kommentar *</span>
        <textarea className="input d2d-fel__text" rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)}
          placeholder="T.ex. samma fel i lgh 1203, trapphus B" />
      </label>
      {err && <span className="d2d-tillf-form__fel">{err}</span>}
      <div className="d2d-tillf-form__knappar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>Avbryt</button>
        <button type="submit" className="btn btn--brand btn--sm" disabled={!text.trim() || busy}>{busy ? "Sparar…" : "Lägg till"}</button>
      </div>
    </form>
  );
}
