// Disconnected visitors land here: what fischio is, the proof it works (read live
// from chain, nothing static), and connect as the primary action. The wallet IS the
// account; there is no signup. Browsing without connecting stays one click away,
// because bettors read the board before they register anywhere.
import { useEffect, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Ticket from "./Ticket.jsx";
import { fetchLatestSettlement } from "./chain.js";

export default function Landing({ onBrowse, onInstant }) {
  const [latest, setLatest] = useState(undefined);
  useEffect(() => {
    fetchLatestSettlement().then(setLatest).catch(() => setLatest(null));
  }, []);

  return (
    <div className="landing">
      <h1 className="display landing-title">Bets that settle themselves.</h1>
      <p className="landing-sub">
        Two people lock funds on a football match. When the match ends, fischio checks
        the final score against a signed proof from TxLINE and pays the winner. No
        bookmaker holds your money, and no operator has to approve the payout.
      </p>
      <div className="landing-cta">
        <WalletMultiButton />
        {onInstant && (
          <button className="landing-instant" onClick={onInstant}>
            start instantly, no wallet or SOL needed
          </button>
        )}
        <button className="landing-browse" onClick={onBrowse}>
          browse markets first
        </button>
      </div>

      <div className="landing-proof">
        <div className="microlabel landing-proof-label">
          Latest settlement · read live from devnet
        </div>
        {latest === undefined && (
          <div className="feed-idle mono">reading latest settlement from chain…</div>
        )}
        {latest === null && (
          <div className="feed-idle mono">
            no settlements on this deployment yet; the first final whistle writes one here
          </div>
        )}
        {latest && (
          <div className="hero-ticket">
            <Ticket wager={latest} />
          </div>
        )}
      </div>
    </div>
  );
}
