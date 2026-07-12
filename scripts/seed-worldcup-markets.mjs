// Seed a full match-result market (1X2) for every remaining World Cup fixture: one leg for
// Home win, one for Draw, one for Away win. A football result has three outcomes, not two, so
// each fixture gets three linked binary markets whose prices add up to one, the same way a
// bookmaker or Polymarket group works.
//
// Each leg opens at the line the market already implies, not 50/50. TxLINE publishes
// demargined consensus odds (the vig removed), so the fair opening price for "home wins" is
// the crowd's home-win probability, for "draw" the draw probability, and so on. We read all
// three, create whichever legs are missing, seed liquidity, then push each price to its line
// with one trade.
//
//   RPC=<url> node scripts/seed-worldcup-markets.mjs
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { txlineClient, impliedResult } from "../lib/txline.mjs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const INGEST = process.env.INGEST ?? "http://127.0.0.1:8795";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const { mint: usdcStr } = JSON.parse(readFileSync("day1/devnet-usdc.json", "utf8"));
const usdc = new PublicKey(usdcStr);
const idl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const tx = txlineClient();
const BN = anchor.BN, U = 1_000_000, LIQ = 1000, CU = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];

// the three legs of a match result: home goals minus away goals, compared to zero
const LEGS = [
  { leg: "home", comparison: { greaterThan: {} } },
  { leg: "draw", comparison: { equalTo: {} } },
  { leg: "away", comparison: { lessThan: {} } },
];
function legOf(t) {
  if (!(t.statAKey === 1 && t.statBKey === 2 && "subtract" in t.op)) return null;
  if (Number(t.predicate.threshold) !== 0) return null;
  const c = t.predicate.comparison;
  return "greaterThan" in c ? "home" : "equalTo" in c ? "draw" : "lessThan" in c ? "away" : null;
}

// mirror of the on-chain FPMM buy, to size the opening trade (programs/market/src/math.rs)
function priceAfterBuy(yesR, noR, cIn, side, feeBps = 200) {
  const fee = Math.floor((cIn * feeBps) / 10000), net = cIn - fee;
  const [rOut, rOther] = side === "yes" ? [yesR, noR] : [noR, yesR];
  const newOut = Math.ceil((rOut * rOther) / (rOther + net));
  const y2 = side === "yes" ? newOut + fee : yesR + net + fee;
  const n2 = side === "yes" ? noR + net + fee : newOut + fee;
  return y2 + n2 > 0 ? n2 / (y2 + n2) : 0.5; // yes price is always noReserve/total, regardless of side
}
function openingTrade(targetP) {
  const R = LIQ * U, side = targetP > 0.5 ? "yes" : "no";
  let lo = 0, hi = 8 * R, best = 0;
  for (let i = 0; i < 44; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const reached = side === "yes" ? priceAfterBuy(R, R, mid, side) >= targetP : priceAfterBuy(R, R, mid, side) <= targetP;
    if (reached) { best = mid; hi = mid; } else lo = mid;
  }
  return { side, collateral: best };
}

// legs that already trade, keyed by fixtureId:leg, so we only create what is missing
async function existingLegs() {
  const now = Date.now() / 1000, have = new Set();
  for (const { account } of await program.account.market.all()) {
    const leg = legOf(account.terms);
    if (leg && Object.keys(account.state)[0] === "trading" && account.closeTs.toNumber() > now) {
      have.add(`${account.terms.fixtureId.toNumber()}:${leg}`);
    }
  }
  return have;
}

async function seedLeg(fx, comparison, targetP) {
  const closeTs = Math.floor(new Date(fx.kickoff).getTime() / 1000);
  const marketId = (BigInt(Date.now()) << 6n) + BigInt(Math.floor(Math.random() * 64));
  const market = PublicKey.findProgramAddressSync([Buffer.from("market"), payer.publicKey.toBuffer(), new BN(marketId.toString()).toArrayLike(Buffer, "le", 8)], PID)[0];
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market), vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  const terms = { fixtureId: new BN(fx.id), statAKey: 1, statBKey: 2, op: { subtract: {} }, predicate: { threshold: 0, comparison } };
  await program.methods.createMarket(new BN(marketId.toString()), terms, new BN(closeTs), new BN(closeTs + 8 * 3600), 200)
    .accountsPartial({ creator: payer.publicKey, market, collateralMint: usdc, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY }).preInstructions([CU]).rpc();
  const col = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, payer.publicKey)).address;
  const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
  const no = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
  const lp = (await getOrCreateAssociatedTokenAccount(connection, payer, P.lpMint, payer.publicKey)).address;
  await program.methods.addLiquidity(new BN(LIQ * U)).accountsPartial({ provider: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, providerCollateral: col, providerYes: yes, providerNo: no, providerLp: lp, tokenProgram: TOKEN_PROGRAM_ID }).preInstructions([CU]).rpc();
  const { side, collateral } = openingTrade(Math.max(0.03, Math.min(0.97, targetP)));
  if (collateral > 0) {
    await program.methods.buy(new BN(collateral), side === "yes" ? { yes: {} } : { no: {} }, new BN(0))
      .accountsPartial({ trader: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, traderCollateral: col, traderYes: yes, traderNo: no, tokenProgram: TOKEN_PROGRAM_ID }).preInstructions([CU]).rpc();
  }
  const y = Number((await connection.getTokenAccountBalance(P.yesPool)).value.amount);
  const n = Number((await connection.getTokenAccountBalance(P.noPool)).value.amount);
  return n / (y + n); // opened price
}

const fixtures = JSON.parse(readFileSync("app/src/fixtures.json", "utf8")).fixtures;
const now = Date.now();
const upcoming = fixtures.filter((f) => new Date(f.kickoff).getTime() > now + 20 * 60 * 1000).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
console.log(`${upcoming.length} upcoming fixtures on ${RPC.includes("helius") ? "helius" : RPC}`);
const have = await existingLegs();

// the demargined 1X2 row is intermittent in a single snapshot, so prefer the ingest cache
// (which keeps the last good line from its streams) and fall back to sampling the feed a few times
async function liveImplied(fixtureId) {
  try { const r = await fetch(`${INGEST}/live/${fixtureId}`); if (r.ok) { const s = await r.json(); if (s?.implied?.home != null) return s.implied; } } catch { /* ingest down */ }
  for (let i = 0; i < 4; i++) {
    try { const p = impliedResult(await tx.oddsSnapshot(fixtureId)); if (p) return p; } catch { /* skip */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

for (const fx of upcoming) {
  const prob = await liveImplied(fx.id);
  if (!prob) { console.log(`skip ${fx.home} v ${fx.away} (no odds yet)`); continue; }
  const opened = [];
  for (const { leg, comparison } of LEGS) {
    if (have.has(`${fx.id}:${leg}`)) { opened.push(`${leg} exists`); continue; }
    try {
      const price = await seedLeg(fx, comparison, prob[leg]);
      opened.push(`${leg} ${(price * 100).toFixed(0)}%`);
    } catch (e) {
      opened.push(`${leg} FAILED:${String(e.message ?? e).slice(0, 40)}`);
    }
  }
  console.log(`${fx.home} v ${fx.away}: ${opened.join("  |  ")}   (TxLINE ${(prob.home * 100).toFixed(0)}/${(prob.draw * 100).toFixed(0)}/${(prob.away * 100).toFixed(0)})`);
}
console.log("done");
