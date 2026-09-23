import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listRecords, getRecord, createRecord, updateRecord, removeRelation,
  listSellers, d2dImportAddresses, d2dSetAssignment, d2dApproveProject,
  d2dGetKartaData, d2dGeokodaNu, type KartaPunkt,
  d2dGetLeveransKartaData, d2dSkapaFastighetFranLeverans, type LeveransPunkt,
  type RecordRow, type SellerOption, DataError,
} from "@/lib/data";
import { StatusPill } from "./StatusPill";

// =============================================================================
// Kartan — Leaflet laddas via CDN (inget npm-beroende, se motivering i doc:
// undviker att git-push-blockeringen gör paketuppdateringar besvärliga att
// klistra in manuellt). Skriptet/CSS:en laddas en gång och återanvänds.
// =============================================================================

const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";

let leafletLoading: Promise<void> | null = null;
function loadLeaflet(): Promise<void> {
  const w = window as unknown as { L?: unknown };
  if (w.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Kunde inte ladda kartbiblioteket."));
    document.body.appendChild(script);
  });
  return leafletLoading;
}

function KartaSection({ projektId, totalFastigheter }: { projektId: string; totalFastigheter: number }) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const [punkter, setPunkter] = useState<KartaPunkt[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [geokodar, setGeokodar] = useState(false);
  const [geokodMsg, setGeokodMsg] = useState<string | null>(null);

  const ladda = useCallback(async () => {
    try {
      const p = await d2dGetKartaData(projektId);
      setPunkter(p);
    } catch (e) {
      setLoadErr(e instanceof DataError ? e.message : "Kunde inte hämta kartdata.");
    }
  }, [projektId]);

  useEffect(() => { ladda(); }, [ladda]);

  useEffect(() => {
    if (!punkter || punkter.length === 0) return;
    let cancelled = false;
    loadLeaflet().then(() => {
      if (cancelled || !mapElRef.current) return;
      const L = (window as unknown as { L: any }).L;
      if (!mapRef.current) {
        mapRef.current = L.map(mapElRef.current);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap-bidragsgivare",
          maxZoom: 19,
        }).addTo(mapRef.current);
      }
      const map = mapRef.current as any;
      // Rensa gamla markörer vid omladdning (t.ex. efter "Geokoda nu").
      map.eachLayer((layer: any) => {
        if (layer instanceof L.Marker) map.removeLayer(layer);
      });
      const bounds: [number, number][] = [];
      for (const p of punkter) {
        const marker = L.marker([p.lat, p.lon]).addTo(map);
        const rader = [
          `<strong>${p.titel ?? p.fastighetsbeteckning ?? "Fastighet"}</strong>`,
          p.fastighetsbeteckning ? p.fastighetsbeteckning : null,
          [p.adress, p.ort].filter(Boolean).join(", ") || null,
          p.geoKalla === "ort" ? "<em>Ungefärlig placering (ort, ej exakt adress)</em>" : null,
        ].filter(Boolean);
        marker.bindPopup(rader.join("<br>"));
        bounds.push([p.lat, p.lon]);
      }
      if (bounds.length === 1) map.setView(bounds[0], 13);
      else map.fitBounds(bounds, { padding: [24, 24] });
    }).catch((e) => setLoadErr(String(e)));
    return () => { cancelled = true; };
  }, [punkter]);

  useEffect(() => () => {
    const map = mapRef.current as any;
    if (map) { map.remove(); mapRef.current = null; }
  }, []);

  async function geokodaNu() {
    setGeokodar(true); setGeokodMsg(null); setLoadErr(null);
    try {
      const res = await d2dGeokodaNu();
      const delar = [
        res.adress ? `${res.adress} via adress` : null,
        res.ort ? `${res.ort} via ort` : null,
        res.utan_traff ? `${res.utan_traff} utan träff` : null,
        res.utan_forankring ? `${res.utan_forankring} saknar ort/adress` : null,
        res.fel ? `${res.fel} fel` : null,
      ].filter(Boolean).join(", ");
      setGeokodMsg(res.totalt === 0 ? "Inget att geokoda just nu." : `Körde ${res.totalt} st: ${delar}.`);
      await ladda();
    } catch (e) {
      setLoadErr(e instanceof DataError ? e.message : "Kunde inte köra geokodningen.");
    } finally {
      setGeokodar(false);
    }
  }

  const saknar = totalFastigheter - (punkter?.length ?? 0);

  return (
    <div className="d2dpb-detail__section">
      <div className="d2dpb-detail__section-header">
        <h3>Karta</h3>
        <button className="btn btn--ghost btn--sm" onClick={geokodaNu} disabled={geokodar}>
          {geokodar ? "Geokodar…" : "Geokoda nu"}
        </button>
      </div>
      {totalFastigheter === 0 ? (
        <div className="d2d-empty">Lägg till fastigheter i projektet för att se dem på kartan.</div>
      ) : (
        <>
          <p className="ink-faint">
            {saknar > 0
              ? `${saknar} av ${totalFastigheter} fastighet(er) saknar koordinater ännu. Geokodningen körs automatiskt var 5:e minut, eller kör den direkt med knappen ovan.`
              : `Alla ${totalFastigheter} fastighet(er) har koordinater.`}
          </p>
          {geokodMsg && <div className="d2d-save-ok">✓ {geokodMsg}</div>}
          {loadErr && <div className="d2d-error">{loadErr}</div>}
          {punkter && punkter.length > 0 && (
            <div ref={mapElRef} className="d2dpb-karta" />
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// Leveranskarta — toppnivåvy med ALLA leveranser (levererade + kommande),
// oavsett om de plockats in i ett D2D-projekt än. Klick på en pin ger
// möjlighet att lägga till fastigheten i ett valt projekt, som ett
// komplement till textsökningen i AddFastighetPicker (delar samma
// skapande-logik via d2dSkapaFastighetFranLeverans).
// =============================================================================

function LeveransKarta() {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const [punkter, setPunkter] = useState<LeveransPunkt[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [geokodar, setGeokodar] = useState(false);
  const [geokodMsg, setGeokodMsg] = useState<string | null>(null);

  const [projekt, setProjekt] = useState<RecordRow[]>([]);
  const [valtProjektId, setValtProjektId] = useState<string>("");
  const [visaBaraOplockade, setVisaBaraOplockade] = useState(false);

  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addOk, setAddOk] = useState<string | null>(null);

  const ladda = useCallback(async () => {
    try {
      const [p, proj] = await Promise.all([
        d2dGetLeveransKartaData(),
        listRecords({ objectType: "d2d_projekt", limit: 200, sort: { field: "updated_at", dir: "desc" } }),
      ]);
      setPunkter(p);
      setProjekt(proj.items);
      setValtProjektId((cur) => cur || proj.items[0]?.id || "");
    } catch (e) {
      setLoadErr(e instanceof DataError ? e.message : "Kunde inte hämta kartdata.");
    }
  }, []);

  useEffect(() => { ladda(); }, [ladda]);

  const synligaPunkter = (punkter ?? []).filter((p) => !visaBaraOplockade || !p.redanIProjekt);

  const laggTill = useCallback(async (leveransId: string) => {
    if (!valtProjektId) {
      setAddErr("Välj ett projekt först.");
      return;
    }
    setAddBusy(true); setAddErr(null); setAddOk(null);
    try {
      await d2dSkapaFastighetFranLeverans(leveransId, valtProjektId, Date.now());
      setAddOk("Fastigheten lades till i projektet.");
      await ladda();
    } catch (e) {
      setAddErr(e instanceof DataError ? e.message : "Kunde inte lägga till fastigheten.");
    } finally {
      setAddBusy(false);
    }
  }, [valtProjektId, ladda]);

  useEffect(() => {
    if (!mapElRef.current) return;
    let cancelled = false;
    loadLeaflet().then(() => {
      if (cancelled || !mapElRef.current) return;
      const L = (window as unknown as { L: any }).L;
      if (!mapRef.current) {
        mapRef.current = L.map(mapElRef.current);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap-bidragsgivare",
          maxZoom: 19,
        }).addTo(mapRef.current);
      }
      const map = mapRef.current as any;
      map.eachLayer((layer: any) => {
        if (layer instanceof L.CircleMarker) map.removeLayer(layer);
      });
      const bounds: [number, number][] = [];
      for (const p of synligaPunkter) {
        const farg = p.redanIProjekt ? "#3388ff" : (p.kundklar ? "#2e9e4f" : "#8a8a8a");
        const marker = L.circleMarker([p.lat, p.lon], {
          radius: 6, color: farg, fillColor: farg, fillOpacity: 0.85, weight: 1,
        }).addTo(map);
        const rader = [
          `<strong>${p.titel ?? p.fastighetsbeteckning ?? "Fastighet"}</strong>`,
          p.fastighetsbeteckning ? p.fastighetsbeteckning : null,
          [p.adress, p.ort].filter(Boolean).join(", ") || null,
          p.geoKalla === "ort" ? "<em>Ungefärlig placering (ort, ej exakt adress)</em>" : null,
          p.redanIProjekt ? "<em>Redan i ett D2D-projekt</em>" : null,
        ].filter(Boolean);
        const popupEl = document.createElement("div");
        popupEl.innerHTML = rader.join("<br>");
        if (!p.redanIProjekt) {
          const btn = document.createElement("button");
          btn.className = "btn btn--brand btn--sm";
          btn.style.marginTop = "6px";
          btn.textContent = "Lägg till i valt projekt";
          btn.onclick = () => laggTill(p.id);
          popupEl.appendChild(document.createElement("br"));
          popupEl.appendChild(btn);
        }
        marker.bindPopup(popupEl);
        bounds.push([p.lat, p.lon]);
      }
      if (bounds.length === 1) map.setView(bounds[0], 13);
      else if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24] });
      else map.setView([59.33, 18.06], 5);
    }).catch((e) => setLoadErr(String(e)));
    return () => { cancelled = true; };
  }, [synligaPunkter, laggTill]);

  useEffect(() => () => {
    const map = mapRef.current as any;
    if (map) { map.remove(); mapRef.current = null; }
  }, []);

  async function geokodaNu() {
    setGeokodar(true); setGeokodMsg(null); setLoadErr(null);
    try {
      const res = await d2dGeokodaNu();
      const delar = [
        res.adress ? `${res.adress} via adress` : null,
        res.ort ? `${res.ort} via ort` : null,
        res.utan_traff ? `${res.utan_traff} utan träff` : null,
        res.utan_forankring ? `${res.utan_forankring} saknar ort/adress` : null,
        res.fel ? `${res.fel} fel` : null,
      ].filter(Boolean).join(", ");
      setGeokodMsg(res.totalt === 0 ? "Inget att geokoda just nu." : `Körde ${res.totalt} st: ${delar}.`);
      await ladda();
    } catch (e) {
      setLoadErr(e instanceof DataError ? e.message : "Kunde inte köra geokodningen.");
    } finally {
      setGeokodar(false);
    }
  }

  if (!punkter) {
    return loadErr
      ? <div className="d2d-error">{loadErr}</div>
      : <div className="d2d-loading">Laddar karta…</div>;
  }

  return (
    <div className="d2dpb-leveranskarta">
      <div className="d2dpb-leveranskarta__toolbar">
        <h2>Leveranskarta</h2>
        <label className="d2dpb-leveranskarta__filter">
          <input
            type="checkbox"
            checked={visaBaraOplockade}
            onChange={(e) => setVisaBaraOplockade(e.target.checked)}
          />
          Visa bara ej inplockade
        </label>
        <select
          className="input"
          value={valtProjektId}
          onChange={(e) => setValtProjektId(e.target.value)}
        >
          <option value="">Välj projekt…</option>
          {projekt.map((p) => (
            <option key={p.id} value={p.id}>{p.title ?? "Namnlöst projekt"}</option>
          ))}
        </select>
        <button className="btn btn--ghost btn--sm" onClick={geokodaNu} disabled={geokodar}>
          {geokodar ? "Geokodar…" : "Geokoda nu"}
        </button>
      </div>

      <p className="ink-faint">
        {punkter.length} av leveransbeståndet har koordinater ännu ({synligaPunkter.length} visas).
        Geokodningen körs automatiskt var 5:e minut, eller kör den direkt med knappen ovan.
      </p>

      <div className="d2dpb-leveranskarta__legend">
        <span><i className="d2dpb-dot d2dpb-dot--blue" /> I ett D2D-projekt</span>
        <span><i className="d2dpb-dot d2dpb-dot--green" /> Kundklar, ej inplockad</span>
        <span><i className="d2dpb-dot d2dpb-dot--gray" /> Ej inplockad</span>
      </div>

      {geokodMsg && <div className="d2d-save-ok">✓ {geokodMsg}</div>}
      {addOk && <div className="d2d-save-ok">✓ {addOk}</div>}
      {addErr && <div className="d2d-error">{addErr}</div>}
      {loadErr && <div className="d2d-error">{loadErr}</div>}
      {addBusy && <div className="d2d-loading">Lägger till…</div>}

      <div ref={mapElRef} className="d2dpb-leveranskarta__map" />
    </div>
  );
}

