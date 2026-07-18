// fischio odds keeper: keeps every home-win AMM market tracking the live TxLINE line.
//
// TxLINE publishes demargined consensus probabilities, the crowd's view with the bookmaker
// margin removed. That is the fair price for a "home wins" market. This keeper reads that line
// for each open market's fixture, compares it to the market's on-chain price, and when the two
// drift apart it buys the cheaper side just enough to push the price back to the line. So when
// the odds move on the feed, the price on fischio moves too. It is permissionless: anyone can
// run it, it holds no special key, and every correction is a public on-chain trade.
//
// It reads the live line from the ingestion service (services/ingest) so it never has to hold
// TxLINE credentials, and falls back to a direct TxLINE read if ingestion is down.
//
//   node bot/odds-keeper.mjs                       # loop, ingest at :8795, RPC from env
//   flags: --drift 0.02  --interval 15000  --max 400  --once  --dry  --rpc <url>  --ingest <url>
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { txlineClient, impliedResult } from "../lib/txline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(`--${k}`);

const RPC = arg("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
const INGEST = arg("ingest", process.env.INGEST ?? "http://127.0.0.1:8795");
const DRIFT = Number(arg("drift", 0.02));        // realign only when price is this far off the line
const INTERVAL = Number(arg("interval", 15000)); // how often to sweep every market
const MAX = Number(arg("max", 400));             // cap collateral per correction, in fUSDC
const ONCE = has("once");
const DRY = has("dry");
const U = 1_000_000;

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(root, "local/devnet-wallet.json"), "utf8"))));
const { mint: usdcStr } = JSON.parse(readFileSync(join(root, "local/devnet-usdc.json"), "utf8"));
const usdc = new PublicKey(usdcStr);
const idl = JSON.parse(readFileSync(join(root, "target/idl/fischio_market.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const tx = txlineClient();
const BN = anchor.BN, CU = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// mirror of the on-chain FPMM buy (programs/market/src/math.rs), to size a correction
function priceAfterBuy(yesR, noR, cIn, side, feeBps = 200) {
  const fee = Math.floor((cIn * feeBps) / 10000), net = cIn - fee;
  const [rOut, rOther] = side === "yes" ? [yesR, noR] : [noR, yesR];
  const newOut = Math.ceil((rOut * rOther) / (rOther + net));
  const y2 = side === "yes" ? newOut + fee : yesR + net + fee;
  const n2 = side === "yes" ? noR + net + fee : newOut + fee;
  return y2 + n2 > 0 ? n2 / (y2 + n2) : 0.5; // yes price is always noReserve/total, regardless of side
}
// smallest buy that moves the current price to the target, on the side that pushes it there
function tradeToTarget(yesR, noR, targetP) {
  const cur = noR / (yesR + noR);                 // current home (YES) price
  const side = targetP > cur ? "yes" : "no";
  let lo = 0, hi = 40 * (yesR + noR), best = 0;
  for (let i = 0; i < 50; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const p = priceAfterBuy(yesR, noR, mid, side);
    const reached = side === "yes" ? p >= targetP : p <= targetP;
    if (reached) { best = mid; hi = mid; } else lo = mid;
  }
  return { side, collateral: best, cur };
}

// which 1X2 result leg a market is (home / draw / away), from its predicate on home goals
// minus away goals: greater than zero is home, equal is a draw, less than zero is away.
function resultLeg(t) {
  if (!(t.statAKey === 1 && t.statBKey === 2 && "subtract" in t.op)) return null;
  if (Number(t.predicate.threshold) !== 0) return null;
  const c = t.predicate.comparison;
  if ("greaterThan" in c) return "home";
  if ("equalTo" in c) return "draw";
  if ("lessThan" in c) return "away";
  return null;
}

// live 1X2 probabilities for a fixture: ingestion first, direct TxLINE as a fallback
async function liveImplied(fixtureId) {
  try {
    const r = await fetch(`${INGEST}/live/${fixtureId}`);
    if (r.ok) { const s = await r.json(); if (s?.implied?.home != null) return s.implied; }
  } catch { /* ingestion down, fall through */ }
  try { return impliedResult(await tx.oddsSnapshot(fixtureId)); } catch { return null; }
}

const ataCache = new Map();
async function atas(m, P) {
  const key = m.toBase58();
  if (!ataCache.has(key)) {
    ataCache.set(key, {
      col: (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, payer.publicKey)).address,
      yes: (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address,
      no: (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address,
    });
  }
  return ataCache.get(key);
}

async function sweep() {
  const now = Date.now() / 1000;
  let all;
  try { all = await program.account.market.all(); }
  catch (e) { log("cannot read markets:", String(e.message ?? e)); return; }

  for (const { publicKey: m, account: a } of all) {
    if (Object.keys(a.state)[0] !== "trading" || a.closeTs.toNumber() <= now) continue;
    const leg = resultLeg(a.terms);
    if (!leg) continue;
    const fixtureId = a.terms.fixtureId.toNumber();
    const implied = await liveImplied(fixtureId);
    if (!implied || implied[leg] == null) continue;
    const tgt = clamp(implied[leg], 0.03, 0.97);

    const P = { yesMint: seed("yes", m), noMint: seed("no", m), vault: seed("vault", m), yesPool: seed("yes_pool", m), noPool: seed("no_pool", m) };
    let yesR, noR;
    try {
      yesR = Number((await connection.getTokenAccountBalance(P.yesPool)).value.amount);
      noR = Number((await connection.getTokenAccountBalance(P.noPool)).value.amount);
    } catch { continue; }
    if (!yesR || !noR) continue;

    const cur = noR / (yesR + noR);
    if (Math.abs(cur - tgt) < DRIFT) continue; // already tracking the line

    let { side, collateral } = tradeToTarget(yesR, noR, tgt);
    collateral = Math.min(collateral, MAX * U);   // never spend more than the cap on one nudge
    if (collateral < 1 * U) continue;             // too small to matter

    const label = `${fixtureId} ${leg} ${(cur * 100).toFixed(0)}% -> line ${(tgt * 100).toFixed(0)}%`;
    if (DRY) { log(`would ${side} ${(collateral / U).toFixed(0)} fUSDC  (${label})`); continue; }
    try {
      const { col, yes, no } = await atas(m, P);
      await program.methods.buy(new BN(collateral), side === "yes" ? { yes: {} } : { no: {} }, new BN(0))
        .accountsPartial({ trader: payer.publicKey, market: m, yesMint: P.yesMint, noMint: P.noMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, traderCollateral: col, traderYes: yes, traderNo: no, tokenProgram: TOKEN_PROGRAM_ID })
        .preInstructions([CU]).rpc();
      const y2 = Number((await connection.getTokenAccountBalance(P.yesPool)).value.amount);
      const n2 = Number((await connection.getTokenAccountBalance(P.noPool)).value.amount);
      log(`realigned ${label} -> now ${((n2 / (y2 + n2)) * 100).toFixed(0)}%  (${side} ${(collateral / U).toFixed(0)} fUSDC)`);
    } catch (e) { log(`skip ${label}: ${String(e.message ?? e).slice(0, 90)}`); }
  }
}

log(`odds keeper on ${RPC.includes("helius") ? "helius" : RPC}; ingest ${INGEST}; drift ${DRIFT}, cap ${MAX} fUSDC${DRY ? " (dry run)" : ""}`);
await sweep();
if (!ONCE) setInterval(sweep, INTERVAL);
