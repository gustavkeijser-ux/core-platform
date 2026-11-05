import { useEffect, useState } from "react";
import "@/styles/salj.css";
import { DataError } from "@/lib/data";
import {
  KONTAKTYTOR, ytaLabel, kontaktytorForPost, sparaKontakt, BOLAG_TYP_LABEL,
  type Bolag, type Kontakt, type KontaktUtkast, type KontaktytorSvar,
} from "@/lib/kontaktytor";

/**
 * Fliken Kontaktytor: kontakterna för kundens bolag, ärvda till affär, leverans
 * och alla processer. Överst täckningen (vem har vilken kontaktyta, vilka saknas),
 * under det en rad per kontakt. Kontaktytor väljs i en rullgardin; "Annan (fritext)"
 * sparas bara på kontakten och läggs aldrig till i listan.
 */
export function KontaktytorTab({ recordId, onOpen }: { recordId: string; onOpen?: (id: string) => void }) {
  const [svar, setSvar] = useState<KontaktytorSvar | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [redigera, setRedigera] = useState<Kontakt | "ny" | null>(null);

  const ladda = () => kontaktytorForPost(recordId).then(setSvar).catch((e) => setFel(e instanceof Error ? e.message : String(e)));
  useEffect(() => { setSvar(null); setRedigera(null); ladda(); }, [recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (fel) return <div className="formfield__error">{fel}</div>;
  if (!svar) return <div className="salj-tom">Laddar kontaktytor…</div>;

  if (svar.bolag.length === 0) {
    return (
      <div className="empty-state">
        Posten är inte kopplad till någon koncernmoder eller något bolag ännu, så det finns inga kontakter att ärva.
        Koppla posten till kunden först.
      </div>
    );
  }

  const tackning = KONTAKTYTOR.map((y) => ({ ...y, kontakter: svar.kontakter.filter((k) => k.kontaktytor.includes(y.key)) }));
  const saknas = tackning.filter((y) => y.kontakter.length === 0).length;

  return (
    <div className="kyt">
      <div className="kyt__arv">
        <span className="kyt__arv-etikett">Ärvs från</span>
        {svar.bolag.map((b) => (
          <button key={b.id} type="button" className="salj-pill salj-pill--grey kyt__bolag" onClick={() => onOpen?.(b.id)} title={BOLAG_TYP_LABEL[b.typ]}>
            {b.namn ?? "Namnlöst bolag"} <span className="kyt__bolag-typ">{BOLAG_TYP_LABEL[b.typ]}</span>
          </button>
        ))}
      </div>

      <section className="kyt__tackning" aria-label="Kontaktytor">
        <div className="kyt__rubrik">
          <span>Kontaktytor</span>
          <span className={`salj-pill ${saknas ? "salj-pill--warn" : "salj-pill--ok"}`}>
            {saknas ? `${saknas} av ${KONTAKTYTOR.length} saknas` : "Alla ifyllda"}
          </span>
        </div>
        <ul className="kyt__ytor">
          {tackning.map((y) => (
            <li key={y.key} className={y.kontakter.length ? "" : "kyt__yta--saknas"}>
              <span className="kyt__yta-namn">{y.label}</span>
              <span className="kyt__yta-vem">{y.kontakter.length ? y.kontakter.map((k) => k.namn).join(", ") : "Saknas"}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="kyt__rubrik kyt__rubrik--lista">
        <span>Kontakter ({svar.kontakter.length})</span>
        {redigera !== "ny" && <button type="button" className="btn btn--brand btn--sm" onClick={() => setRedigera("ny")}>+ Lägg till kontakt</button>}
      </div>

      {redigera === "ny" && (
        <KontaktForm bolag={svar.bolag} onAvbryt={() => setRedigera(null)} onSparad={() => { setRedigera(null); ladda(); }} />
      )}

      {svar.kontakter.length === 0 && redigera !== "ny" && <div className="empty-state">Inga kontakter ännu.</div>}

      <ul className="kyt__lista">
        {svar.kontakter.map((k) => redigera !== "ny" && redigera?.id === k.id ? (
          <li key={k.id}><KontaktForm kontakt={k} bolag={svar.bolag} onAvbryt={() => setRedigera(null)} onSparad={() => { setRedigera(null); ladda(); }} /></li>
        ) : (
          <li key={k.id} className="kyt__kontakt">
            <div className="kyt__kontakt-topp">
              <div className="kyt__kontakt-namn">
                <button type="button" className="salj-lank" onClick={() => onOpen?.(k.id)}>{k.namn ?? "Namnlös"}</button>
                {k.titel && <span className="kyt__titel">{k.titel}</span>}
              </div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRedigera(k)}>Ändra</button>
            </div>
            <div className="kyt__chips">
              {k.kontaktytor.map((y) => <span key={y} className="salj-pill salj-pill--brand">{ytaLabel(y)}</span>)}
              {k.fritext && <span className="salj-pill kyt__fritext" title="Annan kontaktyta (fritext)">{k.fritext}</span>}
              {!k.kontaktytor.length && !k.fritext && <span className="salj-pill salj-pill--warn">Kontaktyta saknas</span>}
            </div>
            <div className="kyt__uppg">
              {k.telefon && <a href={`tel:${k.telefon.replace(/[^\d+]/g, "")}`}>{k.telefon}</a>}
              {k.epost && <a href={`mailto:${k.epost}`}>{k.epost}</a>}
              {!k.telefon && !k.epost && <span className="salj-dim">Telefon och e-post saknas</span>}
            </div>
            {k.notering && <div className="kyt__notering">{k.notering}</div>}
            {svar.bolag.length > 1 && k.bolag && (
              <div className="kyt__hor">Hör till: {k.bolag.map((b) => b.namn).join(", ")}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const ANNAN = "__annan__";

function KontaktForm({ kontakt, bolag, onAvbryt, onSparad }: {
  kontakt?: Kontakt; bolag: Bolag[]; onAvbryt: () => void; onSparad: () => void;
}) {
  const [u, setU] = useState<KontaktUtkast>({
    namn: kontakt?.namn ?? "", titel: kontakt?.titel ?? "", telefon: kontakt?.telefon ?? "", epost: kontakt?.epost ?? "",
    kontaktytor: kontakt?.kontaktytor ?? [], fritext: kontakt?.fritext ?? "", notering: kontakt?.notering ?? "",
  });
  const [visaFritext, setVisaFritext] = useState(!!kontakt?.fritext);
  // Ny kontakt: alla koncernmödrar (dubbletter av samma kund) är förvalda; annars det första bolaget.
  const [valda, setValda] = useState<Set<string>>(() => {
    if (kontakt?.bolag?.length) return new Set(kontakt.bolag.map((b) => b.id));
    const km = bolag.filter((b) => b.typ === "koncernmoder");
    return new Set((km.length ? km : bolag.slice(0, 1)).map((b) => b.id));
  });
  const [sparar, setSparar] = useState(false);
  const [fel, setFel] = useState<string | null>(null);

  const satt = (k: keyof KontaktUtkast, v: string) => setU((x) => ({ ...x, [k]: v }));
  const kvar = KONTAKTYTOR.filter((y) => !u.kontaktytor.includes(y.key));

  async function spara() {
    if (!u.namn.trim()) { setFel("Skriv namnet."); return; }
    if (valda.size === 0) { setFel("Välj minst ett bolag som kontakten hör till."); return; }
    setSparar(true); setFel(null);
    try {
      await sparaKontakt(kontakt?.id ?? null, { ...u, fritext: visaFritext ? u.fritext : "" },
        bolag.filter((b) => valda.has(b.id)), bolag, kontakt?.bolag ?? []);
      onSparad();
    } catch (e) {
      setFel(e instanceof DataError ? e.message : "Kunde inte spara kontakten.");
      setSparar(false);
    }
  }

  return (
    <div className="kyt__form">
      <div className="kyt__form-grid">
        <label className="formfield"><span className="label">Namn</span>
          <input className="input" value={u.namn} onChange={(e) => satt("namn", e.target.value)} autoFocus /></label>
        <label className="formfield"><span className="label">Titel</span>
          <input className="input" value={u.titel} onChange={(e) => satt("titel", e.target.value)} placeholder="t.ex. VD, förvaltare" /></label>
        <label className="formfield"><span className="label">Telefon</span>
          <input className="input" type="tel" value={u.telefon} onChange={(e) => satt("telefon", e.target.value)} /></label>
        <label className="formfield"><span className="label">E-post</span>
          <input className="input" type="email" value={u.epost} onChange={(e) => satt("epost", e.target.value)} /></label>
      </div>

      <div className="formfield">
        <span className="label">Kontaktytor</span>
        <div className="kyt__chips">
          {u.kontaktytor.map((y) => (
            <span key={y} className="salj-pill salj-pill--brand kyt__chip">
              {ytaLabel(y)}
              <button type="button" aria-label={`Ta bort ${ytaLabel(y)}`} onClick={() => setU((x) => ({ ...x, kontaktytor: x.kontaktytor.filter((k) => k !== y) }))}>×</button>
            </span>
          ))}
          {visaFritext && u.fritext.trim() && <span className="salj-pill kyt__fritext">{u.fritext.trim()}</span>}
        </div>
        <select className="input kyt__valj" value="" onChange={(e) => {
          const v = e.target.value;
          if (v === ANNAN) setVisaFritext(true);
          else if (v) setU((x) => ({ ...x, kontaktytor: [...x.kontaktytor, v] }));
        }}>
          <option value="">Lägg till kontaktyta…</option>
          {kvar.map((y) => <option key={y.key} value={y.key}>{y.label}</option>)}
          {!visaFritext && <option value={ANNAN}>Annan (fritext)…</option>}
        </select>
        {visaFritext && (
          <div className="kyt__fritext-rad">
            <input className="input" value={u.fritext} onChange={(e) => satt("fritext", e.target.value)}
              placeholder="Annan kontaktyta, t.ex. nycklar" aria-label="Annan kontaktyta (fritext)" />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setVisaFritext(false); satt("fritext", ""); }}>Ta bort</button>
          </div>
        )}
        <span className="kyt__hjalp">Fritexten sparas bara på kontakten och läggs inte till i listan.</span>
      </div>

      <label className="formfield"><span className="label">Bra att veta</span>
        <textarea className="input" rows={2} value={u.notering} onChange={(e) => satt("notering", e.target.value)} /></label>

      {bolag.length > 1 && (
        <div className="formfield">
          <span className="label">Hör till</span>
          <div className="kyt__bolagval">
            {bolag.map((b) => (
              <label key={b.id}>
                <input type="checkbox" checked={valda.has(b.id)} onChange={() => setValda((s) => {
                  const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n;
                })} />
                {b.namn} <span className="salj-dim">· {BOLAG_TYP_LABEL[b.typ]}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {fel && <div className="formfield__error">{fel}</div>}
      <div className="kyt__form-knappar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onAvbryt} disabled={sparar}>Avbryt</button>
        <button type="button" className="btn btn--brand btn--sm" onClick={spara} disabled={sparar}>{sparar ? "Sparar…" : "Spara kontakt"}</button>
      </div>
    </div>
  );
}
