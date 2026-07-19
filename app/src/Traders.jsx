// Traders: who is profitable here, worked out from public trades.
//
// Copy trading exists on other venues because trades are public there. The half that is usually
// missing is the outcome: a leader's wins were decided by a resolver you have to trust. Here both
// halves are checkable, because the trade is an on-chain transaction and the result it settled
// against carries a proof anyone can re-verify. So this table is not a claim being made about a
// trader, it is arithmetic over public data that anyone can redo.
//
// Realised profit only. An open position needs a live price to value, which would move the table
// for reasons the trader had nothing to do with.
import { useEffect, useState } from "react";
import { usd, shortKey } from "./data.js";
import SolLink from "./SolLink.jsx";

import { INDEXER } from "./origins.js";

export default function Traders() {
  const [rows, setRows] = useState(undefined); // undefined = loading, null = unreachable
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${INDEXER}/leaderboard?minTrades=1`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (alive) setRows(j.traders ?? []);
      } catch { if (alive) setRows(null); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (rows === undefined) return <p className="empty-state">Reading trades from chain…</p>;
  if (rows === null) {
    return (
      <div className="traders">
        <header className="section-head">
          <h2 className="display section-title">Traders</h2>
        </header>
        <p className="empty-state">
          The trade index is not reachable right now, so no ranking is shown rather than a stale one.
        </p>
      </div>
    );
  }

  return (
    <div className="traders">
      <header className="section-head">
        <h2 className="display section-title">Traders</h2>
        <span className="mono section-sub">ranked by realised profit, computed from on-chain trades</span>
      </header>

      {!rows.length ? (
        <p className="empty-state">
          Nobody has closed a position yet, so there is nothing to rank. This fills in as trades settle.
        </p>
      ) : (
        <>
          <div className="tr-head microlabel">
            <span>Trader</span><span>Realised</span><span>Win rate</span><span>Trades</span><span>Markets</span>
          </div>
          {rows.map((t) => (
            <div className="tr-row" key={t.wallet}>
              <span className="tr-who">
                <SolLink account={t.wallet}>{shortKey(t.wallet)}</SolLink>
              </span>
              <span className={`tr-pnl mono ${t.realizedPnl > 0 ? "tr-up" : t.realizedPnl < 0 ? "tr-down" : ""}`}>
                {usd(t.realizedPnl / 1e6)}
              </span>
              <span className="tr-cell mono">{t.winRate == null ? "not yet" : `${Math.round(t.winRate * 100)}%`}</span>
              <span className="tr-cell mono">{t.trades}</span>
              <span className="tr-cell mono">{t.marketsTraded}</span>
            </div>
          ))}
        </>
      )}

      <p className="board-note">
        Realised profit only. Open positions are left out because valuing them needs a live price.
        Every figure here comes from public transactions, so you can recompute it yourself instead
        of believing this table.
      </p>
    </div>
  );
}
