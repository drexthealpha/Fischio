// Disconnected visitors land here: what fischio is, the proof it works (read live
// from chain, nothing static), and connect as the primary action. The wallet IS the
// account; there is no signup. Browsing without connecting stays one click away,
// because bettors read the board before they register anywhere.
import { useEffect, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import Ticket from "./Ticket.jsx";
import { fetchLatestSettlement } from "./chain.js";

export default function Landing({ onBrowse }) {
  const [latest, setLatest] = useState(undefined);
  useEffect(() => {
    fetchLatestSettlement().then(setLatest).catch(() => setLatest(null));
  }, []);

  return (
    <div className="landing">
      <h1 className="display landing-title">Bets that settle themselves.</h1>
      <p className="landing-sub">
        Two-party football wagers, escrowed on Solana. At the final whistle a
        cryptographic proof of the score releases the pot: no bookmaker grades it,
        no oracle admin signs it, no support ticket decides it. Your wallet is your
        account; your ticket is on-chain state.
      </p>
      <div className="landing-cta">
        <WalletMultiButton />
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
