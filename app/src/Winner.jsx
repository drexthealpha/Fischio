// World Cup Winner: each team's chance to lift the trophy, from a Monte Carlo over the remaining
// bracket priced by TxLINE's live 1X2 lines. This is the outright market ADI Predictstreet and
// Kalshi run, but ours is model-backed from the live feed and moves as the odds move.
import { useEffect, useState } from "react";
import Flag from "./Flag.jsx";
import { UPCOMING } from "./chain.js";
import { fetchLiveLine } from "./market.js";
import { simulateWinner } from "./winnerSim.js";

export default function Winner() {
  const [odds, setOdds] = useState(null);
  const [status, setStatus] = useState("Reading the remaining bracket…");

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const games = (UPCOMING ?? []).filter((f) => new Date(f.kickoff).getTime() > Date.now() - 2 * 3600 * 1000);
      if (!games.length) { if (alive) setStatus("The tournament is decided."); return; }
      const round0 = [];
      for (const f of games) { const line = await fetchLiveLine(f.id); if (line) round0.push({ a: f.home, b: f.away, odds: line }); }
      if (!round0.length) { if (alive) setStatus("Waiting for the live line from TxLINE…"); return; }
      const title = simulateWinner([round0], { iterations: 20000 });
      if (alive) { setOdds(title); setStatus(null); }
    };
    run();
    const t = setInterval(run, 15000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const sorted = odds ? Object.entries(odds).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="winner">
      <div className="section-head">
        <h2 className="display section-title">World Cup Winner</h2>
        <span className="mono section-sub">Monte Carlo from the live TxLINE line · 20,000 sims</span>
      </div>
      {status && <p className="feed-idle mono">{status}</p>}
      {sorted.length > 0 && (
        <div className="winner-list">
          {sorted.map(([team, p]) => (
            <div className="winner-row" key={team}>
              <span className="winner-team"><Flag team={team} size={20} /> {team}</span>
              <div className="winner-bar"><span className="winner-fill" style={{ width: `${Math.round(p * 100)}%` }} /></div>
              <span className="display winner-pct">{(p * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
