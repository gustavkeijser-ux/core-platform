import "@/styles/leverans.css";
import { useEffect, useState } from "react";
import { addRelation, createRecord, DataError, getRecord, updateRecord } from "@/lib/data";

/**
 * Kontakterna för en koncernmoder (Gustav 3 nov: kontakter ligger bara på
 * koncernmodern, inte per fastighet). Sparas på koncernmoderns
 * Leveransöversikt-post (fälten agare_* och forvaltare_*). Saknar koncernmodern
 * en post skapas den (kopplad med levov_kund) första gången något sparas.
 */

const FALT: { key: string; label: string; typ: "text" | "email" | "tel"; grupp: string }[] = [
  { key: "agare_namn", label: "För- och efternamn", typ: "text", grupp: "Ägare / primär kontakt" },
  { key: "agare_epost", label: "E-post", typ: "email", grupp: "Ägare / primär kontakt" },
  { key: "agare_telefon", label: "Telefon", typ: "tel", grupp: "Ägare / primär kontakt" },
  { key: "forvaltare_namn", label: "För- och efternamn", typ: "text", grupp: "Förvaltare" },
  { key: "forvaltare_epost", label: "E-post", typ: "email", grupp: "Förvaltare" },
  { key: "forvaltare_telefon", label: "Telefon", typ: "tel", grupp: "Förvaltare" },
];
const GRUPPER = [...new Set(FALT.map((f) => f.grupp))];

export function KoncernmoderKontakter({ kundId, kundNamn, postId, kanAndra, onPostSkapad }: {
  kundId: string;
  kundNamn: string;
  postId: string | null;
  kanAndra: boolean;
  onPostSkapad: (id: string) => void;
}) {
  const [data, setData] = useState<Record<string, unknown>>({});
  const [laddar, setLaddar] = useState(!!postId);
  const [sparar, setSparar] = useState<string | null>(null);
  const [fel, setFel] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    if (!postId) { setData({}); setLaddar(false); return; }
    setLaddar(true);
    getRecord(postId)
      .then((r) => { if (aktiv) setData(r.record.data ?? {}); })
      .catch(() => { if (aktiv) setFel("Kunde inte hämta kontakterna."); })
      .finally(() => { if (aktiv) setLaddar(false); });
    return () => { aktiv = false; };
  }, [postId]);

  async function spara(falt: string, varde: string | null) {
    const fore = data[falt] ?? null;
    if ((fore ?? null) === varde) return;
    setSparar(falt);
    setFel(null);
    setData((d) => ({ ...d, [falt]: varde }));
    try {
      if (postId) {
        await updateRecord(postId, { [falt]: varde });
      } else {
        const ny = await createRecord("leveransoversikt", { name: kundNamn, [falt]: varde });
        await addRelation(ny.id, "levov_kund", kundId);
        onPostSkapad(ny.id);
      }
    } catch (e) {
      setData((d) => ({ ...d, [falt]: fore }));
      setFel(e instanceof DataError ? e.message : "Kunde inte spara kontakten.");
    } finally {
      setSparar(null);
    }
  }

  return (
    <section className="card lev-kmk" aria-label={`Kontakter för ${kundNamn}`}>
      <div className="lev-kmk__huvud">
        <h3 className="lev-fl-detalj__rubrik">Kontakter</h3>
        <span className="lev-fl-detalj__tips">Gäller alla koncernmoderns fastigheter. Sparas när du lämnar fältet.</span>
      </div>
      {fel && <p className="lev-kmk__fel">{fel}</p>}
      <div className={"lev-kmk__grupper" + (laddar ? " is-loading" : "")}>
        {GRUPPER.map((g) => (
          <fieldset key={g} className="lev-fl-detalj__grupp">
            <legend>{g}</legend>
            <div className="lev-kmk__falt">
              {FALT.filter((f) => f.grupp === g).map((f) => {
                const v = typeof data[f.key] === "string" ? (data[f.key] as string) : "";
                return (
                  <label key={f.key} className="lev-fl-detalj__etikett">
                    <span>{f.label}</span>
                    <input
                      className="input input--sm"
                      type={f.typ}
                      defaultValue={v}
                      key={`${postId ?? "ny"}:${v}`}
                      disabled={!kanAndra || laddar || sparar === f.key}
                      autoComplete="off"
                      onBlur={(e) => void spara(f.key, e.currentTarget.value.trim() || null)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
