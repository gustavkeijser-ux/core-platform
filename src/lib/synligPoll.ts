/**
 * Upprepad hämtning som bara går när sidan syns.
 *
 * Säljarna har appen öppen hela dagen i telefonen. Ett vanligt setInterval
 * fortsätter när skärmen är låst eller fliken ligger i bakgrunden och väcker
 * mobilradion varje gång — det drar batteri. Här pausas intervallet när
 * sidan döljs; när den syns igen hämtas direkt (om det gått minst `ms` sedan
 * sist) och intervallet startar om.
 *
 * Kör `fn` en gång direkt (om sidan syns). Returnerar en stoppfunktion för
 * useEffect-städningen.
 */
export function startaSynligPoll(fn: () => unknown, ms: number): () => void {
  let timer: number | null = null;
  let senast = 0;
  const kor = () => { senast = Date.now(); try { void fn(); } catch { /* nästa varv */ } };
  const starta = () => {
    if (timer !== null) return;
    timer = window.setInterval(kor, ms);
  };
  const pausa = () => {
    if (timer !== null) { window.clearInterval(timer); timer = null; }
  };
  const onVis = () => {
    if (document.visibilityState === "visible") {
      if (Date.now() - senast >= ms) kor();
      starta();
    } else {
      pausa();
    }
  };
  if (document.visibilityState === "visible") { kor(); starta(); }
  document.addEventListener("visibilitychange", onVis);
  return () => { pausa(); document.removeEventListener("visibilitychange", onVis); };
}
