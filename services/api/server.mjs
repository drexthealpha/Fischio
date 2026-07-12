// fischio API + data layer: the infrastructure apps and traders build on, which we had
// none of. One service reads every fischio program on devnet and serves it three ways,
// mirroring Polymarket's split (discovery / trading data / real-time):
//   REST  GET /markets            unified discovery across AMM, order-book, and multi markets
//         GET /markets/:address    one market's detail
//         GET /books               order-book summary (best bid/ask, depth, last)
//         GET /books/:address      full order-book depth
//         GET /settlements         proof-settled results ledger
//         GET /trending            biggest movers and deepest books, computed from real
//                                  chain snapshots, no third-party news feed involved
//   WS    /ws                      streams market and book snapshots as chain state changes
//
// It holds no keys and signs nothing; it is a read layer over public chain state.
//
// /trending keeps an in-memory ring buffer of past snapshots to diff against, which
// resets on restart. That is a real limitation, not a placeholder: the fix is the
// persisted indexer, tracked separately, not a bigger buffer here.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { randomBytes, randomUUID } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

const here = dirname(fileURLToPath(import.meta.url));
const idl = (name) => JSON.parse(readFileSync(join(here, "idl", `${name}.json`), "utf8"));

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PORT = Number(process.env.PORT ?? 8790);
const POLL_MS = Number(process.env.POLL_MS ?? 12000); // gentle on public RPC; one read per tick
const connection = new Connection(RPC, "confirmed");

const readWallet = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
const provider = new anchor.AnchorProvider(connection, readWallet, { commitment: "confirmed" });
const marketProg = new anchor.Program(idl("fischio_market"), provider);
const exchangeProg = new anchor.Program(idl("fischio_exchange"), provider);
const multiProg = new anchor.Program(idl("fischio_multi"), provider);
const settleProg = new anchor.Program(idl("wc_settle"), provider);

const PRICE_ONE = 1_000_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seedPk = (pid, s, ...extra) =>
  PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], pid)[0];
const tokenBal = async (pk) => {
  try { return Number((await connection.getTokenAccountBalance(pk)).value.amount); } catch { return 0; }
};

// getProgramAccounts is the most throttled call on public devnet; retry with backoff so a
// free RPC survives. Set RPC to a paid endpoint (Helius, Triton) to remove the limit.
async function accountsOf(program, name, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { return await program.account[name].all(); }
    catch (e) {
      if (!String(e).includes("429")) throw e;
      await sleep(700 * (i + 1));
    }
  }
  throw new Error("rate limited by RPC after retries");
}

// ---- readers: each returns a normalized market/book object ----

async function readAmmMarkets() {
  const all = await accountsOf(marketProg, "market");
  const out = [];
  for (const { publicKey, account } of all) {
    const yesPool = seedPk(marketProg.programId, "yes_pool", publicKey.toBuffer());
    const noPool = seedPk(marketProg.programId, "no_pool", publicKey.toBuffer());
    const [y, n] = [await tokenBal(yesPool), await tokenBal(noPool)];
    const total = y + n;
    out.push({
      kind: "amm", address: publicKey.toBase58(), fixtureId: account.terms.fixtureId.toNumber(),
      state: Object.keys(account.state)[0], yesPrice: total ? n / total : 0.5, liquidity: total, feeBps: account.feeBps,
      // reserves and mints, so a client can quote and trade without doing getProgramAccounts
      // itself (which paid RPC free tiers like Alchemy block)
      yesReserve: y, noReserve: n, collateralMint: account.collateralMint.toBase58(),
      closeTs: account.closeTs.toNumber(),
      // terms, so a client can label the market (winner vs corners vs totals) without a scan
      terms: {
        statAKey: account.terms.statAKey, statBKey: account.terms.statBKey ?? null,
        op: account.terms.op ? Object.keys(account.terms.op)[0] : null,
        threshold: account.terms.predicate.threshold,
        comparison: account.terms.predicate.comparison ? Object.keys(account.terms.predicate.comparison)[0] : null,
      },
    });
  }
  return out;
}

async function readMultiMarkets() {
  const all = await accountsOf(multiProg, "multiMarket");
  const out = [];
  for (const { publicKey, account } of all) {
    const outcomes = [];
    for (let i = 0; i < account.numOutcomes; i++) {
      const yesMint = seedPk(multiProg.programId, "yes", publicKey.toBuffer(), Buffer.from([i]));
      const noMint = seedPk(multiProg.programId, "no", publicKey.toBuffer(), Buffer.from([i]));
      outcomes.push({ index: i, yesMint: yesMint.toBase58(), noMint: noMint.toBase58() });
    }
    out.push({
      kind: "multi", address: publicKey.toBase58(), fixtureId: account.fixtureId.toNumber(),
      numOutcomes: account.numOutcomes, state: Object.keys(account.state)[0],
      winningOutcome: account.winningOutcome === 255 ? null : account.winningOutcome, outcomes,
    });
  }
  return out;
}

