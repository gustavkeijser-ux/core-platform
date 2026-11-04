import "@/styles/leverans.css";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getRecord, updateRecord } from "@/lib/data";
import { laddaNed, skrivXlsx, type Cell } from "@/lib/xlsxSkriv";
import { hamtaAgareOversikt } from "./LeveransAgareKort";
import { AviCell, aviLage, type FastighetRad } from "./LeveransFastighetslista";
import {
  AVI_TYPER, CE_TELEFON, bildTillPng, byggSida, datumKod, flaggorFor, laddaBibliotek, mottagareFor,
  normBeteckning, nyZip, nyckelFor, sidaTillPdf, sidaTillSvg, slugAv, standardText, tal, variantEtikett,
  variantFor, type AviText, type AviTyp, type Mottagare, type Profil, type Variant,
} from "./leveransAviPdf";

/**
 * "Avisera" i Leveransöversikten (Alla fastigheter och koncernmoderns fastigheter).
 * 1. Välj typer (Avisering 1–3, Kabel-TV upphör, Förvaltningsdokument, Fastighetsdekal)
 *    och fastigheter.
 * 2. Förhandsgranska: fastigheter med samma förutsättningar delar text (en grupp),
 *    texten fylls i från fastighetens data och kan ändras per grupp.
 * 3. Skapa: en zip med en PDF per fastighet (lägenhet och lokal var för sig; kabel-tv
 *    en PDF per grupp utan beteckning) i mappar per ägare, plus distributionsöversikt
 *    i Excel (flikarna Distribution och Mailtext). Avin bockas i på checklistan.
 * Profilen (logga, färg, projekthemsida) hämtas från koncernmoderns Leveransöversikt-post.
 * Inget skickas.
 */

type Dokument = {
  rad: FastighetRad;
  typ: AviTyp;
  mottagare: Mottagare;
  v: Variant;
  nyckel: string;
  agare: string;
  beteckning: string;
  flaggor: string[];
};

type Grupp = { nyckel: string; v: Variant; dok: Dokument[]; flaggor: string[] };

const agareFor = (r: FastighetRad) => (r.kund ?? "").trim() || (r.bolag ?? "").trim() || "Okänd ägare";
const filsakert = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();

async function hamtaProfiler(rader: FastighetRad[]): Promise<{ profiler: Map<string, Profil>; fel: string[] }> {
  const fel: string[] = [];
  const grupper = await hamtaAgareOversikt(undefined, []).catch(() => []);
  const perKund = new Map(grupper.filter((g) => g.kund_id).map((g) => [g.kund_id as string, g]));
  const profiler = new Map<string, Profil>();
  const agare = new Map<string, FastighetRad>();
  rader.forEach((r) => { if (!agare.has(agareFor(r))) agare.set(agareFor(r), r); });

  await Promise.all([...agare.entries()].map(async ([namn, r]) => {
    const g = r.kund_id ? perKund.get(r.kund_id) : undefined;
    const post = (g?.post ?? {}) as Record<string, unknown>;
    const p: Profil = {
      agare: namn,
      farg: typeof post.avi_farg === "string" ? post.avi_farg : null,
      logo: null,
      slug: typeof post.avi_slug === "string" && post.avi_slug.trim() ? post.avi_slug.trim() : null,
      kontakt: null,
    };
    if (typeof post.avi_logo === "string" && post.avi_logo) {
      try {
        const { data, error } = await supabase.storage.from("documents").createSignedUrl(post.avi_logo, 600);
        if (error || !data?.signedUrl) throw error;
        const blob = await (await fetch(data.signedUrl)).blob();
        p.logo = await bildTillPng(blob);
      } catch {
        fel.push(`Logotypen för ${namn} gick inte att hämta – text-logotyp används.`);
      }
    }
    if (g?.post_id) {
      try {
        const rec = await getRecord(g.post_id);
        const d = (rec.record.data ?? {}) as Record<string, unknown>;
        const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
        p.kontakt = s("forvaltare_namn")
          ? { namn: s("forvaltare_namn"), telefon: s("forvaltare_telefon"), epost: s("forvaltare_epost") }
          : s("agare_namn") ? { namn: s("agare_namn"), telefon: s("agare_telefon"), epost: s("agare_epost") } : null;
      } catch { /* kontakt saknas – cellen blir tom */ }
    }
    profiler.set(namn, p);
  }));
  return { profiler, fel };
}