// =============================================================================
// Adressradsformulär — matchar exakt fälten som d2d_import_addresses tar emot
// =============================================================================

type AddrRow = {
  lagenhetsnummer: string; postort: string; postnummer: string;
  fastighetsbeteckning: string; portkod: string; gatunamn: string; gatnr: string;
  ingang: string; alias: string; punktid: string; klass: string; cpe_model: string;
  installationsdatum: string; befintlig_fiber: string; befintlig_koax: string;
  koax_avslutsdatum: string; befintligt_kanalpaket: string; nytt_kanalpaket: string;
};

const EMPTY_ADDR_ROW: AddrRow = {
  lagenhetsnummer: "", postort: "", postnummer: "", fastighetsbeteckning: "",
  portkod: "", gatunamn: "", gatnr: "", ingang: "", alias: "", punktid: "",
  klass: "", cpe_model: "", installationsdatum: "", befintlig_fiber: "",
  befintlig_koax: "", koax_avslutsdatum: "", befintligt_kanalpaket: "", nytt_kanalpaket: "",
};

const ADDR_COLUMNS: Array<{ key: keyof AddrRow; label: string }> = [
  { key: "lagenhetsnummer", label: "Lägenhetsnr" },
  { key: "gatunamn", label: "Gatunamn" },
  { key: "gatnr", label: "Gatnr" },
  { key: "ingang", label: "Ingång" },
  { key: "postnummer", label: "Postnr" },
  { key: "postort", label: "Postort" },
  { key: "fastighetsbeteckning", label: "Fastighetsbeteckning" },
  { key: "portkod", label: "Portkod" },
  { key: "alias", label: "Alias" },
  { key: "punktid", label: "PunktID" },
  { key: "klass", label: "Klass" },
  { key: "cpe_model", label: "CPE Model" },
  { key: "installationsdatum", label: "Installationsdatum" },
  { key: "befintlig_fiber", label: "Befintlig fiber" },
  { key: "befintlig_koax", label: "Befintlig koax" },
  { key: "koax_avslutsdatum", label: "Avslutsdatum koax" },
  { key: "befintligt_kanalpaket", label: "Befintligt kanalpaket" },
  { key: "nytt_kanalpaket", label: "Nytt kanalpaket" },
];

