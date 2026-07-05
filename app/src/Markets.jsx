// Landing view: open wagers on real World Cup fixtures, read from devnet. Clicking
// an open ticket offers the accept side via the existing accept_wager instruction.
import { useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import Ticket from "./Ticket.jsx";
import CreateWager from "./CreateWager.jsx";
import SolLink from "./SolLink.jsx";
import { fetchAllWagers, fetchLatestSettlement, fetchLiveScores, refreshFixtures, acceptWagerTx, createWagerTx, connection, UPCOMING, RPC } from "./chain.js";
import { lamportsToSol, shortKey } from "./data.js";

export default function Markets() {
  const wallet = useAnchorWallet();
  const [wagers, setWagers] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [liveScores, setLiveScores] = useState({});
  const [noSol, setNoSol] = useState(false);

  const [latest, setLatest] = useState(undefined); // undefined = loading, null = none yet

  const load = () =>
    fetchAllWagers()
      .then((w) => { setWagers(w); setLoadError(null); })
      .catch((e) => setLoadError(String(e.message ?? e)));
  const [fixtures, setFixtures] = useState(UPCOMING);
  useEffect(() => {
    refreshFixtures().then((f) => { setFixtures(f); load(); });
    fetchLatestSettlement().then(setLatest).catch(() => setLatest(null));
  }, []);

  // tickets breathe with the feed: poll compact live state for visible fixtures
  useEffect(() => {
    if (!wagers) return;
    const ids = [...new Set(
      wagers.filter((w) => w.state === "open" || w.state === "active").map((w) => w.fixtureId)
    )];
    if (ids.length === 0) return;
    let alive = true;
    const tick = () => fetchLiveScores(ids).then((s) => { if (alive) setLiveScores(s); });
    tick();
    const t = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [wagers]);

  // first-session guidance: staking needs devnet SOL, and new wallets have none
  useEffect(() => {
    if (!wallet) { setNoSol(false); return; }
    connection.getBalance(wallet.publicKey)
      .then((b) => setNoSol(b < 5_000_000))
      .catch(() => setNoSol(false));
  }, [wallet]);

  // an Open wager past expiry is refundable, not takeable; it is not a market
  const now = Date.now() / 1000;
  const open = (wagers ?? []).filter((w) => w.state === "open" && w.expiryTs > now);
  const expiredOpen = (wagers ?? []).filter((w) => w.state === "open" && w.expiryTs <= now);
  const active = (wagers ?? []).filter((w) => w.state === "active");

  const accept = async (ticket) => {
    if (!wallet) { setNotice("Connect a wallet to take this bet."); return; }
    setBusy(true);
    setNotice(null);
    try {
      const sig = await acceptWagerTx(wallet, ticket);
      setNotice(`Accepted. Stake locked in escrow. tx ${sig.slice(0, 16)}…`);
      setSelected(null);
      await load();
    } catch (e) {
      setNotice(`Accept failed: ${String(e.message ?? e).slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const create = async ({ fixtureId, side, stake }) => {
    if (!wallet) { setNotice("Connect a wallet to open a wager."); return; }
    const lamports = Math.round(Number(stake) * 1e9);
    if (!Number.isFinite(lamports) || lamports <= 0) { setNotice("Enter a valid stake."); return; }
    const fx = fixtures.find((f) => f.id === fixtureId);
    const kickoff = fx ? new Date(fx.kickoff).getTime() : Date.now();
    setBusy(true);
    setNotice(null);
    try {
      const { wager } = await createWagerTx(wallet, {
        fixtureId,
        backedIsHome: side === "home",
        stakeLamports: lamports,
        // refund path opens 8h after kickoff: past ET, pens, and worst root lag
        expiryTs: Math.floor(kickoff / 1000) + 8 * 3600,
      });
      setNotice(`Wager opened at ${wager.slice(0, 8)}… Stake locked until a taker accepts or expiry refunds.`);
      await load();
    } catch (e) {
      setNotice(`Create failed: ${String(e.message ?? e).slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="markets">
      {notice && <div className="notice mono">{notice}</div>}
      {noSol && (
        <div className="faucet-note mono">
          Connected wallet has no devnet SOL, so it cannot stake yet. Get free test
          SOL at{" "}
          <a className="sol-link" href="https://faucet.solana.com" target="_blank" rel="noopener noreferrer">
            faucet.solana.com
          </a>
          , then refresh.
        </div>
      )}

      {/* first thing a visitor sees: the product working, reconstructed live from chain */}
      {latest !== null && (
        <>
          <div className="section-head">
            <h2 className="display section-title">Latest settlement</h2>
            <span className="mono section-sub">
              read live from devnet · settled by proof, not by anyone
            </span>
          </div>
          <div className="hero-ticket">
            {latest === undefined ? (
              <div className="feed-idle mono">reading latest settlement from chain…</div>
            ) : (
              <Ticket wager={latest} />
            )}
          </div>
        </>
      )}

      <div className="markets-columns">
        <div>
          <div className="section-head section-head-later">
            <h2 className="display section-title">Open markets</h2>
            <span className="mono section-sub">on-chain · {RPC.includes("devnet") ? "devnet" : RPC}</span>
          </div>
          {expiredOpen.length > 0 && (
            <div className="mono expired-note">
              {expiredOpen.length} expired unmatched ticket{expiredOpen.length > 1 ? "s" : ""} awaiting refund (not shown)
            </div>
          )}

          {loadError && <div className="live-error mono">Could not read wagers from chain: {loadError}</div>}
          {wagers === null && !loadError && <div className="feed-idle mono">reading wagers from chain…</div>}
          {wagers !== null && open.length === 0 && (
            <p className="empty-state">
              No open wagers right now. Every ticket here is a real on-chain escrow;
              open one and it appears the moment it confirms.
            </p>
          )}

          <div className="ticket-grid">
            {open.map((w) => (
              <div
                key={w.address}
                className={selected?.address === w.address ? "market-card market-card-on" : "market-card"}
                onClick={() => setSelected(selected?.address === w.address ? null : w)}
              >
                <Ticket wager={w} live={liveScores[w.fixtureId]} />
                {selected?.address === w.address && (
                  <div className="take-panel">
                    <div className="take-terms">
                      Take the other side: <strong>{w.away} not to lose in 90&#8242;+ET</strong>{" "}
                      (draw or shootout counts as your win). Locks{" "}
                      {lamportsToSol(w.stakeLamports)} SOL against{" "}
                      <SolLink account={w.maker}>{shortKey(w.maker)}</SolLink>.
                    </div>
                    <button className="create-submit" disabled={busy} onClick={(e) => { e.stopPropagation(); accept(w); }}>
                      {busy ? "Submitting…" : `Lock ${lamportsToSol(w.stakeLamports)} SOL · take this bet`}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {active.length > 0 && (
            <>
              <div className="section-head section-head-later">
                <h2 className="display section-title">In play / awaiting settlement</h2>
                <span className="mono section-sub">{active.length} active</span>
              </div>
              <div className="ticket-grid">
                {active.map((w) => (
                  <Ticket key={w.address} wager={w} live={liveScores[w.fixtureId]} />
                ))}
              </div>
            </>
          )}
        </div>

        <CreateWager onCreate={create} busy={busy} walletConnected={!!wallet} fixtures={fixtures} />
      </div>
    </div>
  );
}
