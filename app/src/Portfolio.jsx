// Portfolio: one screen for everything the connected wallet holds. Open positions across
// every prediction market with their live value and profit, realized profit from closed
// trades, and head-to-head wagers. All of it read from chain and from the indexer; the app
// stores nothing itself.
import { useEffect, useState } from "react";
import { useActiveWallet } from "./walletBridge.jsx";
import { fetchAllWagers, fetchOutcome } from "./chain.js";
import { fetchMarkets, fetchPosition, describeMarket, fromUsdc } from "./market.js";
import { buyUsdcWithSol } from "./relay.js";
import { usd, lamportsToSol, shortKey } from "./data.js";
import Flag from "./Flag.jsx";
import SolLink from "./SolLink.jsx";

import { INDEXER } from "./origins.js";

export default function Portfolio() {
  const wallet = useActiveWallet();
  const me = wallet?.publicKey?.toBase58();
  const [positions, setPositions] = useState(null); // null = loading
  const [realized, setRealized] = useState(0);
  const [wagers, setWagers] = useState([]);
  const [outcomes, setOutcomes] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!me) { setPositions([]); return; }
    let alive = true;
    (async () => {
      try {
        const markets = await fetchMarkets();
        const held = [];
        for (const m of markets) {
          const p = await fetchPosition(m, me);
          if (p.yes > 0) held.push({ m, side: "yes", shares: fromUsdc(p.yes), price: m.yesPrice });
          if (p.no > 0) held.push({ m, side: "no", shares: fromUsdc(p.no), price: 1 - m.yesPrice });
        }
        if (alive) setPositions(held);

        const pnl = await fetch(`${INDEXER}/pnl/${me}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (alive && pnl) setRealized(pnl.markets.reduce((s, x) => s + (x.realizedPnl ?? 0), 0));

        const all = await fetchAllWagers();
        const mine = all.filter((w) => w.maker === me || w.taker === me);
        if (alive) setWagers(mine);
        for (const w of mine.filter((x) => x.state === "settled")) {
          const o = await fetchOutcome(w).catch(() => null);
          if (alive && o) setOutcomes((prev) => ({ ...prev, [w.address]: o }));
        }
      } catch (e) { if (alive) setError(String(e.message ?? e)); }
    })();
    return () => { alive = false; };
  }, [me]);

  if (!me) {
    return (
      <div className="portfolio">
        <div className="section-head"><h2 className="display section-title">Portfolio</h2></div>
        <p className="empty-state">Connect a wallet or start an instant one to see your positions. Everything here is read from chain.</p>
      </div>
    );
  }

  const marketValue = (positions ?? []).reduce((s, p) => s + p.shares * p.price, 0);

  return (
    <div className="portfolio">
      <div className="section-head">
        <h2 className="display section-title">Portfolio</h2>
        <span className="mono section-sub">{shortKey(me)}</span>
      </div>

      {error && <div className="live-error mono">Could not read your portfolio: {error}</div>}

      <AddFunds wallet={wallet} />

      <div className="pf-summary">
        <div className="pf-stat">
          <span className="microlabel">Positions value</span>
          <span className="display pf-stat-num">{usd(marketValue)}</span>
        </div>
        <div className="pf-stat">
          <span className="microlabel">Realized profit</span>
          <span className={`display pf-stat-num ${realized >= 0 ? "pf-up" : "pf-down"}`}>{realized >= 0 ? "+" : ""}{usd(realized)}</span>
        </div>
        <div className="pf-stat">
          <span className="microlabel">Open positions</span>
          <span className="display pf-stat-num">{positions?.length ?? "…"}</span>
        </div>
      </div>

      <div className="section-head section-head-later">
        <h3 className="display section-title">Open positions</h3>
      </div>
      {positions === null && <div className="feed-idle mono">reading positions from chain…</div>}
      {positions && positions.length === 0 && (
        <p className="empty-state">No open positions yet. Back a market in Predictions and it shows up here.</p>
      )}
      {positions && positions.length > 0 && (
        <div className="pf-list">
          {positions.map((p, i) => {
            const d = describeMarket(p.m.terms, p.m.home, p.m.away);
            const value = p.shares * p.price;
            return (
              <div className="pf-row" key={i}>
                <div className="pf-row-main">
                  <span className="pf-flags"><Flag team={p.m.home} size={16} /><Flag team={p.m.away} size={16} /></span>
                  <div>
                    <div className="pf-row-fixture">{p.m.home} v {p.m.away}</div>
                    <div className="pf-row-bet mono">{p.side === "yes" ? d.yes : d.no}</div>
                  </div>
                </div>
                <div className="pf-row-val">
                  <div className="mono pf-row-value">{usd(value)}</div>
                  <div className="mono pf-row-shares">{p.shares.toLocaleString("en-US", { maximumFractionDigits: 0 })} shares @ {Math.round(p.price * 100)}c</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {wagers.length > 0 && (
        <>
          <div className="section-head section-head-later">
            <h3 className="display section-title">Wagers</h3>
          </div>
          <div className="pf-list">
            {wagers.map((w) => {
              const iAmMaker = w.maker === me;
              const o = outcomes[w.address];
              const iWon = o && ((o.winner === "maker") === iAmMaker);
              return (
                <div className="pf-row" key={w.address}>
                  <div className="pf-row-main">
                    <span className="pf-flags"><Flag team={w.home} size={16} /><Flag team={w.away} size={16} /></span>
                    <div>
                      <div className="pf-row-fixture">{w.home} v {w.away}</div>
                      <div className="pf-row-bet mono">{iAmMaker ? `${w.home} to win` : `against ${w.home}`} · {lamportsToSol(w.stakeLamports)} SOL</div>
                    </div>
                  </div>
                  <div className="pf-row-val">
                    {w.state !== "settled" && <div className="mono pf-row-shares">{w.state}</div>}
                    {o && <div className={`mono pf-row-value ${iWon ? "pf-up" : "pf-down"}`}>{iWon ? `won ${lamportsToSol(o.paidLamports)} SOL` : "lost"}</div>}
                    {o && <div className="pf-row-shares"><SolLink tx={o.sig}>{o.sig.slice(0, 12)}…</SolLink></div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Add funds: buy trading USDC with SOL now, or a card path that waits on a licensed partner.
function AddFunds({ wallet }) {
  const [sol, setSol] = useState("1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const buy = async () => {
    if (!wallet) return;
    setBusy(true); setMsg(null);
    try {
      const j = await buyUsdcWithSol(wallet, Number(sol));
      setMsg(`Added ${usd(j.usdc)} for ${j.paidSol} SOL. It is in your wallet now.`);
    } catch (e) {
      setMsg(`Could not add funds: ${String(e.message ?? e).slice(0, 140)}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="pf-addfunds">
      <div className="microlabel clob-bal-head">Add funds</div>
      {msg && <div className="notice mono pf-addfunds-msg">{msg}</div>}
      <div className="pf-addfunds-row">
        <input className="create-input mono pf-addfunds-input" value={sol} inputMode="decimal" onChange={(e) => setSol(e.target.value)} />
        <span className="mono pf-addfunds-unit">SOL</span>
        <button className="create-submit pf-addfunds-btn" disabled={busy || !wallet} onClick={buy}>
          {busy ? "Adding…" : "Buy USDC with SOL"}
        </button>
      </div>
      <div className="pf-addfunds-card mono">Pay with card is coming once a licensed on-ramp partner is connected.</div>
    </div>
  );
}
