// The AMM prediction markets: a clean list you browse, and a dedicated page you enter when
// you click one. Fixed-product markets on "home beats away in 90' + ET", traded against a
// pool. Every number is read live from the deployed program; nothing here is simulated.
import { useEffect, useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import SolLink from "./SolLink.jsx";
import Flag from "./Flag.jsx";
import { shortKey, DEVNET_USDC, usd } from "./data.js";
import { RPC, UPCOMING } from "./chain.js";
import { useActiveWallet, useWalletBridge } from "./walletBridge.jsx";
import { prepareEmbedded } from "./relay.js";
import { ProbabilityChart, MarketActivity } from "./MarketExtras.jsx";
import Upcoming from "./Upcoming.jsx";
import VerifiedBadge from "./VerifiedBadge.jsx";
import { AnimatedPct, WinMoment } from "./Animated.jsx";
import {
  fetchMarkets, fetchPosition, quoteBuy, quoteSell, toUsdc, fromUsdc,
  createMarketTx, addLiquidityTx, buyTx, sellTx, MARKET_PROGRAM_ID,
  MARKET_TEMPLATES, describeMarket, resultLeg, fetchLiveLine, fetchFinalScore,
} from "./market.js";

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const qty = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

// A match is over once its window has elapsed (kickoff plus regulation, stoppage, and a
// margin for extra time). A market for a match already played must never read as a live
// tradeable line, even while its on-chain state is still Trading because no one has settled
// it. Time decides that, since the chain state alone cannot.
const MATCH_WINDOW_MS = 150 * 60 * 1000;
const matchOver = (kickoff) => {
  const t = kickoff ? new Date(kickoff).getTime() : 0;
  return t > 0 && Date.now() > t + MATCH_WINDOW_MS;
};
const cents = (p) => `${Math.round((p ?? 0) * 100)}¢`;
const vol = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`);
const koLabel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
};

// collapse duplicate markets to one card, keyed by fixture AND market type, so a match can
// show its winner, corners, and cards markets side by side, but three identical winner
// markets become one. Prefer a trading market, then the deepest pool.
function dedupeByFixture(markets) {
  const key = (m) => `${m.fixtureId}:${m.terms?.statAKey}:${m.terms?.op}:${m.terms?.threshold}`;
  const best = new Map();
  for (const m of markets) {
    const k = key(m);
    const cur = best.get(k);
    if (!cur) { best.set(k, m); continue; }
    const better = (m.state === "trading") !== (cur.state === "trading")
      ? m.state === "trading"
      : m.liquidity > cur.liquidity;
    if (better) best.set(k, m);
  }
  return [...best.values()];
}

// Split markets into 1X2 match-result groups and everything else. A football result has three
// outcomes, so we fold the home/draw/away legs of one fixture into a single group and show them
// together. Props (corners, totals, cards) stay as their own cards.
function groupMarkets(markets) {
  const groups = new Map(); // fixtureId -> { legs: {home, draw, away}, ... }
  const props = [];
  for (const m of markets) {
    const leg = resultLeg(m.terms);
    if (!leg) { props.push(m); continue; }
    let g = groups.get(m.fixtureId);
    if (!g) { g = { fixtureId: m.fixtureId, home: m.home, away: m.away, kickoff: m.kickoff, legs: {} }; groups.set(m.fixtureId, g); }
    const cur = g.legs[leg]; // if a leg was opened more than once, keep the trading / deepest one
    const better = !cur || ((m.state === "trading") !== (cur.state === "trading") ? m.state === "trading" : m.liquidity > cur.liquidity);
    if (better) g.legs[leg] = m;
  }
  const results = [];
  for (const g of groups.values()) {
    const legs = Object.values(g.legs);
    g.liquidity = legs.reduce((s, x) => s + x.liquidity, 0);
    g.state = legs.some((x) => x.state === "trading") ? "trading" : "closed";
    // A real three-way market needs all three legs. A fixture with only a home leg is a
    // legacy binary "home to win" market, not a 1X2, so render it as its own plain card
    // instead of a result card with blank Draw and Away outcomes.
    if (g.legs.home && g.legs.draw && g.legs.away) results.push(g);
    else props.push(...legs);
  }
  return { results: results.sort((a, b) => b.liquidity - a.liquidity), props: dedupeByFixture(props) };
}

export default function Market() {
  const wallet = useActiveWallet();
  const { isEmbedded } = useWalletBridge();
  const [markets, setMarkets] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [openAddr, setOpenAddr] = useState(null); // which market's page is open; null = the list
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(null);
  const [liveLines, setLiveLines] = useState({}); // fixtureId -> { home, draw, away } from TxLINE
  const [finalScores, setFinalScores] = useState({}); // fixtureId -> { home, away, statusId } for closed markets

  const refresh = useCallback(async () => {
    try { setMarkets(await fetchMarkets()); }
    catch (e) { setError(String(e.message ?? e)); }
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  // pull the live TxLINE line for every fixture that has a result market, and keep it fresh so
  // the card shows the consensus the on-chain price is tracking, updating as the odds move
  useEffect(() => {
    const ids = [...new Set((markets ?? []).filter((m) => resultLeg(m.terms)).map((m) => m.fixtureId))];
    if (!ids.length) return;
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(ids.map(async (id) => [id, await fetchLiveLine(id)]));
      if (alive) setLiveLines(Object.fromEntries(entries.filter(([, v]) => v)));
    };
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [markets]);

  // for closed result markets, pull the real final score so the card shows the outcome, not odds
  useEffect(() => {
    const { results } = groupMarkets(markets ?? []);
    const ids = results.filter((g) => g.state !== "trading" || matchOver(g.kickoff)).map((g) => g.fixtureId);
    if (!ids.length) return;
    let alive = true;
    Promise.all(ids.map(async (id) => [id, await fetchFinalScore(id)])).then((entries) => {
      if (alive) setFinalScores(Object.fromEntries(entries.filter(([, v]) => v)));
    });
    return () => { alive = false; };
  }, [markets]);

  const open = markets?.find((m) => m.address === openAddr) ?? null;

  // a market's own page: entered by clicking a card, left by the back link
  if (open) {
    return <MarketDetail market={open} wallet={wallet} isEmbedded={isEmbedded}
      onBack={() => { setOpenAddr(null); setNotice(null); }} onTraded={refresh} />;
  }

  // fold into 1X2 match-result cards plus any prop markets, then split live from closed
  const { results, props } = groupMarkets(markets ?? []);
  const liveResults = results.filter((g) => g.state === "trading" && !matchOver(g.kickoff));
  const closedResults = results.filter((g) => g.state !== "trading" || matchOver(g.kickoff));
  const liveProps = props.filter((m) => m.state === "trading" && !matchOver(m.kickoff));
  const closedProps = props.filter((m) => m.state !== "trading" || matchOver(m.kickoff));
  const closedCount = closedResults.length + closedProps.length;

  return (
    <div className="amm">
      <div className="section-head">
        <h2 className="display section-title">Predictions</h2>
        <span className="mono section-sub">{RPC.includes("devnet") ? "devnet" : RPC}</span>
      </div>

      {notice && <div className="notice mono">{notice}</div>}
      {error && <div className="live-error mono">Could not read the market program: {error}</div>}
      {markets === null && !error && <div className="feed-idle mono">reading markets from chain…</div>}
      {markets && liveResults.length === 0 && liveProps.length === 0 && (
        <p className="empty-state">No open markets right now. The board fills as the next matches approach.</p>
      )}

      <Upcoming onOpen={(fid) => { const g = results.find((r) => r.fixtureId === fid); if (g?.legs?.home) setOpenAddr(g.legs.home.address); }} />

      <div className="amm-cards">
        {liveResults.map((g) => <MatchResultCard key={g.fixtureId} group={g} live={liveLines[g.fixtureId]} onOpen={setOpenAddr} />)}
        {liveProps.map((m) => <MarketCard key={m.address} m={m} onOpen={() => setOpenAddr(m.address)} />)}
      </div>

      <div className="foot clob-foot">
        <SolLink account={MARKET_PROGRAM_ID.toBase58()}>Verified on Solana</SolLink>
      </div>
    </div>
  );
}

// One market as a browse card: fixture, a probability bar, and pool size. Clicking opens it.
function MarketCard({ m, onOpen }) {
  const yes = Math.round(m.yesPrice * 100);
  const d = describeMarket(m.terms, m.home, m.away);
  return (
    <button className="mkt-card" onClick={onOpen}>
      <div className="mkt-card-head">
        <span className="mkt-card-fixture">
          <span className="mkt-flags"><Flag team={m.home} size={16} /><Flag team={m.away} size={16} /></span>
          {m.home} v {m.away}
        </span>
        <span className="mono mkt-card-kind">{d.kind}</span>
      </div>
      <div className="mkt-card-q">{d.question}</div>
      <div className="mkt-card-prob">
        <div className="mkt-bar"><span className="mkt-bar-yes" style={{ width: `${yes}%` }} /></div>
        <span className="display mkt-card-pct">{yes}%</span>
      </div>
      <div className="mkt-card-foot">
        <span>{d.yes}</span>
        <span className="mono">{vol(fromUsdc(m.liquidity))} in play</span>
      </div>
    </button>
  );
}

// A football result has three outcomes, so this card shows Home, Draw and Away together, each
// with its live on-chain price and a bar, plus the TxLINE consensus line the prices track.
const RESULT_ORDER = ["home", "draw", "away"];
function MatchResultCard({ group, live, result, onOpen }) {
  const { home, away, legs } = group;
  const label = { home, draw: "Draw", away };
  const winner = result ? (result.home > result.away ? "home" : result.home === result.away ? "draw" : "away") : null;
  const over = matchOver(group.kickoff);
  const pending = over && !result; // match has been played, but the result is not in hand yet
  const tradeable = group.state === "trading" && !over;
  // Show a coherent 1X2 line. Prefer the live TxLINE demargined line; otherwise normalize
  // the three on-chain leg prices so they sum to 100% (independent pools each carry
  // overround, so their raw prices do not add up on their own).
  const onchainSum = RESULT_ORDER.reduce((s, leg) => s + (legs[leg]?.yesPrice ?? 0), 0) || 1;
  const shownPct = (leg) =>
    live?.[leg] != null ? live[leg] : legs[leg] ? legs[leg].yesPrice / onchainSum : null;
  return (
    <div className={`mr-card${tradeable ? "" : " mr-card-closed"}`}>
      <div className="mr-card-head">
        <span className="mr-flags"><Flag team={home} size={18} /><Flag team={away} size={18} /></span>
        <span className="mr-fixture">{home} <span className="mr-v">v</span> {away}</span>
        <VerifiedBadge fixtureId={group.fixtureId} />
        {result
          ? <span className="display mr-score">{result.home}<span className="mr-score-dash">–</span>{result.away}<span className="mr-ft">FT</span></span>
          : <span className="mono mr-kind">{pending ? "Full time" : koLabel(group.kickoff)}</span>}
      </div>
      {pending ? (
        <div className="mr-pending mono">Match played. Awaiting the settlement proof from TxLINE.</div>
      ) : (
        <div className="mr-outcomes">
          {RESULT_ORDER.map((leg) => {
            const m = legs[leg];
            const shown = shownPct(leg);
            const clickable = m && tradeable;
            const won = winner === leg;
            const cls = winner ? (won ? " mr-out-won" : " mr-out-lost") : "";
            return (
              <button key={leg} className={`mr-outcome mr-outcome-${leg}${cls}`} disabled={!clickable} onClick={() => clickable && onOpen(m.address)}>
                <span className="mr-outcome-name">{label[leg]}</span>
                {winner
                  ? <span className="display mr-outcome-pct">{won ? "WON" : "lost"}</span>
                  : <span className="display mr-outcome-pct">{shown != null ? cents(shown) : "–"}</span>}
                {!winner && shown > 0 && <span className="mono mr-outcome-payout">wins {(1 / shown).toFixed(2)}x</span>}
                {!winner && <div className="mr-outcome-bar"><span className="mr-outcome-fill" style={{ width: `${Math.round((shown ?? 0) * 100)}%` }} /></div>}
              </button>
            );
          })}
        </div>
      )}
      <div className="mr-foot">
        {live && tradeable
          ? <span className="mr-live"><span className="mr-live-dot" />Live line {Math.round(live.home * 100)} · {Math.round(live.draw * 100)} · {Math.round(live.away * 100)}</span>
          : <span className="mr-foot-muted">{result ? "Settled from the TxLINE result" : pending ? "Full time. Awaiting settlement." : "Settled on a TxLINE proof"}</span>}
        <span className="mono mr-foot-liq">{vol(fromUsdc(group.liquidity))} in play</span>
      </div>
    </div>
  );
}

// A market's own page: the scoreboard, a big probability, a focused trade panel, and position.
function MarketDetail({ market, wallet, isEmbedded, onBack, onTraded }) {
  const [m, setM] = useState(market);
  const [position, setPosition] = useState(null);
  const [side, setSide] = useState("yes");
  const [mode, setMode] = useState("buy");
  const [amount, setAmount] = useState("10");
  const [liqAmount, setLiqAmount] = useState("100");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [win, setWin] = useState(null);

  const reload = useCallback(async () => {
    const all = await fetchMarkets();
    const fresh = all.find((x) => x.address === market.address);
    if (fresh) setM(fresh);
    onTraded?.();
  }, [market.address, onTraded]);
  useEffect(() => { const t = setInterval(reload, 8000); return () => clearInterval(t); }, [reload]);

  useEffect(() => {
    if (!wallet) { setPosition(null); return; }
    let alive = true;
    fetchPosition(m, wallet.publicKey.toBase58()).then((p) => alive && setPosition(p));
    return () => { alive = false; };
  }, [m, wallet]);

  const amt = Number(amount);
  const validAmt = amt > 0;
  const quote = validAmt
    ? mode === "buy"
      ? quoteBuy(m.yesReserve, m.noReserve, toUsdc(amt), side, m.feeBps)
      : quoteSell(m.yesReserve, m.noReserve, toUsdc(amt), side)
    : null;
  const yesPct = Math.round(m.yesPrice * 100);
  const d = describeMarket(m.terms, m.home, m.away);

  const trade = async () => {
    if (!wallet) { setNotice("Connect a wallet or start an instant one to trade."); return; }
    if (!validAmt) { setNotice("Enter an amount above zero."); return; }
    setBusy(true); setNotice(null);
    try {
      if (isEmbedded) {
        setNotice("Preparing your instant wallet (the sponsor covers the setup)…");
        await prepareEmbedded(wallet.publicKey, [new PublicKey(m.yesMint), new PublicKey(m.noMint)], 1000);
      }
      let sig;
      if (mode === "buy") {
        sig = await buyTx(wallet, m, toUsdc(amt), side, Math.floor(quote.sharesOut * 0.98));
        setWin({ title: "You're in", sub: `Win ${usd(fromUsdc(quote.sharesOut))} if ${side === "yes" ? d.yes : d.no}` });
      } else {
        sig = await sellTx(wallet, m, quote.collateralOut, side, toUsdc(amt));
        setWin({ title: "Cashed out", sub: `${usd(fromUsdc(quote.collateralOut))} back in your wallet` });
      }
      setNotice(`Confirmed on-chain. tx ${sig.slice(0, 12)}…`);
      await reload();
      if (wallet) setPosition(await fetchPosition(m, wallet.publicKey.toBase58()));
    } catch (e) {
      setNotice(`Trade failed: ${String(e.message ?? e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  const seedLiquidity = async () => {
    setBusy(true); setNotice(null);
    try {
      const sig = await addLiquidityTx(wallet, m, toUsdc(Number(liqAmount)));
      setNotice(`Added ${liqAmount} USDC of liquidity. tx ${sig.slice(0, 12)}…`);
      await reload();
    } catch (e) {
      setNotice(`Add liquidity failed: ${String(e.message ?? e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="mkt-detail">
      <WinMoment show={!!win} title={win?.title} sub={win?.sub} onDone={() => setWin(null)} />
      <button className="mkt-back" onClick={onBack}>&larr; all markets</button>

      <header className="mkt-hero">
        <div className="mkt-hero-top">
          <span className="mkt-hero-flags"><Flag team={m.home} size={28} /><Flag team={m.away} size={28} /></span>
          <h2 className="display mkt-hero-title">{m.home} v {m.away}</h2>
          <span className={`mono mkt-hero-state${m.state === "trading" ? " mkt-hero-state-live" : ""}`}>{m.state === "trading" ? "open" : m.state}</span>
        </div>
        <p className="mkt-hero-q"><span className="mkt-hero-kind">{d.kind}</span> {d.question}</p>
        <div className="mkt-hero-prob">
          <div className="mkt-bar mkt-bar-lg">
            <span className="mkt-bar-yes mkt-bar-anim" style={{ width: `${yesPct}%` }} />
            <span className="mkt-bar-label mkt-bar-label-yes">YES <AnimatedPct value={m.yesPrice} /></span>
            <span className="mkt-bar-label mkt-bar-label-no">NO <AnimatedPct value={1 - m.yesPrice} /></span>
          </div>
        </div>
        <ProbabilityChart address={m.address} livePrice={m.yesPrice} />
      </header>

      {notice && <div className="notice mono">{notice}</div>}

      <div className="mkt-detail-grid">
        <div className="mkt-trade">
          <div className="side-toggle">
            <button className={mode === "buy" ? "side-btn side-btn-on" : "side-btn"} onClick={() => setMode("buy")}>Buy</button>
            <button className={mode === "sell" ? "side-btn side-btn-on" : "side-btn"} onClick={() => setMode("sell")}>Sell</button>
          </div>
          <div className="side-toggle amm-outcome-toggle">
            <button className={side === "yes" ? "side-btn side-btn-on" : "side-btn"} onClick={() => setSide("yes")}>{d.yes} · {pct(m.yesPrice)}</button>
            <button className={side === "no" ? "side-btn side-btn-on" : "side-btn"} onClick={() => setSide("no")}>{d.no} · {pct(1 - m.yesPrice)}</button>
          </div>

          <label className="create-label microlabel">{mode === "buy" ? "Amount to bet ($)" : "Shares to sell"}</label>
          <input className="create-input mono" value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />

          {quote && (
            <div className="create-terms">
              {mode === "buy"
                ? <>Pay <strong>{usd(amt)}</strong>, win about <strong>{usd(fromUsdc(quote.sharesOut))}</strong> if {side === "yes" ? d.yes : d.no}. Odds move to <strong>{pct(quote.priceAfter)}</strong>.</>
                : <>Cash out about <strong>{usd(fromUsdc(quote.collateralOut))}</strong> now. Odds move to <strong>{pct(quote.priceAfter)}</strong>.</>}
            </div>
          )}

          <button className="create-submit" disabled={busy || !validAmt || m.state !== "trading"} onClick={trade}>
            {busy ? "Submitting…" : m.state !== "trading" ? `Market ${m.state}` : `${mode === "buy" ? "Buy" : "Sell"} ${side.toUpperCase()}`}
          </button>
          {!wallet && <div className="create-fee">Connect a wallet or start an instant one to trade.</div>}
          {isEmbedded && wallet && <div className="create-fee">Instant wallet: gasless, no SOL needed.</div>}
        </div>

        <div className="mkt-aside">
          {position && (position.yes > 0 || position.no > 0) && (
            <div className="clob-balances">
              <div className="microlabel clob-bal-head">Your position</div>
              {position.yes > 0 && <div className="mkt-pos-row">Win <strong>{usd(fromUsdc(position.yes))}</strong> if {d.yes}</div>}
              {position.no > 0 && <div className="mkt-pos-row">Win <strong>{usd(fromUsdc(position.no))}</strong> if {d.no}</div>}
            </div>
          )}
          <div className="mkt-meta">
            <div className="microlabel clob-bal-head">Market</div>
            <div className="mkt-meta-row"><span>In play</span><span className="mono">{usd(fromUsdc(m.liquidity))}</span></div>
            <div className="mkt-meta-row"><span>Fee</span><span className="mono">{(m.feeBps / 100).toFixed(1)}%</span></div>
            <div className="mkt-meta-row"><span>On-chain</span><SolLink account={m.address}>Verified on Solana</SolLink></div>
          </div>
          {m.liquidity === 0 && (
            <div className="clob-pending mono">
              This pool is empty; seed it to set the opening price and enable trading.
              <div className="amm-seed-row">
                <input className="create-input mono amm-seed-input" value={liqAmount} inputMode="decimal" onChange={(e) => setLiqAmount(e.target.value)} />
                <button className="clob-withdraw" disabled={busy || !wallet} onClick={seedLiquidity}>Add liquidity</button>
              </div>
            </div>
          )}
          <MarketActivity address={m.address} home={m.home} me={wallet?.publicKey?.toBase58()} />
        </div>
      </div>
    </div>
  );
}

function CreateMarket({ wallet, setNotice, onCreated, onCancel }) {
  const [fixtureId, setFixtureId] = useState(UPCOMING[0]?.id);
  const [template, setTemplate] = useState("winner");
  const [line, setLine] = useState(MARKET_TEMPLATES.winner.line);
  const [busy, setBusy] = useState(false);
  const fixture = UPCOMING.find((f) => f.id === fixtureId) ?? UPCOMING[0];
  const tpl = MARKET_TEMPLATES[template];

  const pickTemplate = (k) => { setTemplate(k); setLine(MARKET_TEMPLATES[k].line); };
  const preview = fixture ? describeMarket(
    { statAKey: tpl.statAKey, op: tpl.op, threshold: tpl.needsLine ? Math.floor(Number(line)) : tpl.line },
    fixture.home, fixture.away) : null;

  const create = async () => {
    if (!wallet) { setNotice("Connect a wallet to open a market."); return; }
    if (!fixture) return;
    setBusy(true); setNotice(null);
    try {
      const kickoff = new Date(fixture.kickoff).getTime();
      const address = await createMarketTx(wallet, {
        fixtureId: fixture.id, collateralMint: DEVNET_USDC, template, line,
        closeTs: Math.floor(kickoff / 1000), expiryTs: Math.floor(kickoff / 1000) + 8 * 3600,
      });
      setNotice(`Market opened at ${address.slice(0, 8)}…. Seed it with liquidity to enable trading.`);
      await onCreated();
    } catch (e) {
      setNotice(`Create failed: ${String(e.message ?? e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  if (!fixture) return <p className="empty-state">No upcoming fixtures in the feed. Run scripts/refresh-fixtures.mjs.</p>;
  return (
    <section className="create amm-create">
      <h2 className="display create-title">Open a prediction market</h2>

      <label className="microlabel create-label" htmlFor="amm-fixture">Fixture</label>
      <select id="amm-fixture" className="create-input" value={fixtureId} onChange={(e) => setFixtureId(Number(e.target.value))}>
        {UPCOMING.map((f) => <option key={f.id} value={f.id}>{f.home} v {f.away} · {f.kickoff.slice(0, 16).replace("T", " ")} UTC</option>)}
      </select>

      <div className="microlabel create-label">Market type</div>
      <div className="amm-templates">
        {Object.entries(MARKET_TEMPLATES).map(([k, t]) => (
          <button key={k} className={k === template ? "amm-tpl amm-tpl-on" : "amm-tpl"} onClick={() => pickTemplate(k)}>{t.label}</button>
        ))}
      </div>

      {tpl.needsLine && (
        <>
          <label className="microlabel create-label" htmlFor="amm-line">Line ({tpl.unit})</label>
          <input id="amm-line" className="create-input mono" value={line} inputMode="numeric" onChange={(e) => setLine(e.target.value)} />
        </>
      )}

      <p className="create-terms"><strong>{preview?.question}</strong></p>
      <div className="amm-create-actions">
        <button className="create-submit" disabled={busy} onClick={create}>{busy ? "Submitting…" : "Open market"}</button>
        <button className="mkt-back" onClick={onCancel}>cancel</button>
      </div>
    </section>
  );
}