async function readBooks(full = false) {
  const all = await accountsOf(exchangeProg, "book");
  const out = [];
  for (const { publicKey, account } of all) {
    const bids = [], asks = [];
    for (let i = 0; i < Number(account.bidCount); i++) {
      const o = account.bids[i];
      bids.push({ id: Number(o.id), price: Number(o.price) / PRICE_ONE, size: Number(o.size) });
    }
    for (let i = 0; i < Number(account.askCount); i++) {
      const o = account.asks[i];
      asks.push({ id: Number(o.id), price: Number(o.price) / PRICE_ONE, size: Number(o.size) });
    }
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
    const summary = {
      kind: "book", address: publicKey.toBase58(), market: account.market.toBase58(),
      bestBid, bestAsk, mid, bidDepth: bids.reduce((s, o) => s + o.size, 0), askDepth: asks.reduce((s, o) => s + o.size, 0),
    };
    out.push(full ? { ...summary, bids, asks } : summary);
  }
  return out;
}

async function readSettlements() {
  const all = await accountsOf(settleProg, "wager");
  return all
    .filter(({ account }) => "settled" in account.state)
    .map(({ publicKey, account }) => ({
      address: publicKey.toBase58(), fixtureId: account.terms.fixtureId.toNumber(),
      stakeLamports: account.stakeLamports.toNumber(),
    }));
}

// One chain read per interval, shared by every REST request and WebSocket client. This
// is why a public RPC survives the load: reads do not scale with traffic. Polymarket's
// discovery API caches the same way for heavy read traffic.
async function fullSnapshot() {
  // sequential, not concurrent: four getProgramAccounts at once trips the public RPC limit
  const amm = await readAmmMarkets();
  await sleep(300);
  const multi = await readMultiMarkets();
  await sleep(300);
  const books = await readBooks(true);
  await sleep(300);
  const settlements = await readSettlements();
  return { markets: [...amm, ...multi], books, settlements, ts: Date.now() };
}
let cache = null;
let cacheError = null;

// A bounded history of lightweight snapshots, kept only to diff "now" against "an hour
// ago" for /trending. HISTORY_MS of headroom past the window we actually query.
const HISTORY_WINDOW_MS = 60 * 60 * 1000;
const HISTORY_MS = HISTORY_WINDOW_MS + 5 * 60 * 1000;
const history = []; // [{ ts, markets: [{address, yesPrice}], books: [{address, depth}] }]

function recordHistory(snap) {
  history.push({
    ts: snap.ts,
    markets: snap.markets.filter((m) => m.kind === "amm").map((m) => ({ address: m.address, yesPrice: m.yesPrice })),
    books: snap.books.map((b) => ({ address: b.address, depth: (b.bidDepth ?? 0) + (b.askDepth ?? 0) })),
  });
  const cutoff = snap.ts - HISTORY_MS;
  while (history.length && history[0].ts < cutoff) history.shift();
}

// nearest recorded snapshot to `targetTs`, so a diff can compare against the closest
// real reading to "an hour ago" rather than assuming one exists exactly on the mark
function nearestHistory(targetTs) {
  let best = null, bestDiff = Infinity;
  for (const h of history) {
    const diff = Math.abs(h.ts - targetTs);
    if (diff < bestDiff) { best = h; bestDiff = diff; }
  }
  return best;
}

