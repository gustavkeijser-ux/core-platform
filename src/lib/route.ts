import { useEffect, useState } from "react";

/**
 * Enkel hash-routing: var man är i appen ligger i URL:en som
 * "#/list/deal?post=<id>" eller "#/d2d/lagenhet/<id>/<fastighetId>".
 * Då hamnar man på samma sida efter en omladdning, kan bokmärka/dela en
 * länk och webbläsarens bakåtknapp fungerar. Hash (inte vanliga sökvägar)
 * eftersom appen ligger på statisk hosting utan server-omskrivningar.
 */

export type Route = { segs: string[]; query: URLSearchParams };

export function readRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  return {
    segs: path.split("/").filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(qs),
  };
}

export function formatRoute(segs: string[], query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  return "#/" + segs.map(encodeURIComponent).join("/") + (qs ? `?${qs}` : "");
}

/** Hur många steg in i appen den här historikposten ligger (0 = där man
 *  landade). Sparas i history.state så det överlever omladdning. */
const depth = (): number => {
  const d = (history.state as { ceDepth?: unknown } | null)?.ceDepth;
  return typeof d === "number" ? d : 0;
};

/**
 * Spärr mot att lämna en vy (t.ex. kundkortet när obligatoriska uppgifter
 * saknas). Funktionen returnerar true = stanna kvar (och visar själv varför).
 * Gäller appens navigering och webbläsarens/telefonens bakåt.
 */
let sparr: { stanna: () => boolean; hash: string; state: unknown } | null = null;

export function sattLamnaSparr(stanna: () => boolean): () => void {
  const s = { stanna, hash: window.location.hash, state: history.state };
  sparr = s;
  return () => { if (sparr === s) sparr = null; };
}

// Registreras när modulen laddas, alltså före useRoute-lyssnarna, så att en
// spärrad bakåt kan stoppas innan vyn byts.
window.addEventListener("hashchange", (e) => {
  if (!sparr || window.location.hash === sparr.hash || !sparr.stanna()) return;
  e.stopImmediatePropagation();
  history.pushState(sparr.state, "", sparr.hash);
});

/** Navigera. replace = ersätt nuvarande historikpost (ingen ny bakåt-punkt). */
export function navigate(segs: string[], query?: Record<string, string | null | undefined>, replace = false) {
  const next = formatRoute(segs, query);
  if (next === window.location.hash) return;
  if (sparr && sparr.stanna()) return;
  if (replace) {
    history.replaceState({ ...(history.state ?? {}), ceDepth: depth() }, "", next);
  } else {
    history.pushState({ ceDepth: depth() + 1 }, "", next);
  }
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * Appens egna Tillbaka-knappar: gör exakt samma sak som webbläsarens/
 * telefonens bakåt (tillbaka till sidan man faktiskt kom ifrån, med samma
 * rad och läge). Finns ingen tidigare sida i appen — t.ex. när man öppnat
 * en länk direkt — används fallback (sidans "förälder").
 */
export function goBack(fallback: () => void) {
  if (depth() > 0) history.back();
  else fallback();
}

/** Nuvarande route; renderar om vid varje ändring (även bakåt/framåt). */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
