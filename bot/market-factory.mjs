// Open an on-chain market for every TxLINE line on a fixture that can settle trustlessly.
//
// This is the single path to market creation. It replaces scripts/seed-final-totals.mjs,
// seed-worldcup-markets.mjs, seed-prop-markets.mjs and seed-market-devnet.mjs, which between them
// handled one market type each, hardcoded stat keys 1 and 2, and picked a random market id so the
// same bet could be opened twice.
//
// WHAT IT OPENS, AND WHAT IT REFUSES TO OPEN
//
// lib/settleable.mjs decides. A fischio market is binary, so only lines with a genuinely two-way
// outcome qualify: the three result legs, and the half lines on totals and handicaps, for both the
// full match and the first half. Integer lines push and quarter lines split the stake, so they get
// no market and stay on the board as a price with a reason attached.
//
// PRICES COME FROM THE FEED, NEVER FROM HERE
//
// A new pool starts at even money. The opening trade moves it to the demargined probability TxODDS
// published, using the same AMM maths the program runs, so the price a market opens at is the
// market's own line and not a number this file invented. A line with no usable probability (the
// feed sends "NA" on quarter lines) gets no market at all rather than a guessed price.
//
// IDEMPOTENCY
//
// The market id is derived from the terms (lib/market-id.mjs), so the same bet always lands on the
// same address, and that address can be computed by anyone holding the terms.
//
// Deriving the address is not on its own enough to avoid duplicates, and assuming it was cost five
// duplicate pools on fixture 18257739. Markets opened by the retired seeders carry random ids, so
// they sit at addresses this factory cannot derive. Checking only "is there an account at the
// derived address" therefore said no and opened a second pool beside each legacy one, splitting the
// liquidity and quoting two prices for the same bet.
//
// So existence is decided by TERMS, over every market on the fixture. Terms are what a market
// actually is; the address is only where this factory would have put it.
//
// Existence also is not the same as being tradeable. Creating a market and funding it are two
// transactions, so an interrupted run leaves a market with empty pools that would be counted as
// covered while nobody could trade it. A market with no liquidity is resumed rather than skipped.
//
//   node bot/market-factory.mjs --fixture 18257739 --dry-run
//   node bot/market-factory.mjs --fixture 18257739
//   node bot/market-factory.mjs --fixture 18257739 --liquidity 500

import "../lib/env.mjs";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { onChainMarketsOf, settleabilityOf } from "../lib/settleable.mjs";
import { normalizeTerms, termsKey } from "../lib/market-link.mjs";
import { marketIdOf } from "../lib/market-id.mjs";
import { calcBuy, priceBps } from "../lib/amm.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const FIXTURE = Number(flag("fixture", process.env.FIXTURE ?? 18257739));
const DRY = has("dry-run") || has("shadow");
const LIQ = BigInt(flag("liquidity", "1000"));
const FEE_BPS = Number(flag("fee-bps", "200"));
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";

const U = 1_000_000n; // six decimal collateral
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- the opening trade ------------------------------------------------------------------------
//
// A fresh pool sits at 50/50. Find the collateral that, spent on the heavier side, moves the price
// to the feed's probability. Binary search over the same calcBuy the program runs, so the opening
// price is reproducible rather than approximated.
export function openingTrade(targetP, liquidity) {
  const R = liquidity * U;
  const clamped = Math.max(0.02, Math.min(0.98, targetP));
  const side = clamped > 0.5 ? "yes" : "no";
  const target = BigInt(Math.round(clamped * 10_000));
  let lo = 0n, hi = 8n * R, best = 0n;
  for (let i = 0; i < 46; i++) {
    const mid = (lo + hi) / 2n;
    const out = calcBuy(R, R, mid);
    if (out == null) { hi = mid; continue; }
    const ny = side === "yes" ? R + mid - out : R + mid;
    const nn = side === "yes" ? R + mid : R + mid - out;
    const p = priceBps(ny, nn);
    const reached = side === "yes" ? p >= target : p <= target;
    if (reached) { best = mid; hi = mid; } else lo = mid;
  }
  return { side, collateral: best };
}

/**
 * The probability YES should open at, read off the feed line this market came from.
 *
 * YES means the over on a totals line, the home side on a handicap, and the named leg on a result.
 * Returns null when the feed carries no usable probability, which is the honest answer on a
 * quarter line and the reason those never reach this function.
 */
export function openingProbability(feedMarket, leg) {
  if (!feedMarket?.demargined) return null;
  const outcomes = feedMarket.outcomes ?? [];
  const byName = (re) => outcomes.find((o) => re.test(String(o.name)))?.prob ?? null;
  if (feedMarket.type === "1X2_PARTICIPANT_RESULT") {
    if (leg === "home") return byName(/^part1$/i);
    if (leg === "draw") return byName(/^draw$/i);
    if (leg === "away") return byName(/^part2$/i);
    return null;
  }
  if (feedMarket.type === "OVERUNDER_PARTICIPANT_GOALS") return byName(/over/i);
  if (feedMarket.type === "ASIANHANDICAP_PARTICIPANT_GOALS") return byName(/^part1$/i);
  return null;
}

