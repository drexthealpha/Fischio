// Upcoming games: the tournament schedule as a rail, so the app reads like a sportsbook and
// not just a list of whatever markets happen to exist. Each match shows flags, a kickoff
// countdown, and the live demargined 1X2 line if the TxLINE feed has it. Clicking opens the
// match's market. This is the "full-tournament" surface: every fixture is here, tradeable or
// opening soon.
import { useEffect, useState } from "react";
import Flag from "./Flag.jsx";
import { UPCOMING } from "./chain.js";
import { fetchLiveLine } from "./market.js";

function kickoffLabel(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "kickoff now";
  const mins = Math.floor(ms / 60000), h = Math.floor(mins / 60), d = Math.floor(h / 24);
  if (d >= 1) return `in ${d}d ${h % 24}h`;
  if (h >= 1) return `in ${h}h ${mins % 60}m`;
  return `in ${mins}m`;
}

export default function Upcoming({ onOpen }) {
  // genuinely upcoming only: drop matches that already kicked off more than 2 hours ago
  const games = (UPCOMING ?? []).filter((f) => new Date(f.kickoff).getTime() > Date.now() - 2 * 3600 * 1000).slice(0, 10);
  const [lines, setLines] = useState({});

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
              <div className="upcoming-when mono">{kickoffLabel(f.kickoff)}</div>
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
