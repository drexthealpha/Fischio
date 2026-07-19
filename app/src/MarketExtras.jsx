// The two pieces that make a market page feel like a market and not a form: a probability
// timeline (the signature prediction-market element) and a live activity strip. Both read
// real data from the fischio services (price history from the API, trades from the indexer)
// and quietly disappear if those services are not running, so the page never shows an error.
import { useEffect, useState } from "react";
import { shortKey, usd, nameOf } from "./data.js";
import { fromUsdc } from "./market.js";

import { API, INDEXER } from "./origins.js";

// A clean probability-over-time line, the way Polymarket draws it: no candlesticks, just the
// odds moving. Always plots the current live price so a brand-new market still shows a line.
export function ProbabilityChart({ address, livePrice }) {
  const [series, setSeries] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`${API}/markets/${address}/prices`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (alive) setSeries(j.series ?? []); })
      .catch(() => { if (alive) setSeries([]); });
    load();
    const t = setInterval(load, 12000);
    return () => { alive = false; clearInterval(t); };
  }, [address]);

  if (series == null) return null;
  // fold in the live price as the last point, so the line always reaches "now"
  const pts = [...series];
  if (livePrice != null) pts.push({ ts: Date.now(), price: livePrice });
  if (pts.length < 2) {
    return (
      <div className="mkt-chart">
        <div className="mkt-chart-head">
          <span className="microlabel">Odds over time</span>
          <span className="display mkt-chart-now">{Math.round((livePrice ?? 0) * 100)}%</span>
        </div>
        <div className="mkt-chart-empty mono">The line fills in as the market trades.</div>
      </div>
    );
  }

  const W = 640, H = 120, pad = 4;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const x = (ts) => pad + ((ts - t0) / span) * (W - 2 * pad);
  const y = (p) => pad + (1 - p) * (H - 2 * pad); // price 0..1, inverted for screen
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const area = `${line} L${x(t1).toFixed(1)},${H - pad} L${x(t0).toFixed(1)},${H - pad} Z`;
  const now = Math.round(pts[pts.length - 1].price * 100);

  return (
    <div className="mkt-chart">
      <div className="mkt-chart-head">
        <span className="microlabel">Odds over time</span>
        <span className="display mkt-chart-now">{now}%</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="probability over time">
        <path className="mkt-chart-area" d={area} />
        <path className="mkt-chart-line" d={line} />
      </svg>
    </div>
  );
}

// A live feed of who traded this market, the social proof a lone order book lacks.
export function MarketActivity({ address, home, me }) {
  const [trades, setTrades] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`${INDEXER}/market/${address}/trades`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (alive) setTrades(j.trades ?? []); })
      .catch(() => { if (alive) setTrades(null); }); // indexer down: hide the strip
    load();
    const t = setInterval(load, 12000);
    return () => { alive = false; clearInterval(t); };
  }, [address]);

  if (trades == null) return null;
  return (
    <div className="mkt-activity">
      <div className="microlabel clob-bal-head">Activity</div>
      {trades.length === 0 && <div className="mkt-act-empty mono">No trades yet. Be the first.</div>}
      {trades.map((t) => {
        const boughtYes = t.yesDelta > 0, boughtNo = t.noDelta > 0;
        const side = boughtYes || boughtNo ? "bought" : "sold";
        const outcome = boughtYes || t.yesDelta < 0 ? `${home} wins` : `${home} does not win`;
        const amt = Math.abs(t.collateralDelta);
        return (
          <div className="mkt-act-row" key={t.signature}>
            <span className="mono">{nameOf(t.wallet, me)}</span>
            <span><span className={side === "bought" ? "mkt-act-side-buy" : "mkt-act-side-sell"}>{side}</span> {outcome}</span>
            <span className="mono">{usd(amt)}</span>
          </div>
        );
      })}
    </div>
  );
}
