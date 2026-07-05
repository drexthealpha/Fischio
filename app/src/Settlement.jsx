// Settlements ledger: every settlement this program has executed, reconstructed
// live from chain (wager account + settle transaction + decoded proof leaves).
// No recordings, no stored history; the chain is the only source.
import { useEffect, useState } from "react";
import Ticket from "./Ticket.jsx";
import { fetchSettlements } from "./chain.js";

const when = (t) =>
  t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";

export default function Settlement() {
  const [items, setItems] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchSettlements()
      .then(setItems)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <div className="settlement">
      <div className="settlement-head">
        <h2 className="display settlement-title">Settlements</h2>
        <span className="mono replay-chip">
          reconstructed live from chain · nothing stored off-chain
        </span>
      </div>

      {error && (
        <div className="live-error mono">Could not read settlements from chain: {error}</div>
      )}
      {items === null && !error && (
        <div className="feed-idle mono">reading settlements from chain…</div>
      )}
      {items && items.length === 0 && (
        <p className="empty-state">
          No settlements yet. The first final whistle writes one here.
        </p>
      )}

      <div className="settlements-list">
        {(items ?? []).map((t) => (
          <div key={t.address} className="settlement-item">
            <div className="mono settle-when">settled {when(t.blockTime)}</div>
            <Ticket wager={t} />
          </div>
        ))}
      </div>
    </div>
  );
}
