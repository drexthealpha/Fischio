// Live: the match view. Every number here comes from the TxLINE feed and nothing is
// modelled or simulated. The score, the clock, and the phase come from the scores endpoint.
// The three-way price is the demargined 1X2 line from the odds endpoint, which the book
// itself reprices as the match runs, so a goal moves the odds because the real line moved.
// Before kickoff it shows the opening line and a countdown. When the feed is not reachable
// it says so and shows nothing it cannot stand behind.
import { useEffect, useState } from "react";
import Flag from "./Flag.jsx";
import { fetchLiveScores } from "./chain.js";
import { useFixtures } from "./useFixtures.js";
import { fetchLiveLine } from "./market.js";
import { fmtCountdown } from "./data.js";
import Lineups from "./Lineups.jsx";

// TxLINE status ids, from the real feed (RECON.md). live = the ball is in play, done = a
// terminal phase where the result is final.
const PHASE = {
  1: { t: "Pre-match" },
  2: { t: "1st half", live: true }, 3: { t: "Half time", live: true }, 4: { t: "2nd half", live: true },
  5: { t: "Full time", done: true },
  6: { t: "Extra time", live: true }, 7: { t: "ET first half", live: true }, 8: { t: "ET half time", live: true },
  9: { t: "ET second half", live: true }, 10: { t: "After extra time", done: true },
  11: { t: "Penalties", live: true }, 12: { t: "Penalties", live: true }, 13: { t: "After penalties", done: true },
  100: { t: "Final", done: true },
};

export default function LiveMatch() {
  // Live schedule, including matches already under way, which is the whole point of this view.
  const { fixtures: games } = useFixtures({ includeStarted: true });
  const [fixtureId, setFixtureId] = useState(null);
  const fixture = games.find((f) => f.id === fixtureId) ?? games[0] ?? null;
  const [line, setLine] = useState(null); // real demargined { home, draw, away }
  const [score, setScore] = useState(null); // real { statusId, goals:[h,a], clockSeconds }
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!fixture?.id) return;
    setLine(null); setScore(null); // clear the previous match when switching
    let alive = true;
    const load = async () => {
      const [l, s] = await Promise.all([
        fetchLiveLine(fixture.id).catch(() => null),
        fetchLiveScores([fixture.id]).then((m) => m[fixture.id] ?? null).catch(() => null),
      ]);
      if (!alive) return;
      if (l) setLine(l);
      setScore(s);
    };
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [fixture?.id]);

  if (!fixture) {
    return (
      <div className="live">
        <div className="section-head"><h2 className="display section-title">Match</h2></div>
        <p className="empty-state">No fixture in the feed yet. Fixtures load from the TxLINE fixtures endpoint.</p>
      </div>
    );
  }

  const kickoffMs = fixture.kickoff ? new Date(fixture.kickoff).getTime() : null;
  const phase = score?.statusId != null ? PHASE[score.statusId] : null;
  const inPlay = phase?.live === true;
  const done = phase?.done === true;
  const beforeKickoff = !inPlay && !done && kickoffMs != null && nowMs < kickoffMs;

  const goals = Array.isArray(score?.goals) ? score.goals : null;
  const minute = score?.clockSeconds != null ? Math.floor(score.clockSeconds / 60) : null;
  const winner = done && goals ? (goals[0] > goals[1] ? "home" : goals[0] === goals[1] ? "draw" : "away") : null;

  const legs = [
    { key: "home", label: fixture.home, p: line?.home },
    { key: "draw", label: "Draw", p: line?.draw },
    { key: "away", label: fixture.away, p: line?.away },
  ];

  const title = inPlay ? "Live" : done ? "Full time" : "Match";
  const sub = inPlay ? "in-play · priced by the live TxLINE line"
    : done ? "final result from the TxLINE feed"
    : beforeKickoff ? "pre-match · opening line from TxLINE"
    : "waiting for the TxLINE feed";

  return (
    <div className="live">
      <div className="section-head">
        <h2 className="display section-title">{title}</h2>
        <span className="mono section-sub">{sub}</span>
      </div>

      {games.length > 1 && (
        <div className="live-switch">
          {games.map((g) => (
            <button
              key={g.id}
              className={`live-switch-chip${g.id === fixture.id ? " live-switch-on" : ""}`}
              onClick={() => setFixtureId(g.id)}
            >
              <Flag team={g.home} size={14} /> {g.home} v {g.away} <Flag team={g.away} size={14} />
            </button>
          ))}
        </div>
      )}

      <div className="livecard">
        <div className="livecard-top">
          <span className="live-team"><Flag team={fixture.home} size={24} /> {fixture.home}</span>
          {goals
            ? <span className="display live-score">{goals[0]}<span className="live-dash">-</span>{goals[1]}</span>
            : <span className="display live-score live-score-tbd">v</span>}
          <span className="live-team live-away">{fixture.away} <Flag team={fixture.away} size={24} /></span>
        </div>

        <div className="live-clock">
          {inPlay && <span className="live-dot-live" />}
          <span className="mono">
            {inPlay ? `${phase.t}${minute != null ? ` · ${minute}'` : ""}`
              : done ? phase.t
              : beforeKickoff ? `Kicks off in ${fmtCountdown(kickoffMs - nowMs)}`
              : "Awaiting the live feed"}
          </span>
          {fixture.kickoff && !inPlay && !done && (
            <span className="mono live-ko">{fixture.kickoff.slice(0, 16).replace("T", " ")} UTC</span>
          )}
        </div>

        {line ? (
          <div className="live-outcomes">
            {legs.map((l) => (
              <div className={`live-out live-out-${l.key}${winner ? (winner === l.key ? " mr-out-won" : " mr-out-lost") : ""}`} key={l.key}>
                <span className="live-out-name">{l.label}</span>
                {winner
                  ? <span className="display live-out-pct">{winner === l.key ? "WON" : "lost"}</span>
                  : <span className="display live-out-pct">{Math.round((l.p ?? 0) * 100)}%</span>}
                {!winner && <div className="live-out-bar"><span className="live-out-fill" style={{ width: `${Math.round((l.p ?? 0) * 100)}%` }} /></div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="live-feedwait mono">Live odds open as kickoff approaches.</div>
        )}
      </div>

      {fixture?.id && <Lineups fixtureId={fixture.id} />}
    </div>
  );
}
