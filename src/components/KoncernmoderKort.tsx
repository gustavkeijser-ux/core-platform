import { useEffect, useRef, useState } from "react";
import "@/styles/salj.css";
import type { ObjectDef, RecordRow } from "@/lib/data";
import { updateRecord, uploadDocument, documentUrl, deleteDocumentLink, DataError } from "@/lib/data";
import { kmKort, kmDelaUt, listFastighetssaljare, kundtypLabel, datum, tal, KUNDTYPER, type KmKort as KmKortData, type Saljare } from "@/lib/salj";
import { getUserName, useTenantUsers } from "@/lib/users";
import { supabase } from "@/lib/data";

/* =============================================================================
   Koncernmoder – registerkortet (mockup, skärm 2). Grunddata, kundtyp och
   säljbarhet, bolagsstruktur, fastigheter i registret, dokument, datakvalitet
   och utdelning. Fälten sparas direkt när de lämnas. Mejl skickas inte från
   registret — dokumenten hör till bolaget och kan bifogas i mejl från affären.
   ========================================================================== */

const DELNING = [100, 80, 70, 50];

function Rad({ label, children }: { label: string; children: React.ReactNode }) {
  return (<><dt>{label}</dt><dd>{children}</dd></>);
}

export function KoncernmoderKort({ record, objectDef, onOpenRecord, onOpenList, onSaved, onVisaFalt }: {
  record: RecordRow;
  objectDef: ObjectDef;
  onOpenRecord: (id: string) => void;
  onOpenList: () => void;
  onSaved: (row: RecordRow) => void;
  /** Visa det generiska fältformuläret (alla fält, t.ex. penetration). */
  onVisaFalt: () => void;
}) {
  const [kort, setKort] = useState<KmKortData | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [sparat, setSparat] = useState<string | null>(null);
  const [saljare, setSaljare] = useState<Saljare[]>([]);
  const [myId, setMyId] = useState<string | null>(null);
  const [upp, setUpp] = useState(false);
  const filRef = useRef<HTMLInputElement>(null);
  useTenantUsers();

  const ladda = () => kmKort(record.id).then(setKort).catch((e) => setFel((e as Error).message));
  useEffect(() => { void ladda(); /* eslint-disable-next-line */ }, [record.id]);
  useEffect(() => {
    listFastighetssaljare().then(setSaljare).catch(() => setSaljare([]));
    supabase.auth.getSession().then(({ data }) => setMyId(data.session?.user.id ?? null));
  }, []);

  const d = (kort?.data ?? record.data) as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : d[k] == null ? "" : String(d[k]));

  async function spara(patch: Record<string, unknown>) {
    setFel(null);
    try {
      const row = await updateRecord(record.id, patch);
      onSaved(row);
      setKort((k) => (k ? { ...k, data: row.data } : k));
      setSparat("Sparat");
      setTimeout(() => setSparat(null), 2000);
    } catch (e) {
      setFel(e instanceof DataError ? e.message : "Kunde inte spara.");
    }
  }

  async function bytUtdelning(saljareId: string, motesbokare: string | null, delning: number) {
    if (!saljareId) return;
    setFel(null);
    try {
      const r = await kmDelaUt([record.id], saljareId, motesbokare, delning);
      if (r.hoppade.length) setFel(r.hoppade[0].orsak);
      await ladda();
      setSparat("Utdelningen sparad – affären ligger hos säljaren");
      setTimeout(() => setSparat(null), 3000);
    } catch (e) {
      setFel(e instanceof DataError ? e.message : "Kunde inte dela ut.");
    }
  }

  async function laddaUpp(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUpp(true); setFel(null);
    try {
      for (const f of Array.from(files)) await uploadDocument(record.id, f);
      await ladda();
    } catch (e) {
      setFel(e instanceof DataError ? e.message : "Kunde inte ladda upp.");
    } finally {
      setUpp(false);
      if (filRef.current) filRef.current.value = "";
    }
  }

  async function oppnaDok(dok: KmKortData["dokument"][number]) {
    const url = await documentUrl({ id: dok.id, name: dok.namn, webUrl: dok.url, mimeType: null, sizeBytes: null, provider: "", createdAt: dok.datum });
    if (url) window.open(url, "_blank", "noopener");
  }

  const kundtyp = str("kundtyp");
  const ickeSaljbar = d.icke_saljbar === true;
  const valdSaljare = str("saljare");
  const begransning = kort?.begransning ?? null;
  const fast = kort?.fastigheter;
  const titel = (record.title ?? str("name")) || "Koncernmoder";
  const kalla = str("kalla");

  return (
    <div className="page record-page salj-kort">
      <nav className="crumbs" aria-label="Brödsmulor">
        <button className="crumbs__link" onClick={onOpenList}>Koncernmödrar</button>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        <span className="crumbs__current">Registerkort</span>
      </nav>

      <div className="salj-head">
        <div className="salj-head__text">
          <div className="salj-head__title">
            <h1>{titel}</h1>
            {kundtyp && <span className="salj-pill salj-pill--info">{kundtypLabel(kundtyp)}</span>}
            {ickeSaljbar ? <span className="salj-pill salj-pill--grey">Icke säljbar</span>
              : valdSaljare || kort?.affar?.saljare ? <span className="salj-pill salj-pill--ok">Utdelad</span>
              : <span className="salj-pill salj-pill--grey">Ej utdelad</span>}
          </div>
          <div className="salj-head__sub">
            Org.nr {str("org_number") || "saknas"}{kalla ? ` · Inläst via ${kalla}` : ""}
          </div>
        </div>
        <div className="salj-head__actions">
          <button className="btn btn--ghost" onClick={onVisaFalt}>Alla fält</button>
          {kort?.affar && <button className="btn btn--brand" onClick={() => onOpenRecord(kort.affar!.id)}>Öppna affären</button>}
        </div>
      </div>

      {begransning && <div className="salj-varning">Kontaktbegränsning: {begransning}. Kunden kan inte delas ut.</div>}
      {fel && <div className="formfield__error" style={{ marginBottom: "var(--sp-3)" }}>{fel}</div>}
      {sparat && <div className="salj-notis salj-notis--ok" style={{ margin: "0 0 var(--sp-3)" }}>✓ {sparat}</div>}

      <div className="salj-grid">
        {/* Grunddata */}
        <section className="card salj-card" aria-label="Grunddata">
          <div className="salj-card__head"><div className="salj-card__title">Grunddata</div></div>
          <dl className="salj-kv">
            <Rad label="Namn"><input className="input" defaultValue={str("name")} onBlur={(e) => e.target.value.trim() !== str("name") && spara({ name: e.target.value.trim() })} /></Rad>
            <Rad label="Org.nr"><input className="input" defaultValue={str("org_number")} placeholder="556000-0000" onBlur={(e) => e.target.value.trim() !== str("org_number") && spara({ org_number: e.target.value.trim() || null })} /></Rad>
            <Rad label="Hemsida"><input className="input" defaultValue={str("hemsida")} placeholder="https://" onBlur={(e) => e.target.value.trim() !== str("hemsida") && spara({ hemsida: e.target.value.trim() || null })} /></Rad>
            <Rad label="Källa"><input className="input" defaultValue={kalla} placeholder="T.ex. Import 2026-10-30 · fil.xlsx" onBlur={(e) => e.target.value.trim() !== kalla && spara({ kalla: e.target.value.trim() || null })} /></Rad>
            <Rad label="Skapad">{datum(kort?.created_at ?? record.created_at)}{kort?.created_by ? ` av ${getUserName(kort.created_by)}` : ""}</Rad>
          </dl>
        </section>

        {/* Kundtyp och säljbarhet */}
        <section className="card salj-card" aria-label="Kundtyp och säljbarhet">
          <div className="salj-card__head"><div className="salj-card__title">Kundtyp och säljbarhet</div></div>
          <dl className="salj-kv">
            <Rad label="Kundtyp">
              <select className="input" value={kundtyp} onChange={(e) => spara({ kundtyp: e.target.value || null })}>
                <option value="">Välj kundtyp</option>
                {KUNDTYPER.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </Rad>
            <Rad label="Icke säljbar">
              <select className="input" value={ickeSaljbar ? "ja" : "nej"} onChange={(e) => spara({ icke_saljbar: e.target.value === "ja" })}>
                <option value="nej">Nej</option><option value="ja">Ja</option>
              </select>
            </Rad>
          </dl>
          <p className="formfield__help" style={{ marginTop: "var(--sp-3)" }}>
            Kundtyper med kontaktbegränsning (Befintlig Telia Öppen, Omsorgsbostäder, Studentbostäder) visar en varning här och i affären, och kan inte delas ut.
          </p>
        </section>

        {/* Bolagsstruktur */}
        <section className="card salj-card" aria-label="Bolagsstruktur">
          <div className="salj-card__head"><div className="salj-card__title">Bolagsstruktur</div></div>
          <ul className="salj-lista">
            <li><strong>{titel}</strong><span className="salj-lista__meta">Koncernmoder</span></li>
            {(kort?.bolag ?? []).map((b) => (
              <li key={b.id}>
                <button className="salj-lank" onClick={() => onOpenRecord(b.id)}>
                  {b.typ === "forvaltningsbolag" ? "Förvaltningsbolag: " : "Direktägt: "}{b.namn ?? "Namnlöst bolag"}
                </button>
                <span className="salj-lista__meta">{b.typ === "forvaltningsbolag" ? (b.fastigheter ? `${b.fastigheter} fastigheter` : "") : `${b.fastigheter} fastigheter`}</span>
              </li>
            ))}
            {kort && kort.bolag.length === 0 && <li className="salj-tom">Inga direktägda bolag eller förvaltningsbolag kopplade.</li>}
          </ul>
        </section>

        {/* Fastigheter i registret */}
        <section className="card salj-card" aria-label="Fastigheter i registret">
          <div className="salj-card__head"><div className="salj-card__title">Fastigheter i registret</div></div>
          <dl className="salj-kv">
            <Rad label="Fastigheter">{fast ? tal(fast.antal) : "…"}</Rad>
            <Rad label="Lägenheter / lokaler">{fast ? `${tal(fast.lgh)} / ${tal(fast.lokaler)}` : "…"}</Rad>
            <Rad label="Befintlig leverantör">{fast ? `KOAX ${fast.koax} · fiber ${fast.fiber} · okänd ${fast.okand}` : "…"}</Rad>
          </dl>
          {kort?.affar && (
            <div className="salj-spar"><button className="salj-lank" onClick={() => onOpenRecord(kort.affar!.id)}>Visa fastighetsvyerna i affären →</button></div>
          )}
        </section>

        {/* Dokument */}
        <section className="card salj-card" aria-label="Dokument">
          <div className="salj-card__head">
            <div className="salj-card__title">Dokument</div>
            <button className="salj-lank" disabled={upp} onClick={() => filRef.current?.click()}>{upp ? "Laddar upp…" : "Ladda upp"}</button>
            <input ref={filRef} type="file" multiple hidden onChange={(e) => void laddaUpp(e.target.files)} />
          </div>
          <ul className="salj-lista">
            {(kort?.dokument ?? []).map((dok) => (
              <li key={dok.id}>
                <button className="salj-lank" onClick={() => void oppnaDok(dok)}>{dok.namn}</button>
                <span className="salj-lista__meta">
                  {dok.typ ?? "Bolag"} · {datum(dok.datum)}
                  {" · "}<button className="linklike" onClick={() => { if (confirm("Ta bort dokumentet från koncernmodern?")) deleteDocumentLink(dok.id).then(ladda).catch((e) => setFel((e as Error).message)); }}>Ta bort</button>
                </span>
              </li>
            ))}
            {kort && kort.dokument.length === 0 && <li className="salj-tom">Inga dokument uppladdade.</li>}
          </ul>
          <p className="formfield__help" style={{ marginTop: "var(--sp-3)" }}>Dokumenten hör till bolaget och kan bifogas i mejl från affären. Mejl skickas inte från registret.</p>
        </section>

        {/* Datakvalitet */}
        <section className="card salj-card" aria-label="Datakvalitet">
          <div className="salj-card__head"><div className="salj-card__title">Datakvalitet</div></div>
          <div className="salj-check">
            <Check ok={!!str("org_number")} text={str("org_number") ? "Org.nr" : "Org.nr saknas"} />
            <Check ok={!!fast && fast.antal > 0} text={fast ? (fast.antal > 0 ? `Fastigheter kopplade (${fast.antal})` : "Inga fastigheter kopplade") : "…"} />
            <Check ok={!!fast && fast.okand === 0} text={fast ? (fast.okand === 0 ? "Befintlig leverantör känd för alla fastigheter" : `Befintlig leverantör saknas för ${fast.okand} fastigheter`) : "…"} />
            <Check ok={!!kundtyp} text={kundtyp ? "Kundtyp satt" : "Kundtyp saknas"} />
          </div>
        </section>

        {/* Utdelning */}
        <section className="card salj-card" aria-label="Utdelning">
          <div className="salj-card__head"><div className="salj-card__title">Utdelning</div></div>
          <dl className="salj-kv">
            <Rad label="Säljare">
              <select className="input" value={valdSaljare || kort?.affar?.saljare || ""} disabled={ickeSaljbar || !!begransning}
                onChange={(e) => void bytUtdelning(e.target.value, str("motesbokare") || null, Number(str("procentsats_saljare")) || 100)}>
                <option value="">Ej utdelad</option>
                {saljare.map((s) => <option key={s.id} value={s.id}>{s.id === myId ? "Du" : s.name}</option>)}
              </select>
            </Rad>
            <Rad label="Mötesbokare">
              <select className="input" value={str("motesbokare")} disabled={!(valdSaljare || kort?.affar?.saljare)}
                onChange={(e) => void bytUtdelning(valdSaljare || kort?.affar?.saljare || "", e.target.value || null, Number(str("procentsats_saljare")) || 100)}>
                <option value="">Ingen</option>
                {saljare.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Rad>
            <Rad label="Affärsdelning säljare / mötesbokare">
              <select className="input" value={Number(str("procentsats_saljare")) || 100} disabled={!(valdSaljare || kort?.affar?.saljare)}
                onChange={(e) => void bytUtdelning(valdSaljare || kort?.affar?.saljare || "", str("motesbokare") || null, Number(e.target.value))}>
                {DELNING.map((p) => <option key={p} value={p}>{p} / {100 - p}</option>)}
              </select>
            </Rad>
          </dl>
          <p className="formfield__help" style={{ marginTop: "var(--sp-3)" }}>
            {str("tilldelad_saljare") ? `Utdelad ${datum(str("tilldelad_saljare"))}. ` : ""}Byte av säljare flyttar affären med all historik.
          </p>
        </section>
      </div>
    </div>
  );
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className="salj-check__rad">
      <span className={`salj-check__ikon ${ok ? "salj-check__ikon--ok" : "salj-check__ikon--warn"}`} aria-hidden="true">{ok ? "✓" : "!"}</span>
      {text}
    </div>
  );
}
