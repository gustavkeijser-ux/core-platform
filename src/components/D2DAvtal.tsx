import { useEffect, useMemo, useState } from "react";
import type { FieldDef } from "@/lib/data";
import {
  beraknaAvtal, kr, loadPrislista, onPrislista, savePrislista,
  ENGANG_FALT, ROUTER_FALT, type Prislista, type Pris, type RouterPris,
} from "@/lib/d2dPris";

/* =============================================================================
   "Vad såldes?" → Avtalsförslag: kampanj- och ordinarie pris per tjänst,
   totaler, bindningstid och engångskostnader (router, TV-box). Samma
   siffror går in i avtalet som kunden signerar. Admin ändrar priserna.
   ========================================================================== */

export function AvtalsSammanfattning({ data, soldFields, isAdmin }: {
  data: Record<string, unknown>;
  soldFields: FieldDef[];
  isAdmin: boolean;
}) {
  const [lista, setLista] = useState<Prislista | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [redigera, setRedigera] = useState(false);

  useEffect(() => {
    let on = true;
    loadPrislista().then((p) => { if (on) setLista(p); }).catch((e) => { if (on) setFel(String(e?.message ?? e)); });
    const off = onPrislista((p) => setLista(p));
    return () => { on = false; off(); };
  }, []);

  const avtal = useMemo(() => (lista ? beraknaAvtal(data, soldFields, lista) : null), [data, soldFields, lista]);

  if (fel) return <div className="d2d-avtal d2d-avtal--fel">Kunde inte hämta prislistan: {fel}</div>;
  if (!avtal) return null;

  const tomt = avtal.manad.length === 0 && avtal.engang.length === 0;

  return (
    <div className="d2d-avtal" aria-live="polite">
      <div className="d2d-avtal__head">
        <span className="d2d-avtal__title">Avtalsförslag</span>
        {isAdmin && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRedigera(true)}>Ändra priser</button>
        )}
      </div>

      {tomt ? (
        <p className="d2d-avtal__tom">Välj vad kunden köper ovan, så räknas priset ut här.</p>
      ) : (
        <>
          <div className="d2d-avtal__tabell" role="table" aria-label="Månadskostnad">
            <div className="d2d-avtal__rad d2d-avtal__rad--rubrik" role="row">
              <span role="columnheader">Per månad</span>
              <span role="columnheader">Kampanj</span>
              <span role="columnheader">Ordinarie</span>
            </div>
            {avtal.manad.map((r, i) => (
              <div key={`${r.falt}-${i}`} className="d2d-avtal__rad" role="row">
                <span role="cell" className="d2d-avtal__namn">
                  {r.label}
                  {r.not && <small> · {r.not}</small>}
                </span>
                <span role="cell">{kr(r.kampanj)}</span>
                <span role="cell" className="d2d-avtal__ord">{kr(r.ordinarie)}</span>
              </div>
            ))}
            {avtal.manad.length > 0 && (
              <div className="d2d-avtal__rad d2d-avtal__rad--total" role="row">
                <span role="cell">Totalt per månad</span>
                <span role="cell">{kr(avtal.totalKampanj)}</span>
                <span role="cell">{kr(avtal.totalOrdinarie)}</span>
              </div>
            )}
          </div>

          {avtal.engang.length > 0 && (
            <div className="d2d-avtal__tabell" role="table" aria-label="Engångskostnad">
              <div className="d2d-avtal__rad d2d-avtal__rad--rubrik" role="row">
                <span role="columnheader">Engångskostnad</span>
                <span role="columnheader">Pris</span>
                <span role="columnheader">Ordinarie</span>
              </div>
              {avtal.engang.map((r, i) => (
                <div key={`${r.falt}-${i}`} className="d2d-avtal__rad" role="row">
                  <span role="cell" className="d2d-avtal__namn">{r.label}{r.not && <small> · {r.not}</small>}</span>
                  <span role="cell">{kr(r.kampanj)}</span>
                  <span role="cell" className="d2d-avtal__ord">{kr(r.ordinarie)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="d2d-avtal__villkor">
            <span>Bindningstid <b>{avtal.bindningManader} mån</b></span>
            <span>Kampanjperiod <b>{avtal.kampanjManader} mån</b></span>
            {avtal.antalMobil > 0 && <span>Mobilabonnemang <b>{avtal.antalMobil} st</b></span>}
          </div>

          {avtal.saknas.length > 0 && (
            <p className="d2d-avtal__varning">Pris saknas i prislistan för: {avtal.saknas.join(", ")}.{isAdmin ? " Lägg till under Ändra priser." : " Säg till en administratör."}</p>
          )}
        </>
      )}

      {redigera && lista && (
        <PrislistaPanel lista={lista} soldFields={soldFields} onClose={() => setRedigera(false)} />
      )}
    </div>
  );
}

// ── Admin: redigera prislistan ──────────────────────────────────────────────

type Kolumn = { key: keyof Pris | keyof RouterPris; label: string };

function kolumnerFor(f: FieldDef): Kolumn[] {
  if (f.key === ROUTER_FALT) return [
    { key: "bbEnsam", label: "Bara BB" }, { key: "bbTv", label: "BB + TV" },
    { key: "bbPp", label: "BB + mobil" }, { key: "bbTvTillval", label: "BB + TV + tillval" },
  ];
  const k: Kolumn[] = [{ key: "kampanj", label: ENGANG_FALT.has(f.key) ? "Pris" : "Kampanj" }];
  if (f.key === "salt_bredband") k.push({ key: "kampanjUtanTv", label: "Kampanj utan TV" });
  if (f.key === "salt_streaming_sport") k.push({ key: "kampanjUtanNetflix", label: "Utan Netflix" });
  if (f.key === "salt_trygghet") k.push({ key: "kampanjUtanBredband", label: "Utan bredband" });
  k.push({ key: "ordinarie", label: "Ordinarie" });
  return k;
}

function PrislistaPanel({ lista, soldFields, onClose }: { lista: Prislista; soldFields: FieldDef[]; onClose: () => void }) {
  return (
    <div className="overlay overlay--above overlay--center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="field-config d2d-prislista" role="dialog" aria-label="Prislista">
        <div className="field-config__header">
          <h2>Prislista</h2>
          <button className="close-btn" onClick={onClose} aria-label="Stäng">×</button>
        </div>
        <PrislistaForm lista={lista} soldFields={soldFields} onSaved={onClose} onCancel={onClose} />
      </div>
    </div>
  );
}

/** Själva prislistan (används både i dialogen och på sidan Door to door → Priser). */
function PrislistaForm({ lista, soldFields, onSaved, onCancel }: {
  lista: Prislista; soldFields: FieldDef[]; onSaved?: () => void; onCancel?: () => void;
}) {
  const [utkast, setUtkast] = useState<Prislista>(() => JSON.parse(JSON.stringify(lista)));
  const [sparar, setSparar] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [sparat, setSparat] = useState(false);
  const [bas, setBas] = useState<Prislista>(lista);   // senast sparade versionen
  const andrad = useMemo(() => JSON.stringify(utkast) !== JSON.stringify(bas), [utkast, bas]);

  const grupp = (f: FieldDef) => (ENGANG_FALT.has(f.key) ? "engang" : "priser") as "engang" | "priser";
  const varde = (f: FieldDef, nyckel: string, k: string) => {
    const g = utkast[grupp(f)] ?? {};
    const v = (g[nyckel] as Record<string, unknown> | undefined)?.[k];
    return typeof v === "number" ? String(v) : "";
  };
  const satt = (f: FieldDef, nyckel: string, k: string, raw: string) => {
    setSparat(false);
    setUtkast((u) => {
      const g = { ...(u[grupp(f)] ?? {}) };
      const rad = { ...(g[nyckel] ?? {}) } as Record<string, unknown>;
      const n = raw.trim() === "" ? null : Number(raw.replace(",", "."));
      if (n == null || !Number.isFinite(n)) delete rad[k]; else rad[k] = n;
      g[nyckel] = rad as Pris;
      return { ...u, [grupp(f)]: g };
    });
  };

  async function spara() {
    setSparar(true); setFel(null);
    try { const next = await savePrislista(utkast); setBas(next); setUtkast(JSON.parse(JSON.stringify(next))); setSparat(true); onSaved?.(); }
    catch (e) { setFel(String((e as { message?: string })?.message ?? e)); }
    finally { setSparar(false); }
  }

  return (
    <>
      <div className="field-config__body">
        <p className="field-config__hint">Priser i kronor. Månadspriser gäller per månad, router och TV-box är engångskostnader. TV-boxen ingår alltid i TV-paketen (0 kr för TV Start och TV Bas). Ändringen gäller direkt för alla säljare och nya avtal.</p>

        <div className="d2d-prislista__villkor">
          <label>Bindningstid (mån)
            <input className="input input--sm" inputMode="numeric" value={String(utkast.bindningManader ?? "")}
              onChange={(e) => { setSparat(false); setUtkast((u) => ({ ...u, bindningManader: Number(e.target.value) || undefined })); }} />
          </label>
          <label>Kampanjperiod (mån)
            <input className="input input--sm" inputMode="numeric" value={String(utkast.kampanjManader ?? "")}
              onChange={(e) => { setSparat(false); setUtkast((u) => ({ ...u, kampanjManader: Number(e.target.value) || undefined })); }} />
          </label>
        </div>

        {soldFields.map((f) => {
          const kol = kolumnerFor(f);
          const rader = f.fieldType === "boolean"
            ? [{ nyckel: f.key, label: f.label }]
            : (f.options.choices ?? []).map((c) => ({ nyckel: `${f.key}:${c.key}`, label: c.label }));
          return (
            <section key={f.key} className="d2d-prislista__grupp">
              <h3>{f.label}{ENGANG_FALT.has(f.key) ? " (engång)" : ""}</h3>
              <div className="d2d-prislista__tabell" style={{ ["--kol" as string]: kol.length }}>
                <span className="d2d-prislista__th" />
                {kol.map((k) => <span key={k.key} className="d2d-prislista__th">{k.label}</span>)}
                {rader.map((r) => (
                  <div key={r.nyckel} className="d2d-prislista__rad">
                    <span className="d2d-prislista__namn">{r.label}</span>
                    {kol.map((k) => (
                      <input key={k.key} className="input input--sm" inputMode="numeric" aria-label={`${r.label} – ${k.label}`}
                        value={varde(f, r.nyckel, k.key)} onChange={(e) => satt(f, r.nyckel, k.key, e.target.value)} />
                    ))}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {fel && <div className="formfield__error">{fel}</div>}
      </div>
      <div className="d2d-prislista__fot">
        {sparat && !andrad && <span className="d2d-prislista__sparat">✓ Sparat</span>}
        {onCancel && <button className="btn btn--ghost" onClick={onCancel} disabled={sparar}>Avbryt</button>}
        {!onCancel && andrad && <button className="btn btn--ghost" onClick={() => setUtkast(JSON.parse(JSON.stringify(bas)))} disabled={sparar}>Ångra ändringar</button>}
        <button className="btn btn--brand" onClick={() => void spara()} disabled={sparar || (!onCancel && !andrad)}>{sparar ? "Sparar…" : "Spara priser"}</button>
      </div>
    </>
  );
}

/** Kategorierna under "Vad såldes?" (samma urval som i D2D-vyn). */
export const prisKategorier = (fields: FieldDef[]) => fields
  .filter((f) => f.options.sold_panel && f.visibility !== "hidden"
    && (f.fieldType === "boolean" || (f.options.choices?.length ?? 0) > 0))
  .sort((a, b) => a.sortOrder - b.sortOrder);

/* =============================================================================
   Door to door → Priser: global prislista för alla D2D-avtal (admin).
   ========================================================================== */
export function D2DPrislistaPage({ fields }: { fields: FieldDef[] }) {
  const [lista, setLista] = useState<Prislista | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const soldFields = useMemo(() => prisKategorier(fields), [fields]);

  useEffect(() => {
    let on = true;
    loadPrislista(true).then((p) => { if (on) setLista(p); }).catch((e) => { if (on) setFel(String(e?.message ?? e)); });
    return () => { on = false; };
  }, []);

  return (
    <div className="page d2dpris">
      <section className="card d2dpris__kort">
        {fel && <div className="formfield__error">Kunde inte hämta prislistan: {fel}</div>}
        {!lista && !fel && <p className="formfield__help">Hämtar prislistan…</p>}
        {lista && <PrislistaForm lista={lista} soldFields={soldFields} />}
      </section>
    </div>
  );
}
