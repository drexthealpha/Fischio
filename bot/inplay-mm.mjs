// fischio in-play market maker: an autonomous agent that reads live TxLINE match data and
// quotes two-sided prices on fischio's on-chain order book, re-quoting as the match moves.
// Unlike the closed, centralised Betfair bots, every quote it makes is an on-chain limit
// order anyone can see, take, or verify.
//
// The strategy is transparent and deterministic. From the live score and clock it computes a
// fair probability that the home side wins in 90 minutes plus extra time (a Skellam / Poisson
// diffusion of the remaining goal difference), then posts a bid just below and an ask just
// above that fair value. When a goal lands or the clock ticks, the fair value moves and the
// bot cancels and re-quotes. No human input after launch.
//
//   node bot/inplay-mm.mjs --fixture 18218149            # real TxLINE scores feed
//   node bot/inplay-mm.mjs --sim                          # simulated in-play match (offline)
//   flags: --spread 0.03  --size 100  --interval 8000  --rpc <url>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(`--${k}`);

const RPC = arg("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
const FIXTURE = Number(arg("fixture", 0));
const SIM = has("sim") || !FIXTURE;
const SPREAD = Number(arg("spread", 0.03));   // half-spread around fair, in probability
const SIZE = Number(arg("size", 100));         // shares quoted each side
const INTERVAL = Number(arg("interval", 8000));
const U = 1_000_000, PRICE_ONE = 1_000_000;

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(root, "day1/devnet-wallet.json"), "utf8"))));
const idl = JSON.parse(readFileSync(join(root, "target/idl/fischio_exchange.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const seed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], PID)[0];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// standard normal CDF (Abramowitz-Stegun), for the diffusion model
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

// Fair probability that home wins in 90'+ET, from the live score and clock. Models the
// remaining goal difference as a diffusion: variance grows with the minutes left, so a lead
// is worth more late than early. A draw resolves to the taker (home does NOT win), so at full
// time the fair value collapses to 1 if home leads, else ~0.
function fairHomeWin(homeGoals, awayGoals, clockSeconds) {
  const gd = homeGoals - awayGoals;
  const t = clamp((clockSeconds ?? 0) / 60, 0, 90);
  const rem = Math.max(0, 90 - t);
  if (rem <= 0.5) return gd > 0 ? 0.98 : 0.02;   // effectively decided
  const lambda = 0.016;                            // goals per minute per team, ~2.9/match
  const sd = Math.sqrt(2 * lambda * rem);          // sd of remaining goal difference
  return clamp(normCdf(gd / sd), 0.02, 0.98);      // P(final gd > 0)
}

// ---- the live feed: real TxLINE scores, or a simulated in-play match ----
let creds = null;
try { creds = JSON.parse(readFileSync(join(root, "day1/credentials.json"), "utf8")); } catch { /* sim only */ }

async function realState() {
  const r = await fetch(`https://txline-dev.txodds.com/api/scores/snapshot/${FIXTURE}?asOf=${Date.now()}`,
    { headers: { Authorization: `Bearer ${creds.jwt}`, "X-Api-Token": creds.apiToken } }).catch(() => null);
  if (!r?.ok) return null;
  const recs = await r.json();
  if (!Array.isArray(recs) || recs.length === 0) return null;
  const rev = [...recs].reverse();
  const stats = rev.find((x) => x.Stats && x.Stats["1"] != null);
  const clock = rev.find((x) => x.Clock?.Seconds != null);
  const status = rev.find((x) => x.StatusId != null);
  return {
    home: stats ? Number(stats.Stats["1"] ?? 0) : 0,
    away: stats ? Number(stats.Stats["2"] ?? 0) : 0,
    clock: clock?.Clock?.Seconds ?? 0,
    statusId: status?.StatusId ?? null,
  };
}

// a plausible in-play match for offline demos: clock advances, goals arrive at set minutes
let simStart = Date.now(); // reset after book setup so the match starts when quoting starts
const SIM_RATE = Number(arg("simrate", 1.5)); // sim-minutes per real second (90'/60s by default)
const simGoals = [{ m: 18, side: "home" }, { m: 34, side: "away" }, { m: 61, side: "home" }, { m: 79, side: "home" }];
function simState() {
  const mins = ((Date.now() - simStart) / 1000) * SIM_RATE;
  let home = 0, away = 0;
  for (const g of simGoals) if (mins >= g.m) (g.side === "home" ? home++ : away++);
  return { home, away, clock: Math.min(90, mins) * 60, statusId: mins >= 90 ? 5 : 2 };
}

// ---- fischio order book: set up a book the bot funds and quotes on ----
async function airdropIfNeeded() {
  const bal = await connection.getBalance(payer.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) log("warning: low SOL for fees");
}

async function setupBook() {
  log("minting demo YES token + USDC, opening a book…");
  const base = await createMint(connection, payer, payer.publicKey, null, 6); // YES (home-win) token
  const quote = await createMint(connection, payer, payer.publicKey, null, 6); // USDC
  const market = Keypair.generate().publicKey;
  const book = seed("book", market);
  await program.methods.createBook(market).accountsPartial({
    creator: payer.publicKey, book, baseMint: base, quoteMint: quote,
    baseVault: seed("base_vault", book), quoteVault: seed("quote_vault", book),
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  }).rpc();
  await program.methods.initEventHeap().accountsPartial({
    creator: payer.publicKey, book, eventHeap: seed("events", book), systemProgram: SystemProgram.programId,
  }).rpc();

  const oo = PublicKey.findProgramAddressSync([Buffer.from("open_orders"), book.toBuffer(), payer.publicKey.toBuffer()], PID)[0];
  await program.methods.initOpenOrders().accountsPartial({
    payer: payer.publicKey, owner: payer.publicKey, book, openOrders: oo, systemProgram: SystemProgram.programId,
  }).rpc();

  // fund the maker: mint itself base (to sell) and quote (to buy), then deposit into the book
  const baseAta = (await getOrCreateAssociatedTokenAccount(connection, payer, base, payer.publicKey)).address;
  const quoteAta = (await getOrCreateAssociatedTokenAccount(connection, payer, quote, payer.publicKey)).address;
  await mintTo(connection, payer, base, baseAta, payer, 100_000 * U);
  await mintTo(connection, payer, quote, quoteAta, payer, 100_000 * U);
  await program.methods.deposit(new anchor.BN(100_000 * U), new anchor.BN(100_000 * U)).accountsPartial({
    owner: payer.publicKey, book, openOrders: oo, baseVault: seed("base_vault", book), quoteVault: seed("quote_vault", book),
    userBase: baseAta, userQuote: quoteAta, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  log("book ready:", book.toBase58());
  return { book, oo };
}

async function myRestingOrders(book, oo) {
  const b = await program.account.book.fetch(book);
  const mine = [];
  for (let i = 0; i < Number(b.bidCount); i++) if (b.bids[i].owner.equals(oo)) mine.push({ side: "bid", id: Number(b.bids[i].id) });
  for (let i = 0; i < Number(b.askCount); i++) if (b.asks[i].owner.equals(oo)) mine.push({ side: "ask", id: Number(b.asks[i].id) });
  return mine;
}

async function requote(book, oo, fair) {
  // pull existing quotes, then post fresh ones around the new fair value
  for (const o of await myRestingOrders(book, oo)) {
    await program.methods.cancelOrder(o.side === "bid" ? { bid: {} } : { ask: {} }, new anchor.BN(o.id))
      .accountsPartial({ owner: payer.publicKey, book, openOrders: oo }).rpc().catch(() => {});
  }
  const bid = clamp(fair - SPREAD, 0.01, 0.99);
  const ask = clamp(fair + SPREAD, 0.01, 0.99);
  const eventHeap = seed("events", book);
  await program.methods.placeOrder({ bid: {} }, new anchor.BN(Math.round(bid * PRICE_ONE)), new anchor.BN(SIZE * U))
    .accountsPartial({ owner: payer.publicKey, book, openOrders: oo, eventHeap }).rpc();
  await program.methods.placeOrder({ ask: {} }, new anchor.BN(Math.round(ask * PRICE_ONE)), new anchor.BN(SIZE * U))
    .accountsPartial({ owner: payer.publicKey, book, openOrders: oo, eventHeap }).rpc();
  return { bid, ask };
}

// ---- run ----
await airdropIfNeeded();
const { book, oo } = await setupBook();
simStart = Date.now(); // start the simulated match now that the book is ready
log(SIM ? "mode: SIMULATED in-play match (kickoff)" : `mode: LIVE TxLINE fixture ${FIXTURE}`);
log(`quoting ${SIZE} shares each side at +/- ${SPREAD} around fair, every ${INTERVAL}ms`);

let lastFair = null;
let running = false; // a slow tick (RPC retries) must finish before the next starts, or two
                     // requotes race and the bot crosses its own orders
async function tick() {
  if (running) { log("previous tick still running, skipping"); return; }
  running = true;
  try {
    const st = SIM ? simState() : await realState();
    if (!st) { log("no feed data yet, holding"); return; }
    const fair = fairHomeWin(st.home, st.away, st.clock);
    const mins = Math.floor((st.clock ?? 0) / 60);
    if (lastFair == null || Math.abs(fair - lastFair) > 0.005) {
      const { bid, ask } = await requote(book, oo, fair);
      log(`${mins}'  score ${st.home}-${st.away}  fair ${(fair * 100).toFixed(0)}%  ->  quote bid ${bid.toFixed(2)} / ask ${ask.toFixed(2)}`);
      lastFair = fair;
    } else {
      log(`${mins}'  score ${st.home}-${st.away}  fair ${(fair * 100).toFixed(0)}%  (unchanged, holding quotes)`);
    }
    if (st.statusId === 5 || st.statusId === 10 || st.statusId === 13) {
      log("full time reached; final fair", (fair * 100).toFixed(0) + "%. Stopping.");
      process.exit(0);
    }
  } catch (e) { log("tick error:", String(e.message ?? e)); }
  finally { running = false; }
}
await tick();
setInterval(tick, INTERVAL);
