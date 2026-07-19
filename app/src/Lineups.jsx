// Team lineups for a match, from the TxLINE scores feed.
//
// This is a fan view, not a settlement input. TxLINE publishes the starting eleven and the bench
// about an hour before kickoff, so a match that is still days away has none yet, and this says so
// rather than showing an empty grid. No player id is ever used to resolve a market: the honest
// limit is that "who scored" is not provable data, but "who started" is real and worth showing.
import { useEffect, useState } from "react";

import { INGEST } from "./origins.js";

function Side({ side }) {
  const starters = side.players.filter((p) => p.starter);
  const subs = side.players.filter((p) => !p.starter);
  const Row = (p) => (
    <div className="lu-player" key={`${p.number}-${p.name}`}>
      <span className="lu-num mono">{p.number || "·"}</span>
      <span className="lu-name">{p.name}</span>
    </div>
  );
  return (
    <div className="lu-side">
      <div className="lu-team display">{side.team}</div>
      <div className="lu-group microlabel">Starting eleven</div>
      {starters.map(Row)}
      {subs.length > 0 && (
        <>
          <div className="lu-group microlabel">Substitutes</div>
          {subs.map(Row)}
        </>
      )}
    </div>
  );
}

export default function Lineups({ fixtureId }) {
  const [teams, setTeams] = useState(undefined); // undefined = loading, null = not published, [] = teams
  useEffect(() => {
    if (!fixtureId) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${INGEST}/lineups/${fixtureId}`);
        const j = r.ok ? await r.json() : null;
        if (alive) setTeams(j?.teams ?? null);
      } catch { if (alive) setTeams(null); }
    })();
    return () => { alive = false; };
  }, [fixtureId]);

  if (teams === undefined) return null; // stay quiet while loading
  return (
    <section className="lu">
      <header className="lu-head">
        <h3 className="display lu-title">Lineups</h3>
        <span className="lu-src mono">from the TxLINE scores feed</span>
      </header>
      {!teams ? (
        <p className="empty-state">
          Lineups are published about an hour before kickoff. None for this match yet.
        </p>
      ) : (
        <div className="lu-grid">
          {teams.map((t) => <Side key={t.team} side={t} />)}
        </div>
      )}
    </section>
  );
}
