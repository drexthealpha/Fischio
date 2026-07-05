// Any on-chain identifier rendered as a verifiable Solscan devnet link.
// stopPropagation so links inside clickable market cards do not toggle the card.
import { solscanTx, solscanAccount } from "./data.js";

export default function SolLink({ tx, account, children, className = "" }) {
  return (
    <a
      className={`sol-link mono ${className}`}
      href={tx ? solscanTx(tx) : solscanAccount(account)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}