function profilFlaggor(p: Profil | undefined): string[] {
  const f: string[] = [];
  if (!p?.logo) f.push("Text-logotyp (ingen logga uppladdad)");
  if (!p?.farg) f.push("Neutral färg (ingen profilfärg vald)");
  if (!p?.slug) f.push(`Projekthemsida antagen: connectestate.se/${slugAv(p?.agare ?? "")}`);
  return f;
}

export function LeveransAvisering({ rader, forvaljAlla, kanAndra, onStang, onRadAndrad }: {
  /** Fastigheterna i den ordning de visas (efter filter och sortering). */
  rader: FastighetRad[];
  forvaljAlla: boolean;
  kanAndra: boolean;
  onStang: () => void;
  onRadAndrad: (id: string, andring: Partial<FastighetRad>) => void;
}) {
  const [steg, setSteg] = useState<1 | 2 | 3>(1);
  const [typer, setTyper] = useState<Set<AviTyp>>(new Set());
  const [valda, setValda] = useState<Set<string>>(() => new Set(forvaljAlla ? rader.map((r) => r.id) : []));
  const [sok, setSok] = useState("");
  const [profiler, setProfiler] = useState<Map<string, Profil> | null>(null);
  const [profilFel, setProfilFel] = useState<string[]>([]);
  const [laddar, setLaddar] = useState(false);
  const [fel, setFel] = useState<string | null>(null);
  const [texter, setTexter] = useState<Record<string, AviText>>({});
  const [aktiv, setAktiv] = useState<string | null>(null);
  const [bocka, setBocka] = useState(true);
  const [resultat, setResultat] = useState<{ pdf: number; zip: string; bockade: number; bockFel: number } | null>(null);
  const kod = useMemo(() => datumKod(), []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !laddar) onStang(); };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [laddar, onStang]);

  const synliga = useMemo(() => {
    const q = sok.trim().toLowerCase();
    if (!q) return rader;
    return rader.filter((r) => [r.fastighet, r.adress, r.ort, r.kund, r.bolag].some((x) => (x ?? "").toLowerCase().includes(q)));
  }, [rader, sok]);
  const valdaRader = useMemo(() => rader.filter((r) => valda.has(r.id)), [rader, valda]);

  // Dokument och grupper (beror på profiler bara via ägarnamnet).
  const { dokument, grupper, utanKtv } = useMemo(() => {
    const dok: Dokument[] = [];
    const utanKtv: string[] = [];
    const typLista = AVI_TYPER.filter((t) => typer.has(t.key)).map((t) => t.key);
    const orterPerAgare = new Map<string, Set<string>>();
    valdaRader.forEach((r) => {
      const a = agareFor(r);
      if (!orterPerAgare.has(a)) orterPerAgare.set(a, new Set());
      orterPerAgare.get(a)!.add((r.ort ?? "").trim().toLowerCase());
    });
    for (const typ of typLista) {
      for (const r of valdaRader) {
        // Kabel-TV upphör bara där det finns kabel-tv (koax eller KTV/KOAX-avtal).
        if (typ === "ktv" && !(r.bef_koax ?? "").trim() && !r.ktv_avtal) { utanKtv.push(normBeteckning(r.fastighet) || r.adress || "–"); continue; }
        const agare = agareFor(r);
        const flerKommuner = (orterPerAgare.get(agare)?.size ?? 0) > 1;
        const bet = normBeteckning(r.fastighet) || (r.adress ?? "").split(",")[0].trim() || "Okänd fastighet";
        const beteckning = flerKommuner && normBeteckning(r.fastighet) && r.ort ? `${normBeteckning(r.ort)} ${bet}` : bet;
        const mott: Mottagare[] = typ === "forv" || typ === "dekal" ? [null] : mottagareFor(r).lista;
        for (const m of mott) {
          const v = variantFor(r, typ, m, agare);
          dok.push({ rad: r, typ, mottagare: m, v, nyckel: nyckelFor(v), agare, beteckning, flaggor: flaggorFor(r, typ) });
        }
      }
    }
    const g = new Map<string, Grupp>();
    dok.forEach((d) => {
      if (!g.has(d.nyckel)) g.set(d.nyckel, { nyckel: d.nyckel, v: d.v, dok: [], flaggor: [] });
      const gr = g.get(d.nyckel)!;
      gr.dok.push(d);
      d.flaggor.forEach((f) => { if (!gr.flaggor.includes(f)) gr.flaggor.push(f); });
    });
    return { dokument: dok, grupper: [...g.values()], utanKtv };
  }, [typer, valdaRader]);

  const antalPdf = useMemo(() => {
    const ktv = new Set<string>();
    let n = 0;
    dokument.forEach((d) => { if (d.typ === "ktv") ktv.add(d.nyckel); else n++; });
    return n + ktv.size;
  }, [dokument]);

  const textFor = (nyckel: string, v: Variant): AviText => texter[nyckel] ?? standardText(v);
  const aktivGrupp = grupper.find((g) => g.nyckel === aktiv) ?? grupper[0];

  async function tillForhands() {
    setFel(null);
    if (!dokument.length) {
      setFel("Inga dokument att skapa – de valda fastigheterna har ingen kabel-tv (varken befintlig koax eller KTV/KOAX-avtal).");
      return;
    }
    setLaddar(true);
    try {
      await laddaBibliotek();
      if (!profiler) {
        const r = await hamtaProfiler(valdaRader);
        setProfiler(r.profiler);
        setProfilFel(r.fel);
      } else {
        // Nya ägare sedan förra gången.
        const saknas = valdaRader.filter((r) => !profiler.has(agareFor(r)));
        if (saknas.length) {
          const r = await hamtaProfiler(saknas);
          setProfiler(new Map([...profiler, ...r.profiler]));
          setProfilFel((f) => [...f, ...r.fel]);
        }
      }
      setSteg(2);
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Kunde inte förbereda aviseringarna.");
    } finally {
      setLaddar(false);
    }
  }

  const profilFor = (agare: string): Profil =>
    profiler?.get(agare) ?? { agare, farg: null, logo: null, slug: null, kontakt: null };

  async function skapa() {
    setFel(null);
    setLaddar(true);
    try {
      await laddaBibliotek();
      const zip = nyZip();
      const rot = `Aviseringar ${kod}`;
      const distribution: Cell[][] = [[
        "Ägare", "Fastighetsbeteckning", "Adress", "Lägenhet/Lokal", "Antal", "Avisering", "PDF-filnamn",
        "Innehållsvariant", "Kontaktperson", "Telefon", "E-post", "Flaggor",
      ]];
      const mail = new Map<string, string[]>();
      const ktvFiler = new Map<string, string>();
      const anvandaNamn = new Set<string>();
      let pdf = 0;

      for (const d of dokument) {
        const typInfo = AVI_TYPER.find((t) => t.key === d.typ)!;
        const p = profilFor(d.agare);
        const mottTxt = d.mottagare === "lgh" ? "Lägenhet" : d.mottagare === "lokal" ? "Lokal" : "";
        let filnamn: string;
        if (d.typ === "ktv") {
          filnamn = ktvFiler.get(d.nyckel) ?? "";
          if (!filnamn) {
            const bas = filsakert([typInfo.filnamn, d.agare, d.v.ktvDatum ?? kod, `${d.v.bredband ? "Kollektiv" : "Öppet nät"} ${d.v.paket}`, mottTxt].filter(Boolean).join(" - "));
            filnamn = `${bas}.pdf`;
            for (let i = 2; anvandaNamn.has(filnamn); i++) filnamn = `${bas} (${i}).pdf`;
            anvandaNamn.add(filnamn);
            ktvFiler.set(d.nyckel, filnamn);
            const sida = byggSida({ v: d.v, text: textFor(d.nyckel, d.v), profil: p, beteckning: "", kod });
            zip.file(`${rot}/${filsakert(d.agare)}/${filnamn}`, sidaTillPdf(sida));
            pdf++;
          }
        } else {
          const bas = filsakert([typInfo.filnamn, d.agare, d.beteckning, mottTxt].filter(Boolean).join(" - "));
          filnamn = `${bas}.pdf`;
          for (let i = 2; anvandaNamn.has(filnamn); i++) filnamn = `${bas} (${i}).pdf`;
          anvandaNamn.add(filnamn);
          const sida = byggSida({ v: d.v, text: textFor(d.nyckel, d.v), profil: p, beteckning: d.beteckning, kod });
          zip.file(`${rot}/${filsakert(d.agare)}/${filnamn}`, sidaTillPdf(sida));
          pdf++;
        }
        const antal = d.mottagare === "lgh" ? tal(d.rad.hushall) : d.mottagare === "lokal" ? tal(d.rad.lokaler) : tal(d.rad.hushall) + tal(d.rad.lokaler);
        const flaggor = [...d.flaggor, ...profilFlaggor(profiler?.get(d.agare))];
        distribution.push([
          d.agare, d.beteckning, d.rad.adress ?? "", mottTxt, antal || null, typInfo.label, filnamn,
          `${d.v.bredband ? "Kollektiv" : "Öppet nät"} ${d.v.paket ?? ""}`.trim(),
          p.kontakt?.namn ?? "", p.kontakt?.telefon ?? "", p.kontakt?.epost ?? "", flaggor.join("; "),
        ]);
        if (!mail.has(d.agare)) mail.set(d.agare, []);
        mail.get(d.agare)!.push(`${d.beteckning} | ${filnamn.replace(/\.pdf$/, "")}`);
      }

      // Summa per ägare.
      const perAgare = new Map<string, number>();
      distribution.slice(1).forEach((r) => perAgare.set(String(r[0]), (perAgare.get(String(r[0])) ?? 0) + (typeof r[4] === "number" ? r[4] : 0)));
      distribution.push([]);
      perAgare.forEach((n, a) => distribution.push([{ fet: `Summa ${a}` }, null, null, null, n]));

      const mailRader: Cell[][] = [["Mailtext"]];
      mail.forEach((rader, agare) => {
        mailRader.push([{ fet: agare }]);
        mailRader.push(["Hej,"]);
        mailRader.push([`Här kommer aviseringarna till hyresgästerna i era fastigheter. Varje avisering är märkt med fastighet nedan. Hyresgästerna når ConnectEstate på ${CE_TELEFON} vid frågor om projektet.`]);
        mailRader.push([""]);
        rader.forEach((r) => mailRader.push([r]));
        mailRader.push([""]);
        mailRader.push(["Hör av er om ni har frågor eller vill ändra något innan aviseringarna delas ut."]);
        mailRader.push(["Med vänliga hälsningar"]);
        mailRader.push([""]);
      });
      const xlsx = skrivXlsx([
        { namn: "Distribution", rader: distribution, bredd: [26, 22, 30, 12, 8, 20, 60, 18, 22, 16, 28, 60] },
        { namn: "Mailtext", rader: mailRader, bredd: [110] },
      ]);
      zip.file(`${rot}/Distributionsöversikt - ${kod}.xlsx`, xlsx);
      const blob: Blob = await zip.generateAsync({ type: "blob" });
      laddaNed(blob, `${rot}.zip`);

      // Bocka i avin (och förvaltningsdokument) i checklistan.
      let bockade = 0, bockFel = 0;
      if (bocka && kanAndra) {
        const perRad = new Map<string, Record<string, boolean>>();
        dokument.forEach((d) => {
          const chk = AVI_TYPER.find((t) => t.key === d.typ)?.chk;
          if (!chk || d.rad.detalj?.[chk] === true) return;
          if (!perRad.has(d.rad.id)) perRad.set(d.rad.id, {});
          perRad.get(d.rad.id)![chk] = true;
        });
        const lista = [...perRad.entries()];
        for (let i = 0; i < lista.length; i += 6) {
          await Promise.all(lista.slice(i, i + 6).map(async ([id, andring]) => {
            try {
              await updateRecord(id, andring);
              const r = rader.find((x) => x.id === id);
              onRadAndrad(id, { detalj: { ...(r?.detalj ?? {}), ...andring } });
              bockade++;
            } catch { bockFel++; }
          }));
        }
      }
      setResultat({ pdf, zip: `${rot}.zip`, bockade, bockFel });
      setSteg(3);
    } catch (e) {
      setFel(e instanceof Error ? e.message : "Kunde inte skapa aviseringarna.");
    } finally {
      setLaddar(false);
    }
  }

  function vaxla<T>(set: Set<T>, v: T): Set<T> {
    const n = new Set(set);
    if (n.has(v)) n.delete(v); else n.add(v);
    return n;
  }

  const tf = new Intl.NumberFormat("sv-SE");

  return (
    <div className="lev-avi" role="dialog" aria-modal="true" aria-label="Avisera" onMouseDown={(e) => { if (e.target === e.currentTarget && !laddar) onStang(); }}>
      <div className={"lev-avi__ruta" + (steg === 2 ? " is-bred" : "")}>
        <header className="lev-avi__huvud">
          <div>
            <h2>Avisera</h2>
            <ol className="lev-avi__steg" aria-label="Steg">
              {["Välj", "Förhandsgranska", "Klart"].map((t, i) => (
                <li key={t} className={steg === i + 1 ? "is-aktiv" : steg > i + 1 ? "is-klar" : undefined}>{i + 1}. {t}</li>
              ))}
            </ol>
          </div>
          <button type="button" className="close-btn" aria-label="Stäng" onClick={onStang} disabled={laddar}>×</button>
        </header>

        {fel && <p className="lev-avi__fel">{fel}</p>}

        {steg === 1 && (
          <div className="lev-avi__kropp">
            <section>
              <h3 className="lev-avi__rubrik">Vad ska skapas?</h3>
              <div className="lev-avi__typer">
                {AVI_TYPER.map((t) => (
                  <label key={t.key} className={"lev-avi__typ" + (typer.has(t.key) ? " is-vald" : "")}>
                    <input type="checkbox" checked={typer.has(t.key)} onChange={() => setTyper((s) => vaxla(s, t.key))} />
                    <span><b>{t.label}</b><small>{t.hint}</small></span>
                  </label>
                ))}
              </div>
            </section>
            <section className="lev-avi__falt">
              <div className="lev-avi__listhuvud">
                <h3 className="lev-avi__rubrik">Fastigheter <span>{tf.format(valda.size)} av {tf.format(rader.length)} valda</span></h3>
                <input className="input input--sm" type="search" placeholder="Sök fastighet, adress, ort, ägare" value={sok} onChange={(e) => setSok(e.target.value)} />
                <div className="lev-avi__knappar">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setValda((s) => new Set([...s, ...synliga.map((r) => r.id)]))}>Markera {sok ? "sökträffar" : "alla"}</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setValda((s) => { const n = new Set(s); synliga.forEach((r) => n.delete(r.id)); return n; })}>Avmarkera</button>
                </div>
              </div>
              <ul className="lev-avi__lista">
                {synliga.slice(0, 400).map((r) => (
                  <li key={r.id}>
                    <label className={valda.has(r.id) ? "is-vald" : undefined}>
                      <input type="checkbox" checked={valda.has(r.id)} onChange={() => setValda((s) => vaxla(s, r.id))} />
                      <span className="lev-avi__fast">
                        <b>{normBeteckning(r.fastighet) || r.adress || "–"}</b>
                        <small>{[r.adress, r.ort].filter(Boolean).join(" · ")}</small>
                      </span>
                      <span className="lev-avi__agare">{agareFor(r)}</span>
                      <AviCell a={aviLage(r)} />
                    </label>
                  </li>
                ))}
                {synliga.length > 400 && <li className="lev-avi__mer">Visar 400 av {tf.format(synliga.length)} – sök eller filtrera tabellen för att se resten. "Markera alla" tar med alla {tf.format(synliga.length)}.</li>}
                {!synliga.length && <li className="lev-avi__mer">Inga fastigheter matchar sökningen.</li>}
              </ul>
            </section>
            <footer className="lev-avi__fot">
              <span>{typer.size && valda.size ? `${tf.format(antalPdf)} dokument` : "Välj minst en typ och en fastighet."}</span>
              <button type="button" className="btn btn--ghost" onClick={onStang}>Avbryt</button>
              <button type="button" className="btn btn--brand" disabled={!typer.size || !valda.size || laddar} onClick={() => void tillForhands()}>
                {laddar ? "Förbereder…" : "Förhandsgranska"}
              </button>
            </footer>
          </div>
        )}

        {steg === 2 && aktivGrupp && (
          <div className="lev-avi__kropp">
            {profilFel.length > 0 && <p className="lev-avi__varning">{profilFel.join(" ")}</p>}
            {utanKtv.length > 0 && (
              <p className="lev-avi__varning">
                Kabel-TV upphör skapas inte för {utanKtv.length === 1 ? "1 fastighet" : `${tf.format(utanKtv.length)} fastigheter`} utan kabel-tv (varken befintlig koax eller KTV/KOAX-avtal): {utanKtv.slice(0, 5).join(", ")}{utanKtv.length > 5 ? ` +${utanKtv.length - 5}` : ""}.
              </p>
            )}
            <div className="lev-avi__forhand">
              <nav className="lev-avi__grupper" aria-label="Textgrupper">
                <p className="lev-avi__tips">{grupper.length === 1 ? "Alla dokument delar text." : `${grupper.length} textgrupper – fastigheter med samma förutsättningar delar text men får varsin PDF.`}</p>
                {grupper.map((g) => (
                  <button key={g.nyckel} type="button" className={"lev-avi__grupp" + (g === aktivGrupp ? " is-aktiv" : "")} onClick={() => setAktiv(g.nyckel)}>
                    <span>{variantEtikett(g.v)}</span>
                    <small>
                      {g.v.typ === "ktv" ? "1 PDF" : `${g.dok.length} PDF`} · {g.dok.map((d) => d.beteckning).slice(0, 3).join(", ")}{g.dok.length > 3 ? ` +${g.dok.length - 3}` : ""}
                      {texter[g.nyckel] && " · ändrad"}
                    </small>
                    {(g.flaggor.length > 0 || profilFlaggor(profiler?.get(g.v.agare)).length > 0) && (
                      <em>{g.flaggor.length + profilFlaggor(profiler?.get(g.v.agare)).length} flaggor</em>
                    )}
                  </button>
                ))}
              </nav>
              <GruppEditor
                key={aktivGrupp.nyckel}
                grupp={aktivGrupp}
                text={textFor(aktivGrupp.nyckel, aktivGrupp.v)}
                andrad={!!texter[aktivGrupp.nyckel]}
                profil={profilFor(aktivGrupp.v.agare)}
                profilFlaggor={profilFlaggor(profiler?.get(aktivGrupp.v.agare))}
                kod={kod}
                onAndra={(t) => setTexter((x) => ({ ...x, [aktivGrupp.nyckel]: t }))}
                onAterstall={() => setTexter((x) => { const n = { ...x }; delete n[aktivGrupp.nyckel]; return n; })}
              />
            </div>
            <footer className="lev-avi__fot">
              {kanAndra && dokument.some((d) => AVI_TYPER.find((t) => t.key === d.typ)?.chk) ? (
                <label className="lev-avi__bocka">
                  <input type="checkbox" checked={bocka} onChange={(e) => setBocka(e.target.checked)} />
                  Bocka i {[...typer].map((t) => AVI_TYPER.find((x) => x.key === t)).filter((t) => t?.chk).map((t) => t!.label.replace("Avisering", "Avi")).join(", ")} i checklistan
                </label>
              ) : <span />}
              <button type="button" className="btn btn--ghost" onClick={() => setSteg(1)} disabled={laddar}>← Tillbaka</button>
              <button type="button" className="btn btn--brand" onClick={() => void skapa()} disabled={laddar}>
                {laddar ? "Skapar…" : `Skapa ${tf.format(antalPdf)} PDF:er (zip)`}
              </button>
            </footer>
          </div>
        )}

        {steg === 3 && resultat && (
          <div className="lev-avi__kropp lev-avi__klart">
            <p><b>{tf.format(resultat.pdf)} PDF:er</b> och distributionsöversikten (Excel med flikarna Distribution och Mailtext) laddades ned som <b>{resultat.zip}</b>.</p>
            {resultat.bockade > 0 && <p>Avin bockades i på {tf.format(resultat.bockade)} fastigheter.</p>}
            {resultat.bockFel > 0 && <p className="lev-avi__fel">{tf.format(resultat.bockFel)} fastigheter gick inte att bocka i – gör det i checklistan.</p>}
            <p className="lev-avi__tips">Inget har skickats. Granska PDF:erna och flaggorna i Excel innan aviseringarna delas ut.</p>
            <footer className="lev-avi__fot">
              <span />
              <button type="button" className="btn btn--ghost" onClick={() => { setResultat(null); setSteg(2); }}>Skapa igen</button>
              <button type="button" className="btn btn--brand" onClick={onStang}>Stäng</button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function GruppEditor({ grupp, text, andrad, profil, profilFlaggor, kod, onAndra, onAterstall }: {
  grupp: Grupp;
  text: AviText;
  andrad: boolean;
  profil: Profil;
  profilFlaggor: string[];
  kod: string;
  onAndra: (t: AviText) => void;
  onAterstall: () => void;
}) {
  const [visa, setVisa] = useState(0);
  const d = grupp.dok[Math.min(visa, grupp.dok.length - 1)];
  const sida = useMemo(
    () => byggSida({ v: grupp.v, text, profil, beteckning: d.beteckning, kod }),
    [grupp.v, text, profil, d.beteckning, kod],
  );
  const svg = useMemo(() => sidaTillSvg(sida), [sida]);
  const flaggor = [...grupp.flaggor, ...profilFlaggor];
  const enkel = grupp.v.typ === "dekal";

  const satt = (f: (t: AviText) => AviText) => onAndra(f(structuredClone(text)));

  return (
    <div className="lev-avi__editor">
      <div className="lev-avi__textfalt">
        <div className="lev-avi__edhuvud">
          <b>Texter</b>
          {andrad && <button type="button" className="lev-fl__lank" onClick={onAterstall}>Återställ från data</button>}
        </div>
        <label className="lev-fl-detalj__etikett"><span>Rubrik</span>
          <input className="input input--sm" value={text.rubrik} onChange={(e) => { const v = e.target.value; satt((t) => ({ ...t, rubrik: v })); }} />
        </label>
        <label className="lev-fl-detalj__etikett"><span>Ingress</span>
          <textarea className="input input--sm" rows={3} value={text.ingress} onChange={(e) => { const v = e.target.value; satt((t) => ({ ...t, ingress: v })); }} />
        </label>
        {text.avsnitt.map((a, i) => (
          <fieldset key={i} className="lev-avi__avsnitt">
            <input className="input input--sm" aria-label={`Rubrik avsnitt ${i + 1}`} value={a.rubrik} onChange={(e) => { const v = e.target.value; satt((t) => { t.avsnitt[i].rubrik = v; return t; }); }} />
            <textarea className="input input--sm" rows={3} aria-label={`Text avsnitt ${i + 1}`} value={a.text} onChange={(e) => { const v = e.target.value; satt((t) => { t.avsnitt[i].text = v; return t; }); }} />
          </fieldset>
        ))}
        <div className="lev-avi__fakta">
          <span className="lev-avi__etikett">{enkel ? "Rader" : "Faktaruta"}</span>
          {text.fakta.map((f, i) => (
            <div key={i}>
              <input className="input input--sm" aria-label={`Etikett ${i + 1}`} value={f.etikett} onChange={(e) => { const v = e.target.value; satt((t) => { t.fakta[i].etikett = v; return t; }); }} />
              <input className="input input--sm" aria-label={`Värde ${i + 1}`} value={f.varde} onChange={(e) => { const v = e.target.value; satt((t) => { t.fakta[i].varde = v; return t; }); }} />
            </div>
          ))}
        </div>
        {text.tidslinje.length > 0 && (
          <div className="lev-avi__fakta">
            <span className="lev-avi__etikett">Tidslinje</span>
            {text.tidslinje.map((s, i) => (
              <input key={i} className="input input--sm" aria-label={`Tidslinje ${i + 1}`} value={s} onChange={(e) => { const v = e.target.value; satt((t) => { t.tidslinje[i] = v; return t; }); }} />
            ))}
          </div>
        )}
        {flaggor.length > 0 && (
          <div className="lev-avi__flaggor">
            <b>Flaggat</b>
            <ul>{flaggor.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        )}
      </div>
      <div className="lev-avi__visning">
        <div className="lev-avi__edhuvud">
          <b>Förhandsgranskning</b>
          {grupp.dok.length > 1 && grupp.v.typ !== "ktv" && (
            <select className="input input--sm" value={visa} onChange={(e) => setVisa(+e.target.value)} aria-label="Visa fastighet">
              {grupp.dok.map((x, i) => <option key={i} value={i}>{x.beteckning}</option>)}
            </select>
          )}
        </div>
        {sida.forLang && <p className="lev-avi__fel">Texten får inte plats på en sida – korta den.</p>}
        <div className={"lev-avi__papper" + (enkel ? " is-a6" : "")} dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>
  );
}
