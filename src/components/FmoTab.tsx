import { useEffect, useMemo, useState } from "react";
import type { RecordRow, RelatedRecord } from "@/lib/data";
import { fmoAngra, fmoLista, fmoLoggFor, fmoSkicka, fmoSvara, type FmoLogg } from "@/lib/fmo";

/* =============================================================================
   Affär → FMO-check. Säljaren väljer vilka fastigheter som ska kontrolleras
   och skickar dem. Telia svarar (i sin FMO-vy eller via fil); godkända ligger
   kvar i affären, ej godkända tas bort och syns i historiken nedan.
   ========================================================================== */

type Fmo = { status?: string; skickad?: string; besvarad?: string; kommentar?: string | null };
const datum = (s?: string | null) => (s ? new Date(s).toLocaleDateString("sv-SE") : "");

export function FmoTab({ deal, related, kanSvara, onChanged }: {
  deal: RecordRow;
  related: RelatedRecord[];
  /** Administratörer kan också svara (t.ex. om Telia mejlat svaret). */
  kanSvara: boolean;
  onChanged: () => void;
}) {
  const fastigheter = useMemo(
    () => related.filter((r) => r.relType === "deal_property" && r.record.objectType === "property")
      .map((r) => ({ id: r.record.id, namn: r.record.title ?? "Fastighet", fmo: ((r.data ?? {}) as { fmo?: Fmo }).fmo ?? null }))
      .sort((a, b) => a.namn.localeCompare(b.namn, "sv")),
    [related]);
  const [valda, setValda] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [logg, setLogg] = useState<FmoLogg[]>([]);

  useEffect(() => { fmoLoggFor(deal.id).then(setLogg).catch(() => setLogg([])); }, [deal.id, related]);
  useEffect(() => { setValda(new Set()); }, [related]);
  // Kopplingens id per fastighet (behövs bara för att svara direkt härifrån).
  const [relIds, setRelIds] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!kanSvara) return;
    fmoLista("alla")
      .then((r) => setRelIds(new Map(r.filter((x) => x.dealId === deal.id).map((x) => [x.propertyId, x.id]))))
      .catch(() => setRelIds(new Map()));
  }, [kanSvara, deal.id, related]);

  const ejSkickade = fastigheter.filter((f) => !f.fmo?.status);
  const skickade = fastigheter.filter((f) => f.fmo?.status === "skickad");
  const godkanda = fastigheter.filter((f) => f.fmo?.status === "godkand");
  const borttagna = logg.filter((l) => l.status === "ej_godkand");

  async function kor(fn: () => Promise<unknown>) {
    setBusy(true); setFel(null);
    try { await fn(); onChanged(); }
    catch (e) { setFel((e as Error).message); }
    finally { setBusy(false); }
  }
  const vagla = (id: string) => setValda((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const valdaEj = ejSkickade.filter((f) => valda.has(f.id)).map((f) => f.id);
  const valdaSkickade = skickade.filter((f) => valda.has(f.id)).map((f) => f.id);

  return (
    <div className="drawer__main fmo-tab">
      <div className="fmo-tab__summa">
        <span><b>{fastigheter.length}</b> fastigheter i affären</span>
        <span className="fmo-tab__dot fmo-tab__dot--skickad"><b>{skickade.length}</b> väntar på FMO</span>
        <span className="fmo-tab__dot fmo-tab__dot--godkand"><b>{godkanda.length}</b> godkända</span>
        {borttagna.length > 0 && <span className="fmo-tab__dot fmo-tab__dot--ej"><b>{borttagna.length}</b> borttagna av FMO</span>}
      </div>

      <div className="fmo-tab__knappar">
        <button className="btn btn--brand btn--sm" disabled={busy || valdaEj.length === 0}
          onClick={() => void kor(() => fmoSkicka(deal.id, valdaEj))}>
          Skicka {valdaEj.length || ""} på FMO-check
        </button>
        {valdaSkickade.length > 0 && (
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void kor(() => fmoAngra(deal.id, valdaSkickade))}>
            Ångra {valdaSkickade.length} skickade
          </button>
        )}
        {ejSkickade.length > 0 && (
          <button className="btn btn--ghost btn--sm" disabled={busy}
            onClick={() => setValda(valdaEj.length === ejSkickade.length ? new Set() : new Set(ejSkickade.map((f) => f.id)))}>
            {valdaEj.length === ejSkickade.length ? "Avmarkera alla" : "Markera alla ej skickade"}
          </button>
        )}
      </div>
      {fel && <div className="formfield__error">{fel}</div>}

      {fastigheter.length === 0 ? (
        <p className="formfield__help">Affären har inga fastigheter.</p>
      ) : (
        <ul className="fmo-tab__lista">
          {fastigheter.map((f) => {
            const st = f.fmo?.status;
            return (
              <li key={f.id} className={`fmo-tab__rad${valda.has(f.id) ? " fmo-tab__rad--vald" : ""}`}>
                <label className="fmo-tab__val">
                  <input type="checkbox" checked={valda.has(f.id)} disabled={st === "godkand"} onChange={() => vagla(f.id)} />
                  <span className="fmo-tab__namn">{f.namn}</span>
                </label>
                <span className={`fmo-tab__status fmo-tab__status--${st ?? "ej"}`}>
                  {st === "skickad" ? `Skickad ${datum(f.fmo?.skickad)}`
                    : st === "godkand" ? `Godkänd ${datum(f.fmo?.besvarad)}`
                    : "Ej skickad"}
                  {f.fmo?.kommentar ? ` · ${f.fmo.kommentar}` : ""}
                </span>
                {kanSvara && st === "skickad" && (
                  <span className="fmo-tab__svar">
                    <button className="btn btn--ghost btn--sm" disabled={busy}
                      onClick={() => { const r = relIds.get(f.id); if (r) void kor(() => fmoSvara([{ id: r, status: "godkand" }])); }}>Godkänd</button>
                    <button className="btn btn--ghost btn--sm" disabled={busy}
                      onClick={() => { const r = relIds.get(f.id); if (r && confirm(`${f.namn} tas bort ur affären. Fortsätta?`)) void kor(() => fmoSvara([{ id: r, status: "ej_godkand" }])); }}>Ej godkänd</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {borttagna.length > 0 && (
        <div className="fmo-tab__historik">
          <h3>Borttagna efter FMO-check</h3>
          <ul>
            {borttagna.map((l, i) => (
              <li key={i}><b>{l.fastighet}</b> · {datum(l.tid)}{l.av ? ` · ${l.av}` : ""}{l.kommentar ? ` · ${l.kommentar}` : ""}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
