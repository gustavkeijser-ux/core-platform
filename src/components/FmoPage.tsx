import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ThemeToggle } from "@/lib/theme";
import {
  exporteraFmo, fmoLista, fmoSvara, lasSvarsfil,
  type FmoRad, type ImportRad,
} from "@/lib/fmo";
import { EmptyState, FilterPills, SearchField, SkeletonRows, TopbarActions } from "./PageChrome";

/* =============================================================================
   FMO-check för Telia (och administratörer): fastigheterna som säljarna
   skickat. Svara Godkänd / Ej godkänd direkt här, eller exportera listan
   till Excel, fyll i kolumnen Svar och importera filen igen.
   Ej godkända fastigheter tas bort ur affären.
   ========================================================================== */

const fmt = (s: string | null) => (s ? new Date(s).toLocaleDateString("sv-SE") : "");

export function FmoPage({ fristaende = false }: { fristaende?: boolean }) {
  const [filter, setFilter] = useState<"oppna" | "alla">("oppna");
  const [rader, setRader] = useState<FmoRad[] | null>(null);
  const [fel, setFel] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sok, setSok] = useState("");
  const [valda, setValda] = useState<Set<string>>(new Set());
  const [kommentar, setKommentar] = useState<Record<string, string>>({});
  const [sparar, setSparar] = useState(false);
  const [importRader, setImportRader] = useState<ImportRad[] | null>(null);
  const filRef = useRef<HTMLInputElement>(null);

  const ladda = useCallback(async () => {
    try { setRader(await fmoLista(filter)); setFel(null); }
    catch (e) { setFel((e as Error).message); }
  }, [filter]);
  useEffect(() => { setRader(null); setValda(new Set()); void ladda(); }, [ladda]);

  const visade = useMemo(() => {
    const q = sok.trim().toLowerCase();
    return (rader ?? []).filter((r) => !q || [r.fastighet, r.fastighetKomplett, r.koncernmoder, r.adress, r.kommun, r.orgnr]
      .some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rader, sok]);
  const oppna = useMemo(() => (rader ?? []).filter((r) => r.status === "skickad"), [rader]);

  async function svara(ids: string[], status: "godkand" | "ej_godkand") {
    if (!ids.length) return;
    if (status === "ej_godkand" && !confirm(`${ids.length === 1 ? "Fastigheten" : `${ids.length} fastigheter`} tas bort ur affären. Fortsätta?`)) return;
    setSparar(true); setFel(null); setInfo(null);
    try {
      const r = await fmoSvara(ids.map((id) => ({ id, status, kommentar: kommentar[id] || undefined })));
      setInfo(`${r.godkanda} godkända, ${r.borttagna} ej godkända (borttagna ur affären).`);
      setValda(new Set());
      await ladda();
    } catch (e) { setFel((e as Error).message); }
    finally { setSparar(false); }
  }

  async function valjFil(f: File | undefined) {
    if (!f) return;
    setFel(null); setInfo(null);
    try {
      const alla = filter === "oppna" ? (rader ?? []) : await fmoLista("oppna");
      setImportRader(await lasSvarsfil(f, alla.filter((r) => r.status === "skickad")));
    } catch (e) { setFel(`Kunde inte läsa filen: ${(e as Error).message}`); }
    finally { if (filRef.current) filRef.current.value = ""; }
  }

  async function sparaImport() {
    if (!importRader) return;
    const ok = importRader.filter((r) => r.id && r.status);
    const unika = Array.from(new Map(ok.map((r) => [r.id!, r])).values());
    setSparar(true);
    try {
      const r = await fmoSvara(unika.map((x) => ({ id: x.id!, status: x.status!, kommentar: x.kommentar || undefined })));
      setInfo(`Importerat: ${r.godkanda} godkända, ${r.borttagna} ej godkända (borttagna ur affären).`);
      setImportRader(null);
      await ladda();
    } catch (e) { setFel((e as Error).message); }
    finally { setSparar(false); }
  }

  const allaValda = visade.length > 0 && visade.filter((r) => r.status === "skickad").every((r) => valda.has(r.id));
  const vagla = (id: string) => setValda((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const sida = (
    <div className="page fmo">
      {!fristaende && (
        <TopbarActions>
          <SearchField value={sok} onChange={setSok} placeholder="Sök fastighet, kund, kommun…" />
        </TopbarActions>
      )}

      <div className="fmo__head">
        <FilterPills
          active={filter}
          onSelect={(k) => setFilter(k as "oppna" | "alla")}
          items={[
            { key: "oppna", label: "Väntar på svar", count: filter === "oppna" ? rader?.length ?? null : null },
            { key: "alla", label: "Alla", count: filter === "alla" ? rader?.length ?? null : null },
          ]}
        />
        <div className="fmo__verktyg">
          {fristaende && <SearchField value={sok} onChange={setSok} placeholder="Sök…" />}
          <button className="btn btn--ghost btn--sm" disabled={!visade.length} onClick={() => exporteraFmo(visade)}>Exportera till Excel</button>
          <button className="btn btn--brand btn--sm" onClick={() => filRef.current?.click()}>Importera svar</button>
          <input ref={filRef} type="file" accept=".xlsx,.csv" hidden onChange={(e) => void valjFil(e.target.files?.[0])} />
        </div>
      </div>

      <p className="fmo__hjalp">
        Svara per fastighet här, eller exportera till Excel, fyll i kolumnen <b>Svar</b> med <i>Godkänd</i> eller <i>Ej godkänd</i> och importera filen.
        Fastigheter som inte godkänns tas bort ur affären.
      </p>

      {info && <div className="fmo__info">{info}</div>}
      {fel && <div className="formfield__error">{fel}</div>}

      {valda.size > 0 && (
        <div className="bulk-bar card">
          <span className="bulk-bar__count"><strong>{valda.size}</strong> markerade</span>
          <button className="btn btn--brand btn--sm" disabled={sparar} onClick={() => void svara(Array.from(valda), "godkand")}>Godkänd</button>
          <button className="btn btn--ghost btn--sm" disabled={sparar} onClick={() => void svara(Array.from(valda), "ej_godkand")}>Ej godkänd</button>
          <button className="btn btn--ghost btn--sm" onClick={() => setValda(new Set())}>Avmarkera</button>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {rader == null ? <SkeletonRows rows={6} />
          : visade.length === 0 ? (
            <EmptyState kind={sok ? "filtered" : "empty"}
              title={filter === "oppna" ? "Inget väntar på svar" : "Inga fastigheter"}
              text={filter === "oppna" ? "När säljarna skickar fastigheter på FMO-check hamnar de här." : "Prova en annan sökning."} />
          ) : (
            <div className="rtable-scroll">
              <table className="rtable fmo__tabell">
                <thead>
                  <tr>
                    <th className="rtable__select">
                      <input type="checkbox" aria-label="Markera alla" checked={allaValda}
                        onChange={() => setValda(allaValda ? new Set() : new Set(visade.filter((r) => r.status === "skickad").map((r) => r.id)))} />
                    </th>
                    <th>Fastighet</th><th>Koncernmoder</th><th>Adress</th><th>Hushåll</th><th>Skickad</th><th>Svar</th><th aria-hidden />
                  </tr>
                </thead>
                <tbody>
                  {visade.map((r) => (
                    <tr key={r.id} className={`rtable__row${valda.has(r.id) ? " rtable__row--selected" : ""}`}>
                      <td className="rtable__select">
                        {r.status === "skickad" && <input type="checkbox" aria-label={`Markera ${r.fastighet ?? ""}`} checked={valda.has(r.id)} onChange={() => vagla(r.id)} />}
                      </td>
                      <td className="rtable__title" data-label="Fastighet">{r.fastighetKomplett ?? r.fastighet}</td>
                      <td data-label="Koncernmoder"><span>{r.koncernmoder}{r.orgnr && <small className="fmo__sub"> {r.orgnr}</small>}</span></td>
                      <td data-label="Adress" className="fmo__adress"><span>{r.adress}{(r.kommun ?? r.ort) && <small className="fmo__sub"> {r.kommun ?? r.ort}</small>}</span></td>
                      <td data-label="Hushåll">{r.hushall}</td>
                      <td data-label="Skickad"><span>{fmt(r.skickad)}{r.saljare && <small className="fmo__sub"> · {r.saljare}</small>}</span></td>
                      <td data-label="Svar">
                        {r.status === "skickad" ? (
                          <input className="input input--sm fmo__kommentar" placeholder="Kommentar (valfri)"
                            value={kommentar[r.id] ?? ""} onChange={(e) => setKommentar((k) => ({ ...k, [r.id]: e.target.value }))} />
                        ) : (
                          <span className={`fmo__status fmo__status--${r.status}`}>{r.status === "godkand" ? "Godkänd" : "Ej godkänd"}{r.kommentar ? ` · ${r.kommentar}` : ""}</span>
                        )}
                      </td>
                      <td className="rtable__actions">
                        {r.status === "skickad" && (
                          <div className="fmo__knappar">
                            <button className="btn btn--brand btn--sm" disabled={sparar} onClick={() => void svara([r.id], "godkand")}>Godkänd</button>
                            <button className="btn btn--ghost btn--sm" disabled={sparar} onClick={() => void svara([r.id], "ej_godkand")}>Ej godkänd</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {importRader && (
        <div className="overlay overlay--above overlay--center" onMouseDown={(e) => e.target === e.currentTarget && setImportRader(null)}>
          <div className="field-config fmo__import" role="dialog" aria-label="Importera svar">
            <div className="field-config__header">
              <h2>Importera svar</h2>
              <button className="close-btn" onClick={() => setImportRader(null)} aria-label="Stäng">×</button>
            </div>
            <div className="field-config__body">
              {(() => {
                const ok = importRader.filter((r) => r.id && r.status);
                const godk = ok.filter((r) => r.status === "godkand").length;
                return (
                  <p className="field-config__hint">
                    {ok.length} av {importRader.length} rader kan sparas: <b>{godk} godkända</b> och <b>{ok.length - godk} ej godkända</b> (tas bort ur affären).
                    {importRader.length - ok.length > 0 && ` ${importRader.length - ok.length} rader hoppas över.`}
                  </p>
                );
              })()}
              <div className="fmo__importlista">
                {importRader.map((r, i) => (
                  <div key={i} className={`fmo__importrad${r.problem ? " fmo__importrad--fel" : ""}`}>
                    <span className="fmo__importnr">Rad {r.rad}</span>
                    <span className="fmo__importnamn">{r.rubrik}</span>
                    <span>{r.problem ?? (r.status === "godkand" ? "Godkänd" : "Ej godkänd")}{!r.problem && r.kommentar ? ` · ${r.kommentar}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="d2d-prislista__fot">
              <button className="btn btn--ghost" onClick={() => setImportRader(null)}>Avbryt</button>
              <button className="btn btn--brand" disabled={sparar || !importRader.some((r) => r.id && r.status)} onClick={() => void sparaImport()}>
                {sparar ? "Sparar…" : "Spara svaren"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (!fristaende) return sida;
  return (
    <div className="fmo-app">
      <header className="fmo-app__header">
        <div className="fmo-app__brand">ConnectEstate <span>· FMO-check</span></div>
        <div className="fmo-app__actions">
          <ThemeToggle />
          <button className="btn btn--ghost btn--sm" onClick={() => supabase.auth.signOut()}>Logga ut</button>
        </div>
      </header>
      <main className="fmo-app__main">{sida}</main>
    </div>
  );
}
