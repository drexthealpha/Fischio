// Browser chain layer for the AMM prediction market. Reads live markets (state, reserves,
// price) from devnet and builds the trade transactions through the connected wallet. All
// money paths are the deployed program's instructions; nothing here custodies funds.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import marketIdl from "./market_idl.json";
import { connection, FIXTURES_BY_ID } from "./chain.js"; // reuse the one connection
import { execute } from "./relay.js"; // gasless seam for the embedded wallet

const BN = anchor.BN;
export const MARKET_PROGRAM_ID = new PublicKey(marketIdl.address);

const readProvider = new anchor.AnchorProvider(
  connection,
  { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
  { commitment: "confirmed" }
);
export const marketRead = new anchor.Program(marketIdl, readProvider);
export const marketFor = (wallet) =>
  new anchor.Program(marketIdl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));

const seed = (s, market) =>
  PublicKey.findProgramAddressSync([Buffer.from(s), market.toBuffer()], MARKET_PROGRAM_ID)[0];

export function marketPdas(creator, marketId) {
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), creator.toBuffer(), new BN(marketId).toArrayLike(Buffer, "le", 8)],
    MARKET_PROGRAM_ID
  )[0];
  return {
    market,
    yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
    vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market),
  };
}

const USDC = 1_000_000; // 6 decimals
export const toUsdc = (x) => Math.round(x * USDC);
export const fromUsdc = (x) => x / USDC;

const params = new URLSearchParams(window.location.search);
const API = params.get("api") ?? import.meta.env.VITE_API ?? "http://127.0.0.1:8790";
const INGEST = params.get("ingest") ?? import.meta.env.VITE_INGEST ?? "http://127.0.0.1:8795";

// Which leg of a 1X2 match result a market is: home goals minus away goals, compared to zero.
// Greater than is a home win, equal is a draw, less than is an away win. Anything else (a
// corners or totals prop, a different stat) is not a result leg and returns null.
export function resultLeg(terms) {
  const isSub = terms?.op === "subtract" || terms?.op?.subtract !== undefined;
  if (!(terms && terms.statAKey === 1 && terms.statBKey === 2 && isSub)) return null;
  if (Number(terms.threshold) !== 0) return null;
  const c = terms.comparison;
  return c === "greaterThan" ? "home" : c === "equalTo" ? "draw" : c === "lessThan" ? "away" : null;
}

// The live demargined 1X2 line for a fixture, straight from the ingestion service (the last
// good TxLINE consensus, kept fresh by its streams). Returns { home, draw, away } or null.
export async function fetchLiveLine(fixtureId) {
  try {
    const r = await fetch(`${INGEST}/live/${fixtureId}`);
    if (r.ok) { const s = await r.json(); return s?.implied ?? null; }
  } catch { /* ingestion not running */ }
  return null;
}

// The final (or latest) score for a fixture, so a closed market can show the real result and
// the winning outcome instead of a frozen probability. Returns { home, away, statusId } or null.
export async function fetchFinalScore(fixtureId) {
  try {
    const r = await fetch(`${INGEST}/score/${fixtureId}`);
    if (r.ok) { const s = await r.json(); return s?.home != null ? s : null; }
  } catch { /* ingestion not running */ }
  return null;
}

// Shape one API market row into the object the UI trades on, resolving names locally and
// deriving the YES/NO mints from the address (no chain read needed).
function shapeApiMarket(m) {
  const marketPk = new PublicKey(m.address);
  const fx = FIXTURES_BY_ID.get(m.fixtureId);
  const total = m.liquidity ?? (m.yesReserve + m.noReserve);
  // a market past its close time still reports state "trading" on-chain, but the program
  // rejects trades after it, so treat it as closed in the UI
  const closed = m.closeTs && Date.now() / 1000 > m.closeTs;
  const state = m.state === "trading" && closed ? "closed" : m.state;
  return {
    address: m.address, fixtureId: m.fixtureId,
    home: fx?.home ?? "Home", away: fx?.away ?? "Away", kickoff: fx?.kickoff ?? null,
    state, yesReserve: m.yesReserve, noReserve: m.noReserve, liquidity: total,
    yesPrice: total > 0 ? m.noReserve / total : 0.5, feeBps: m.feeBps,
    yesMint: seed("yes", marketPk).toBase58(), noMint: seed("no", marketPk).toBase58(),
    collateralMint: m.collateralMint, terms: m.terms ?? { statAKey: 1, op: "subtract", threshold: 0 },
  };
}

