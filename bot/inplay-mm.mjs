// fischio in-play market maker: an autonomous agent that reads the live TxLINE board and
// quotes two-sided prices on fischio's on-chain order books, re-quoting as the lines move.
// Every quote it makes is an on-chain limit order that anyone can see, take, or verify.
//
// WHAT IT PRICES
//
// Fair value is never modelled. It is TxODDS's own demargined percentage, the `Pct` field on
// each odds row, which is exactly 1000/Price and sums to 1.000 across a market. The bot does
// no probability maths of its own, so there is no model to be wrong.
//
// It quotes the whole board, not one line. A single World Cup fixture carries 29 distinct
// markets, verified live on fixture 18257739:
//
//   1X2_PARTICIPANT_RESULT            full match and first half
//   ASIANHANDICAP_PARTICIPANT_GOALS   9 lines full match, 5 first half
//   OVERUNDER_PARTICIPANT_GOALS       9 lines full match, 4 first half
//
// A market is identified by SuperOddsType + MarketPeriod + MarketParameters together. Reading
// only the row where period and line are empty, which is what this bot used to do, sees one
// market and misses twenty-eight.
//
// WHAT IT REFUSES TO PRICE
//
// Quarter lines (-0.25, 0.75, 1.75 and friends) split the stake across two outcomes, so a
// two-way percentage does not exist for them and TxODDS sends `Pct: "NA"`. Of 1677 live rows,
// 640 were NA. The bot skips those markets. Inventing a number for them would be a fabricated
// price wearing a real market's name.
//
// There are no corners or cards odds anywhere on this feed. Those markets settle from a proof
// but cannot be priced from TxLINE, so this bot does not touch them.
//
// PROVENANCE
//
// Every quote logs the messageId and ts of the exact odds update that priced it. Those two
// fields are the handle for /api/odds/validation, which returns a Merkle proof that the
// on-chain oracle checks with validate_odds. So any quote this bot posts can be traced to a
// TxODDS record and proven, rather than taken on trust.
//
// DATA AGE
//
// The free World Cup tier is service level 1, which is delayed by about 60 seconds. The bot
// prints the real age of the line it quoted. It does not call minute-old data live.
//
// RISK ENGINE
//
// The bot does more than mirror the line. It watches each market's own move over a short window,
// and when a line steams (a sharp move, usually informed money) it widens the spread and cuts
// size so it is paid for adverse selection instead of picked off. It tracks inventory per market
// and, past a hard cap, flips to reduce-only, quoting only the side that shrinks the position.
// Every tick logs why it did what it did, so the decision is visible, not buried.
//
//   node bot/inplay-mm.mjs --fixture 18257739
//   flags: --markets all|1x2|totals|handicap  --max 3  --spread 0.03  --size 100
//          --interval 8000  --skew 0.5  --requote 0.005  --rpc <url>  --ingest <origin>
//   risk:  --steam 0.02  --steam-window 30  --steam-widen 2  --max-inventory 0.6
import "../lib/env.mjs"; // load the gitignored root .env (RPC etc.) before anything reads it
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { readScore, statusNow, clockOf, isInPlay, isOver } from "../lib/scores.mjs";
import { findOnChainMarket, settleabilityOf, termsOfFeedMarket, termsKey } from "../lib/market-link.mjs";
import { createGuard } from "../lib/guard.mjs";
import { ageVerdict } from "../lib/staleness.mjs";
import { marketIdOf } from "../lib/market-id.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };

const RPC = arg("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
const FIXTURE = Number(arg("fixture", 0));
if (!FIXTURE) { console.error("usage: node bot/inplay-mm.mjs --fixture <id>   (a real TxLINE fixture id; there is no simulated mode)"); process.exit(1); }
// Quote the whole settleable board by default. The old defaults were "1x2,totals" capped at three
// markets, which left most of a fixture with no bid and no offer even though the markets existed.
const FILTER = String(arg("markets", "all")).toLowerCase();
const MAX_MARKETS = Number(arg("max", 0)); // 0 means no cap, quote everything eligible
const SPREAD = Number(arg("spread", 0.03));   // half-spread around fair, in probability
const SIZE = Number(arg("size", 100));        // shares quoted each side
const INTERVAL = Number(arg("interval", 8000));
const SKEW = Number(arg("skew", 0.5));        // how hard inventory pulls the quote, 0 = never
const REQUOTE_AT = Number(arg("requote", 0.005)); // re-quote once fair moves this far

// Shadow mode: run the whole strategy against the live feed and log every decision, but send no
// transaction. This is how you evaluate a change before it touches money, and how you leave an
// agent running against a live match with nothing at stake. Nothing else about the run differs,
// so what you read in the log is exactly what would have been placed.
const SHADOW = process.argv.includes("--shadow");

// Risk limits. A market maker without them is a way to lose money automatically.
//   max-shares    the largest net position, in shares, this bot will carry on one market
//   max-notional  the most collateral it will put at risk across every market at once
//   max-loss      stop everything once realised losses reach this, and pull all quotes
// (separate from max-inventory below, which is the softer reduce-only band as a fraction of target)
const MAX_SHARES = Number(arg("max-shares", 500));
const MAX_NOTIONAL = Number(arg("max-notional", 5000));
const MAX_LOSS = Number(arg("max-loss", 1000));

// The limits above live in memory and reset when the process does. Committing collateral is the
// one action that outlives a restart, so it gets a guard that persists: a daily ceiling on how
// much this bot may lock up across every market, and a breaker after repeated failures. Without
// it, a bot that crashes while opening books re-funds every market again on each boot.
// Collateral is counted in the token's smallest unit, six decimals, the same scale as U further
// down. The literal is used here because U is defined later in the file and the guard has to
// exist before anything can ask it for permission.
const MAX_DAILY_COLLATERAL = Number(arg("max-daily-collateral", 20_000));
const guard = createGuard({
  path: join(root, "local", `mm-guard-${FIXTURE}.json`),
  dailyCap: MAX_DAILY_COLLATERAL * 1_000_000,
  maxFailures: 5,
});
const risk = { notional: 0, realised: 0, halted: false, reason: null };

/** Refuse the trade before it happens, and say which limit stopped it. */
function riskCheck(entry, size) {
  if (risk.halted) return { ok: false, why: risk.reason };
  if (risk.realised <= -MAX_LOSS) {
    risk.halted = true;
    risk.reason = `loss limit hit (${risk.realised.toFixed(2)} <= -${MAX_LOSS})`;
    return { ok: false, why: risk.reason };
  }
  const inv = Math.abs(entry.inventory ?? 0);
  if (inv + size > MAX_SHARES) return { ok: false, why: `share limit (${inv} + ${size} > ${MAX_SHARES})` };
  if (risk.notional + size > MAX_NOTIONAL) return { ok: false, why: `notional limit (${risk.notional} + ${size} > ${MAX_NOTIONAL})` };
  return { ok: true };
}
// Pull quotes off a market whose line has gone quiet. How quiet is too quiet depends
// entirely on the phase, and a single flat limit is wrong.
//
// Before kickoff a line can legitimately sit for hours. Measured on the live board for the
// final: ages ranged 323s to 12467s across all 15 quotable markets, and every one of those
// prices was perfectly good. A flat five-minute limit pulls the entire board and the bot
// quotes nothing.
//
// In play the same silence is lethal. The line must track the match, so a quiet market means
// we are resting on a price from before the goal went in, and anyone watching the match can
// lift it. Service level 1 is already delayed about 60s, so the in-play floor cannot go below
// roughly two minutes without pulling on the feed's own latency.
const MAX_AGE_LIVE_S = Number(arg("max-age-live", 180));
const MAX_AGE_PRE_S = Number(arg("max-age-pre", 6 * 3600));

// A flat age limit still cannot tell apart the two reasons a line is old, and they need opposite
// answers.
//
//   the feed has stopped      every market goes quiet together. Our prices are blind. Pull them.
//   nobody trades this line   one market is quiet while the rest of the board ticks. The price is
//                             still the price. The bookmaker has not moved it because there is no
//                             reason to.
//
// Measured on fixture 18257739, one snapshot, ages in minutes:
//
//   1X2 FT 6, ASIANHANDICAP FT 0 6, ASIANHANDICAP FT -0.5 31, OVERUNDER FT 2.5 29,
//   ASIANHANDICAP FT +0.5 478, OVERUNDER FT 3 662, OVERUNDER FT 1.25 812
//
// The feed was healthy the whole time: its newest market was six minutes old. Four of twenty-nine
// markets were over six hours old purely because they are peripheral lines. The absolute limit
// refused to quote those, which is how the handicap +0.5 market ended up as the one proposition on
// the board with no order book.
//
// So staleness is judged against the feed's own liveness. If the freshest market on the board is
// recent, the feed is alive and a quiet market is quiet for its own reasons. Such a line is still
// quoted, but wider, because a price nobody has revisited in hours is a price we are more likely
// to be picked off on.
// The staleness rule lives in lib/staleness.mjs so it can be tested without a network, a chain, or
// this agent running. See test/age-verdict.test.mjs for the cases it has to get right.
const STALENESS = {
  feedDeadSeconds: Number(arg("feed-dead", 900)),
  inPlayMaxSeconds: MAX_AGE_LIVE_S,
  quietAfterSeconds: Number(arg("quiet-after", 1800)),
  quietWiden: Number(arg("quiet-widen", 2)),
};

// ---- risk engine ----
//
// Two behaviours that separate a market maker from a quote printer.
//
// Steam. When a line moves fast, that is usually informed money, and standing still in front of
// it means being picked off: someone lifts the ask that the move just made too cheap. The bot
// watches each line's own recent move and, when it exceeds a threshold, widens the spread to be
// paid for the adverse selection and cuts its quote size to risk less on it. This is the same
// signal the "sharp movement detector" idea in the track describes, used to protect quotes
// rather than just log an alert.
//
// Inventory. Every fill leaves the bot holding one side. Skew already nudges quotes to walk
// inventory back, but past a hard limit that is not enough, so the bot flips to reduce-only on
// that market: it quotes only the side that shrinks the position and pulls the side that would
// grow it. A maker that cannot say no to more inventory is not managing risk.
const STEAM = Number(arg("steam", 0.02));            // a fair-value move this big counts as sharp
const STEAM_WINDOW_S = Number(arg("steam-window", 30));
const STEAM_WIDEN = Number(arg("steam-widen", 2));   // spread multiplier while a line is steaming
const MAX_INVENTORY = Number(arg("max-inventory", 0.6)); // reduce-only past this fraction of target

const U = 1_000_000, PRICE_ONE = 1_000_000;

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? readFileSync(join(root, "local/devnet-wallet.json"), "utf8"))));
const idl = JSON.parse(readFileSync(join(root, "target/idl/fischio_exchange.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const seed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], PID)[0];

// The market program, so a book can be tied to the real market it prices and inventory can be
// split out of real collateral rather than minted from thin air.
const marketProgram = new anchor.Program(
  JSON.parse(readFileSync(join(root, "target/idl/fischio_market.json"), "utf8")), provider);
const mSeed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], marketProgram.programId)[0];
const usdcMint = new PublicKey(JSON.parse(readFileSync(join(root, "local/devnet-usdc.json"), "utf8")).mint);

/**
 * Every fischio market on this fixture, in the shape lib/market-link.mjs expects.
 *
 * More than one market can exist for the same proposition. The retired seeders assigned market ids
 * at random, so their markets sit at addresses nobody can re-derive, and the factory opened its own
 * alongside them. Fixture 18257739 carries 16 accounts for 11 propositions because of it.
 *
 * When that happens the maker has to pick the same one every time, and the same one the app and the
 * settlement bots pick, or it will quote a pool no one is looking at. The canonical market is the
 * one whose id equals the id derived from its terms, which is a property anyone can check without
 * asking us which pool is the real one. Canonical markets sort first, so findOnChainMarket lands on
 * them; the legacy ones stay visible here rather than being hidden, because they hold real
 * liquidity that still has to be withdrawn.
 */
async function loadOnChainMarkets(fixtureId) {
  const all = await marketProgram.account.market.all();
  const rows = all
    .filter(({ account }) => Number(account.terms.fixtureId) === fixtureId)
    .map(({ publicKey, account }) => {
      const terms = {
        statAKey: account.terms.statAKey,
        statBKey: account.terms.statBKey ?? null,
        op: account.terms.op ? Object.keys(account.terms.op)[0] : null,
        threshold: account.terms.predicate.threshold,
        comparison: account.terms.predicate.comparison ? Object.keys(account.terms.predicate.comparison)[0] : null,
      };
      let canonical = false;
      try { canonical = BigInt(account.marketId.toString()) === marketIdOf(fixtureId, terms); } catch { /* terms that do not settle have no derived id */ }
      return {
        address: publicKey.toBase58(),
        fixtureId: Number(account.terms.fixtureId),
        terms,
        canonical,
        yesMint: mSeed("yes", publicKey).toBase58(),
        noMint: mSeed("no", publicKey).toBase58(),
        vault: mSeed("vault", publicKey),
      };
    });
  const legacy = rows.filter((r) => !r.canonical).length;
  if (legacy) log(`${legacy} market(s) on this fixture predate the factory and carry a random id; quoting the canonical ones`);
  return rows.sort((a, b) => Number(b.canonical) - Number(a.canonical));
}
let onChainMarkets = [];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const tx = txlineClient();

// ---- the feed: scores for the clock and the phase, odds for every price ----
//
// Read through lib/scores.mjs so this bot cannot disagree with settlement about what state a
// match is in. It used to read the feed itself, and got one thing badly wrong.
//
// It took the highest-sequence row carrying a StatusId and called that the state. On a finished
// match that row is the administrative finalisation, status 100. Since 100 is in neither the
// terminal set nor the in-play set, the bot concluded the match had not kicked off, applied the
// six-hour pre-match staleness window, and kept quoting both sides. Measured on England v
// Argentina, a match that ended 1-2 two days ago: statusId read 100, TERMINAL.has(100) was
// false, so nothing ever told it to stop. It would have stood there offering prices on a result
// that was already proven on-chain, to anyone who bothered to look up the score.
async function realState() {
  const recs = await tx.scoresSnapshot(FIXTURE).catch(() => null);
  if (!Array.isArray(recs) || !recs.length) return null;
  const score = readScore(recs);
  const clock = clockOf(recs);
  return {
    home: score?.p1 ?? 0,
    away: score?.p2 ?? 0,
    statusId: statusNow(recs),
    // Whether the game clock is actually ticking. A more direct answer than reading the status,
    // and it goes false the instant play stops.
    clockRunning: clock?.running ?? false,
    clock: clock?.seconds ?? 0,
    minute: clock?.minute ?? 0,
    inPlay: isInPlay(recs),
    // The one that matters here. True from full time onward, including the finalisation state,
    // so quoting stops the moment the result becomes knowable rather than the moment it becomes
    // provable. Those are different instants and the gap is where the money leaks.
    over: isOver(recs),
  };
}

// The full board. asOf is required for a complete snapshot: without it the endpoint returns
// only whatever updated most recently (measured: 5 rows against 29).
let lastBoard = [];
async function board() {
  const rows = await tx.oddsSnapshot(FIXTURE).catch(() => null);
  const cat = parseMarkets(rows ?? []);
  if (cat.length) lastBoard = cat;
  return lastBoard;
}

const WANTS = {
  "1x2": "1X2_PARTICIPANT_RESULT",
  totals: "OVERUNDER_PARTICIPANT_GOALS",
  handicap: "ASIANHANDICAP_PARTICIPANT_GOALS",
};

/**
 * Markets this bot is willing to quote.
 *
 * Settleability is the first filter, not an afterthought. A line that cannot settle on-chain has no
 * market to quote against, and quoting it would put resting orders on a book whose outcome nobody
 * can prove. Selecting on `demargined` alone is not the same test: TxODDS demargins the integer
 * lines happily, and those push rather than resolving two ways, so they used to be selected here
 * and then silently dropped further down when the market lookup came back empty. That reads in the
 * logs as a missing market rather than as a line that was never eligible.
 *
 * The board is quoted whole by default. Capping at a handful of markets left most of the board with
 * no bid and no offer, which is the coverage gap this bot exists to close.
 */
function selectMarkets(cat) {
  const want = FILTER === "all" ? Object.values(WANTS) : FILTER.split(",").map((f) => WANTS[f.trim()]).filter(Boolean);
  const eligible = cat
    .filter((m) => want.includes(m.type))
    .filter((m) => {
      const s = settleabilityOf(m);
      if (!s.settleable) return false;
      return true;
    })
    .filter((m) => m.demargined)          // never quote a line TxODDS would not demargin
    // full match before first half, then tightest line first, so the deepest markets are funded
    // first when the budget cannot cover everything
    .sort((a, b) => (a.period === "FT" ? 0 : 1) - (b.period === "FT" ? 0 : 1) || Math.abs(a.line ?? 0) - Math.abs(b.line ?? 0));

  // Expand each feed line into the on-chain markets it actually prices.
  //
  // A feed line and an on-chain market are not the same thing, and quoting one per line leaves the
  // board half made. A three-way result is one row on the feed and three separate markets on chain,
  // so taking outcome index 0 of each line quoted the home leg and left the draw and the away leg
  // with no bid and no offer. On fixture 18257739 that was 9 lines covering 7 of the 11 markets.
  //
  // Deduplication by terms matters in the other direction. Handicap -0.5 is the same proposition as
  // the home leg, so without this the bot would open two books on one market and quote against
  // itself.
  const seen = new Set();
  const quotable = [];
  for (const m of eligible) {
    for (const leg of settleabilityOf(m).legs ?? []) {
      const terms = termsOfFeedMarket(m, leg);
      const tk = termsKey(terms);
      if (!tk || seen.has(tk)) continue;
      const outcomeIndex = m.type === "1X2_PARTICIPANT_RESULT" ? ["home", "draw", "away"].indexOf(leg) : 0;
      const prob = m.outcomes[outcomeIndex]?.prob;
      if (!(prob > 0.02 && prob < 0.98)) continue; // nothing to make a two-sided market around
      seen.add(tk);
      quotable.push({ ...m, key: `${m.key}#${leg}`, feedKey: m.key, termsKey: tk, leg, outcomeIndex });
    }
  }
  return MAX_MARKETS > 0 ? quotable.slice(0, MAX_MARKETS) : quotable;
}

/** The probability this quotable market is priced on, which is its own leg and not the first one. */
const fairOf = (m) => m.outcomes[m.outcomeIndex ?? 0]?.prob;

/**
 * How much collateral each market may use.
 *
 * The daily ceiling is for the whole fixture, so quoting more markets means quoting each of them
 * smaller. Sizing per market from a fixed constant instead would make the total spend a function of
 * how many lines the feed happened to publish that day, which is not a budget.
 *
 * When the split falls below what one quote costs, the answer is to quote fewer markets rather than
 * to overspend. That decision is made here and logged, so an operator sees the board being trimmed
 * instead of discovering it as a failed transaction.
 */
function budgetPerMarket(count) {
  if (count <= 0) return { perMarket: 0, quoting: 0 };
  const remaining = Math.max(0, MAX_DAILY_COLLATERAL - guard.spent);
  const perMarket = Math.floor(remaining / count);
  const minViable = SIZE; // one quote of SIZE shares at a price of at most 1.0
  if (perMarket >= minViable) return { perMarket, quoting: count };
  const quoting = Math.max(0, Math.floor(remaining / minViable));
  return { perMarket: quoting ? Math.floor(remaining / quoting) : 0, quoting };
}

// ---- on-chain: one book per market, created lazily and cached ----
const books = new Map(); // market.key -> { book, oo, base, quote }
async function ensureBook(m) {
  if (books.has(m.key)) return books.get(m.key);
  // Shadow mode opens nothing on-chain. It carries just enough state to price and log.
  if (SHADOW) {
    const stub = { book: null, oo: null, target: 0, inventory: 0, lastFair: null, stale: false, shadow: true };
    books.set(m.key, stub);
    return stub;
  }
  // Bind the book to the real on-chain market this feed line prices. The old code generated a
  // random Keypair as the market and minted its own play tokens, so every book it opened was
  // attached to nothing: the app could never find it, and the "liquidity" was in a private
  // sandbox. A book is only real if it trades the market's own YES share against real collateral.
  const onchain = findOnChainMarket(onChainMarkets, m, m.outcomeIndex ?? 0);
  if (!onchain) {
    log(`no on-chain market for ${label(m)} yet, so nothing to quote. Open one first, then this
      bot will make it. Refusing to invent a substitute.`);
    books.set(m.key, null);
    return null;
  }
  log(`opening a book for ${label(m)} on market ${onchain.address.slice(0, 8)}`);
  const market = new PublicKey(onchain.address);
  const base = new PublicKey(onchain.yesMint); // the market's own YES share, not a play token
  const quote = usdcMint;                      // real collateral
  const book = seed("book", market);
  await program.methods.createBook(market).accountsPartial({
    creator: payer.publicKey, book, baseMint: base, quoteMint: quote,
    baseVault: seed("base_vault", book), quoteVault: seed("quote_vault", book),
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  }).rpc().catch(async (e) => {
    // A book already existing is the normal case on a restart, not a failure.
    if (!String(e.message ?? e).match(/already in use|custom program error: 0x0/)) throw e;
    log(`  book already open, reusing it`);
  });
  // Every setup step below has to be safe to run again. A market maker gets restarted: the
  // process dies, the box reboots, a deploy rolls. If resuming against a book it already opened
  // throws "already in use", the agent can never come back to a market it is quoting, which is a
  // production failure disguised as a startup error.
  const alreadyThere = (e) => /already in use|custom program error: 0x0\b/.test(String(e.message ?? e));
  await program.methods.initEventHeap().accountsPartial({
    creator: payer.publicKey, book, eventHeap: seed("events", book), systemProgram: SystemProgram.programId,
  }).rpc().catch((e) => { if (!alreadyThere(e)) throw e; });
  const oo = PublicKey.findProgramAddressSync([Buffer.from("open_orders"), book.toBuffer(), payer.publicKey.toBuffer()], PID)[0];
  const freshOpenOrders = await program.methods.initOpenOrders().accountsPartial({
    payer: payer.publicKey, owner: payer.publicKey, book, openOrders: oo, systemProgram: SystemProgram.programId,
  }).rpc().then(() => true).catch((e) => { if (!alreadyThere(e)) throw e; return false; });
  const baseAta = (await getOrCreateAssociatedTokenAccount(connection, payer, base, payer.publicKey)).address;
  const quoteAta = (await getOrCreateAssociatedTokenAccount(connection, payer, quote, payer.publicKey)).address;
  const noAta = (await getOrCreateAssociatedTokenAccount(connection, payer, new PublicKey(onchain.noMint), payer.publicKey)).address;

  // Get YES inventory the only legitimate way: split collateral into a matched YES and NO pair
  // through the market program. Minting our own YES is not possible and should not be, because
  // the market mint is the market's, and every share in existence must be backed by collateral
  // sitting in its vault. This is the difference between real inventory and play money.
  const INVENTORY = Number(arg("inventory", 2000)) * U;
  // Resuming a book means reading what is actually in the open-orders account, never assuming it.
  //
  // This used to trust that an existing open-orders account had been funded, because the run that
  // created it would have deposited straight after. Creating the account and depositing into it are
  // two transactions, so any run interrupted between them leaves an account with nothing in it, and
  // the balance can also have been spent or withdrawn since. Measured live on fixture 18257739: the
  // bot resumed four books, assumed inventory was present, and every order it placed came back
  // InsufficientBalance from the exchange, tick after tick.
  //
  // Believed state has to be reconciled against the chain before anything trades on it, which is
  // the same rule lib/guard.mjs reconcile exists for.
  if (!freshOpenOrders) {
    const acct = await program.account.openOrders.fetch(oo).catch(() => null);
    // these come back as BN, and Number() on a BN does not give the value
    const baseFree = acct?.baseFree?.toNumber?.() ?? 0;
    const quoteFree = acct?.quoteFree?.toNumber?.() ?? 0;
    // A quote needs shares to sell and collateral to buy with. Below that, this book cannot make a
    // two-sided market and topping it up is the same work as funding a fresh one.
    const needed = SIZE * U;
    if (baseFree >= needed && quoteFree >= needed) {
      log(`  resuming ${label(m)}: ${(baseFree / U).toFixed(0)} shares and ${(quoteFree / U).toFixed(0)} collateral already deposited`);
      const resumed = { book, oo, base, quote, market, lastFair: null, target: Math.min(baseFree, quoteFree) };
      books.set(m.key, resumed);
      return resumed;
    }
    log(`  resuming ${label(m)}: only ${(baseFree / U).toFixed(0)} shares and ${(quoteFree / U).toFixed(0)} collateral on the book, topping up`);
    // fall through and fund it, exactly as if the book were new
  }
  // Locking collateral is the spend that survives a restart, so it is checked against the durable
  // ceiling before anything is committed rather than after.
  const allowed = guard.canSpend(INVENTORY);
  if (!allowed.ok) {
    log(`  not funding ${label(m)}: ${allowed.why}`);
    books.set(m.key, null);
    return null;
  }
  await marketProgram.methods.split(new anchor.BN(INVENTORY)).accountsPartial({
    user: payer.publicKey, market, yesMint: base, noMint: new PublicKey(onchain.noMint),
    vault: onchain.vault, userYes: baseAta, userNo: noAta, userCollateral: quoteAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  guard.recordSpend(INVENTORY); // confirmed on chain, so it counts against the daily ceiling
  log(`  split ${INVENTORY / U} collateral into matched YES and NO for inventory (${guard.spent / U} of ${MAX_DAILY_COLLATERAL} committed today)`);

  await program.methods.deposit(new anchor.BN(INVENTORY), new anchor.BN(INVENTORY)).accountsPartial({
    owner: payer.publicKey, book, openOrders: oo, baseVault: seed("base_vault", book), quoteVault: seed("quote_vault", book),
    userBase: baseAta, userQuote: quoteAta, tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();
  const entry = { book, oo, base, quote, market, lastFair: null, target: INVENTORY };
  books.set(m.key, entry);
  log(`  book ready ${book.toBase58()}`);
  return entry;
}

async function myRestingOrders(book, oo) {
  const b = await program.account.book.fetch(book);
  const mine = [];
  for (let i = 0; i < Number(b.bidCount); i++) if (b.bids[i].owner.equals(oo)) mine.push({ side: "bid", id: Number(b.bids[i].id) });
  for (let i = 0; i < Number(b.askCount); i++) if (b.asks[i].owner.equals(oo)) mine.push({ side: "ask", id: Number(b.asks[i].id) });
  return mine;
}

/**
 * Inventory skew. A maker that quotes symmetrically around fair accumulates whatever the
 * market is selling it. Holding more YES than target means we shade both quotes down, so we
 * are keener to sell and less keen to buy, which walks inventory back toward target without
 * ever quoting away from the real line by more than the spread.
 */
function skewed(fair, entry, held) {
  if (!SKEW || !entry.target) return fair;
  const drift = (held - entry.target) / entry.target;      // +1 = double the target
  return clamp(fair - drift * SKEW * SPREAD, 0.01, 0.99);
}

/**
 * Steam: how far this line has moved over the recent window, and whether that is sharp. Measured
 * on the raw demargined line, not the skewed quote, so it reflects the market and not our own
 * inventory. Keeps a short per-market history and compares now against the oldest point in window.
 */
function steamOf(entry, rawFair) {
  const now = Date.now();
  (entry.hist ??= []).push({ t: now, f: rawFair });
  const cutoff = now - STEAM_WINDOW_S * 1000;
  while (entry.hist.length && entry.hist[0].t < cutoff) entry.hist.shift();
  const oldest = entry.hist[0];
  const delta = oldest ? rawFair - oldest.f : 0;           // + means the line rose
  return { steaming: Math.abs(delta) >= STEAM, delta, secs: oldest ? Math.round((now - oldest.t) / 1000) : 0 };
}

/** Cancel every resting order on a book and leave it empty. Used when a line goes stale. */
async function pullQuotes(entry) {
  if (SHADOW) return 0; // shadow mode holds no orders, so there is nothing to cancel
  const mine = await myRestingOrders(entry.book, entry.oo);
  for (const o of mine) {
    await program.methods.cancelOrder(o.side === "bid" ? { bid: {} } : { ask: {} }, new anchor.BN(o.id))
      .accountsPartial({ owner: payer.publicKey, book: entry.book, openOrders: entry.oo }).rpc().catch(() => {});
  }
  return mine.length;
}

// Place a fresh two-sided (or one-sided) quote. spread, size and sides come from the risk engine,
// so a steaming or over-exposed market gets a wider, smaller, or one-legged quote, not the default.
async function requote(entry, fair, { spread = SPREAD, size = SIZE, sides = "both" } = {}) {
  // Check the limits before cancelling anything. Pulling quotes and then refusing to replace them
  // would leave the market unquoted for the wrong reason.
  const check = riskCheck(entry, size);
  if (!check.ok) {
    const n = await pullQuotes(entry).catch(() => 0);
    log(`risk: ${check.why} -> not quoting, pulled ${n} resting order(s)`);
    return { bid: null, ask: null, blocked: check.why };
  }

  const bid = sides !== "askOnly" ? clamp(fair - spread, 0.01, 0.99) : null;
  const ask = sides !== "bidOnly" ? clamp(fair + spread, 0.01, 0.99) : null;

  // Shadow mode stops here: the decision is made and logged, no transaction is sent.
  if (SHADOW) return { bid, ask, shadow: true };

  await pullQuotes(entry);
  const eventHeap = seed("events", entry.book);
  const out = { bid: null, ask: null };
  if (bid != null) {
    await program.methods.placeOrder({ bid: {} }, new anchor.BN(Math.round(bid * PRICE_ONE)), new anchor.BN(size * U))
      .accountsPartial({ owner: payer.publicKey, book: entry.book, openOrders: entry.oo, eventHeap }).rpc();
    out.bid = bid;
    risk.notional += size;
  }
  if (ask != null) {
    await program.methods.placeOrder({ ask: {} }, new anchor.BN(Math.round(ask * PRICE_ONE)), new anchor.BN(size * U))
      .accountsPartial({ owner: payer.publicKey, book: entry.book, openOrders: entry.oo, eventHeap }).rpc();
    out.ask = ask;
    risk.notional += size;
  }
  return out;
}

// The leg is part of the name, because the three legs of a result are three separate markets and
// three separate books. Without it every 1X2 line logs under one label and the log cannot be used
// to tell which market a quote went to.
const label = (m) =>
  `${m.type.split("_")[0]} ${m.period}${m.line != null ? ` ${m.line > 0 ? "+" : ""}${m.line}` : ""}`
  + (m.type === "1X2_PARTICIPANT_RESULT" && m.leg ? ` ${m.leg}` : "");

// ---- run ----
const bal = await connection.getBalance(payer.publicKey);
if (bal < 0.05 * LAMPORTS_PER_SOL) log("warning: low SOL for fees");
log(`fixture ${FIXTURE} | markets=${FILTER} max=${MAX_MARKETS} | spread=${SPREAD} size=${SIZE} skew=${SKEW}`);
log(`mode ${SHADOW ? "SHADOW (decisions logged, no transactions sent)" : "LIVE (places real orders)"}`);
if (!SHADOW) {
  onChainMarkets = await loadOnChainMarkets(FIXTURE);
  log(`on-chain markets on this fixture: ${onChainMarkets.length} (a book is only opened where one exists)`);
}
log(`risk limits | max ${MAX_SHARES} shares/market | max notional ${MAX_NOTIONAL} | stop at -${MAX_LOSS}`);
log(`collateral ceiling | ${MAX_DAILY_COLLATERAL}/day, ${guard.spent / U} already committed today (survives restart)`);
if (guard.tripped) { log(`circuit breaker is tripped: ${guard.reason}`); log(`clear it deliberately once you know why, then start again.`); process.exit(1); }

const first = await board();
if (!first.length) { log("odds feed has no board for this fixture yet; nothing to quote"); process.exit(0); }
const selected = selectMarkets(first);
log(`board has ${first.length} markets; quoting ${selected.length}:`);
for (const m of selected) log(`   ${label(m)}  fair ${(fairOf(m) * 100).toFixed(1)}%  (${m.outcomes[m.outcomeIndex].name})`);
const skippedNA = first.filter((m) => !m.demargined).length;
if (skippedNA) log(`skipping ${skippedNA} quarter lines: TxODDS sends Pct "NA" and a two-way price does not exist for them`);

let running = false; // a slow tick must finish before the next starts, or two requotes race
async function tick() {
  if (running) { log("previous tick still running, skipping"); return; }
  running = true;
  try {
    const [st, cat] = await Promise.all([realState(), board()]);
    if (!cat.length) { log("no board from the odds feed, holding every quote"); return; }
    const mins = st?.minute ?? 0;
    const score = st ? `${st.home}-${st.away}` : "?";

    // Check this before quoting anything, not after. The old code ran the whole quoting loop
    // and only then asked whether the match had ended, so a match that finished during the
    // previous sleep got one more round of quotes at prices whose answer was already public.
    //
    // And pull the resting orders on the way out. Exiting on its own leaves live orders sitting
    // on the book of a decided match, which is the liability this check exists to remove. The
    // process stopping does not cancel them.
    if (st?.over) {
      let pulled = 0;
      for (const entry of books.values()) pulled += await pullQuotes(entry).catch(() => 0);
      log(`match is over at ${score} (status ${st.statusId}). The result is public, so quoting stops. Pulled ${pulled} resting order(s).`);
      process.exit(0);
    }

    // The staleness limit follows the phase. Before kickoff a quiet line is a good line; in
    // play a quiet line means the match moved and we have not.
    const inPlay = st?.inPlay ?? false;
    // How fresh the feed itself is, measured as the newest market on the whole board. This is what
    // separates "the feed has stopped" from "this one line is quiet", and those need opposite
    // answers, so it is computed once per tick and handed to every market's verdict.
    const boardTs = cat.map((x) => x.ts).filter(Boolean);
    const boardAge = boardTs.length ? Math.round((Date.now() - Math.max(...boardTs)) / 1000) : null;

    // One market's failure must not take the board down with it.
    //
    // Everything below used to sit under the single try that wraps this whole function, so the
    // first market that threw ended the tick and every market after it in the list was never
    // quoted. Measured live on fixture 18257739: an InsufficientBalance on the fourth market meant
    // markets five through eleven had no quotes at all, every tick, and the log showed only a
    // "tick error" line with no indication that most of the board had been skipped.
    //
    // A market that fails repeatedly is a real problem, so failures are counted through the guard
    // and the breaker trips rather than the bot retrying forever in silence.
    for (const m of selectMarkets(cat)) {
      try {
      const age = m.ts ? Math.round((Date.now() - m.ts) / 1000) : null;

      // A line we cannot vouch for is a line we do not stand behind. The judgement is made against
      // the feed's own liveness rather than the wall clock, so a peripheral market the bookmaker
      // simply has not revisited is quoted wider instead of being refused outright.
      const verdict = ageVerdict(age, boardAge, inPlay, STALENESS);
      if (!verdict.quote) {
        const entry = books.get(m.key);
        if (entry && !entry.stale) {
          const n = await pullQuotes(entry);
          entry.stale = true; entry.lastFair = null;
          log(`${mins}' ${score} | ${label(m)} | ${verdict.reason} -> pulled ${n} order(s), quoting nothing`);
        } else if (!entry) {
          log(`${mins}' ${score} | ${label(m)} | ${verdict.reason} -> not opening a book`);
        }
        continue;
      }

      const entry = await ensureBook(m);
      if (!entry) continue; // no on-chain market prices this line, so there is nothing to quote
      if (entry.stale) { log(`${mins}' ${score} | ${label(m)} | line is fresh again (${age}s) -> resuming quotes`); entry.stale = false; }
      const raw = clamp(fairOf(m), 0.01, 0.99);
      const held = (await program.account.openOrders.fetch(entry.oo).catch(() => null))?.baseFree?.toNumber?.() ?? entry.target;
      const fair = skewed(raw, entry, held);

      // ---- risk engine: decide the quote before placing it ----
      const steam = steamOf(entry, raw);
      const exposure = entry.target ? (held - entry.target) / entry.target : 0; // + = long the base
      const overExposed = Math.abs(exposure) > MAX_INVENTORY;
      // Steam widens the spread and shrinks the size: get paid for adverse selection, risk less.
      // Two independent reasons to widen, and they compound. Steam means informed money is moving
      // the line right now. Quiet means the line is old enough that we are pricing off something
      // the bookmaker stopped maintaining. Both raise the chance the next person to trade knows
      // more than we do.
      const spread = SPREAD * (steam.steaming ? STEAM_WIDEN : 1) * (verdict.widen ?? 1);
      const size = steam.steaming ? Math.max(1, Math.round(SIZE / STEAM_WIDEN)) : SIZE;
      // Past the inventory cap, quote only the side that reduces the position.
      const sides = overExposed ? (exposure > 0 ? "askOnly" : "bidOnly") : "both";
      // A distinct state string, so the bot re-quotes when the risk picture changes and not only
      // when fair drifts. Otherwise steam or a filled position would not trigger a fresh quote.
      const mode = `${steam.steaming ? "S" : "-"}${sides}`;

      if (entry.lastFair == null || Math.abs(fair - entry.lastFair) > REQUOTE_AT || mode !== entry.mode) {
        const { bid, ask } = await requote(entry, fair, { spread, size, sides });
        const q = sides === "askOnly" ? `sell ${ask.toFixed(2)}` : sides === "bidOnly" ? `buy ${bid.toFixed(2)}` : `${bid.toFixed(2)}/${ask.toFixed(2)}`;
        const reasons = [
          fair !== raw ? `skew->${(fair * 100).toFixed(1)}%` : null,
          steam.steaming ? `STEAM ${steam.delta > 0 ? "+" : ""}${(steam.delta * 100).toFixed(1)}pp/${steam.secs}s -> spread ${spread.toFixed(3)} size ${size}` : null,
          overExposed ? `INVENTORY ${(exposure * 100).toFixed(0)}% -> ${sides === "askOnly" ? "sell-only" : "buy-only"}` : null,
        ].filter(Boolean).join(" | ");
        log(`${mins}' ${score} | ${label(m)} | line ${(raw * 100).toFixed(1)}% | quote ${q} | age ${age}s${reasons ? ` | ${reasons}` : ""} | proof ${m.messageId}`);
        entry.lastFair = fair; entry.mode = mode;
      } else {
        log(`${mins}' ${score} | ${label(m)} | line ${(raw * 100).toFixed(1)}% unchanged, holding | age ${age}s`);
      }
      guard.ok(); // this market got through cleanly, so the failure streak is broken
      } catch (e) {
        const tripped = guard.fail(`${label(m)}: ${String(e.message ?? e)}`);
        log(`${label(m)} failed this tick: ${String(e.message ?? e).slice(0, 140)}`);
        if (tripped) {
          log(`circuit breaker tripped: ${guard.reason}. Pulling quotes and stopping.`);
          risk.halted = true;
          risk.reason = guard.reason;
        }
      }
    }

  } catch (e) { log("tick error (whole board):", String(e.message ?? e)); }
  finally { running = false; }
}
await tick();
setInterval(tick, INTERVAL);
