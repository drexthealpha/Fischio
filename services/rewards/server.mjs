// fischio liquidity rewards. An order book is only as good as its depth, and depth comes
// from paying makers to quote, not from the matching engine. Polymarket pays out millions a
// month for resting limit orders near the mid; this is the same idea, scored on-chain data.
//
// Every interval it reads each book, and for every resting order it awards points by size and
// tightness: an order right at the mid earns full weight, an order at the edge of the allowed
// spread earns almost none, past that it earns nothing. Points accrue per owner in a
// persisted ledger. A payout period converts each owner's share of total points into a share
// of that period's reward pool.
//
// It computes what each maker is owed; it does not move tokens. The reward token, the pool
// size, and the funding source are a tokenomics decision for the operator, not something this
// service should invent. REWARD_POOL_PER_DAY below is a labeled default, not a commitment.
//
//   REST  GET /rewards            leaderboard: points and pro-rata owed this period
//         GET /rewards/:wallet     one maker's points, share, and owed amount
//         GET /params              the scoring parameters in force
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT ?? 8794);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 30000);
const connection = new Connection(RPC, "confirmed");

const idl = JSON.parse(readFileSync(join(here, "..", "api", "idl", "fischio_exchange.json"), "utf8"));
const PID = new PublicKey(idl.address);
const readWallet = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, readWallet, { commitment: "confirmed" }));
const PRICE_ONE = 1_000_000, UNIT = 1_000_000;

// Scoring parameters. MAX_SPREAD is how far from the mid an order still earns; the weight
// falls off quadratically to zero at that edge, so tight quotes earn far more than wide ones.
const MAX_SPREAD = Number(process.env.MAX_SPREAD ?? 0.10); // in price units (0..1)
const MIN_SIZE = Number(process.env.MIN_SIZE ?? 1); // shares; dust orders earn nothing
const REWARD_POOL_PER_DAY = Number(process.env.REWARD_POOL_PER_DAY ?? 1000); // DEFAULT, not a commitment
const PERIOD_MS = 24 * 60 * 60 * 1000;

const db = new DatabaseSync(join(here, "rewards.db"));
db.exec(`CREATE TABLE IF NOT EXISTS points (
  owner TEXT, period INTEGER, score REAL, PRIMARY KEY (owner, period)
);`);
const addPoints = db.prepare(`INSERT INTO points (owner, period, score) VALUES (?, ?, ?)
  ON CONFLICT(owner, period) DO UPDATE SET score = score + excluded.score`);
const periodOf = (ts) => Math.floor(ts / PERIOD_MS);

// weight one resting order by tightness to mid and size; zero past MAX_SPREAD or under MIN_SIZE
function orderWeight(price, size, mid) {
  const shares = size / UNIT;
  if (shares < MIN_SIZE || mid == null) return 0;
  const dist = Math.abs(price / PRICE_ONE - mid);
  if (dist >= MAX_SPREAD) return 0;
  const tightness = 1 - dist / MAX_SPREAD; // 1 at mid, 0 at the edge
  return shares * tightness * tightness; // quadratic falloff rewards genuinely tight quotes
}

async function sample() {
  const books = await program.account.book.all();
  const now = Date.now();
  const period = periodOf(now);
  const intervalFrac = SAMPLE_MS / PERIOD_MS; // this sample represents this slice of the period
  const owners = new Map(); // owner -> weight accumulated this sample
  for (const { account } of books) {
    const bids = [], asks = [];
    for (let i = 0; i < Number(account.bidCount); i++) bids.push(account.bids[i]);
    for (let i = 0; i < Number(account.askCount); i++) asks.push(account.asks[i]);
    const bestBid = bids[0] ? Number(bids[0].price) / PRICE_ONE : null;
    const bestAsk = asks[0] ? Number(asks[0].price) / PRICE_ONE : null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    for (const o of [...bids, ...asks]) {
      const w = orderWeight(Number(o.price), Number(o.size), mid);
      if (w <= 0) continue;
      const owner = o.owner.toBase58();
      owners.set(owner, (owners.get(owner) ?? 0) + w);
    }
  }
  for (const [owner, weight] of owners) addPoints.run(owner, period, weight * intervalFrac);
  if (owners.size) console.log(`${new Date(now).toISOString()}  scored ${owners.size} maker(s)`);
}

const currentPeriod = () => periodOf(Date.now());
function leaderboard(period) {
  const rows = db.prepare("SELECT owner, score FROM points WHERE period = ? ORDER BY score DESC").all(period);
  const total = rows.reduce((s, r) => s + r.score, 0);
  return rows.map((r) => ({
    owner: r.owner, points: r.score,
    share: total > 0 ? r.score / total : 0,
    owed: total > 0 ? (r.score / total) * REWARD_POOL_PER_DAY : 0,
  }));
}

const app = express();
app.use((_, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); });
app.get("/health", (_, res) => res.json({ ok: true, rpc: RPC, period: currentPeriod() }));
app.get("/params", (_, res) => res.json({ maxSpread: MAX_SPREAD, minSize: MIN_SIZE, rewardPoolPerDay: REWARD_POOL_PER_DAY, sampleMs: SAMPLE_MS, note: "rewardPoolPerDay is a default, not a committed emission; set it with tokenomics" }));
app.get("/rewards", (_, res) => res.json({ period: currentPeriod(), pool: REWARD_POOL_PER_DAY, makers: leaderboard(currentPeriod()) }));
app.get("/rewards/:wallet", (req, res) => {
  const board = leaderboard(currentPeriod());
  const me = board.find((m) => m.owner === req.params.wallet) ?? { owner: req.params.wallet, points: 0, share: 0, owed: 0 };
  res.json({ period: currentPeriod(), pool: REWARD_POOL_PER_DAY, ...me });
});

app.listen(PORT, () => {
  console.log(`fischio liquidity rewards on http://127.0.0.1:${PORT}`);
  console.log(`  scoring: maxSpread ${MAX_SPREAD}, minSize ${MIN_SIZE}, pool/day ${REWARD_POOL_PER_DAY} (default)`);
  console.log(`  REST: /health /params /rewards /rewards/:wallet`);
  sample();
  setInterval(sample, SAMPLE_MS);
});