/// A live market: on-chain state plus current reserves and the implied YES price. Reads the
/// list from the API (which does the one getProgramAccounts scan), so clients work on RPC
/// tiers that block getProgramAccounts, like Alchemy's free tier. Falls back to a direct scan
/// only if the API is unreachable.
export async function fetchMarkets() {
  try {
    const r = await fetch(`${API}/markets`);
    if (!r.ok) throw new Error(String(r.status));
    const { markets } = await r.json();
    return markets.filter((m) => m.kind === "amm").map(shapeApiMarket).sort((a, b) => b.liquidity - a.liquidity);
  } catch {
    return fetchMarketsOnChain(); // API down: direct scan (needs a getProgramAccounts-capable RPC)
  }
}

async function fetchMarketsOnChain() {
  const all = await marketRead.account.market.all();
  const out = [];
  for (const { publicKey, account } of all) {
    let y = 0, n = 0;
    try {
      const [yb, nb] = await Promise.all([
        connection.getTokenAccountBalance(seed("yes_pool", publicKey)),
        connection.getTokenAccountBalance(seed("no_pool", publicKey)),
      ]);
      y = Number(yb.value.amount); n = Number(nb.value.amount);
    } catch { /* pools not funded yet */ }
    const total = y + n;
    const fixtureId = account.terms.fixtureId.toNumber();
    const fx = FIXTURES_BY_ID.get(fixtureId);
    out.push({
      address: publicKey.toBase58(), fixtureId,
      home: fx?.home ?? "Home", away: fx?.away ?? "Away", kickoff: fx?.kickoff ?? null,
      state: Object.keys(account.state)[0], yesReserve: y, noReserve: n, liquidity: total,
      yesPrice: total > 0 ? n / total : 0.5, feeBps: account.feeBps,
      yesMint: seed("yes", publicKey).toBase58(), noMint: seed("no", publicKey).toBase58(),
      collateralMint: account.collateralMint.toBase58(),
      terms: { statAKey: account.terms.statAKey, statBKey: account.terms.statBKey ?? null,
        op: account.terms.op ? Object.keys(account.terms.op)[0] : null, threshold: account.terms.predicate.threshold,
        comparison: account.terms.predicate.comparison ? Object.keys(account.terms.predicate.comparison)[0] : null },
    });
  }
  return out.sort((a, b) => b.liquidity - a.liquidity);
}

// quote helpers mirror the on-chain FPMM so the UI can show shares and price impact
export function quoteBuy(yesReserve, noReserve, collateralIn, side, feeBps) {
  const fee = Math.floor((collateralIn * feeBps) / 10_000);
  const net = collateralIn - fee;
  const [rOut, rOther] = side === "yes" ? [yesReserve, noReserve] : [noReserve, yesReserve];
  const newOut = Math.ceil((rOut * rOther) / (rOther + net));
  const sharesOut = rOut + net - newOut;
  const y2 = side === "yes" ? newOut + fee : yesReserve + net + fee;
  const n2 = side === "yes" ? noReserve + net + fee : newOut + fee;
  return { sharesOut, priceAfter: (y2 + n2) > 0 ? n2 / (y2 + n2) : 0.5 }; // yes price = noReserve/total, either side
}

// mirrors math::calc_sell in programs/market/src/math.rs exactly (ceiling division, no fee:
// the sell instruction charges none). BigInt so it matches the on-chain u128 math exactly.
function calcSellExact(reserveOut, reserveOther, collateralOut) {
  if (collateralOut <= 0n) return 0n;
  if (collateralOut >= reserveOther) return null; // cannot drain more than the opposite reserve holds
  const denom = reserveOther - collateralOut;
  const sum = reserveOut + reserveOther - collateralOut;
  const numer = collateralOut * sum;
  return (numer + denom - 1n) / denom; // ceiling division
}

