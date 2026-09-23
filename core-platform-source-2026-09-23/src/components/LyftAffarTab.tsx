import { useMemo, useState } from "react";
import type { RecordRow, RelatedRecord } from "@/lib/data";
import { addRelation, listRecords, setRelationData, updateRecord, DataError } from "@/lib/data";

type Props = {
  deal: RecordRow;
  related: RelatedRecord[];
  onSaved: (row: RecordRow) => void;
  onRelationsChanged: () => void;
};

/** En capex/opex/leverans-fråga som besvaras ja/nej per fastighet. */
type Fraga = { key: string; label: string };

const CAPEX: Fraga[] = [
  { key: "byggnation_cat6", label: "Byggnation av fastighetsnät CAT6 (lokal/lgh)" },
  { key: "byggnation_fiber", label: "Byggnation av fastighetsnät fiber (lokal/lgh)" },
  { key: "byggnation_fs_port", label: "Byggnation av fastighetsnät (CAT6) FS PORT" },
  { key: "byggnation_bom_cpe", label: "Byggnation av fastighetsnät BOM/Trasig CPE" },
  { key: "ta_over_fastighetsnat", label: "Ta över befintligt fastighetsnät (lokal/lgh)" },
  { key: "bostadsnat_uttag", label: "Bostadsnät/lägenhetsnät (1 uttag)" },
  { key: "dokumentation", label: "Dokumentation fullständig" },
  { key: "skap_stativ", label: "Skåp/stativ vid övertag stadsnät" },
];

const OPEX: Fraga[] = [
  { key: "fs_internet_2mb", label: "FS internet 2 mb/s" },
  { key: "nathyra_bas", label: "Näthyra BAS" },
  { key: "nathyra_start", label: "Näthyra START" },
  { key: "nathyra_lagom", label: "Näthyra lagom" },
  { key: "opex_hastighet_kanalpaket", label: "Hastighet + Kanalpaket" },
  { key: "avtalstid", label: "Avtalstid" },
];

const LEVERANS: Fraga[] = [
  { key: "kanalpaket_bas", label: "Kanalpaket BAS" },
  { key: "kanalpaket_start", label: "Kanalpaket START" },
  { key: "kanalpaket_lagom", label: "Kanalpaket Lagom" },
  { key: "leverans_hastighet_kanalpaket", label: "Hastighet + Kanalpaket" },
];

const ALLA_FRAGOR = [...CAPEX, ...OPEX, ...LEVERANS];

/** Fastighetens räknefält + ja/nej-svar på varje capex/opex/leverans-fråga. Lagras på deal_property-relationen. */
type FastighetData = {
  lagenheter: number | null;
  lokaler: number | null;
  fs_portar: number | null;
  sc_portar: number | null;
  svar: Record<string, boolean | null>;
};

function tomFastighet(): FastighetData {
  return { lagenheter: null, lokaler: null, fs_portar: null, sc_portar: null, svar: {} };
}

function asFastighetData(d: Record<string, unknown>): FastighetData {
  const svarRaw = d.svar;
  const svar: Record<string, boolean | null> = {};
  if (svarRaw && typeof svarRaw === "object") {
    for (const f of ALLA_FRAGOR) {
      const v = (svarRaw as Record<string, unknown>)[f.key];
      svar[f.key] = typeof v === "boolean" ? v : null;
    }
  }
  return {
    lagenheter: typeof d.lagenheter === "number" ? d.lagenheter : null,
    lokaler: typeof d.lokaler === "number" ? d.lokaler : null,
    fs_portar: typeof d.fs_portar === "number" ? d.fs_portar : null,
    sc_portar: typeof d.sc_portar === "number" ? d.sc_portar : null,
    svar,
  };
}

/** Rader i den sammanställda tabellen (Kostnad/Kommentar är gemensamma för hela affären). */
type RowValue = { antal: number | null; kostnad: number | null; kommentar: string };
const TOM_RAD: RowValue = { antal: null, kostnad: null, kommentar: "" };