function computeTrending() {
  if (!cache) return { movers: [], hot: [], ts: null };
  const past = nearestHistory(cache.ts - HISTORY_WINDOW_MS);
  const priceThen = new Map((past?.markets ?? []).map((m) => [m.address, m.yesPrice]));
  const movers = cache.markets
    .filter((m) => m.kind === "amm" && priceThen.has(m.address))
    .map((m) => ({ address: m.address, fixtureId: m.fixtureId, yesPrice: m.yesPrice,
      delta: m.yesPrice - priceThen.get(m.address) }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);
  const hot = cache.books
    .map((b) => ({ address: b.address, market: b.market, depth: (b.bidDepth ?? 0) + (b.askDepth ?? 0), mid: b.mid }))
    .sort((a, b) => b.depth - a.depth)
    .slice(0, 10);
  return { movers, hot, windowMs: HISTORY_WINDOW_MS, historyDepth: history.length, ts: cache.ts };
}

// ---- REST (served from cache) ----

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use((_, res, next) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Access-Control-Allow-Headers", "content-type, authorization"); next(); });
app.options("*", (_, res) => res.sendStatus(204));

// ---- Sign-In With Solana: the wallet is the identity, proven by a signature, not a password.
// A one-time nonce is signed by the wallet; we verify the ed25519 signature and issue a
// bearer session token. No cookies, no secrets to steal: the user's key never leaves them.
const nonces = new Map();   // pubkey -> { nonce, exp }
const sessions = new Map(); // token   -> { pubkey, exp }
const NONCE_TTL = 5 * 60 * 1000;
const SESSION_TTL = 24 * 60 * 60 * 1000;

app.post("/auth/nonce", (req, res) => {
  const pubkey = String(req.body?.pubkey ?? "");
  try { new PublicKey(pubkey); } catch { return res.status(400).json({ error: "bad pubkey" }); }
  const nonce = `fischio wants you to sign in.\n\naddress: ${pubkey}\nnonce: ${randomBytes(16).toString("hex")}\nissued: ${new Date().toISOString()}`;
  nonces.set(pubkey, { nonce, exp: Date.now() + NONCE_TTL });
  res.json({ nonce });
});

app.post("/auth/verify", (req, res) => {
  const { pubkey, signature } = req.body ?? {};
  const rec = nonces.get(pubkey);
  if (!rec || rec.exp < Date.now()) return res.status(400).json({ error: "nonce expired; request a new one" });
  try {
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(rec.nonce),
      Uint8Array.from(Buffer.from(signature, "base64")),
      new PublicKey(pubkey).toBytes(),
    );
    if (!ok) return res.status(401).json({ error: "signature does not match" });
  } catch (e) { return res.status(400).json({ error: String(e.message ?? e) }); }
  nonces.delete(pubkey);
  const token = randomUUID();
  sessions.set(token, { pubkey, exp: Date.now() + SESSION_TTL });
  res.json({ token, pubkey, expiresIn: SESSION_TTL });
});

function authed(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) return null;
  return s.pubkey;
}
// Who am I: proves the backend knows the authenticated wallet. A protected endpoint that
// returns only for a validly signed-in session, so the frontend can show real session state.
app.get("/me", (req, res) => {
  const pubkey = authed(req);
  if (!pubkey) return res.status(401).json({ error: "not signed in" });
  res.json({ pubkey, signedIn: true });
});
const fromCache = (pick) => (req, res) => {
  if (!cache) return res.status(503).json({ error: cacheError ?? "warming up, try again in a few seconds" });
  try { res.json(pick(req)); } catch (e) { res.status(404).json({ error: String(e.message ?? e) }); }
};
const find = (list, key, val) => {
  const x = (cache[list] ?? []).find((i) => i[key] === val);
  if (!x) throw new Error(`${list.slice(0, -1)} not found`);
  return x;
};
// book summaries drop the per-order arrays; detail keeps them
const bookSummary = ({ bids, asks, ...rest }) => rest;

app.get("/health", (_, res) => res.json({ ok: true, rpc: RPC, cachedAt: cache?.ts ?? null, programs: {
  amm: marketProg.programId.toBase58(), exchange: exchangeProg.programId.toBase58(),
  multi: multiProg.programId.toBase58(), settle: settleProg.programId.toBase58(),
} }));
app.get("/markets", fromCache(() => ({ markets: cache.markets, ts: cache.ts })));
app.get("/markets/:address", fromCache((req) => find("markets", "address", req.params.address)));
app.get("/books", fromCache(() => ({ books: cache.books.map(bookSummary), ts: cache.ts })));
app.get("/books/:address", fromCache((req) => find("books", "address", req.params.address)));
app.get("/settlements", fromCache(() => ({ settlements: cache.settlements, ts: cache.ts })));
app.get("/trending", fromCache(() => computeTrending()));
// Price-over-time series for one AMM market, from the same snapshot history that powers
// trending. Real points sampled at POLL_MS; the chart fills in as the service runs. The
// current live price is always appended so a fresh market still draws a line.
app.get("/markets/:address/prices", fromCache((req) => {
  const addr = req.params.address;
  const series = history
    .map((h) => ({ ts: h.ts, price: h.markets.find((m) => m.address === addr)?.yesPrice }))
    .filter((p) => p.price != null);
  const live = cache.markets.find((m) => m.address === addr && m.kind === "amm");
  if (live) series.push({ ts: cache.ts, price: live.yesPrice });
  return { address: addr, series };
}));

// ---- WebSocket: broadcast each new snapshot (Polymarket-style real-time layer) ----

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
let lastMsg = null;
async function tick() {
  try {
    cache = await fullSnapshot();
    cacheError = null;
    recordHistory(cache);
    const msg = JSON.stringify({ channel: "snapshot", data: {
      markets: cache.markets, books: cache.books.map(bookSummary), ts: cache.ts,
    } });
    if (msg !== lastMsg) {
      lastMsg = msg;
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    }
  } catch (e) {
    cacheError = String(e.message ?? e);
    console.error("tick error:", cacheError);
  }
}
wss.on("connection", (ws) => { if (lastMsg) ws.send(lastMsg); });
setInterval(tick, POLL_MS);

server.listen(PORT, () => {
  console.log(`fischio API on http://127.0.0.1:${PORT}  (rpc ${RPC})`);
  console.log(`  REST: /health /markets /markets/:a /books /books/:a /settlements /trending`);
  console.log(`  WS:   ws://127.0.0.1:${PORT}/ws  (snapshot channel, ${POLL_MS}ms)`);
  tick();
});
