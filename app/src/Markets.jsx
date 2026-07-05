// Landing view: open wagers on real World Cup fixtures, read from devnet. Clicking
// an open ticket offers the accept side via the existing accept_wager instruction.
import { useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import Ticket from "./Ticket.jsx";
import CreateWager from "./CreateWager.jsx";
import { fetchAllWagers, acceptWagerTx, createWagerTx, UPCOMING, RPC } from "./chain.js";
import { lamportsToSol, shortKey } from "./data.js";

export default function Markets() {
  const wallet = useAnchorWallet();
  const [wagers, setWagers] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = () =>
    fetchAllWagers()
      .then((w) => { setWagers(w); setLoadError(null); })
      .catch((e) => setLoadError(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const open = (wagers ?? []).filter((w) => w.state === "open");
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
    const fx = UPCOMING.find((f) => f.id === fixtureId);
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

      <div className="markets-columns">
        <div>
          <div className="section-head">
            <h2 className="display section-title">Open markets</h2>
            <span className="mono section-sub">on-chain · {RPC.includes("devnet") ? "devnet" : RPC}</span>
          </div>

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
                <Ticket wager={w} />
                {selected?.address === w.address && (
                  <div className="take-panel">
                    <div className="take-terms">
                      Take the other side: <strong>{w.away} not to lose in 90&#8242;+ET</strong>{" "}
                      (draw or shootout counts as your win). Locks{" "}
                      {lamportsToSol(w.stakeLamports)} SOL against {shortKey(w.maker)}.
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
                  <Ticket key={w.address} wager={w} />
                ))}
              </div>
            </>
          )}
        </div>

        <CreateWager onCreate={create} busy={busy} walletConnected={!!wallet} />
      </div>
    </div>
  );
}