// calc_sell has no closed-form inverse worth hand-deriving on a money path, so this finds the
// largest collateral_out whose required shares_in stays at or under what the trader offered, by
// binary search over the exact integer formula above. Always safe: on-chain slippage check is
// shares_in <= max_shares_in, and this never returns a collateralOut that needs more.
export function quoteSell(yesReserve, noReserve, sharesIn, side) {
  const [rOut, rOther] = side === "yes" ? [BigInt(yesReserve), BigInt(noReserve)] : [BigInt(noReserve), BigInt(yesReserve)];
  const budget = BigInt(Math.floor(sharesIn));
  if (budget <= 0n || rOther <= 1n) return { collateralOut: 0, sharesIn: 0, priceAfter: 0.5 };
  let lo = 0n, hi = rOther - 1n, best = 0n;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const need = calcSellExact(rOut, rOther, mid);
    if (need !== null && need <= budget) { best = mid; lo = mid + 1n; } else hi = mid - 1n;
  }
  const actualSharesIn = calcSellExact(rOut, rOther, best) ?? 0n;
  const rOutAfter = rOut + actualSharesIn - best;
  const rOtherAfter = rOther - best;
  const total = rOutAfter + rOtherAfter;
  const priceAfter = total > 0n
    ? Number(side === "yes" ? rOtherAfter : rOutAfter) / Number(total)
    : 0.5;
  return { collateralOut: Number(best), sharesIn: Number(actualSharesIn), priceAfter };
}

// A trader's YES/NO share balances for one market, read straight off their token accounts.
export async function fetchPosition(m, owner) {
  const ownerPk = new PublicKey(owner);
  const yesAta = getAssociatedTokenAddressSync(new PublicKey(m.yesMint), ownerPk);
  const noAta = getAssociatedTokenAddressSync(new PublicKey(m.noMint), ownerPk);
  const bal = async (a) => { try { return Number((await connection.getTokenAccountBalance(a)).value.amount); } catch { return 0; } };
  const [yes, no] = await Promise.all([bal(yesAta), bal(noAta)]);
  return { yes, no };
}

const ataIx = (mint, owner, payer) => {
  const addr = getAssociatedTokenAddressSync(mint, owner);
  return { addr, ix: createAssociatedTokenAccountIdempotentInstruction(payer, addr, owner, mint) };
};

// Market templates. Every one settles through the SAME validate_stat CPI on the TxLINE
// Merkle proof, so a corners prop resolves as trustlessly as the match winner, with no human
// grader and no dispute window. TxLINE stat keys: 1/2 goals, 3/4 yellow cards, 7/8 corners.
export const MARKET_TEMPLATES = {
  winner:  { label: "Match winner",       statAKey: 1, statBKey: 2, op: "subtract", line: 0, needsLine: false, unit: "" },
  goals:   { label: "Total goals O/U",    statAKey: 1, statBKey: 2, op: "add",      line: 2, needsLine: true,  unit: "goals" },
  corners: { label: "Total corners O/U",  statAKey: 7, statBKey: 8, op: "add",      line: 9, needsLine: true,  unit: "corners" },
  cards:   { label: "Total yellow cards O/U", statAKey: 3, statBKey: 4, op: "add",  line: 3, needsLine: true,  unit: "yellow cards" },
};

export function buildTerms(fixtureId, templateKey, line) {
  const t = MARKET_TEMPLATES[templateKey];
  const threshold = t.needsLine ? Math.max(0, Math.floor(Number(line))) : t.line;
  return {
    fixtureId: new BN(fixtureId), statAKey: t.statAKey, statBKey: t.statBKey,
    op: t.op === "add" ? { add: {} } : { subtract: {} },
    predicate: { threshold, comparison: { greaterThan: {} } },
  };
}

// Human question + YES/NO meaning for a market, derived from its on-chain terms, so a card
// reads "Over 9 total corners?" instead of always "home beats away".
export function describeMarket(terms, home, away) {
  const a = terms.statAKey, n = terms.threshold;
  const isAdd = terms.op === "add" || terms.op?.add !== undefined;
  const leg = resultLeg(terms);
  if (leg === "home") return { kind: "Home win", question: `Will ${home} beat ${away}?`, yes: `${home} wins`, no: `${home} does not win` };
  if (leg === "draw") return { kind: "Draw", question: `Will ${home} v ${away} end level?`, yes: "it ends in a draw", no: "not a draw" };
  if (leg === "away") return { kind: "Away win", question: `Will ${away} beat ${home}?`, yes: `${away} wins`, no: `${away} does not win` };
  if (a === 1 && !isAdd) return { kind: "Winner", question: `Will ${home} beat ${away}?`, yes: `${home} wins`, no: `${home} does not win` };
  if (a === 1 && isAdd)  return { kind: "Total goals", question: `Over ${n} total goals?`, yes: `over ${n} goals`, no: `${n} goals or fewer` };
  if (a === 7 && isAdd)  return { kind: "Corners", question: `Over ${n} total corners?`, yes: `over ${n} corners`, no: `${n} corners or fewer` };
  if (a === 3 && isAdd)  return { kind: "Cards", question: `Over ${n} yellow cards?`, yes: `over ${n} cards`, no: `${n} cards or fewer` };
  return { kind: "Prop", question: `${home} v ${away}`, yes: "YES", no: "NO" };
}