function AddressEditor({
  fastighetId, existingCount, onImported,
}: {
  fastighetId: string; existingCount: number; onImported: () => void;
}) {
  const [rows, setRows] = useState<AddrRow[]>([{ ...EMPTY_ADDR_ROW }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  function setCell(i: number, key: keyof AddrRow, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }
  function addRow() { setRows((rs) => [...rs, { ...EMPTY_ADDR_ROW }]); }
  function removeRow(i: number) { setRows((rs) => rs.filter((_, idx) => idx !== i)); }

  async function save() {
    setSaving(true); setError(null); setOk(null);
    try {
      const nonEmpty = rows.filter((r) => Object.values(r).some((v) => v.trim() !== ""));
      if (nonEmpty.length === 0) { setError("Lägg till minst en rad."); return; }
      const res = await d2dImportAddresses(fastighetId, nonEmpty);
      setOk(`${res.imported} adress(er) sparade.`);
      setRows([{ ...EMPTY_ADDR_ROW }]);
      onImported();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara adresserna.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="d2dpb-addr">
      <div className="d2dpb-addr__header">
        <span>{existingCount} adress(er) redan inlagda</span>
      </div>
      <div className="d2dpb-addr__table-wrap">
        <table className="d2dpb-addr__table">
          <thead>
            <tr>
              {ADDR_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {ADDR_COLUMNS.map((c) => (
                  <td key={c.key}>
                    <input
                      className="d2dpb-addr__input"
                      value={row[c.key]}
                      onChange={(e) => setCell(i, c.key, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <button className="btn btn--ghost btn--sm" onClick={() => removeRow(i)} title="Ta bort rad">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="d2dpb-addr__actions">
        <button className="btn btn--ghost btn--sm" onClick={addRow}>+ Rad</button>
        <button className="btn btn--brand btn--sm" onClick={save} disabled={saving}>
          {saving ? "Sparar…" : "Spara adresser"}
        </button>
        {ok && <span className="d2d-save-ok">✓ {ok}</span>}
        {error && <span className="d2d-error">{error}</span>}
      </div>
    </div>
  );
}

// =============================================================================
// Säljartilldelning (procent)
// =============================================================================

type Assignment = { user_id: string; procent: number };

function AssignmentEditor({
  fastighetId, sellers, initial, onSaved,
}: {
  fastighetId: string; sellers: SellerOption[]; initial: Assignment[]; onSaved: () => void;
}) {
  const [rows, setRows] = useState<Assignment[]>(initial.length ? initial : []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const sum = rows.reduce((s, r) => s + (Number(r.procent) || 0), 0);

  function addRow() {
    const unused = sellers.find((s) => !rows.some((r) => r.user_id === s.id));
    if (!unused) return;
    setRows((rs) => [...rs, { user_id: unused.id, procent: 0 }]);
  }
  function setRow(i: number, patch: Partial<Assignment>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true); setError(null); setOk(false);
    try {
      if (rows.length === 0) { setError("Lägg till minst en säljare."); return; }
      if (Math.abs(sum - 100) > 0.5) { setError(`Procentsatserna måste summera till 100 (nu ${sum}).`); return; }
      await d2dSetAssignment(fastighetId, rows.map((r) => ({ user_id: r.user_id, procent: Number(r.procent) })));
      setOk(true);
      onSaved();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte spara tilldelningen.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="d2dpb-assign">
      {rows.map((r, i) => (
        <div key={i} className="d2dpb-assign__row">
          <select
            className="input"
            value={r.user_id}
            onChange={(e) => setRow(i, { user_id: e.target.value })}
          >
            {sellers.map((s) => (
              <option key={s.id} value={s.id} disabled={rows.some((rr, idx) => idx !== i && rr.user_id === s.id)}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="number" min={0} max={100} step={1}
            value={r.procent}
            onChange={(e) => setRow(i, { procent: Number(e.target.value) })}
          />
          <span>%</span>
          <button className="btn btn--ghost btn--sm" onClick={() => removeRow(i)}>✕</button>
        </div>
      ))}
      <div className="d2dpb-assign__actions">
        <button className="btn btn--ghost btn--sm" onClick={addRow} disabled={rows.length >= sellers.length}>
          + Lägg till säljare
        </button>
        <span className={sum === 100 ? "d2d-save-ok" : "d2d-error"}>{sum} % av 100 %</span>
        <button className="btn btn--brand btn--sm" onClick={save} disabled={saving}>
          {saving ? "Sparar…" : "Spara tilldelning"}
        </button>
        {ok && <span className="d2d-save-ok">✓ Sparat</span>}
        {error && <span className="d2d-error">{error}</span>}
      </div>
      {sellers.length === 0 && (
        <div className="d2d-empty">Inga säljare med rollen "Dörrsäljare" finns ännu. Skapa användarkonton och tilldela rollen i Supabase Authentication.</div>
      )}
    </div>
  );
}

// =============================================================================
// Fastighetsrad i projektet
// =============================================================================

type FastRow = RecordRow & { _addrCount: number };

function FastighetRow({
  fastighet, sellers, onChanged, onRemove,
}: {
  fastighet: FastRow; sellers: SellerOption[]; onChanged: () => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState<"none" | "addresses" | "assign">("none");
  const [turordning, setTurordning] = useState(String((fastighet.data as Record<string, unknown>).turordning ?? ""));

  async function saveTurordning() {
    const n = turordning.trim() === "" ? null : Number(turordning);
    await updateRecord(fastighet.id, { turordning: n }).catch(() => {});
    onChanged();
  }

  const data = fastighet.data as Record<string, unknown>;
  const assignment = (data.saljartilldelning as Assignment[] | undefined) ?? [];

  return (
    <div className="d2dpb-fast">
      <div className="d2dpb-fast__main">
        <input
          className="input d2dpb-fast__turordning"
          type="number"
          value={turordning}
          onChange={(e) => setTurordning(e.target.value)}
          onBlur={saveTurordning}
          title="Turordning"
        />
        <div className="d2dpb-fast__title">
          <strong>{fastighet.title ?? "Namnlös"}</strong>
          {!!data.fastighetsbeteckning && <span className="d2d-card__sub"> · {String(data.fastighetsbeteckning)}</span>}
        </div>
        <span className="d2d-card__badge">{fastighet._addrCount} adress(er)</span>
        {assignment.length > 0 && (
          <span className="d2d-card__badge">{assignment.length} säljare</span>
        )}
        <StatusPill status={fastighet.status} />
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(open === "addresses" ? "none" : "addresses")}>
          Adresser
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(open === "assign" ? "none" : "assign")}>
          Tilldela säljare
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onRemove} title="Ta bort fastighet ur projektet">Ta bort</button>
      </div>

      {open === "addresses" && (
        <AddressEditor
          fastighetId={fastighet.id}
          existingCount={fastighet._addrCount}
          onImported={onChanged}
        />
      )}
      {open === "assign" && (
        <AssignmentEditor
          fastighetId={fastighet.id}
          sellers={sellers}
          initial={assignment}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

// =============================================================================
// Lägg till fastighet — sök leverans
// =============================================================================

function AddFastighetPicker({ projektId, turordningStart, onAdded }: {
  projektId: string; turordningStart: number; onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<RecordRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(q: string) {
    setQuery(q);
    if (q.trim().length < 2) { setOptions([]); return; }
    try {
      const res = await listRecords({ objectType: "delivery", search: q, limit: 10 });
      setOptions(res.items);
    } catch {
      setOptions([]);
    }
  }

  async function pick(delivery: RecordRow) {
    setBusy(true); setError(null);
    try {
      // Skapandet av d2d_fastighet-posten (inkl. ärvda koordinater och
      // länken tillbaka till leveransen) sker i d2dSkapaFastighetFranLeverans
      // så att både textsökningen här och "Lägg till i projekt" på
      // översiktskartan delar exakt samma logik.
      await d2dSkapaFastighetFranLeverans(delivery.id, projektId, turordningStart);
      setQuery(""); setOptions([]);
      onAdded();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte lägga till fastigheten.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="d2dpb-picker">
      <input
        className="input"
        placeholder="Sök leverans (adress, fastighetsbeteckning, kund)…"
        value={query}
        onChange={(e) => search(e.target.value)}
        disabled={busy}
      />
      {options.length > 0 && (
        <div className="card d2dpb-picker__options">
          {options.map((o) => {
            const od = o.data as Record<string, unknown>;
            return (
              <button key={o.id} className="d2dpb-picker__option" onClick={() => pick(o)} disabled={busy}>
                <strong>{o.title ?? String(od.adress ?? "Namnlös")}</strong>
                {!!od.fastighetsbeteckning && <span> · {String(od.fastighetsbeteckning)}</span>}
              </button>
            );
          })}
        </div>
      )}
      {error && <div className="d2d-error">{error}</div>}
    </div>
  );
}

// =============================================================================
// Projektdetalj
// =============================================================================

function ProjectDetail({ projektId, onBack }: { projektId: string; onBack: () => void }) {
  const [project, setProject] = useState<RecordRow | null>(null);
  const [fastigheter, setFastigheter] = useState<FastRow[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [approveMsg, setApproveMsg] = useState<string | null>(null);
  const [approveErr, setApproveErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [proj, sellerList] = await Promise.all([getRecord(projektId), listSellers()]);
      setProject(proj.record);
      setSellers(sellerList);

      const fastIds = proj.related
        .filter((r) => r.record.objectType === "d2d_fastighet")
        .map((r) => r.record.id);

      if (fastIds.length === 0) { setFastigheter([]); return; }

      const { data: fastData } = await supabase
        .from("records")
        .select("id,object_type,data,status,owner_user_id,title,created_at,updated_at")
        .in("id", fastIds);

      const { data: relCounts } = await supabase
        .from("relationships")
        .select("to_record_id")
        .eq("rel_type", "d2d_lag_fastighet")
        .in("to_record_id", fastIds);

      const counts = new Map<string, number>();
      for (const r of (relCounts ?? []) as Array<{ to_record_id: string }>) {
        counts.set(r.to_record_id, (counts.get(r.to_record_id) ?? 0) + 1);
      }

      const rows = ((fastData ?? []) as RecordRow[])
        .map((f) => ({ ...f, _addrCount: counts.get(f.id) ?? 0 }))
        .sort((a, b) => {
          const ta = Number((a.data as Record<string, unknown>).turordning ?? 999999);
          const tb = Number((b.data as Record<string, unknown>).turordning ?? 999999);
          return ta - tb;
        });
      setFastigheter(rows);
    } catch {
      // tyst
    } finally {
      setLoading(false);
    }
  }, [projektId]);

  useEffect(() => { load(); }, [load]);

  async function removeFastighet(id: string) {
    if (!confirm("Ta bort fastigheten ur projektet? Lägenheter/adresser tas inte bort.")) return;
    await removeRelation(id, "d2d_fast_projekt", projektId).catch(() => {});
    load();
  }

  async function approve() {
    setApproving(true); setApproveMsg(null); setApproveErr(null);
    try {
      const res = await d2dApproveProject(projektId);
      setApproveMsg(
        `Klart — ${res.distributed} adress(er) utdelade.` +
        (res.fastigheterUtanTilldelning > 0
          ? ` OBS: ${res.fastigheterUtanTilldelning} fastighet(er) saknade tilldelning och hoppades över.`
          : "")
      );
      load();
    } catch (e) {
      setApproveErr(e instanceof DataError ? e.message : "Kunde inte godkänna projektet.");
    } finally {
      setApproving(false);
    }
  }

  if (loading) return <div className="d2d-loading">Laddar projekt…</div>;
  if (!project) return <div className="d2d-empty">Projektet hittades inte.</div>;

  const data = project.data as Record<string, unknown>;

  return (
    <div className="d2dpb-detail">
      <div className="d2dpb-detail__header">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>← Alla projekt</button>
        <h2>{project.title ?? "Projekt"}</h2>
        <StatusPill status={project.status} />
      </div>
      {!!data.description && <p className="ink-faint">{String(data.description)}</p>}

      <div className="d2dpb-detail__section">
        <div className="d2dpb-detail__section-header">
          <h3>Fastigheter ({fastigheter.length})</h3>
        </div>
        {fastigheter.length === 0 && (
          <div className="d2d-empty">Inga fastigheter tillagda ännu. Sök upp en leverans nedan för att lägga till en.</div>
        )}
        {fastigheter.map((f) => (
          <FastighetRow
            key={f.id}
            fastighet={f}
            sellers={sellers}
            onChanged={load}
            onRemove={() => removeFastighet(f.id)}
          />
        ))}
        <AddFastighetPicker
          projektId={projektId}
          turordningStart={fastigheter.length + 1}
          onAdded={load}
        />
      </div>

      <KartaSection projektId={projektId} totalFastigheter={fastigheter.length} />

      <div className="d2dpb-detail__approve">
        <button className="btn btn--brand" onClick={approve} disabled={approving || fastigheter.length === 0}>
          {approving ? "Godkänner…" : "Godkänn projekt och dela ut adresser"}
        </button>
        <p className="ink-faint">
          Delar ut adresserna till respektive säljare enligt tilldelad procentandel per fastighet,
          och gör dem synliga i säljarnas app.
        </p>
        {approveMsg && <div className="d2d-save-ok">✓ {approveMsg}</div>}
        {approveErr && <div className="d2d-error">{approveErr}</div>}
      </div>
    </div>
  );
}

// =============================================================================
// Projektlista
// =============================================================================

function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listRecords({ objectType: "d2d_projekt", limit: 200, sort: { field: "updated_at", dir: "desc" } });
      setItems(res.items);
    } catch {
      // tyst
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!newName.trim()) return;
    setError(null);
    try {
      const row = await createRecord("d2d_projekt", { name: newName.trim() }, "planering");
      setNewName(""); setCreating(false);
      await load();
      onOpen(row.id);
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte skapa projektet.");
    }
  }

  if (loading) return <div className="d2d-loading">Laddar projekt…</div>;

  return (
    <div className="d2dpb-list">
      <div className="d2dpb-list__header">
        <h2>D2D-projekt</h2>
        <button className="btn btn--brand btn--sm" onClick={() => setCreating((c) => !c)}>
          {creating ? "Avbryt" : "+ Nytt projekt"}
        </button>
      </div>

      {creating && (
        <div className="d2dpb-list__new">
          <input
            className="input"
            placeholder="Projektnamn"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <button className="btn btn--brand btn--sm" onClick={create}>Skapa</button>
          {error && <span className="d2d-error">{error}</span>}
        </div>
      )}

      {items.length === 0 && <div className="d2d-empty">Inga D2D-projekt ännu.</div>}

      {items.map((item) => (
        <button key={item.id} className="d2d-card" onClick={() => onOpen(item.id)}>
          <div className="d2d-card__main">
            <span className="d2d-card__title">{item.title ?? "Namnlöst projekt"}</span>
          </div>
          <div className="d2d-card__meta">
            <StatusPill status={item.status} />
          </div>
          <svg className="d2d-card__chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 4l4 4-4 4"/></svg>
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// Huvudkomponent
// =============================================================================

export function D2DProjectBuilder() {
  const [view, setView] = useState<
    { kind: "list" } | { kind: "project"; id: string } | { kind: "karta" }
  >({ kind: "list" });

  return (
    <div className="d2dpb">
      {view.kind !== "project" && (
        <div className="d2dpb-toplevel-tabs">
          <button
            className={`btn btn--sm ${view.kind === "list" ? "btn--brand" : "btn--ghost"}`}
            onClick={() => setView({ kind: "list" })}
          >
            Projekt
          </button>
          <button
            className={`btn btn--sm ${view.kind === "karta" ? "btn--brand" : "btn--ghost"}`}
            onClick={() => setView({ kind: "karta" })}
          >
            Karta
          </button>
        </div>
      )}
      {view.kind === "list" && <ProjectList onOpen={(id) => setView({ kind: "project", id })} />}
      {view.kind === "karta" && <LeveransKarta />}
      {view.kind === "project" && (
        <ProjectDetail projektId={view.id} onBack={() => setView({ kind: "list" })} />
      )}
    </div>
  );
}
