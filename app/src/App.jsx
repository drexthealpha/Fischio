import { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "./App.css";
import Markets from "./Markets.jsx";
import Settlement from "./Settlement.jsx";
import Live from "./Live.jsx";
import Account from "./Account.jsx";
import { PROGRAM_ID } from "./data.js";

// ?live&wager=<address> switches the settlement view to the real bot tail.
// The recorded replay stays the default so the safe demo is never lost.
const params = new URLSearchParams(window.location.search);
const LIVE_MODE = params.has("live");
const LIVE_WAGER = params.get("wager");

const VIEWS = ["Markets", "Settlement", "Account"];

export default function App() {
  const [view, setView] = useState(LIVE_MODE ? "Settlement" : "Markets");

  return (
    <div className="shell">
      <header className="topbar">
        <div className="display wordmark">
          WC<span className="wordmark-dot">·</span>SETTLE
        </div>
        <nav className="nav">
          {VIEWS.map((v) => (
            <button
              key={v}
              className={view === v ? "nav-link nav-link-on" : "nav-link"}
              onClick={() => setView(v)}
            >
              {v}
              {v === "Settlement" && LIVE_MODE && <span className="nav-live"> LIVE</span>}
            </button>
          ))}
        </nav>
        <WalletMultiButton />
      </header>

      {view === "Markets" && (
        <>
          <p className="tagline">
            Two-party World Cup wagers, escrowed on Solana and settled by{" "}
            <strong>cryptographic proof of the final score</strong>. Anyone can settle:
            no oracle admin, no multisig, no human in the loop.
          </p>
          <Markets />
          <section className="steps">
            {[
              ["01", "Full time detected", "The bot watches the TxLINE feed until the match reaches a terminal phase: FT or after extra time."],
              ["02", "Proof pulled", "One Merkle proof of the final score, bound to the on-chain root TxODDS publishes every five minutes."],
              ["03", "Funds released", "The program verifies the proof via CPI and pays the winner. Any keypair can submit it; first one earns the tip."],
            ].map(([n, title, body]) => (
              <div className="step" key={n}>
                <span className="mono step-n">{n}</span>
                <div>
                  <div className="step-title">{title}</div>
                  <p className="step-body">{body}</p>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
      {view === "Settlement" && (LIVE_MODE ? <Live wagerAddress={LIVE_WAGER} /> : <Settlement />)}
      {view === "Account" && <Account />}

      <footer className="foot mono">program {PROGRAM_ID}</footer>
    </div>
  );
}