/// create_market: opens a binary market for any template (winner, totals, corners, cards).
export async function createMarketTx(wallet, { fixtureId, collateralMint, closeTs, expiryTs, feeBps = 200, template = "winner", line = 0 }) {
  const program = marketFor(wallet);
  const marketId = (BigInt(Date.now()) << 6n) + BigInt(Math.floor(Math.random() * 64));
  const P = marketPdas(wallet.publicKey, marketId.toString());
  const terms = buildTerms(fixtureId, template, line);
  await program.methods
    .createMarket(new BN(marketId.toString()), terms, new BN(closeTs), new BN(expiryTs), feeBps)
    .accountsPartial({
      creator: wallet.publicKey, market: P.market, collateralMint: new PublicKey(collateralMint),
      yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .rpc();
  return P.market.toBase58();
}

/// add_liquidity: seed or top up a market's pools. A freshly created market starts at zero
/// reserves and cannot be traded until someone funds it; this is that step.
export async function addLiquidityTx(wallet, m, amount) {
  const program = marketFor(wallet);
  const market = new PublicKey(m.address);
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
    vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const usdcMint = (await marketRead.account.market.fetch(market)).collateralMint;
  const pre = [];
  const col = ataIx(usdcMint, wallet.publicKey, wallet.publicKey); pre.push(col.ix);
  const yes = ataIx(P.yesMint, wallet.publicKey, wallet.publicKey); pre.push(yes.ix);
  const no = ataIx(P.noMint, wallet.publicKey, wallet.publicKey); pre.push(no.ix);
  const lp = ataIx(P.lpMint, wallet.publicKey, wallet.publicKey); pre.push(lp.ix);
  pre.push(anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  return program.methods
    .addLiquidity(new BN(amount))
    .accountsPartial({
      provider: wallet.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint,
      vault: P.vault, yesPool: P.yesPool, noPool: P.noPool,
      providerCollateral: col.addr, providerYes: yes.addr, providerNo: no.addr, providerLp: lp.addr,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(pre).rpc();
}

export async function buyTx(wallet, m, collateralIn, side, minSharesOut) {
  const program = marketFor(wallet);
  const market = new PublicKey(m.address);
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), vault: seed("vault", market),
    yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const usdcMint = (await marketRead.account.market.fetch(market)).collateralMint;
  const pre = [];
  const col = ataIx(usdcMint, wallet.publicKey, wallet.publicKey); pre.push(col.ix);
  const yes = ataIx(P.yesMint, wallet.publicKey, wallet.publicKey); pre.push(yes.ix);
  const no = ataIx(P.noMint, wallet.publicKey, wallet.publicKey); pre.push(no.ix);
  pre.push(anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  return execute(program.methods
    .buy(new BN(collateralIn), side === "yes" ? { yes: {} } : { no: {} }, new BN(minSharesOut))
    .accountsPartial({
      trader: wallet.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, vault: P.vault,
      yesPool: P.yesPool, noPool: P.noPool, traderCollateral: col.addr, traderYes: yes.addr, traderNo: no.addr,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions(pre), wallet);
}

export async function sellTx(wallet, m, collateralOut, side, maxSharesIn) {
  const program = marketFor(wallet);
  const market = new PublicKey(m.address);
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), vault: seed("vault", market),
    yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const usdcMint = (await marketRead.account.market.fetch(market)).collateralMint;
  const col = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  const yes = getAssociatedTokenAddressSync(P.yesMint, wallet.publicKey);
  const no = getAssociatedTokenAddressSync(P.noMint, wallet.publicKey);
  return execute(program.methods
    .sell(new BN(collateralOut), side === "yes" ? { yes: {} } : { no: {} }, new BN(maxSharesIn))
    .accountsPartial({
      trader: wallet.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, vault: P.vault,
      yesPool: P.yesPool, noPool: P.noPool, traderCollateral: col, traderYes: yes, traderNo: no,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]), wallet);
}
