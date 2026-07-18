// fischio indexer: the persisted trade history the API's in-memory cache can't give you.
// Backfills and tails on-chain transaction history for the programs where a trade's real
// executed amount is reliably recoverable without needing new on-chain events:
//
//   AMM (market) buys and sells: the instruction args only carry min/max bounds, not the
//   exact amount executed, but the exact amount always shows up as a real SPL token balance
//   delta on the trader's YES/NO/collateral accounts in that same transaction. We diff
//   preTokenBalances against postTokenBalances, so this is exact, not estimated.
//
//   Exchange (CLOB) order intent: place_order and cancel_order carry their real arguments
//   directly, so those index cleanly. What this does NOT give you is exact fill history,
//   because a fill's real size depends on what was resting in the book at match time, which
//   the instruction args don't carry and the program does not currently emit as an event.
//   That is a real, scoped gap, not something faked here: closing it needs `emit!` events
//   added to programs/exchange and a redeploy, tracked as a follow-up, not silently invented.
//
//   REST  GET /history/:wallet   merged AMM trades + CLOB order intents, newest first
//         GET /pnl/:wallet       realized/unrealized PnL per AMM market, weighted-avg cost
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const idl = (name) => JSON.parse(readFileSync(join(here, "..", "api", "idl", `${name}.json`), "utf8"));
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT ?? 8792);
const POLL_MS = Number(process.env.POLL_MS ?? 20000);
const connection = new Connection(RPC, "confirmed");

const marketIdl = idl("fischio_market");
const exchangeIdl = idl("fischio_exchange");
const MARKET_PID = new PublicKey(marketIdl.address);
const EXCHANGE_PID = new PublicKey(exchangeIdl.address);
const marketCoder = new anchor.BorshInstructionCoder(marketIdl);
const exchangeCoder = new anchor.BorshInstructionCoder(exchangeIdl);
const U = 1_000_000;

const seed = (pid, s, key) => PublicKey.findProgramAddressSync([Buffer.from(s), key.toBuffer()], pid)[0];