// ---- main -------------------------------------------------------------------------------------

const tx = txlineClient();
const board = parseMarkets((await tx.oddsSnapshot(FIXTURE)) ?? []);
if (!board.length) { log(`no odds on fixture ${FIXTURE}; nothing to open`); process.exit(0); }

// Kickoff decides when trading closes. A market that cannot close in the future cannot be created,
// because the program requires close_ts > now, so a match already under way is skipped rather than
// opened with a fabricated close time.
const day = Math.floor(Date.now() / 86_400_000);
let kickoffMs = null;
for (const d of [day, day - 1, day + 1]) {
  const fx = await tx.fixturesSnapshot(d).catch(() => null);
  const row = (fx ?? []).find((f) => Number(f.FixtureId) === FIXTURE);
  if (row?.StartTime) { kickoffMs = Number(row.StartTime) > 1e11 ? Number(row.StartTime) : Number(row.StartTime) * 1000; break; }
}
if (!kickoffMs) { log(`no kickoff time for fixture ${FIXTURE}; refusing to invent one`); process.exit(1); }

const closeTs = Math.floor(kickoffMs / 1000);
// Regulation, stoppage, extra time, penalties and a margin for a delayed feed. Eight hours is well
// past the longest match ever played, and the market voids and refunds if nothing settles it.
const expiryTs = closeTs + 8 * 3600;
const nowTs = Math.floor(Date.now() / 1000);

const plan = onChainMarketsOf(board);
const byFeedKey = new Map(board.map((m) => [m.key, m]));

log(`fixture ${FIXTURE}: ${board.length} feed lines, ${board.filter((m) => settleabilityOf(m).settleable).length} settleable`);
log(`kickoff ${new Date(kickoffMs).toISOString()}  close ${closeTs}  expiry ${expiryTs}`);
log(`${plan.length} on-chain markets implied (result legs are separate markets, and handicap -0.5 collapses into the home leg)`);

if (closeTs <= nowTs) {
  log(`kickoff has passed, so trading cannot close in the future. Nothing to open.`);
  process.exit(0);
}

// Attach the opening price, and drop anything the feed cannot price.
const priced = [];
for (const p of plan) {
  const source = byFeedKey.get(p.sources[0].feedKey);
  const prob = openingProbability(source, p.leg);
  if (prob == null) { log(`  skip ${p.sources[0].feedKey} ${p.leg}: the feed carries no usable probability`); continue; }
  priced.push({ ...p, prob, marketId: marketIdOf(FIXTURE, p.terms) });
}

if (DRY) {
  log(`DRY RUN, nothing will be sent.`);
  for (const p of priced) {
    const lineage = p.sources.map((s) => `${s.feedKey}#${s.leg}`).join(" + ");
    log(`  open ${String(p.termsKey).padEnd(26)} at ${(p.prob * 100).toFixed(1)}%  id=${p.marketId}  from ${lineage}`);
  }
  log(`would open ${priced.length} markets with ${LIQ} USDC of liquidity each (${LIQ * BigInt(priced.length)} total)`);
  process.exit(0);
}

// ---- send -------------------------------------------------------------------------------------

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  process.env.KEYPAIR_JSON ?? readFileSync("local/devnet-wallet.json", "utf8"))));
const { mint: usdcStr } = JSON.parse(readFileSync("local/devnet-usdc.json", "utf8"));
const usdc = new PublicKey(usdcStr);
const idl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const BN = anchor.BN;
const CU = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];

const collateralAta = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, payer.publicKey)).address;
const balance = BigInt((await connection.getTokenAccountBalance(collateralAta)).value.amount);
const needed = LIQ * U * BigInt(priced.length);
log(`collateral on hand ${balance / U} USDC, opening ${priced.length} markets needs about ${needed / U}`);
if (balance < needed) {
  log(`not enough collateral. Fund the wallet or lower --liquidity. Refusing to open a partial board silently.`);
  process.exit(1);
}

// Index every market already on this fixture BY ITS TERMS, not by its address.
//
// Checking only the derived address is not enough, and the reconciliation proved it. Markets
// opened by the retired seeders carry random ids, so they sit at addresses this factory cannot
// derive. Skipping on "no account at the derived address" therefore opened a second pool beside
// each legacy one: five propositions on fixture 18257739 ended up with two pools each, splitting
// the liquidity and quoting two prices for the same bet.
//
// Terms are the identity of a market. Anything already priced on these terms counts as existing,
// wherever it lives.
const existing = new Map();
for (const { publicKey, account } of await program.account.market.all()) {
  if (Number(account.terms.fixtureId) !== FIXTURE) continue;
  const k = termsKey(normalizeTerms(account.terms));
  if (!k) continue;
  (existing.get(k) ?? existing.set(k, []).get(k)).push({ address: publicKey, account });
}
log(`${existing.size} propositions already have a pool on this fixture`);

