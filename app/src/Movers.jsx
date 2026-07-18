// What is moving right now.
//
// The feed publishes every odds update in the current five minute window. A single update says
// nothing on its own: movement needs the same market at two points in time. The ingestion service
// groups the window by market and reports the earliest and latest price for each, so this shows
// a line that travelled rather than a list of things that ticked.
//
// Quarter lines never appear here. They carry no single fair price, so there is nothing to
// compare and a movement figure for them would be invented.
import { useEffect, useState } from "react";

const INGEST = new URLSearchParams(window.location.search).get("ingest")
  ?? import.meta.env.VITE_INGEST ?? "http://127.0.0.1:8795";

const KIND = {
  "1X2_PARTICIPANT_RESULT": "Match result",
  OVERUNDER_PARTICIPANT_GOALS: "Total goals",
  ASIANHANDICAP_PARTICIPANT_GOALS: "Handicap",
};
const label = (m) => {
  const line = m.line == null ? "" : m.type === "ASIANHANDICAP_PARTICIPANT_GOALS"
    ? ` ${m.line > 0 ? "+" : ""}${m.line}` : ` ${m.line}`;
  const half = m.period === "H1" ? " first half" : "";
  return `${KIND[m.type] ?? m.type}${line}${half}`;
};
const name = (s) => {
  const n = String(s).toLowerCase();
  return n === "part1" ? "home" : n === "part2" ? "away" : n;
};

export default function Movers() {
  const [data, setData] = useState(undefined); // undefined loading, null unreachable

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${INGEST}/movers`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (alive) setData(j);
      } catch { if (alive) setData(null); }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (data === undefined) return null;      // stay quiet while loading
  if (data === null) return null;           // the feed is unreachable, and other surfaces say so

  const rows = data.movers ?? [];
  return (
    <section className="movers">
      <div className="section-head">
        <h3 className="display movers-title">Moving now</h3>
        <span className="mono section-sub">
          {rows.length ? `biggest price moves in the last five minutes` : `five minute window`}
        </span>
      </div>

      {!rows.length ? (
        <p className="empty-state">
          No line has moved in the last five minutes. Prices drift slowly before kickoff and move
          most while a match is being played.
        </p>
      ) : (
        <div className="movers-rail">
          {rows.slice(0, 8).map((m) => (
            <div className="mover" key={m.key}>
              <div className="mover-kind">{label(m)}</div>
              <div className="mover-outcome">{name(m.outcome)}</div>
              <div className="mover-move">
                <span className="mono mover-from">{Math.round(m.from * 100)}%</span>
                <span className={`mover-arrow ${m.move > 0 ? "mover-up" : "mover-down"}`}>
                  {m.move > 0 ? "up" : "down"}
                </span>
                <span className="display mover-to">{Math.round(m.to * 100)}%</span>
              </div>
              <div className="mono mover-meta">
                {m.move > 0 ? "+" : ""}{(m.move * 100).toFixed(1)} points in {m.seconds}s
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
