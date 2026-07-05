// "My wagers": read-only view of the connected wallet's wager PDAs on devnet.
// Winner is not stored on-chain, so settled outcomes are derived from the settle
// transaction's balance deltas (fetchOutcome): still a pure read, no new state.
import { useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { fetchAllWagers, fetchOutcome } from "./chain.js";
import { lamportsToSol, shortKey } from "./data.js";
import SolLink from "./SolLink.jsx";

const STATE_LABEL = {
  open: "OPEN · waiting for a taker",
  active: "ACTIVE · settles on the final whistle",
  settled: "SETTLED",
  refunded: "REFUNDED",
};

// ?as=<pubkey> views any wallet's tickets read-only (demo and judging convenience;
// nothing on this page signs anyway)
const VIEW_AS = new URLSearchParams(window.location.search).get("as");

export default function Account() {
  const wallet = useAnchorWallet();
  const viewKey = VIEW_AS ?? wallet?.publicKey.toBase58();
  const [mine, setMine] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!viewKey) return;
    let alive = true;
    const me = viewKey;
    fetchAllWagers()
      .then(async (all) => {
        if (!alive) return;
        const own = all.filter((w) => w.maker === me || w.taker === me);
        setMine(own);
        for (const w of own.filter((x) => x.state === "settled")) {
          const o = await fetchOutcome(w).catch(() => null);
          if (alive && o) setOutcomes((prev) => ({ ...prev, [w.address]: o }));
        }
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => { alive = false; };
  }, [viewKey]);

  if (!viewKey) {
    return (
      <div className="account">
        <h2 className="display section-title">My wagers</h2>
        <p className="empty-state">Connect a wallet to see your tickets. Everything on this page is read from chain; there is nothing to sign.</p>
      </div>
    );
  }

  const me = viewKey;

  return (
    <div className="account">
      <div className="section-head">
        <h2 className="display section-title">My wagers</h2>
        <span className="mono section-sub">
          {shortKey(me)} · devnet{VIEW_AS ? " · read-only view" : ""}
        </span>
      </div>

      {error && <div className="live-error mono">Could not read from chain: {error}</div>}
      {mine === null && !error && <div className="feed-idle mono">reading your wagers from chain…</div>}
      {mine !== null && mine.length === 0 && (
        <p className="empty-state">
          No wagers for this wallet yet. Open one in Markets; your stake locks in the
          program vault and the ticket appears here.
        </p>
      )}

      {mine !== null && mine.length > 0 && (
        <table className="account-table">
          <thead>
            <tr>
              <th className="microlabel">Fixture</th>
              <th className="microlabel">Side</th>
              <th className="microlabel">Stake</th>
              <th className="microlabel">Status</th>
              <th className="microlabel">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((w) => {
              const iAmMaker = w.maker === me;
              const o = outcomes[w.address];
              const iWon = o && ((o.winner === "maker") === iAmMaker);
              return (
                <tr key={w.address}>
                  <td>
                    <div className="account-fixture">{w.home} v {w.away}</div>
                    <div className="account-addr">
                      <SolLink account={w.address}>{shortKey(w.address)}</SolLink>
                    </div>
                  </td>
                  <td>{iAmMaker ? `${w.home} to win` : `against ${w.home}`}</td>
                  <td className="mono">{lamportsToSol(w.stakeLamports)} SOL</td>
                  <td className="mono account-state">{STATE_LABEL[w.state] ?? w.state}</td>
                  <td>
                    {w.state !== "settled" && <span className="mono account-dash">·</span>}
                    {w.state === "settled" && !o && <span className="mono account-dash">reading settle tx…</span>}
                    {o && (
                      <div>
                        <span className={iWon ? "outcome-win mono" : "outcome-loss mono"}>
                          {iWon ? `WON ${lamportsToSol(o.paidLamports)} SOL` : "LOST"}
                        </span>
                        <div className="account-addr">
                          <SolLink tx={o.sig}>{o.sig.slice(0, 16)}…</SolLink>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
