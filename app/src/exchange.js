// Browser chain layer for the on-chain order book. It reads live books and depth from
// devnet and builds the trading transactions through the connected wallet. Every money path
// is a deployed instruction; this file custodies nothing. Matching runs on-chain, so the UI
// only sends orders and reads the result back off the book.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import exchangeIdl from "./exchange_idl.json";
import { connection } from "./chain.js"; // reuse the single connection

const BN = anchor.BN;
export const EXCHANGE_PROGRAM_ID = new PublicKey(exchangeIdl.address);
export const PRICE_ONE = 1_000_000; // on-chain price scale: 1.0 == 1_000_000, so price is USDC per share
export const UNIT = 1_000_000; // both mints use 6 decimals in the demo

export const toPrice = (p) => Math.round(p * PRICE_ONE); // 0.62 -> 620000
export const fromPrice = (p) => p / PRICE_ONE;
export const toUnits = (x) => Math.round(x * UNIT);
export const fromUnits = (x) => x / UNIT;

const readProvider = new anchor.AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" }
);
export const exchangeRead = new anchor.Program(exchangeIdl, readProvider);
export const exchangeFor = (wallet) =>
  new anchor.Program(exchangeIdl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));

const seed = (s, key) =>
  PublicKey.findProgramAddressSync([Buffer.from(s), key.toBuffer()], EXCHANGE_PROGRAM_ID)[0];

export function bookPdas(book) {
  return {
    baseVault: seed("base_vault", book),
    quoteVault: seed("quote_vault", book),
    eventHeap: seed("events", book),
  };
}
export const openOrdersPda = (book, owner) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("open_orders"), book.toBuffer(), owner.toBuffer()], EXCHANGE_PROGRAM_ID
  )[0];

// Read every book on the program, each with its live bid and ask ladder collapsed into price
// levels. This is the whole depth chart the UI draws from.
export async function fetchBooks() {
  const all = await exchangeRead.account.book.all();
  return all.map(({ publicKey, account }) => shapeBook(publicKey, account)).sort((a, b) => b.depth - a.depth);
}

export async function fetchBook(address) {
  const pk = new PublicKey(address);
  const account = await exchangeRead.account.book.fetch(pk);
  return shapeBook(pk, account);
}

function shapeBook(pk, account) {
  const bids = ladder(account.bids, Number(account.bidCount), "desc");
  const asks = ladder(account.asks, Number(account.askCount), "asc");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
  const depth = bids.reduce((s, l) => s + l.size, 0) + asks.reduce((s, l) => s + l.size, 0);
  return {
    address: pk.toBase58(),
    market: account.market.toBase58(),
    baseMint: account.baseMint.toBase58(),
    quoteMint: account.quoteMint.toBase58(),
    bids, asks, bestBid, bestAsk,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    mid, depth,
  };
}

// collapse an array of resting orders into price levels, keeping per-order rows so a trader
// can find their own order to cancel it
function ladder(orders, count, dir) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const o = orders[i];
    rows.push({ id: Number(o.id), owner: o.owner.toBase58(), price: fromPrice(Number(o.price)), size: fromUnits(Number(o.size)) });
  }
  const byPrice = new Map();
  for (const r of rows) {
    const cur = byPrice.get(r.price) ?? { price: r.price, size: 0, orders: [] };
    cur.size += r.size; cur.orders.push(r);
    byPrice.set(r.price, cur);
  }
  const levels = [...byPrice.values()].sort((a, b) => (dir === "desc" ? b.price - a.price : a.price - b.price));
  let running = 0;
  for (const l of levels) { running += l.size; l.cumulative = running; } // depth from the top of book down
  return levels;
}

// A trader's claimable balances and their resting orders on one book.
export async function fetchAccount(book, owner) {
  const oo = openOrdersPda(new PublicKey(book), new PublicKey(owner));
  let balances = null;
  try {
    const a = await exchangeRead.account.openOrders.fetch(oo);
    balances = { baseFree: fromUnits(Number(a.baseFree)), quoteFree: fromUnits(Number(a.quoteFree)) };
  } catch { /* no OpenOrders yet: the trader has not joined this book */ }
  const b = await fetchBook(book);
  const mine = [
    ...b.bids.flatMap((l) => l.orders).filter((o) => o.owner === oo.toBase58()).map((o) => ({ ...o, side: "bid" })),
    ...b.asks.flatMap((l) => l.orders).filter((o) => o.owner === oo.toBase58()).map((o) => ({ ...o, side: "ask" })),
  ].sort((x, y) => y.id - x.id);
  return { openOrders: oo.toBase58(), joined: balances != null, balances, orders: mine };
}

