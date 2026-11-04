import "@/styles/leverans.css";
import { useEffect, useState } from "react";
import { addRelation, createRecord, DataError, getRecord, updateRecord } from "@/lib/data";
import { supabase } from "@/integrations/supabase/client";

/**
 * Kontakterna för en koncernmoder (Gustav 3 nov: kontakter ligger bara på
 * koncernmodern, inte per fastighet). Sparas på koncernmoderns
 * Leveransöversikt-post (fälten agare_* och forvaltare_*). Saknar koncernmodern
 * en post skapas den (kopplad med levov_kund) första gången något sparas.
 *
 * Här ligger också aviseringsprofilen (Avisera i fastighetslistan): logotyp
 * (fil i storage-bucketen "documents", sökvägen i avi_logo), profilfärg (avi_farg)
 * och projekthemsidans adress connectestate.se/<avi_slug>.
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

  /** Postens id; skapar posten (kopplad till koncernmodern) om den saknas. */
  async function sakerPost(forsta: Record<string, unknown>): Promise<{ id: string; ny: boolean }> {
    if (postId) return { id: postId, ny: false };
    const ny = await createRecord("leveransoversikt", { name: kundNamn, ...forsta });
    await addRelation(ny.id, "levov_kund", kundId);
    onPostSkapad(ny.id);
    return { id: ny.id, ny: true };
  }

  async function spara(falt: string, varde: string | null) {
    const fore = data[falt] ?? null;
    if ((fore ?? null) === varde) return;
    setSparar(falt);
    setFel(null);
    setData((d) => ({ ...d, [falt]: varde }));
    try {
      const p = await sakerPost({ [falt]: varde });
      if (!p.ny) await updateRecord(p.id, { [falt]: varde });
    } catch (e) {
      setData((d) => ({ ...d, [falt]: fore }));
      setFel(e instanceof DataError ? e.message : "Kunde inte spara.");
    } finally {
      setSparar(null);
    }
  }

  // Logotypen visas via en tidsbegränsad länk.
  const logoSokvag = typeof data.avi_logo === "string" ? data.avi_logo : "";
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => {
    let aktiv = true;
    setLogoUrl(null);
    if (!logoSokvag) return;
    supabase.storage.from("documents").createSignedUrl(logoSokvag, 3600)
      .then(({ data: d }) => { if (aktiv) setLogoUrl(d?.signedUrl ?? null); });
    return () => { aktiv = false; };
  }, [logoSokvag]);

  async function laddaUppLogo(fil: File) {
    if (!/^image\/(png|jpe?g|svg\+xml|webp|gif)$/.test(fil.type)) { setFel("Logotypen ska vara en bild (PNG, JPG, SVG eller WebP)."); return; }
    if (fil.size > 5 * 1024 * 1024) { setFel("Logotypen får vara högst 5 MB."); return; }
    setSparar("avi_logo");
    setFel(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { data: u, error: ue } = await supabase.from("users").select("tenant_id").eq("id", auth.user?.id ?? "").single();
      if (ue || !u) throw new Error("Kunde inte läsa din organisation.");
      const p = await sakerPost({});
      const ext = (fil.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const sokvag = `${(u as { tenant_id: string }).tenant_id}/${p.id}/avi-logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("documents").upload(sokvag, fil, { cacheControl: "3600", upsert: false, contentType: fil.type });
      if (error) throw new Error(error.message);
      await updateRecord(p.id, { avi_logo: sokvag });
      setData((d) => ({ ...d, avi_logo: sokvag }));
    } catch (e) {
      setFel(e instanceof Error ? `Kunde inte ladda upp logotypen: ${e.message}` : "Kunde inte ladda upp logotypen.");
    } finally {
      setSparar(null);
    }
  }

  const farg = typeof data.avi_farg === "string" && /^#[0-9a-f]{6}$/i.test(data.avi_farg) ? data.avi_farg : "";
  const slug = typeof data.avi_slug === "string" ? data.avi_slug : "";
  const lasProfil = !kanAndra || laddar;

  return (
    <section className="card lev-kmk" aria-label={`Kontakter för ${kundNamn}`}>
      <div className="lev-kmk__huvud">
        <h3 className="lev-fl-detalj__rubrik">Kontakter</h3>
        <span className="lev-fl-detalj__tips">Gäller alla koncernmoderns fastigheter och används i aviseringarna (kontakterna står bara i distributionsöversikten). Sparas när du lämnar fältet.</span>
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
      <fieldset className="lev-fl-detalj__grupp">
        <legend>Aviseringsprofil</legend>
        <div className="lev-kmp">
          <div className="lev-kmp__logo">
            {logoUrl ? <img src={logoUrl} alt={`Logotyp ${kundNamn}`} /> : logoSokvag ? "Laddar…" : "Ingen logga – ägarens namn används som text-logotyp"}
          </div>
          <div className="lev-kmp__del">
            <span className={"btn btn--ghost btn--sm lev-kmp__fil" + (lasProfil ? " is-disabled" : "")}>
              {sparar === "avi_logo" ? "Laddar upp…" : logoSokvag ? "Byt logga" : "Ladda upp logga"}
              <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" disabled={lasProfil || sparar === "avi_logo"}
                aria-label="Ladda upp logga"
                onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void laddaUppLogo(f); }} />
            </span>
            {logoSokvag && !lasProfil && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void spara("avi_logo", null)}>Ta bort</button>
            )}
          </div>
          <label className="lev-kmp__del">
            <span>Profilfärg</span>
            <input type="color" value={farg || "#334155"} disabled={lasProfil}
              onChange={(e) => { const v = e.currentTarget.value; setData((d) => ({ ...d, avi_farg: v })); }}
              onBlur={(e) => void spara("avi_farg", e.currentTarget.value)} />
            <input className="input input--sm" key={`f:${farg}`} defaultValue={farg} placeholder="#334155" disabled={lasProfil} aria-label="Profilfärg (hex)"
              onBlur={(e) => { const v = e.currentTarget.value.trim(); if (!v || /^#[0-9a-f]{6}$/i.test(v)) void spara("avi_farg", v || null); else setFel("Färgen skrivs som #rrggbb, t.ex. #1e7a8c."); }}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          </label>
          <label className="lev-kmp__del lev-kmp__slug">
            <span>Projekthemsida connectestate.se/</span>
            <input className="input input--sm" key={`s:${slug}`} defaultValue={slug} placeholder="agare" disabled={lasProfil}
              onBlur={(e) => void spara("avi_slug", e.currentTarget.value.trim().replace(/^\/+/, "") || null)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          </label>
        </div>
      </fieldset>
    </section>
  );
}
