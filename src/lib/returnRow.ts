import { useEffect, useRef } from "react";

/**
 * "Tillbaka till samma rad" — gäller alla listor i systemet.
 *
 * När man öppnar en rad (post, lägenhet, uppgift …) och sedan kommer
 * tillbaka till listan ska man landa på exakt den raden igen, inte högst
 * upp. Senast öppnade rad per lista sparas i minnet + sessionStorage (så
 * det överlever en omladdning) och när listan ritats skrollas raden in
 * mitt i vyn och blinkar kort (klassen .return-flash).
 *
 * Användning i en lista:
 *   const returnRow = useReturnToRow("list:deal", !loading);
 *   <tr {...returnRow(r.id)} onClick={() => { rememberRow("list:deal", r.id); open(r.id); }}>
 */

const lastOpened = new Map<string, string>();
const KEY = "ce:lastOpened:";

export function rememberRow(listKey: string, id: string) {
  lastOpened.set(listKey, id);
  try { sessionStorage.setItem(KEY + listKey, id); } catch { /* privat läge m.m. */ }
}

function lastRow(listKey: string): string | null {
  const mem = lastOpened.get(listKey);
  if (mem) return mem;
  try { return sessionStorage.getItem(KEY + listKey); } catch { return null; }
}

export function useReturnToRow(listKey: string, ready: boolean, flashClass = "return-flash") {
  // Bara en gång per montering: listor som laddar om i bakgrunden (live-
  // uppdateringar, byte av sida) ska inte hoppa tillbaka hela tiden.
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    const id = lastRow(listKey);
    if (!id) return;
    // Vänta en bildruta så att listan hunnit ritas.
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-return-row="${CSS.escape(listKey + ":" + id)}"]`);
      if (!el) return;
      done.current = true;
      el.scrollIntoView({ block: "center" });
      el.classList.add(flashClass);
      window.setTimeout(() => el.classList.remove(flashClass), 1600);
    });
    return () => cancelAnimationFrame(raf);
  }, [listKey, ready, flashClass]);
  return (id: string) => ({ "data-return-row": `${listKey}:${id}` });
}

/** Sparad listinställning (sida, sök, filter, sortering …) per lista, så
 *  att man kommer tillbaka till samma läge när man byter meny och tillbaka
 *  — eller laddar om sidan. */
export function loadListState<T>(listKey: string): Partial<T> {
  try {
    const raw = sessionStorage.getItem("ce:listState:" + listKey);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch { return {}; }
}

export function saveListState<T>(listKey: string, state: T) {
  try { sessionStorage.setItem("ce:listState:" + listKey, JSON.stringify(state)); } catch { /* ignoreras */ }
}
