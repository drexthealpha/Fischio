// Screen 2: the live settlement view, the demo centerpiece. Replays the genuine
// recorded bot run (real feed lines, real signature). The ONE orchestrated motion
// moment lives here: the SETTLED BY PROOF stamp landing when the settle confirms.
import { useEffect, useRef, useState } from "react";
import Ticket from "./Ticket.jsx";
import { SETTLED_WAGER, REPLAY_EVENTS } from "./data.js";

const KIND_TAG = { bot: "BOT", score: "FEED", ft: "FT", settle: "TX" };

export default function Settlement() {
  const [events, setEvents] = useState([]);
  const [settled, setSettled] = useState(false);
  const [running, setRunning] = useState(false);
  const timers = useRef([]);

  const play = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setEvents([]);
    setSettled(false);
    setRunning(true);
    for (const ev of REPLAY_EVENTS) {
      timers.current.push(
        setTimeout(() => {
          setEvents((prev) => [...prev, ev]);
          if (ev.kind === "settle") {
            setSettled(true);
            setRunning(false);
          }
        }, ev.at)
      );
    }
  };

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const wager = settled
    ? SETTLED_WAGER
    : { ...SETTLED_WAGER, state: "active", finalScore: null };

  return (
    <div className="settlement">
      <div className="settlement-head">
        <h2 className="display settlement-title">Settlement, live</h2>
        <span className="mono replay-chip">REPLAY · recorded devnet run 2026-07-03</span>
        <button className="replay-btn" onClick={play} disabled={running}>
          {running ? "Running…" : events.length ? "Replay settlement" : "Run settlement"}
        </button>
      </div>

      <div className="settlement-columns">
        <div className={settled ? "ticket-wrap ticket-wrap-settled" : "ticket-wrap"}>
          <Ticket wager={wager} />
        </div>

        <section className="feed" aria-live="polite">
          <div className="microlabel feed-label">Bot log: anyone can run this</div>
          <div className="feed-rows">
            {events.length === 0 && (
              <div className="feed-idle mono">
                awaiting kickoff; the bot holds no admin key, only a proof and a tip incentive
              </div>
            )}
            {events.map((ev, i) => (
              <div key={i} className={`feed-row feed-row-${ev.kind}`}>
                <span className="mono feed-tag">{KIND_TAG[ev.kind]}</span>
                <span className="mono feed-text">{ev.text}</span>
              </div>
            ))}
            {settled && (
              <div className="climax display">
                SETTLED BY PROOF: no oracle, no admin, no human signed this.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