// How many events sit unpaid in the book's heap. The UI surfaces this so makers know a crank
// is pending, since fills settle asynchronously.
export async function fetchHeapPending(book) {
  try {
    const h = await exchangeRead.account.eventHeap.fetch(bookPdas(new PublicKey(book)).eventHeap);
    return Number(h.count);
  } catch { return 0; }
}

const ataIx = (mint, owner, payer) => {
  const addr = getAssociatedTokenAddressSync(mint, owner);
  return { addr, ix: createAssociatedTokenAccountIdempotentInstruction(payer, addr, owner, mint) };
};

// One click to trade: create the OpenOrders if the trader has not joined, move the escrow
// they need into the book, then rest or cross the order. We bundle these so a first-time
// trader signs once, not three times.
export async function placeOrderTx(wallet, book, { side, price, size, joined, haveBase, haveQuote }) {
  const program = exchangeFor(wallet);
  const bookPk = new PublicKey(book);
  const P = bookPdas(bookPk);
  const oo = openOrdersPda(bookPk, wallet.publicKey);
  const b = await exchangeRead.account.book.fetch(bookPk);
  const baseMint = b.baseMint, quoteMint = b.quoteMint;

  const priceScaled = toPrice(price);
  const sizeScaled = toUnits(size);
  // escrow the worst-case cost of this order: quote for a bid, base for an ask
  const needQuote = side === "bid" ? Math.ceil((priceScaled * sizeScaled) / PRICE_ONE) : 0;
  const needBase = side === "ask" ? sizeScaled : 0;
  const topUpBase = Math.max(0, needBase - toUnits(haveBase ?? 0));
  const topUpQuote = Math.max(0, needQuote - toUnits(haveQuote ?? 0));

  const pre = [];
  if (!joined) {
    pre.push(await program.methods.initOpenOrders()
      .accountsPartial({ payer: wallet.publicKey, owner: wallet.publicKey, book: bookPk, openOrders: oo, systemProgram: SystemProgram.programId })
      .instruction());
  }
  if (topUpBase > 0 || topUpQuote > 0) {
    const base = ataIx(baseMint, wallet.publicKey, wallet.publicKey);
    const quote = ataIx(quoteMint, wallet.publicKey, wallet.publicKey);
    pre.push(base.ix, quote.ix);
    pre.push(await program.methods.deposit(new BN(topUpBase), new BN(topUpQuote))
      .accountsPartial({
        owner: wallet.publicKey, book: bookPk, openOrders: oo, baseVault: P.baseVault, quoteVault: P.quoteVault,
        userBase: base.addr, userQuote: quote.addr, tokenProgram: TOKEN_PROGRAM_ID,
      }).instruction());
  }
  return program.methods
    .placeOrder(side === "bid" ? { bid: {} } : { ask: {} }, new BN(priceScaled), new BN(sizeScaled))
    .accountsPartial({ owner: wallet.publicKey, book: bookPk, openOrders: oo, eventHeap: P.eventHeap })
    .preInstructions(pre)
    .rpc();
}

export async function cancelOrderTx(wallet, book, side, orderId) {
  const program = exchangeFor(wallet);
  const bookPk = new PublicKey(book);
  const oo = openOrdersPda(bookPk, wallet.publicKey);
  return program.methods
    .cancelOrder(side === "bid" ? { bid: {} } : { ask: {} }, new BN(orderId))
    .accountsPartial({ owner: wallet.publicKey, book: bookPk, openOrders: oo })
    .rpc();
}

// Pull claimable balances back to the wallet.
export async function withdrawTx(wallet, book, baseAmt, quoteAmt) {
  const program = exchangeFor(wallet);
  const bookPk = new PublicKey(book);
  const P = bookPdas(bookPk);
  const oo = openOrdersPda(bookPk, wallet.publicKey);
  const b = await exchangeRead.account.book.fetch(bookPk);
  const base = ataIx(b.baseMint, wallet.publicKey, wallet.publicKey);
  const quote = ataIx(b.quoteMint, wallet.publicKey, wallet.publicKey);
  return program.methods
    .withdraw(new BN(toUnits(baseAmt)), new BN(toUnits(quoteAmt)))
    .accountsPartial({
      owner: wallet.publicKey, book: bookPk, openOrders: oo, baseVault: P.baseVault, quoteVault: P.quoteVault,
      userBase: base.addr, userQuote: quote.addr, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([base.ix, quote.ix])
    .rpc();
}
