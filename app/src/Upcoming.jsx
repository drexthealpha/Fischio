// Upcoming games: the tournament schedule as a rail, so the app reads like a sportsbook and
// not just a list of whatever markets happen to exist. Each match shows flags, a kickoff
// countdown, and the live demargined 1X2 line if the TxLINE feed has it. Clicking opens the
// match's market. This is the "full-tournament" surface: every fixture is here, tradeable or
// opening soon.
import { useEffect, useState } from "react";
import Flag from "./Flag.jsx";
import { UPCOMING } from "./chain.js";
import { fetchLiveLine } from "./market.js";
import { fmtCountdown } from "./data.js";

const kickoffLabel = (iso, nowMs) => {
  const ms = new Date(iso).getTime() - nowMs;
  return ms <= 0 ? "kickoff now" : `in ${fmtCountdown(ms)}`;
};

export default function Upcoming({ onOpen }) {
  // genuinely upcoming only: drop matches that already kicked off more than 2 hours ago
  const games = (UPCOMING ?? []).filter((f) => new Date(f.kickoff).getTime() > Date.now() - 2 * 3600 * 1000).slice(0, 10);
  const [lines, setLines] = useState({});
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!games.length) return;
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(games.map(async (f) => [f.id, await fetchLiveLine(f.id)]));
      if (alive) setLines(Object.fromEntries(entries.filter(([, v]) => v)));
    };
    load();
    const t = setInterval(load, 15000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!games.length) return null;

  return (
    <section className="upcoming">
      <div className="section-head">
        <h3 className="display upcoming-title">Upcoming games</h3>
        <span className="mono section-sub">{games.length} on the schedule · live line from TxLINE</span>
      </div>
      <div className="upcoming-rail">
        {games.map((f) => {
          const line = lines[f.id];
          return (
            <button className="upcoming-card" key={f.id} onClick={() => onOpen?.(f.id)}>
              <div className="upcoming-when mono">{kickoffLabel(f.kickoff, nowMs)}</div>
              <div className="upcoming-teams">
                <span className="upcoming-team"><Flag team={f.home} size={16} /> {f.home}</span>
                <span className="upcoming-vs">v</span>
                <span className="upcoming-team"><Flag team={f.away} size={16} /> {f.away}</span>
              </div>
              {line ? (
                <div className="upcoming-line">
                  <span>{Math.round(line.home * 100)}</span>
                  <span className="upcoming-dot">·</span>
                  <span>{Math.round(line.draw * 100)}</span>
                  <span className="upcoming-dot">·</span>
                  <span>{Math.round(line.away * 100)}</span>
                </div>
              ) : (
                <div className="upcoming-line upcoming-soon">opening soon</div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