/** Liquidity in a market's pools, so a half-created market is not mistaken for a live one. */
async function liquidityOf(market) {
  const bal = async (which) => BigInt((await connection.getTokenAccountBalance(
    PublicKey.findProgramAddressSync([Buffer.from(which), market.toBuffer()], PID)[0])).value.amount).valueOf();
  try { return (await bal("yes_pool")) + (await bal("no_pool")); } catch { return 0n; }
}

/**
 * Seed a market with liquidity and move it to the feed's price.
 *
 * Shared by the create path and the resume path, because an interrupted run leaves a market that
 * exists with empty pools, and finishing it is exactly the same work as funding a fresh one.
 */
async function fundAndPrice(market, p) {
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
    vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
  const no = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
  const lp = (await getOrCreateAssociatedTokenAccount(connection, payer, P.lpMint, payer.publicKey)).address;

  await program.methods.addLiquidity(new BN((LIQ * U).toString()))
    .accountsPartial({ provider: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint,
      lpMint: P.lpMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool,
      providerCollateral: collateralAta, providerYes: yes, providerNo: no, providerLp: lp,
      tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([CU]).rpc();

  const { side, collateral } = openingTrade(p.prob, LIQ);
  if (collateral > 0n) {
    await program.methods.buy(new BN(collateral.toString()), side === "yes" ? { yes: {} } : { no: {} }, new BN(0))
      .accountsPartial({ trader: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint,
        vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, traderCollateral: collateralAta,
        traderYes: yes, traderNo: no, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions([CU]).rpc();
  }

  const y = BigInt((await connection.getTokenAccountBalance(P.yesPool)).value.amount);
  const n = BigInt((await connection.getTokenAccountBalance(P.noPool)).value.amount);
  log(`  live ${market.toBase58()}  ${p.termsKey}  at ${((Number(n) / Number(y + n)) * 100).toFixed(1)}% (line ${(p.prob * 100).toFixed(1)}%)`);
}

let opened = 0, skipped = 0, funded = 0, failed = 0;
for (const p of priced) {
  const marketId = new BN(p.marketId.toString());
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), payer.publicKey.toBuffer(), marketId.toArrayLike(Buffer, "le", 8)], PID)[0];

  const already = existing.get(p.termsKey) ?? [];
  if (already.length) {
    // Creating a market is one transaction and funding it is another, so an interrupted run can
    // leave a market that exists with empty pools. That is not tradeable and must be finished
    // rather than reported as covered.
    const target = already.find((h) => h.address.equals(market)) ?? already[0];
    const liq = await liquidityOf(target.address);
    if (liq > 0n) {
      log(`  exists ${target.address.toBase58()}  ${p.termsKey}${already.length > 1 ? `  (${already.length} pools, split liquidity)` : ""}`);
      skipped++;
      continue;
    }
    log(`  unfunded ${target.address.toBase58()}  ${p.termsKey}, adding liquidity`);
    try {
      await fundAndPrice(target.address, p);
      funded++;
    } catch (e) {
      log(`  FAILED funding ${p.termsKey}: ${String(e.message ?? e).slice(0, 160)}`);
      failed++;
    }
    continue;
  }

  const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
    vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const terms = {
    fixtureId: new BN(FIXTURE),
    statAKey: p.terms.statAKey,
    statBKey: p.terms.statBKey,
    op: p.terms.op === "add" ? { add: {} } : { subtract: {} },
    predicate: {
      threshold: p.terms.threshold,
      comparison: p.terms.comparison === "greaterThan" ? { greaterThan: {} }
        : p.terms.comparison === "lessThan" ? { lessThan: {} } : { equalTo: {} },
    },
  };

  try {
    await program.methods.createMarket(marketId, terms, new BN(closeTs), new BN(expiryTs), FEE_BPS)
      .accountsPartial({ creator: payer.publicKey, market, collateralMint: usdc, yesMint: P.yesMint,
        noMint: P.noMint, lpMint: P.lpMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
      .preInstructions([CU]).rpc();

    await fundAndPrice(market, p);
    opened++;
  } catch (e) {
    log(`  FAILED ${p.termsKey}: ${String(e.message ?? e).slice(0, 160)}`);
    failed++;
  }
}

log(`done. opened ${opened}, funded ${funded}, already live ${skipped}, failed ${failed}, of ${priced.length} planned`);
if (failed) process.exitCode = 1;
