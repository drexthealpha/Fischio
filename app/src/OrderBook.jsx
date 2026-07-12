// The order-book trading view. It draws one book's live depth, takes limit orders through the
// connected wallet, and lists the trader's own resting orders and claimable balances. Matching
// happens on-chain in the program, so this screen only sends an order and reads the book back.
import { useEffect, useState, useCallback } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import SolLink from "./SolLink.jsx";
import { shortKey } from "./data.js";
import { RPC } from "./chain.js";
import {
  fetchBooks, fetchBook, fetchAccount, fetchHeapPending,
  placeOrderTx, cancelOrderTx, withdrawTx, EXCHANGE_PROGRAM_ID,
} from "./exchange.js";

const pct = (p) => `${(p * 100).toFixed(0)}%`;
const price2 = (p) => (p == null ? "—" : p.toFixed(2));
const qty = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export default function OrderBook() {
  const wallet = useAnchorWallet();
  const [books, setBooks] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [activeAddr, setActiveAddr] = useState(null);
  const [book, setBook] = useState(null);
  const [account, setAccount] = useState(null);
  const [pending, setPending] = useState(0);
  const [side, setSide] = useState("bid");
  const [price, setPrice] = useState("0.50");
  const [size, setSize] = useState("100");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  // discover books once, then hold the selection
  useEffect(() => {
    fetchBooks()
      .then((bs) => { setBooks(bs); if (bs[0]) setActiveAddr(bs[0].address); })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const refresh = useCallback(async () => {
    if (!activeAddr) return;
    try {
      const b = await fetchBook(activeAddr);
      setBook(b);
      setPending(await fetchHeapPending(activeAddr));
      if (wallet) setAccount(await fetchAccount(activeAddr, wallet.publicKey.toBase58()));
      else setAccount(null);
    } catch (e) { setError(String(e.message ?? e)); }
  }, [activeAddr, wallet]);

  // the book breathes: poll it while the view is open
  useEffect(() => {
    if (!activeAddr) return;
    let alive = true;
    const tick = () => { if (alive) refresh(); };
    tick();
    const t = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(t); };
  }, [activeAddr, refresh]);

  const p = Number(price), s = Number(size);
  const validOrder = p > 0 && p <= 1 && s > 0;
  const cost = side === "bid" ? p * s : s; // quote you lock for a buy, shares you lock for a sell
  const costLabel = side === "bid" ? `${qty(cost)} USDC` : `${qty(s)} shares`;

  const submit = async () => {
    if (!wallet) { setNotice("Connect a wallet to trade."); return; }
    if (!validOrder) { setNotice("Enter a price between 0.01 and 1.00 and a size above zero."); return; }
    setBusy(true); setNotice(null);
    try {
      const sig = await placeOrderTx(wallet, activeAddr, {
        side, price: p, size: s,
        joined: account?.joined ?? false,
        haveBase: account?.balances?.baseFree ?? 0,
        haveQuote: account?.balances?.quoteFree ?? 0,
      });
      setNotice(`Order sent. ${side === "bid" ? "Buy" : "Sell"} ${qty(s)} @ ${price2(p)}. tx ${sig.slice(0, 12)}…`);
      await refresh();
    } catch (e) {
      setNotice(`Order failed: ${String(e.message ?? e).slice(0, 160)}`);
    } finally { setBusy(false); }
  };

  const cancel = async (o) => {
    setBusy(true); setNotice(null);
    try {
      await cancelOrderTx(wallet, activeAddr, o.side, o.id);
      setNotice(`Cancelled order #${o.id}. Escrow returned to your balance.`);
      await refresh();
    } catch (e) {
      setNotice(`Cancel failed: ${String(e.message ?? e).slice(0, 140)}`);
    } finally { setBusy(false); }
  };

  const withdrawAll = async () => {
    const bal = account?.balances; if (!bal) return;
    setBusy(true); setNotice(null);
    try {
      await withdrawTx(wallet, activeAddr, bal.baseFree, bal.quoteFree);
      setNotice("Withdrew your claimable balances to your wallet.");
      await refresh();
    } catch (e) {
      setNotice(`Withdraw failed: ${String(e.message ?? e).slice(0, 140)}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="clob">
      <div className="section-head">
        <h2 className="display section-title">Order book</h2>
        <span className="mono section-sub">
          on-chain matching · {RPC.includes("devnet") ? "devnet" : RPC}
        </span>
      </div>
      <p className="tagline clob-lede">A price-time order book, fully on-chain. Rest a limit order, or take one that is resting.</p>

      {notice && <div className="notice mono">{notice}</div>}
      {error && <div className="live-error mono">Could not read the exchange: {error}</div>}
      {books === null && !error && <div className="feed-idle mono">reading books from chain…</div>}
      {books !== null && books.length === 0 && (
        <p className="empty-state">
          No books exist on the exchange yet. Create one with the CLI, and it shows up here the
          moment it confirms.
        </p>
      )}

      {books && books.length > 1 && (
        <div className="clob-picker mono">
          {books.map((b, i) => (
            <button
              key={b.address}
              className={b.address === activeAddr ? "clob-tab clob-tab-on" : "clob-tab"}
              onClick={() => setActiveAddr(b.address)}
            >
              Book {i + 1} · depth {qty(b.depth)}
            </button>
          ))}
        </div>
      )}

      {book && (
        <div className="clob-grid">
          <div className="clob-book">
            <div className="clob-topline">
              <div><span className="microlabel">Best bid</span><div className="display clob-big clob-bid">{price2(book.bestBid)}</div></div>
              <div><span className="microlabel">Spread</span><div className="display clob-big">{book.spread == null ? "—" : book.spread.toFixed(2)}</div></div>
              <div><span className="microlabel">Best ask</span><div className="display clob-big clob-ask">{price2(book.bestAsk)}</div></div>
              <div><span className="microlabel">Implied</span><div className="display clob-big">{book.mid == null ? "—" : pct(book.mid)}</div></div>
            </div>

            <div className="clob-ladder mono">
              <div className="clob-ladder-head">
                <span>Price</span><span>Size</span><span>Total</span>
              </div>
              {/* asks: worst at top, best just above the spread line */}
              {[...book.asks].reverse().map((l) => (
                <Row key={`a${l.price}`} l={l} kind="ask" max={book.depth} />
              ))}
              <div className="clob-spread-line">
                <span>{book.mid == null ? "no market" : `mid ${price2(book.mid)}`}</span>
                <span>{book.spread == null ? "" : `spread ${book.spread.toFixed(2)}`}</span>
              </div>
              {/* bids: best just below the spread line, worse below */}
              {book.bids.map((l) => (
                <Row key={`b${l.price}`} l={l} kind="bid" max={book.depth} />
              ))}
              {book.bids.length === 0 && book.asks.length === 0 && (
                <div className="clob-empty">This book is empty. Post the first order.</div>
              )}
            </div>
            {pending > 0 && (
              <div className="clob-pending mono">
                {pending} filled order{pending > 1 ? "s" : ""} waiting for the payout crank. Fills
                settle asynchronously, so makers are credited when the keeper next runs.
              </div>
            )}
          </div>

          <div className="clob-side">
            <div className="clob-ticket">
              <div className="side-toggle">
                <button className={side === "bid" ? "side-btn side-btn-on" : "side-btn"} onClick={() => setSide("bid")}>Buy</button>
                <button className={side === "ask" ? "side-btn side-btn-on" : "side-btn"} onClick={() => setSide("ask")}>Sell</button>
              </div>

              <label className="create-label microlabel">Limit price (USDC per share, 0 to 1)</label>
              <input className="create-input mono" value={price} inputMode="decimal"
                onChange={(e) => setPrice(e.target.value)} placeholder="0.50" />

              <label className="create-label microlabel">Size (shares)</label>
              <input className="create-input mono" value={size} inputMode="decimal"
                onChange={(e) => setSize(e.target.value)} placeholder="100" />

              <div className="create-terms">
                {side === "bid" ? "Buy" : "Sell"} <strong>{qty(s || 0)} shares</strong> at{" "}
                <strong>{price2(p || 0)}</strong> or better. This locks <strong>{costLabel}</strong> in
                the book. Any part that crosses the {side === "bid" ? "asks" : "bids"} fills now at the
                maker's price; the rest rests until someone takes it.
              </div>

              <button className="create-submit" disabled={busy || !validOrder} onClick={submit}>
                {busy ? "Submitting…" : `${side === "bid" ? "Buy" : "Sell"} ${qty(s || 0)} @ ${price2(p || 0)}`}
              </button>
              {!wallet && <div className="create-fee">Connect a wallet to place a live order.</div>}
            </div>

            {account?.joined && (
              <div className="clob-balances">
                <div className="microlabel clob-bal-head">Your balances on this book</div>
                <div className="clob-bal-row mono">
                  <span>{qty(account.balances.baseFree)} shares</span>
                  <span>{qty(account.balances.quoteFree)} USDC</span>
                </div>
                {(account.balances.baseFree > 0 || account.balances.quoteFree > 0) && (
                  <button className="clob-withdraw" disabled={busy} onClick={withdrawAll}>Withdraw to wallet</button>
                )}
              </div>
            )}

            {account?.orders?.length > 0 && (
              <div className="clob-orders">
                <div className="microlabel clob-bal-head">Your open orders</div>
                {account.orders.map((o) => (
                  <div className="clob-order mono" key={`${o.side}${o.id}`}>
                    <span className={o.side === "bid" ? "clob-bid" : "clob-ask"}>{o.side === "bid" ? "BUY" : "SELL"}</span>
                    <span>{qty(o.size)} @ {price2(o.price)}</span>
                    <button className="clob-cancel" disabled={busy} onClick={() => cancel(o)}>cancel</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="foot clob-foot">
        <SolLink account={EXCHANGE_PROGRAM_ID.toBase58()}>Verified on Solana</SolLink>
      </div>
    </div>
  );
}

// one price level, with a depth bar sized by cumulative volume from the top of book
function Row({ l, kind, max }) {
  const width = max > 0 ? Math.min(100, (l.cumulative / max) * 100) : 0;
  return (
    <div className={`clob-row clob-row-${kind}`}>
      <span className={kind === "bid" ? "clob-bid" : "clob-ask"}>{l.price.toFixed(2)}</span>
      <span>{qty(l.size)}</span>
      <span className="clob-cum">{qty(l.cumulative)}</span>
      <span className="clob-fill" style={{ width: `${width}%` }} aria-hidden="true" />
    </div>
  );
}
