import { useEffect, useRef, useState } from "react";

/* =============================================================================
   Säljarvyn: fyrverkerier i två sekunder när säljaren lämnar en lägenhet med
   statusen Såld. Formuläret skickar händelsen `d2d:fyrverkeri` på window
   (skjutFyrverkeri), och <Fyrverkeri /> ligger i säljarvyns rot och ritar
   på en canvas över hela skärmen. Respekterar prefers-reduced-motion.
   ========================================================================== */

const HANDELSE = "d2d:fyrverkeri";
const LANGD_MS = 2000;

export function skjutFyrverkeri() {
  window.dispatchEvent(new CustomEvent(HANDELSE));
}

type Partikel = { x: number; y: number; vx: number; vy: number; liv: number; maxLiv: number; farg: string; r: number };

const FARGER = ["#3FC386", "#E5A83E", "#6C8CFF", "#F16C82", "#B388FF", "#FFD166", "#4DD0E1"];

export function Fyrverkeri() {
  const [aktiv, setAktiv] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const starta = () => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      setAktiv(false);
      // Nollställ så en ny salva startar även om den förra fortfarande syns.
      requestAnimationFrame(() => setAktiv(true));
    };
    window.addEventListener(HANDELSE, starta);
    return () => window.removeEventListener(HANDELSE, starta);
  }, []);

  useEffect(() => {
    if (!aktiv) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const b = canvas.width = Math.floor(window.innerWidth * dpr);
    const h = canvas.height = Math.floor(window.innerHeight * dpr);

    const partiklar: Partikel[] = [];
    const small = (cx: number, cy: number) => {
      const n = 70 + Math.floor(Math.random() * 40);
      const farg = FARGER[Math.floor(Math.random() * FARGER.length)];
      const farg2 = FARGER[Math.floor(Math.random() * FARGER.length)];
      for (let i = 0; i < n; i++) {
        const v = (2 + Math.random() * 6) * dpr;
        const a = (Math.PI * 2 * i) / n + Math.random() * 0.2;
        const liv = 40 + Math.random() * 40;
        partiklar.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, liv, maxLiv: liv, farg: i % 2 ? farg : farg2, r: (1.5 + Math.random() * 2) * dpr });
      }
    };
    // Fem salvor utspridda över de två sekunderna.
    const start = performance.now();
    const salvor = [0, 250, 550, 900, 1300].map((t) => ({
      t, x: (0.15 + Math.random() * 0.7) * b, y: (0.15 + Math.random() * 0.45) * h, skjuten: false,
    }));

    let raf = 0;
    const rita = (nu: number) => {
      const gatt = nu - start;
      for (const s of salvor) if (!s.skjuten && gatt >= s.t) { s.skjuten = true; small(s.x, s.y); }
      ctx.clearRect(0, 0, b, h);
      for (const p of partiklar) {
        if (p.liv <= 0) continue;
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.12 * dpr; // luftmotstånd + gravitation
        p.liv -= 1;
        ctx.globalAlpha = Math.max(0, p.liv / p.maxLiv);
        ctx.fillStyle = p.farg;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (gatt < LANGD_MS + 600) raf = requestAnimationFrame(rita);
      else setAktiv(false);
    };
    raf = requestAnimationFrame(rita);
    return () => cancelAnimationFrame(raf);
  }, [aktiv]);

  if (!aktiv) return null;
  return <canvas ref={canvasRef} className="d2d-fyrverkeri" aria-hidden="true" />;
}
