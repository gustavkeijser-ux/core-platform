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

/** Navigera. replace = ersätt nuvarande historikpost (ingen ny bakåt-punkt). */
export function navigate(segs: string[], query?: Record<string, string | null | undefined>, replace = false) {
  const next = formatRoute(segs, query);
  if (next === window.location.hash) return;
  if (replace) {
    history.replaceState(history.state, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = next;
  }
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
