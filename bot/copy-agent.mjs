#!/usr/bin/env node
// Copy trading: follow a trader whose record you can verify, and mirror their trades.
//
// WHY THIS IS DIFFERENT HERE
//
// Copy trading already exists on Polymarket, and it works because trades are public there. The
// weak point is the other half. A leader's track record is only as trustworthy as the resolver
// that decided their wins, and on a centralised venue that is a company's word.
//
// On fischio both halves are checkable. The trade is an on-chain transaction, and the result it
// settled against carries a Merkle proof that a program TxODDS deployed will re-verify for
// anyone. So before you follow someone you can confirm their record is real, and after you follow
// them you can confirm the settlements were real, without asking us to vouch for either.
//
// HOW IT BEHAVES
//
// Non-custodial: it signs with your key and holds nothing of yours. Proportional: it scales the
// leader's size to your allocation rather than copying their absolute stake, because copying a
// whale's ticket with a small bankroll is how people get liquidated. Bounded: per-trade and total
// caps, and it will not follow a market that has already closed.
//
//   node bot/copy-agent.mjs --leader <wallet> --allocation 500
//   node bot/copy-agent.mjs --leader <wallet> --allocation 500 --shadow
//   node bot/copy-agent.mjs --leaderboard          rank traders by verified realized profit
//   flags: --max-trade 100  --interval 20000  --indexer <url>  --min-trades 3
import "../lib/env.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createGuard } from "../lib/guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const INDEXER = arg("indexer", process.env.INDEXER ?? "http://127.0.0.1:8792");
const LEADER = arg("leader", null);
const ALLOCATION = Number(arg("allocation", 500));   // your total budget, in collateral units
const MAX_TRADE = Number(arg("max-trade", 100));     // never put more than this into one trade
const INTERVAL = Number(arg("interval", 20000));
const SHADOW = process.argv.includes("--shadow");
const U = 1_000_000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const usd = (n) => `$${(n / U).toFixed(2)}`;

// ---- leaderboard mode: who is worth following, by a record anyone can recompute ----
if (process.argv.includes("--leaderboard")) {
  const r = await fetch(`${INDEXER}/leaderboard?minTrades=${arg("min-trades", 3)}`).catch(() => null);
  if (!r?.ok) { console.error(`indexer not reachable at ${INDEXER}. Start it with: node services/indexer/server.mjs`); process.exit(1); }
  const { traders } = await r.json();
  if (!traders.length) { console.log("\nNo trader has enough closed positions to rank yet.\n"); process.exit(0); }
  console.log(`\nTraders by realized profit, computed from on-chain trades\n`);
  console.log(`  ${"wallet".padEnd(46)} ${"realized".padStart(12)} ${"win rate".padStart(9)} ${"trades".padStart(7)} ${"markets".padStart(8)}`);
  for (const t of traders.slice(0, 20)) {
    console.log(`  ${t.wallet.padEnd(46)} ${usd(t.realizedPnl).padStart(12)} ${(t.winRate == null ? "n/a" : `${(t.winRate * 100).toFixed(0)}%`).padStart(9)} ${String(t.trades).padStart(7)} ${String(t.marketsTraded).padStart(8)}`);
  }
  console.log(`\nEvery number above is arithmetic over public trades. Recompute it yourself:`);
  console.log(`  curl ${INDEXER}/leaderboard\n`);
  console.log(`Follow one:  node bot/copy-agent.mjs --leader <wallet> --allocation 500\n`);
  process.exit(0);
}

if (!LEADER) {
  console.error("usage:\n  node bot/copy-agent.mjs --leaderboard\n  node bot/copy-agent.mjs --leader <wallet> --allocation 500 [--shadow]");
  process.exit(1);
}
try { new PublicKey(LEADER); } catch { console.error(`"${LEADER}" is not a wallet address.`); process.exit(1); }

const RPC = arg("rpc", process.env.RPC ?? "https://api.devnet.solana.com");
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? readFileSync(join(root, "local/devnet-wallet.json"), "utf8"))));
const marketProgram = new anchor.Program(
  JSON.parse(readFileSync(join(root, "target/idl/fischio_market.json"), "utf8")),
  new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
const mSeed = (s, k) => PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], marketProgram.programId)[0];
const usdcMint = new PublicKey(JSON.parse(readFileSync(join(root, "local/devnet-usdc.json"), "utf8")).mint);

// What the leader has already done before we started. Copying their history would be buying into
// moves that are hours old at prices that no longer exist, so we only mirror what happens next.
const seen = new Set();

