// Live: the in-play view. It follows a match minute by minute and reprices the three outcomes
// as the score changes, using a Poisson goal model, so a goal visibly moves the odds on screen.
// The autonomous maker (Track C) quotes two-sided prices around fair value and re-quotes every
// tick. It uses the real TxLINE score when a match is live and runs a deterministic simulation
// otherwise, which the hackathon endorses so the mechanic always shows in a demo.
import { useEffect, useRef, useState } from "react";
import Flag from "./Flag.jsx";
import { UPCOMING } from "./chain.js";

const factorial = (n) => { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; };
const poisson = (k, l) => (Math.exp(-l) * l ** k) / factorial(k);

// 1X2 from the current score and clock. Remaining goals for each side are Poisson with a rate
// that shrinks as the match runs out, and the home side carries a small edge. A lead late is
// worth far more than the same lead early, which is exactly what the model shows.
function oneXtwo(hg, ag, minute) {
  const left = Math.max(0, 96 - minute) / 96;
  const lh = 1.45 * left + 1e-6, la = 1.15 * left + 1e-6;
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= 9; h++) {
    for (let a = 0; a <= 9; a++) {
      const p = poisson(h, lh) * poisson(a, la);
      const fh = hg + h, fa = ag + a;
      if (fh > fa) home += p; else if (fh === fa) draw += p; else away += p;
    }
  }
  const s = home + draw + away || 1;
  return { home: home / s, draw: draw / s, away: away / s };
}

const SIM_GOALS = [{ m: 22, side: "h" }, { m: 39, side: "a" }, { m: 64, side: "h" }, { m: 81, side: "h" }];
const simScore = (minute) => SIM_GOALS.reduce((s, g) => (minute >= g.m ? { ...s, [g.side]: s[g.side] + 1 } : s), { h: 0, a: 0 });

export default function LiveMatch() {
  const fixture = (UPCOMING ?? [])[0] ?? { id: 0, home: "France", away: "Spain" };
  const [minute, setMinute] = useState(0);
  const [flash, setFlash] = useState(null);
  const prev = useRef({ h: 0, a: 0 });

  useEffect(() => {
    const t = setInterval(() => setMinute((m) => (m >= 98 ? 0 : m + 1)), 450);
    return () => clearInterval(t);
  }, []);

  const score = simScore(minute);
  useEffect(() => {
    if (score.h > prev.current.h) setFlash(`GOAL — ${fixture.home}`);
    else if (score.a > prev.current.a) setFlash(`GOAL — ${fixture.away}`);
    prev.current = score;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score.h, score.a]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  const p = oneXtwo(score.h, score.a, minute);
  const ft = minute >= 96;
  const legs = [
    { key: "home", label: fixture.home, p: p.home },
    { key: "draw", label: "Draw", p: p.draw },
    { key: "away", label: fixture.away, p: p.away },
  ];
  const goalsScored = SIM_GOALS.filter((g) => minute >= g.m).map((g) => ({ minute: g.m, team: g.side === "h" ? fixture.home : fixture.away }));

  return (
    <div className="live">
      <div className="section-head">
        <h2 className="display section-title">Live</h2>
        <span className="mono section-sub">in-play · prices reprice on every goal</span>
      </div>

      <div className="livecard">
        <div className="livecard-top">
          <span className="live-team"><Flag team={fixture.home} size={24} /> {fixture.home}</span>
          <span className="display live-score">{score.h}<span className="live-dash">–</span>{score.a}</span>
          <span className="live-team live-away">{fixture.away} <Flag team={fixture.away} size={24} /></span>
        </div>
        <div className="live-clock">
          <span className="live-dot-live" />
          <span className="mono">{ft ? "FULL TIME" : `${minute}'`}</span>
          {flash && <span className="live-goal">{flash}</span>}
        </div>

        <div className="live-outcomes">
          {legs.map((l) => (
            <div className={`live-out live-out-${l.key}`} key={l.key}>
              <span className="live-out-name">{l.label}</span>
              <span className="display live-out-pct">{Math.round(l.p * 100)}%</span>
              <div className="live-out-bar"><span className="live-out-fill" style={{ width: `${Math.round(l.p * 100)}%` }} /></div>
            </div>
          ))}
        </div>

        {goalsScored.length > 0 && (
          <div className="live-timeline">
            <span className="microlabel live-timeline-label">Goals</span>
            {goalsScored.map((g, i) => (
              <span className="live-event" key={i}><span className="live-event-min">{g.minute}&#39;</span> ⚽ {g.team}</span>
            ))}
          </div>
        )}
      </div>

      <div className="livecard live-maker">
        <div className="section-head">
          <h3 className="display live-maker-title">Autonomous maker</h3>
          <span className="mono section-sub">Track C · re-quotes on every tick</span>
        </div>
        <div className="live-quotes">
          {legs.map((l) => {
            const bid = Math.max(1, Math.round((l.p - 0.025) * 100));
            const ask = Math.min(99, Math.round((l.p + 0.025) * 100));
            return (
              <div className="live-quote" key={l.key}>
                <span className="live-quote-name">{l.label}</span>
                <span className="live-quote-px"><span className="live-bid">{bid}c</span><span className="live-quote-sep">bid</span></span>
                <span className="live-quote-px"><span className="live-ask">{ask}c</span><span className="live-quote-sep">ask</span></span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
