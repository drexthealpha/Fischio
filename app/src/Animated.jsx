// Small motion helpers, the difference between "a form" and "a live product". A percentage
// that rolls to its new value instead of snapping, and a brief celebratory moment when a
// trade lands. Kept short and eased so it feels alive, not gimmicky.
import { useEffect, useRef, useState } from "react";

// Animate a 0..1 probability to a rolling integer percentage on every change.
export function AnimatedPct({ value }) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    const a = from.current, b = value ?? 0, start = performance.now(), dur = 550;
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / dur);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      setShown(a + (b - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{Math.round(shown * 100)}%</>;
}

// A short win-moment overlay shown after a successful trade: a green stamp and the payout,
// scaling in and fading out. One orchestrated beat, never looped.
export function WinMoment({ show, title, sub, onDone }) {
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [show, onDone]);
  if (!show) return null;
  return (
    <div className="win-moment" onClick={onDone}>
      <div className="win-card">
        <div className="win-check">✓</div>
        <div className="win-title display">{title}</div>
        {sub && <div className="win-sub">{sub}</div>}
      </div>
    </div>
  );
}
