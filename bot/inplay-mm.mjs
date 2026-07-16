// fischio in-play market maker: an autonomous agent that reads live TxLINE match data and
// quotes two-sided prices on fischio's on-chain order book, re-quoting as the match moves.
// Unlike the closed, centralised Betfair bots, every quote it makes is an on-chain limit
// order anyone can see, take, or verify.
//
// Fair value is not modelled. It is the demargined 1X2 line published by TxLINE: the home
// probability of that line is the fair price of a home-win share, because a draw pays the
// taker. The bot reads the live odds endpoint, takes the home probability, and posts a bid
// just below and an ask just above it. When the line moves, the bot cancels and re-quotes.
// If the odds feed has no line yet, it holds and quotes nothing. No model, no simulation:
// the only inputs are TxLINE's own scores and odds endpoints.
//
//   node bot/inplay-mm.mjs --fixture 18218149            # a real TxLINE fixture (required)
//   flags: --spread 0.03  --size 100  --interval 8000  --rpc <url>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { impliedResult } from "../lib/txline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };

const RPC = arg("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
const FIXTURE = Number(arg("fixture", 0));
if (!FIXTURE) { console.error("usage: node bot/inplay-mm.mjs --fixture <id>  (a real TxLINE fixture id is required; there is no simulated mode)"); process.exit(1); }
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

// ---- the live feed: real TxLINE scores and the real demargined odds line ----
const creds = JSON.parse(readFileSync(join(root, "day1/credentials.json"), "utf8"));
const headers = { Authorization: `Bearer ${creds.jwt}`, "X-Api-Token": creds.apiToken };
const TXLINE = "https://txline-dev.txodds.com";

async function realState() {
  const r = await fetch(`${TXLINE}/api/scores/snapshot/${FIXTURE}?asOf=${Date.now()}`, { headers }).catch(() => null);
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

// the demargined 1X2 line from the odds endpoint; the 1X2 row is intermittent in snapshots,
// so hold the last good line rather than drop a quote when a poll misses it
let lastLine = null;
async function realLine() {
  const r = await fetch(`${TXLINE}/api/odds/snapshot/${FIXTURE}`, { headers }).catch(() => null);
  if (!r?.ok) return lastLine;
  const rows = await r.json().catch(() => null);
  const line = Array.isArray(rows) ? impliedResult(rows) : null;
  if (line) lastLine = line;
  return lastLine;
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
log(`mode: LIVE TxLINE fixture ${FIXTURE}`);
log(`quoting ${SIZE} shares each side at +/- ${SPREAD} around the demargined line, every ${INTERVAL}ms`);

let lastFair = null;
let running = false; // a slow tick (RPC retries) must finish before the next starts, or two
                     // requotes race and the bot crosses its own orders
async function tick() {
  if (running) { log("previous tick still running, skipping"); return; }
  running = true;
  try {
    const [st, line] = await Promise.all([realState(), realLine()]);
    if (!line) { log("no demargined line from the odds feed yet, holding quotes"); return; }
    const fair = clamp(line.home, 0.01, 0.99); // P(home wins); a draw pays the taker
    const mins = Math.floor((st?.clock ?? 0) / 60);
    const score = st ? `${st.home}-${st.away}` : "?";
    if (lastFair == null || Math.abs(fair - lastFair) > 0.005) {
      const { bid, ask } = await requote(book, oo, fair);
      log(`${mins}'  score ${score}  line home ${(fair * 100).toFixed(0)}%  ->  quote bid ${bid.toFixed(2)} / ask ${ask.toFixed(2)}`);
      lastFair = fair;
    } else {
      log(`${mins}'  score ${score}  line home ${(fair * 100).toFixed(0)}%  (unchanged, holding quotes)`);
    }
    if (st && (st.statusId === 5 || st.statusId === 10 || st.statusId === 13)) {
      log("full time reached; final line home", (fair * 100).toFixed(0) + "%. Stopping.");
      process.exit(0);
    }
  } catch (e) { log("tick error:", String(e.message ?? e)); }
  finally { running = false; }
}
await tick();
setInterval(tick, INTERVAL);