// ---- storage ----
const db = new DatabaseSync(join(here, "index.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS amm_trades (
    signature TEXT PRIMARY KEY, market TEXT, wallet TEXT, kind TEXT,
    collateral_delta REAL, yes_delta REAL, no_delta REAL, block_time INTEGER
  );
  CREATE TABLE IF NOT EXISTS clob_orders (
    signature TEXT PRIMARY KEY, book TEXT, owner TEXT, kind TEXT, side TEXT,
    price REAL, size REAL, order_id INTEGER, block_time INTEGER
  );
  CREATE TABLE IF NOT EXISTS cursors (program TEXT PRIMARY KEY, last_signature TEXT);
`);
const getCursor = (p) => db.prepare("SELECT last_signature FROM cursors WHERE program = ?").get(p)?.last_signature ?? null;
const setCursor = (p, sig) => db.prepare("INSERT INTO cursors (program, last_signature) VALUES (?, ?) ON CONFLICT(program) DO UPDATE SET last_signature = excluded.last_signature").run(p, sig);
const insertAmm = db.prepare(`INSERT OR IGNORE INTO amm_trades (signature, market, wallet, kind, collateral_delta, yes_delta, no_delta, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insertClob = db.prepare(`INSERT OR IGNORE INTO clob_orders (signature, book, owner, kind, side, price, size, order_id, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// token balance delta for one account's mint in a parsed transaction, exact (real amount
// moved), not derived from instruction args
function tokenDelta(tx, ownerBase58, mintBase58) {
  const pre = tx.meta.preTokenBalances ?? [], post = tx.meta.postTokenBalances ?? [];
  const find = (arr) => arr.find((b) => b.owner === ownerBase58 && b.mint === mintBase58);
  const p = find(pre), q = find(post);
  const before = p ? BigInt(p.uiTokenAmount.amount) : 0n;
  const after = q ? BigInt(q.uiTokenAmount.amount) : 0n;
  return Number(after - before) / U;
}

async function indexMarketTx(sig) {
  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return; // skip failed transactions; nothing executed
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId?.toBase58?.() !== MARKET_PID.toBase58()) continue;
    let decoded;
    try { decoded = marketCoder.decode(ix.data, "base58"); } catch { continue; }
    if (!decoded || (decoded.name !== "buy" && decoded.name !== "sell")) continue;
    const accNames = marketIdl.instructions.find((i) => i.name === decoded.name).accounts.map((a) => a.name);
    // ix.accounts are PublicKey objects, not strings; every downstream comparison and
    // SQLite bind needs the base58 string, caught only by running this against real data
    const acc = Object.fromEntries(accNames.map((n, i) => [n, ix.accounts[i]?.toBase58?.() ?? ix.accounts[i]]));
    const market = acc.market;
    const marketPk = new PublicKey(market);
    const yesMint = seed(MARKET_PID, "yes", marketPk).toBase58();
    const noMint = seed(MARKET_PID, "no", marketPk).toBase58();
    const trader = acc.trader;
    const yesDelta = tokenDelta(tx, trader, yesMint);
    const noDelta = tokenDelta(tx, trader, noMint);
    // collateral delta: whichever token account moved negative (buy) or positive (sell)
    // that isn't the yes/no mint; sum all of the trader's other token deltas in this tx
    const pre = tx.meta.preTokenBalances ?? [], post = tx.meta.postTokenBalances ?? [];
    let collateralDelta = 0;
    const seen = new Set();
    for (const b of [...pre, ...post]) {
      if (b.owner !== trader || b.mint === yesMint || b.mint === noMint || seen.has(b.mint)) continue;
      seen.add(b.mint);
      collateralDelta += tokenDelta(tx, trader, b.mint);
    }
    insertAmm.run(sig, market, trader, decoded.name, collateralDelta, yesDelta, noDelta, tx.blockTime ?? null);
  }
}

// BorshInstructionCoder.decode returns the IDL's own snake_case names verbatim (not
// camelCased), Rust enum variants as their PascalCase key, and u64 args as hex strings, not
// numbers. Verified empirically against real decoded devnet transactions, not assumed.
const hexToNum = (hex) => (hex == null ? null : Number(BigInt("0x" + hex)));

async function indexExchangeTx(sig) {
  const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) return;
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId?.toBase58?.() !== EXCHANGE_PID.toBase58()) continue;
    let decoded;
    try { decoded = exchangeCoder.decode(ix.data, "base58"); } catch { continue; }
    if (!decoded || (decoded.name !== "place_order" && decoded.name !== "cancel_order")) continue;
    const accNames = exchangeIdl.instructions.find((i) => i.name === decoded.name).accounts.map((a) => a.name);
    const acc = Object.fromEntries(accNames.map((n, i) => [n, ix.accounts[i]?.toBase58?.() ?? ix.accounts[i]]));
    const side = decoded.data.side.Bid !== undefined ? "bid" : "ask";
    insertClob.run(
      sig, acc.book, acc.owner, decoded.name === "place_order" ? "place" : "cancel", side,
      hexToNum(decoded.data.price) != null ? hexToNum(decoded.data.price) / U : null,
      hexToNum(decoded.data.size) != null ? hexToNum(decoded.data.size) / U : null,
      hexToNum(decoded.data.order_id),
      tx.blockTime ?? null,
    );
  }
}

// backfill everything since the last cursor, oldest first, then advance the cursor
async function sweep(programId, indexFn, label) {
  const cursor = getCursor(label);
  let before = undefined;
  const batch = [];
  for (;;) {
    const sigs = await connection.getSignaturesForAddress(programId, { before, until: cursor ?? undefined, limit: 1000 });
    if (sigs.length === 0) break;
    batch.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }
  if (batch.length === 0) return 0;
  batch.reverse(); // oldest first, so the cursor always advances monotonically
  for (const s of batch) {
    if (s.err) continue;
    try { await indexFn(s.signature); } catch (e) { console.error(`${label} index error on ${s.signature}:`, String(e.message ?? e)); }
    await new Promise((r) => setTimeout(r, 250)); // gentle on the public RPC's per-tx rate limit
  }
  setCursor(label, batch[batch.length - 1].signature);
  return batch.length;
}

async function tick() {
  try {
    const n1 = await sweep(MARKET_PID, indexMarketTx, "market");
    const n2 = await sweep(EXCHANGE_PID, indexExchangeTx, "exchange");
    if (n1 || n2) console.log(`indexed ${n1} market tx, ${n2} exchange tx`);
  } catch (e) { console.error("sweep error:", String(e.message ?? e)); }
}

// ---- REST ----
const app = express();
app.use((_, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });

app.get("/health", (_, res) => res.json({ ok: true, rpc: RPC }));

// Recent trades on one AMM market, newest first, for the market page's activity strip.
app.get("/market/:address/trades", (req, res) => {
  const rows = db.prepare("SELECT * FROM amm_trades WHERE market = ? ORDER BY block_time DESC LIMIT 25").all(req.params.address);
  res.json({ market: req.params.address, trades: rows.map((r) => ({
    kind: r.kind, wallet: r.wallet, collateralDelta: r.collateral_delta,
    yesDelta: r.yes_delta, noDelta: r.no_delta, blockTime: r.block_time, signature: r.signature,
  })) });
});

app.get("/history/:wallet", (req, res) => {
  const w = req.params.wallet;
  const amm = db.prepare("SELECT * FROM amm_trades WHERE wallet = ? ORDER BY block_time DESC").all(w)
    .map((r) => ({ kind: "amm_" + r.kind, signature: r.signature, market: r.market, collateralDelta: r.collateral_delta, yesDelta: r.yes_delta, noDelta: r.no_delta, blockTime: r.block_time }));
  const clob = db.prepare("SELECT * FROM clob_orders WHERE owner = ? ORDER BY block_time DESC").all(w)
    .map((r) => ({ kind: "clob_" + r.kind, signature: r.signature, book: r.book, side: r.side, price: r.price, size: r.size, orderId: r.order_id, blockTime: r.block_time }));
  const merged = [...amm, ...clob].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
  res.json({ wallet: w, trades: merged });
});

// realized PnL per market/side: weighted-average cost basis on buys, realized gain on
// sells against that average. Unrealized value needs a live price, which is the caller's
// job (fetch the market, multiply by current holdings); this endpoint reports cost basis
// and realized PnL only, since that is what the indexed history can prove.
app.get("/pnl/:wallet", (req, res) => {
  const w = req.params.wallet;
  const rows = db.prepare("SELECT * FROM amm_trades WHERE wallet = ? ORDER BY block_time ASC").all(w);
  const books = new Map(); // market -> { yesQty, yesCost, noQty, noCost, realized }
  for (const r of rows) {
    const b = books.get(r.market) ?? { yesQty: 0, yesCost: 0, noQty: 0, noCost: 0, realized: 0 };
    const spend = -r.collateral_delta; // positive collateral_delta on a sell, negative on a buy
    if (r.yes_delta > 0) { b.yesCost += spend > 0 ? spend : 0; b.yesQty += r.yes_delta; }
    else if (r.yes_delta < 0 && b.yesQty > 0) {
      const avg = b.yesCost / b.yesQty;
      const sold = -r.yes_delta;
      b.realized += r.collateral_delta - avg * sold;
      b.yesCost -= avg * sold; b.yesQty -= sold;
    }
    if (r.no_delta > 0) { b.noCost += spend > 0 ? spend : 0; b.noQty += r.no_delta; }
    else if (r.no_delta < 0 && b.noQty > 0) {
      const avg = b.noCost / b.noQty;
      const sold = -r.no_delta;
      b.realized += r.collateral_delta - avg * sold;
      b.noCost -= avg * sold; b.noQty -= sold;
    }
    books.set(r.market, b);
  }
  res.json({ wallet: w, markets: [...books.entries()].map(([market, b]) => ({
    market, yesQty: b.yesQty, yesAvgCost: b.yesQty > 0 ? b.yesCost / b.yesQty : 0,
    noQty: b.noQty, noAvgCost: b.noQty > 0 ? b.noCost / b.noQty : 0, realizedPnl: b.realized,
  })) });
});

// Trader leaderboard: every wallet ranked on what it actually did, computed from chain.
//
// This is the part a centralised venue cannot honestly offer. Copy trading exists on Polymarket
// because trades are public there, but the outcome those trades are scored against comes from a
// resolver you have to trust. Here both halves are verifiable: the trade is an on-chain
// transaction, and the result it settled against carries a Merkle proof anyone can re-check. A
// track record is therefore not a claim the platform makes about a trader, it is arithmetic over
// public data, and anyone can recompute it and get the same answer.
//
// Realized profit only. Open positions are excluded because valuing them needs a live price,
// which would make the table move for reasons the trader had nothing to do with.
app.get("/leaderboard", (req, res) => {
  const minTrades = Number(req.query.minTrades ?? 3);
  const rows = db.prepare("SELECT * FROM amm_trades ORDER BY block_time ASC").all();
  const byWallet = new Map();
  for (const r of rows) {
    const w = byWallet.get(r.wallet) ?? { trades: 0, volume: 0, realized: 0, wins: 0, closed: 0, books: new Map(), lastAt: 0 };
    w.trades++;
    w.volume += Math.abs(r.collateral_delta);
    w.lastAt = Math.max(w.lastAt, r.block_time ?? 0);
    const b = w.books.get(r.market) ?? { yesQty: 0, yesCost: 0, noQty: 0, noCost: 0 };
    const spend = -r.collateral_delta;
    for (const side of ["yes", "no"]) {
      const delta = side === "yes" ? r.yes_delta : r.no_delta;
      const qk = `${side}Qty`, ck = `${side}Cost`;
      if (delta > 0) { b[ck] += spend > 0 ? spend : 0; b[qk] += delta; }
      else if (delta < 0 && b[qk] > 0) {
        const avg = b[ck] / b[qk], sold = -delta;
        const gain = r.collateral_delta - avg * sold;
        w.realized += gain; w.closed++; if (gain > 0) w.wins++;
        b[ck] -= avg * sold; b[qk] -= sold;
      }
    }
    w.books.set(r.market, b);
    byWallet.set(r.wallet, w);
  }
  const traders = [...byWallet.entries()]
    .map(([wallet, w]) => ({
      wallet, trades: w.trades, volume: w.volume, realizedPnl: w.realized,
      closedPositions: w.closed, winRate: w.closed ? w.wins / w.closed : null,
      marketsTraded: w.books.size, lastTradeAt: w.lastAt || null,
    }))
    .filter((r) => r.trades >= minTrades)
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
  res.json({ traders, note: "realized profit only, computed from on-chain trades; open positions excluded" });
});

app.listen(PORT, () => {
  console.log(`fischio indexer on http://127.0.0.1:${PORT}`);
  console.log(`  REST: /health /history/:wallet /pnl/:wallet /leaderboard`);
  console.log(`  CLOB order intents index cleanly; exact fill history needs emit! events (not built yet, tracked separately)`);
  tick();
  setInterval(tick, POLL_MS);
});
