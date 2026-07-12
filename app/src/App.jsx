import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "./App.css";
import Landing from "./Landing.jsx";
import Markets from "./Markets.jsx";
import Market from "./Market.jsx";
import OrderBook from "./OrderBook.jsx";
import Trending from "./Trending.jsx";
import Settlement from "./Settlement.jsx";
import Live from "./Live.jsx";
import Portfolio from "./Portfolio.jsx";
import LiveMatch from "./LiveMatch.jsx";
import Winner from "./Winner.jsx";
import LiveFeed from "./LiveFeed.jsx";
import { PROGRAM_ID } from "./data.js";
import SolLink from "./SolLink.jsx";
import { useWalletBridge } from "./walletBridge.jsx";

// ?live&wager=<address> switches the settlement view to the real bot tail.
// The recorded replay stays the default so the safe demo is never lost.
const params = new URLSearchParams(window.location.search);
const LIVE_MODE = params.has("live");
const LIVE_WAGER = params.get("wager");

const VIEWS = ["Live", "Winner", "Wagers", "Predictions", "Order book", "Settlement", "Portfolio"];

export default function App() {
  const [view, setView] = useState(LIVE_MODE ? "Settlement" : "Live");
  const [browsing, setBrowsing] = useState(false);
  const { connected } = useWallet();
  const { embeddedOn, enableEmbedded } = useWalletBridge();

  // disconnected visitors get the landing; connecting, choosing the instant wallet, or one
  // explicit browse click enters the app
  const gate = !connected && !embeddedOn && !browsing && !LIVE_MODE;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="display wordmark">
          FISCHIO<span className="wordmark-dot">.</span>
        </div>
        {gate ? (
          <WalletMultiButton />
        ) : (
          <>
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
            <LiveFeed />
            <SessionArea embeddedActive={embeddedOn && !connected} />
          </>
        )}
      </header>

      {gate && <Landing onBrowse={() => setBrowsing(true)} onInstant={enableEmbedded} />}

      {!gate && view === "Wagers" && (
        <>
          <p className="tagline">
            Two people lock funds on a match. When it ends, a{" "}
            <strong>signed proof of the final score</strong> pays the winner. Anyone can
            trigger the payout by submitting that proof.
          </p>
          <Trending />
          <Markets />
          <section className="steps">
            {[
              ["01", "The match ends", "The keeper watches the TxLINE feed and waits for full time, or the end of extra time or penalties."],
              ["02", "It fetches the proof", "It pulls one proof of the final score. TxODDS publishes the matching root on-chain every five minutes."],
              ["03", "The winner gets paid", "The program checks the proof on-chain and releases the funds. Anyone can submit it, and whoever does earns a small tip."],
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
      {!gate && view === "Live" && <LiveMatch />}
      {!gate && view === "Winner" && <Winner />}
      {!gate && view === "Predictions" && <Market />}
      {!gate && view === "Order book" && <OrderBook />}
      {!gate && view === "Settlement" && (LIVE_MODE ? <Live wagerAddress={LIVE_WAGER} /> : <Settlement />)}
      {!gate && view === "Portfolio" && <Portfolio />}

      <footer className="foot">
        <SolLink account={PROGRAM_ID}>Verified on Solana</SolLink>
      </footer>
    </div>
  );
}

// Header session area. Instant wallet: shows the address, its auto sign-in state, and exit.
// External wallet: the connect button plus a Sign-in action so the backend session is real,
// not just a connected key.
function SessionArea({ embeddedActive }) {
  const { wallet, disableEmbedded, signedIn, signingIn, signIn } = useWalletBridge();
  const addr = wallet?.publicKey?.toBase58();

  if (embeddedActive) {
    return (
      <div className="embedded-chip mono">
        <span className={signedIn ? "embedded-dot" : "embedded-dot embedded-dot-off"} />
        instant wallet {addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : ""}
        <span className="embedded-sess">{signedIn ? "signed in" : "signing in…"}</span>
        <button className="embedded-exit" onClick={disableEmbedded} title="forget this wallet">exit</button>
      </div>
    );
  }
  return (
    <div className="session-ext">
      <WalletMultiButton />
      {wallet && !signedIn && (
        <button className="session-signin" disabled={signingIn} onClick={signIn}>
          {signingIn ? "signing…" : "Sign in"}
        </button>
      )}
      {wallet && signedIn && <span className="session-ok mono">signed in</span>}
    </div>
  );
}
