import { useState } from "react";
import { UPCOMING } from "./chain.js";

const fmt = (f) => ({ id: f.id, home: f.home, away: f.away, kickoff: f.kickoff.slice(0, 16).replace("T", " ") + " UTC" });

export default function CreateWager({ onCreate, busy = false, walletConnected = true, fixtures = UPCOMING }) {
  const list = fixtures.map(fmt);
  const [fixtureId, setFixtureId] = useState(list[0]?.id);
  const [side, setSide] = useState("home");
  const [stake, setStake] = useState("0.01");

  const fixture = list.find((f) => f.id === fixtureId) ?? list[0];
  if (!fixture) {
    return (
      <section className="create">
        <h2 className="display create-title">Open a wager</h2>
        <p className="empty-state">
          No upcoming fixtures in the feed right now. New matches appear here the
          moment TxLINE lists them.
        </p>
      </section>
    );
  }
  const backed = side === "home" ? fixture.home : fixture.away;
  const opponent = side === "home" ? fixture.away : fixture.home;

  return (
    <section className="create">
      <h2 className="display create-title">Open a wager</h2>

      <label className="microlabel create-label" htmlFor="fixture">Fixture</label>
      <select
        id="fixture"
        className="create-input"
        value={fixtureId}
        onChange={(e) => setFixtureId(Number(e.target.value))}
      >
        {list.map((f) => (
          <option key={f.id} value={f.id}>
            {f.home} v {f.away} · {f.kickoff}
          </option>
        ))}
      </select>

      <div className="microlabel create-label">Your side</div>
      <div className="side-toggle" role="radiogroup">
        <button
          className={side === "home" ? "side-btn side-btn-on" : "side-btn"}
          onClick={() => setSide("home")}
          aria-pressed={side === "home"}
        >
          {fixture.home}
        </button>
        <button
          className={side === "away" ? "side-btn side-btn-on" : "side-btn"}
          onClick={() => setSide("away")}
          aria-pressed={side === "away"}
        >
          {fixture.away}
        </button>
      </div>

      <label className="microlabel create-label" htmlFor="stake">Stake (SOL, matched by taker)</label>
      <input
        id="stake"
        className="create-input mono"
        inputMode="decimal"
        value={stake}
        onChange={(e) => setStake(e.target.value)}
      />

      <p className="create-terms"><strong>{backed} to beat {opponent}</strong> in 90 minutes or extra time. Penalties count as a loss.</p>

      <button
        className="create-submit"
        disabled={busy}
        onClick={() => onCreate?.({ fixtureId, side, stake })}
      >
        {walletConnected
          ? busy ? "Submitting…" : `Lock ${stake || "0"} SOL on ${backed}`
          : "Connect a wallet to open a wager"}
      </button>
      <div className="create-fee mono">escrow: program vault · refund opens at expiry</div>
    </section>
  );
}