const SAMMANFATTNING_KEYS = ["nya_telia_lgh", "nya_telia_lokaler", "totalt_nya_telia", "bef_telia"] as const;
const SAMMANFATTNING_LABEL: Record<string, string> = {
  nya_telia_lgh: "Nya Telia lägenheter",
  nya_telia_lokaler: "Nya Telia Lokaler",
  totalt_nya_telia: "Totalt nya Telia (lokal/lgh)",
  bef_telia: "Bef Telia",
};

function NumInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <input
      className="input tnum" type="number" inputMode="decimal"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

function JaNej({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <div className="chips" style={{ flexWrap: "nowrap" }}>
      <button type="button" className="chip" aria-pressed={value === true} onClick={() => onChange(value === true ? null : true)}>Ja</button>
      <button type="button" className="chip" aria-pressed={value === false} onClick={() => onChange(value === false ? null : false)}>Nej</button>
    </div>
  );
}

export function LyftAffarTab({ deal, related, onSaved, onRelationsChanged }: Props) {
  const properties = useMemo(
    () => related.filter((r) => r.record.objectType === "property" && r.relType === "deal_property"),
    [related]
  );

  const [fastigheter, setFastigheter] = useState<Record<string, FastighetData>>(() => {
    const m: Record<string, FastighetData> = {};
    for (const p of properties) m[p.record.id] = asFastighetData(p.data);
    return m;
  });
  const [savingRow, setSavingRow] = useState<string | null>(null);

  function patchFastighet(propertyId: string, patch: Partial<Omit<FastighetData, "svar">>) {
    setFastigheter((prev) => {
      const next = { ...prev, [propertyId]: { ...(prev[propertyId] ?? tomFastighet()), ...patch } };
      persist(propertyId, next[propertyId]);
      return next;
    });
  }

  function setSvar(propertyId: string, fraga: string, value: boolean | null) {
    setFastigheter((prev) => {
      const current = prev[propertyId] ?? tomFastighet();
      const next = { ...prev, [propertyId]: { ...current, svar: { ...current.svar, [fraga]: value } } };
      persist(propertyId, next[propertyId]);
      return next;
    });
  }

  function persist(propertyId: string, data: FastighetData) {
    setSavingRow(propertyId);
    setRelationData(deal.id, "deal_property", propertyId, data)
      .catch(() => { /* värdet behålls lokalt även om sparningen misslyckas */ })
      .finally(() => setSavingRow((r) => (r === propertyId ? null : r)));
  }

  // ── Sök och koppla fastigheter från beståndet ──
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<{ id: string; title: string | null }[]>([]);
  const [linking, setLinking] = useState(false);

  async function search(q: string) {
    setQuery(q);
    if (q.length < 2) { setOptions([]); return; }
    const { items } = await listRecords({ objectType: "property", search: q, limit: 8 });
    const alreadyLinked = new Set(properties.map((p) => p.record.id));
    setOptions(items.filter((i) => !alreadyLinked.has(i.id)).map((i) => ({ id: i.id, title: i.title })));
  }

  async function linkProperty(id: string) {
    setLinking(true);
    try {
      await addRelation(deal.id, "deal_property", id);
      setQuery("");
      setOptions([]);
      onRelationsChanged();
    } catch {
      /* tyst */
    } finally {
      setLinking(false);
    }
  }

  // ── Antal per fråga = hur många fastigheter som svarat Ja ──
  function antalJa(fragaKey: string): number {
    let n = 0;
    for (const f of Object.values(fastigheter)) if (f.svar[fragaKey] === true) n++;
    return n;
  }

  // ── Sammanfattning: en fastighet räknas som "ny Telia" om den fått något
  // av byggnation CAT6/fiber eller Bostadsnät-uttag. Kan justeras om regeln
  // inte stämmer med hur ni faktiskt vill räkna.
  const sammanfattningBeraknad = useMemo(() => {
    let lgh = 0, lokaler = 0;
    for (const f of Object.values(fastigheter)) {
      const nyTelia = f.svar.byggnation_cat6 === true || f.svar.byggnation_fiber === true || f.svar.bostadsnat_uttag === true;
      if (!nyTelia) continue;
      lgh += f.lagenheter ?? 0;
      lokaler += f.lokaler ?? 0;
    }
    return { lgh, lokaler, totalt: lgh + lokaler };
  }, [fastigheter]);

  // ── Kostnad/Kommentar (gemensamma per fråga) + manuellt Bef Telia ──
  const initialTabell = (): Record<string, RowValue> => {
    const t = (deal.data.lyft_affar as { rows?: Record<string, RowValue> } | undefined)?.rows ?? {};
    const m: Record<string, RowValue> = {};
    for (const key of [...SAMMANFATTNING_KEYS, ...ALLA_FRAGOR.map((f) => f.key)]) {
      m[key] = { ...TOM_RAD, ...(t[key] ?? {}) };
    }
    return m;
  };
  const [tabell, setTabell] = useState<Record<string, RowValue>>(initialTabell);

  function setCell(key: string, patch: Partial<RowValue>) {
    setTabell((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function antalFor(key: string): number | null {
    if (key === "nya_telia_lgh") return sammanfattningBeraknad.lgh;
    if (key === "nya_telia_lokaler") return sammanfattningBeraknad.lokaler;
    if (key === "totalt_nya_telia") return sammanfattningBeraknad.totalt;
    if (key === "bef_telia") return tabell.bef_telia?.antal ?? null;
    return antalJa(key);
  }

  // ── Spara Kostnad/Kommentar/Bef Telia ──
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  async function saveTabell() {
    setSaving(true);
    setError(null);
    try {
      const rows: Record<string, RowValue> = {};
      for (const key of [...SAMMANFATTNING_KEYS, ...ALLA_FRAGOR.map((f) => f.key)]) {
        rows[key] = { ...tabell[key], antal: antalFor(key) };
      }
      const row = await updateRecord(deal.id, { lyft_affar: { rows } });
      onSaved(row);
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2000);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara.");
    } finally {
      setSaving(false);
    }
  }

  function renderFragorSection(title: string, fragor: Fraga[]) {
    return (
      <div className="lyft-affar__section">
        <div className="form-section__header"><span className="form-section__title">{title}</span></div>
        <div className="rtable-scroll">
          <table className="rtable">
            <thead>
              <tr>
                <th>{title}</th>
                <th data-align="right">Antal ja</th>
                <th data-align="right">Kostnad</th>
                <th>Kommentar</th>
              </tr>
            </thead>
            <tbody>
              {fragor.map((f) => (
                <tr key={f.key}>
                  <td>{f.label}</td>
                  <td data-align="right">
                    <span className="tnum" style={{ fontVariantNumeric: "tabular-nums" }}>{antalJa(f.key)}</span>
                  </td>
                  <td data-align="right">
                    <NumInput value={tabell[f.key]?.kostnad ?? null} onChange={(v) => setCell(f.key, { kostnad: v })} />
                  </td>
                  <td>
                    <input
                      className="input" value={tabell[f.key]?.kommentar ?? ""}
                      onChange={(e) => setCell(f.key, { kommentar: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="drawer__main lyft-affar-tab">
      <p className="formfield__help" style={{ marginBottom: "var(--sp-4)" }}>
        Lägg till fastigheterna i beståndet och sätt lägenheter/lokaler/FS-portar/SC-portar per
        fastighet. Kryssa sedan Ja eller Nej på varje capex/opex/leverans-fråga, per fastighet —
        Antal-kolumnen i tabellerna nedanför räknas automatiskt fram från hur många fastigheter
        som fått Ja.
      </p>

      {/* Fastighetsbestånd + matris */}
      <div className="lyft-affar__section">
        <div className="form-section__header"><span className="form-section__title">Fastighetsbestånd</span></div>
        <div className="rtable-scroll">
          <table className="rtable rtable--wide">
            <thead>
              <tr>
                <th>Fastighet</th>
                <th data-align="right">Lgh</th>
                <th data-align="right">Lokaler</th>
                <th data-align="right">FS-portar</th>
                <th data-align="right">SC-portar</th>
                {ALLA_FRAGOR.map((f) => <th key={f.key}><span className="rtable__th">{f.label}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {properties.length === 0 && (
                <tr><td colSpan={5 + ALLA_FRAGOR.length} className="empty-state">Inga fastigheter kopplade ännu.</td></tr>
              )}
              {properties.map((p) => {
                const f = fastigheter[p.record.id] ?? tomFastighet();
                return (
                  <tr key={p.record.id}>
                    <td className="rtable__title">
                      {p.record.title ?? "Namnlös"}
                      {savingRow === p.record.id && <span className="formfield__help"> · sparar…</span>}
                    </td>
                    <td data-align="right"><NumInput value={f.lagenheter} onChange={(v) => patchFastighet(p.record.id, { lagenheter: v })} /></td>
                    <td data-align="right"><NumInput value={f.lokaler} onChange={(v) => patchFastighet(p.record.id, { lokaler: v })} /></td>
                    <td data-align="right"><NumInput value={f.fs_portar} onChange={(v) => patchFastighet(p.record.id, { fs_portar: v })} /></td>
                    <td data-align="right"><NumInput value={f.sc_portar} onChange={(v) => patchFastighet(p.record.id, { sc_portar: v })} /></td>
                    {ALLA_FRAGOR.map((fr) => (
                      <td key={fr.key}>
                        <JaNej value={f.svar[fr.key] ?? null} onChange={(v) => setSvar(p.record.id, fr.key, v)} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="picker" style={{ marginTop: "var(--sp-3)" }}>
          <input
            className="input" placeholder="Sök fastighet i beståndet och koppla…"
            value={query} onChange={(e) => search(e.target.value)} disabled={linking}
          />
        </div>
        {options.length > 0 && (
          <div className="card" style={{ padding: "8px", marginTop: "8px" }}>
            {options.map((o) => (
              <div key={o.id} className="relation-row" style={{ cursor: "pointer" }} onClick={() => linkProperty(o.id)}>
                <span>{o.title ?? "Namnlös post"}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sammanfattning */}
      <div className="lyft-affar__section">
        <div className="form-section__header"><span className="form-section__title">Sammanfattning</span></div>
        <div className="rtable-scroll">
          <table className="rtable">
            <thead>
              <tr>
                <th>Fastighetsbolaget (koncernmoder)</th>
                <th data-align="right">Antal</th>
                <th data-align="right">Kostnad</th>
                <th>Kommentar</th>
              </tr>
            </thead>
            <tbody>
              {SAMMANFATTNING_KEYS.map((key) => (
                <tr key={key}>
                  <td>{SAMMANFATTNING_LABEL[key]}</td>
                  <td data-align="right">
                    {key === "bef_telia"
                      ? <NumInput value={tabell.bef_telia?.antal ?? null} onChange={(v) => setCell("bef_telia", { antal: v })} />
                      : <span className="tnum" style={{ fontVariantNumeric: "tabular-nums" }}>{antalFor(key)}</span>}
                  </td>
                  <td data-align="right">
                    <NumInput value={tabell[key]?.kostnad ?? null} onChange={(v) => setCell(key, { kostnad: v })} />
                  </td>
                  <td>
                    <input className="input" value={tabell[key]?.kommentar ?? ""} onChange={(e) => setCell(key, { kommentar: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {renderFragorSection("CAPEX", CAPEX)}
      {renderFragorSection("OPEX", OPEX)}
      {renderFragorSection("Leverans", LEVERANS)}

      {error && <div className="formfield__error" style={{ marginTop: "var(--sp-4)" }}>{error}</div>}

      <div className="detail-save-row">
        <button className="btn btn--brand" onClick={saveTabell} disabled={saving}>
          {saving ? "Sparar…" : "Spara Kostnad/Kommentar"}
        </button>
        {saveOk && <span className="detail-save-ok">✓ Sparat</span>}
      </div>
    </div>
  );
}