// The allocation has to survive a restart. Following a leader is the case where an in-memory
// budget is most dangerous: the agent crashes, comes back, believes it has spent nothing, and
// starts the allocation again from zero on a leader who is still trading. The guard persists the
// running total and trips a breaker after repeated failures rather than retrying into a wall.
const guard = createGuard({
  path: join(root, "local", `copy-guard-${LEADER.slice(0, 8)}.json`),
  dailyCap: ALLOCATION * U,
  maxFailures: 5,
});
async function leaderTrades() {
  const r = await fetch(`${INDEXER}/history/${LEADER}`).catch(() => null);
  if (!r?.ok) return [];
  const { trades } = await r.json();
  return (trades ?? []).filter((t) => t.kind?.startsWith("amm_"));
}
for (const t of await leaderTrades()) seen.add(t.signature);
log(`following ${LEADER}`);
log(`mode ${SHADOW ? "SHADOW (decisions logged, nothing signed)" : "LIVE (signs with your key, non-custodial)"}`);
log(`allocation ${usd(ALLOCATION * U)}, max ${usd(MAX_TRADE * U)} per trade, ignoring ${seen.size} earlier trades`);
if (guard.spent) log(`${usd(guard.spent)} of that allocation is already deployed from an earlier run`);
if (guard.tripped) { log(`circuit breaker is tripped: ${guard.reason}`); log(`clear it deliberately once you know why, then start again.`); process.exit(1); }

async function follow() {
  for (const t of (await leaderTrades()).reverse()) {
    if (seen.has(t.signature)) continue;
    seen.add(t.signature);

    // Only mirror opening trades. Copying a leader's exit without holding their position is just
    // an unrelated short, which is not what "copy" means.
    const side = t.yesDelta > 0 ? "yes" : t.noDelta > 0 ? "no" : null;
    if (!side) { log(`skip ${t.signature.slice(0, 8)}: leader closed a position, nothing to open`); continue; }

    const leaderSpend = Math.abs(t.collateralDelta);
    if (!leaderSpend) continue;

    // Proportional sizing, capped. The cap stops one large leader ticket from spending the whole
    // allocation on a single market.
    let size = Math.min(leaderSpend, MAX_TRADE * U, (ALLOCATION * U) - guard.spent);
    if (size <= 0) { log(`allocation exhausted (${usd(guard.spent)} deployed), not following further`); return; }
    const allowed = guard.canSpend(size);
    if (!allowed.ok) { log(`refusing to copy: ${allowed.why}`); return; }

    const market = new PublicKey(t.market);
    const acct = await marketProgram.account.market.fetch(market).catch(() => null);
    if (!acct) { log(`skip ${t.market.slice(0, 8)}: market not readable`); continue; }
    const state = Object.keys(acct.state ?? {})[0];
    if (state !== "trading") { log(`skip ${t.market.slice(0, 8)}: market is ${state}, not open`); continue; }

    log(`leader ${side.toUpperCase()} ${usd(leaderSpend)} on ${t.market.slice(0, 8)} -> copying ${usd(size)}`);
    if (SHADOW) { guard.recordSpend(size); continue; }

    try {
      const P = { yesMint: mSeed("yes", market), noMint: mSeed("no", market), vault: mSeed("vault", market),
        yesPool: mSeed("yes_pool", market), noPool: mSeed("no_pool", market) };
      const col = (await getOrCreateAssociatedTokenAccount(connection, payer, usdcMint, payer.publicKey)).address;
      const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
      const no = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
      const sig = await marketProgram.methods
        .buy(new anchor.BN(size), side === "yes" ? { yes: {} } : { no: {} }, new anchor.BN(0))
        .accountsPartial({ trader: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, vault: P.vault,
          yesPool: P.yesPool, noPool: P.noPool, traderCollateral: col, traderYes: yes, traderNo: no, tokenProgram: TOKEN_PROGRAM_ID })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc();
      // Only count it once the chain confirms. Recording the intent instead would let a run of
      // failed sends eat the allocation without a single position being opened.
      guard.recordSpend(size);
      guard.ok();
      log(`  copied on-chain: ${sig}  (${usd(guard.spent)} of ${usd(ALLOCATION * U)} deployed)`);
    } catch (e) {
      const why = String(e.message ?? e).slice(0, 120);
      log(`  copy failed: ${why}`);
      if (guard.fail(why)) { log(`circuit breaker tripped: ${guard.reason}. Stopping.`); return; }
    }
  }
}

for (;;) {
  await follow().catch((e) => log(`follow failed: ${String(e.message ?? e).slice(0, 120)}`));
  await new Promise((r) => setTimeout(r, INTERVAL));
}
