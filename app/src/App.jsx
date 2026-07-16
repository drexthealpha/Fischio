import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import "./App.css";
import Markets from "./Markets.jsx";
import Market from "./Market.jsx";
import Trending from "./Trending.jsx";
import Settlement from "./Settlement.jsx";
import Live from "./Live.jsx";
import Portfolio from "./Portfolio.jsx";
import LiveMatch from "./LiveMatch.jsx";
import LiveFeed from "./LiveFeed.jsx";
import { PROGRAM_ID, DEVNET_USDC } from "./data.js";
import { connection } from "./chain.js";
import SolLink from "./SolLink.jsx";
import { useWalletBridge } from "./walletBridge.jsx";

// ?live&wager=<address> switches the settlement view to the real bot log tail. The default
// settlement view reads settlements straight from chain; both show only real data.
const params = new URLSearchParams(window.location.search);
const LIVE_MODE = params.has("live");
const LIVE_WAGER = params.get("wager");

const VIEWS = ["Predictions", "Live", "Wagers", "Settlement", "Portfolio"];

export default function App() {
  const [view, setView] = useState(LIVE_MODE ? "Settlement" : "Predictions");
  const { connected } = useWallet();
  const { embeddedOn, enableEmbedded, pubkey } = useWalletBridge();

  // Everyone lands on the board. A visitor can read every market with no wallet; the account
  // is the wallet key, created on the spot by "Start instantly" or connected from an extension.
  return (
    <div className="shell">
      <header className="topbar">
        <div className="display wordmark">
          FISCHIO<span className="wordmark-dot">.</span>
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
        <LiveFeed />
        {pubkey && <HeaderBalance pubkey={pubkey} />}
        <SessionArea connected={connected} embeddedOn={embeddedOn} onInstant={enableEmbedded} />
      </header>

      {view === "Wagers" && (
        <>
          <Trending />
          <Markets />
        </>
      )}
      {view === "Live" && <LiveMatch />}
      {view === "Predictions" && <Market />}
      {view === "Settlement" && (LIVE_MODE ? <Live wagerAddress={LIVE_WAGER} /> : <Settlement />)}
      {view === "Portfolio" && <Portfolio />}

      <footer className="foot">
        <SolLink account={PROGRAM_ID}>Verified on Solana</SolLink>
      </footer>
    </div>
  );
}

// Header session area. Disconnected: a one-tap instant wallet, or connect an extension. The
// instant wallet shows its address and auto sign-in state; the account is the key, so there
// is no signup. External wallets add a Sign-in action so the backend session is real.
function SessionArea({ connected, embeddedOn, onInstant }) {
  const { wallet, disableEmbedded, signedIn, signingIn, signIn } = useWalletBridge();
  const addr = wallet?.publicKey?.toBase58();

  if (embeddedOn && !connected) {
    return (
      <div className="embedded-chip mono">
        <span className={signedIn ? "embedded-dot" : "embedded-dot embedded-dot-off"} />
        instant wallet {addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : ""}
        <span className="embedded-sess">{signedIn ? "signed in" : signingIn ? "signing in…" : "ready"}</span>
        <button className="embedded-exit" onClick={disableEmbedded} title="forget this wallet">exit</button>
      </div>
    );
  }
  return (
    <div className="session-ext">
      {!connected && <button className="session-instant" onClick={onInstant}>Start instantly</button>}
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

// A quiet balance readout in the header, so a connected user sees their USDC and SOL at a
// glance the way every real market does. Reads devnet directly and polls slowly.
function HeaderBalance({ pubkey }) {
  const [sol, setSol] = useState(null);
  const [usdc, setUsdc] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const owner = new PublicKey(pubkey);
        const lamports = await connection.getBalance(owner);
        if (alive) setSol(lamports / 1e9);
        const ata = getAssociatedTokenAddressSync(new PublicKey(DEVNET_USDC), owner);
        const bal = await connection.getTokenAccountBalance(ata).then((b) => b.value.uiAmount).catch(() => 0);
        if (alive) setUsdc(bal ?? 0);
      } catch { /* rpc hiccup: keep the last value */ }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [pubkey]);
  if (sol == null) return null;
  return (
    <span className="header-bal mono" title="Your devnet balance">
      <span className="header-bal-usdc">${(usdc ?? 0).toFixed(2)}</span>
      <span className="header-bal-sep">·</span>
      <span className="header-bal-sol">◎{sol.toFixed(2)}</span>
    </span>
  );
}
