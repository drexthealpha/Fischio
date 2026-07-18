// Open the clean total-goals markets on one match, priced at the real line.
//
// The board shows every line TxODDS quotes, but only the match result had a pool you could
// trade against. Everything else read "no pool open on it yet". This opens the total-goals
// markets that settle cleanly, so the most recognised prop in football, over or under so many
// goals, is actually tradeable.
//
// WHICH LINES, AND WHY ONLY THESE
//
// Only the full-match half-goal lines. A half-goal line has no draw: over 2.5 wins if three or
// more goals are scored, under 2.5 wins otherwise, and nothing sits in between, so a plain
// YES/NO market settles it exactly. A whole-goal line (over 2.0) pushes and refunds on exactly
// two goals, which a binary market cannot express, so it stays on the board as a price and does
// not get a pool. A quarter line splits the stake and is already shown as reference only.
//
// HOW IT SETTLES
//
// over X.5 goals == (P1 goals + P2 goals) > X. That is stat key 1 plus stat key 2, compared to
// the integer X, which is exactly the validate_stat predicate the market program already proves
// on the TxLINE Merkle root. Same trustless path as the match result, no new program code.
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { calcBuy, priceBps } from "../lib/amm.mjs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const FIXTURE = Number(process.argv[2] ?? process.env.FIXTURE ?? 18257739); // the final by default
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("local/devnet-wallet.json", "utf8"))));
const { mint: usdcStr } = JSON.parse(readFileSync("local/devnet-usdc.json", "utf8"));
const usdc = new PublicKey(usdcStr);
const idl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const BN = anchor.BN, U = 1_000_000n, LIQ = 1000n, CU = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];
const tx = txlineClient();

// Size the opening buy that moves a fresh 50/50 pool to the real line, using the same math the
// program runs. Reserves start equal at LIQ; buy the heavier side until the price reaches target.
function openingTrade(targetP) {
  const R = LIQ * U;
  const side = targetP > 0.5 ? "yes" : "no"; // yes price = no/(yes+no); buying yes raises it
  const target = BigInt(Math.round(Math.max(0.02, Math.min(0.98, targetP)) * 10_000));
  let lo = 0n, hi = 8n * R, best = 0n;
  for (let i = 0; i < 46; i++) {
    const mid = (lo + hi) / 2n;
    const [rOut, rOther] = side === "yes" ? [R, R] : [R, R];
    const out = calcBuy(rOut, rOther, mid);
    if (out == null) { hi = mid; continue; }
    // reserves after buying `side`: bought side draws down, other side gains
    const ny = side === "yes" ? R + mid - out : R + mid;
    const nn = side === "yes" ? R + mid : R + mid - out;
    const p = priceBps(ny, nn);
    const reached = side === "yes" ? p >= target : p <= target;
    if (reached) { best = mid; hi = mid; } else lo = mid;
  }
  return { side, collateral: best };
}

async function alreadyOpen(threshold) {
  for (const { account } of await program.account.market.all()) {
    const t = account.terms;
    if (Number(t.fixtureId) !== FIXTURE) continue;
    if (t.statAKey !== 1 || (t.statBKey ?? null) !== 2) continue;
    if (!t.op || !("add" in t.op)) continue;
    if (Number(t.predicate.threshold) === threshold) return true;
  }
  return false;
}

async function openTotals(line, overProb) {
  const threshold = Math.floor(line); // over X.5 == total > X
  if (await alreadyOpen(threshold)) { console.log(`  over/under ${line}: already open, skipping`); return; }

  const marketId = (BigInt(Date.now()) << 6n) + BigInt(Math.floor(Math.random() * 64));
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), payer.publicKey.toBuffer(), new BN(marketId.toString()).toArrayLike(Buffer, "le", 8)], PID)[0];
  const P = { yesMint: seed("yes", market), noMint: seed("no", market), lpMint: seed("lp", market),
    vault: seed("vault", market), yesPool: seed("yes_pool", market), noPool: seed("no_pool", market) };
  // YES = "over": (goals1 + goals2) > threshold
  const terms = { fixtureId: new BN(FIXTURE), statAKey: 1, statBKey: 2, op: { add: {} },
    predicate: { threshold, comparison: { greaterThan: {} } } };

  // close at the final's kickoff so trading stops when the match starts
  const fx = await tx.fixturesSnapshot(Math.floor(Date.now() / 86_400_000), 72).catch(() => null);
  const row = (fx ?? []).find((f) => Number(f.FixtureId) === FIXTURE);
  const closeTs = row?.StartTime ? Math.floor(Number(row.StartTime) / 1000) : Math.floor(Date.now() / 1000) + 3 * 3600;

  await program.methods.createMarket(new BN(marketId.toString()), terms, new BN(closeTs), new BN(closeTs + 8 * 3600), 200)
    .accountsPartial({ creator: payer.publicKey, market, collateralMint: usdc, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint,
      vault: P.vault, yesPool: P.yesPool, noPool: P.noPool, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY })
    .preInstructions([CU]).rpc();

  const col = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, payer.publicKey)).address;
  const yes = (await getOrCreateAssociatedTokenAccount(connection, payer, P.yesMint, payer.publicKey)).address;
  const no = (await getOrCreateAssociatedTokenAccount(connection, payer, P.noMint, payer.publicKey)).address;
  const lp = (await getOrCreateAssociatedTokenAccount(connection, payer, P.lpMint, payer.publicKey)).address;
  await program.methods.addLiquidity(new BN((LIQ * U).toString()))
    .accountsPartial({ provider: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault,
      yesPool: P.yesPool, noPool: P.noPool, providerCollateral: col, providerYes: yes, providerNo: no, providerLp: lp, tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([CU]).rpc();

  const { side, collateral } = openingTrade(overProb);
  if (collateral > 0n) {
    await program.methods.buy(new BN(collateral.toString()), side === "yes" ? { yes: {} } : { no: {} }, new BN(0))
      .accountsPartial({ trader: payer.publicKey, market, yesMint: P.yesMint, noMint: P.noMint, vault: P.vault,
        yesPool: P.yesPool, noPool: P.noPool, traderCollateral: col, traderYes: yes, traderNo: no, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions([CU]).rpc();
  }
  const y = Number((await connection.getTokenAccountBalance(P.yesPool)).value.amount);
  const n = Number((await connection.getTokenAccountBalance(P.noPool)).value.amount);
  const opened = n / (y + n);
  console.log(`  over/under ${line}: opened at ${(opened * 100).toFixed(1)}% over (target ${(overProb * 100).toFixed(1)}%)  ${market.toBase58()}`);
}

const board = parseMarkets((await tx.oddsSnapshot(FIXTURE)) ?? []);
const totals = board.filter((m) => m.type === "OVERUNDER_PARTICIPANT_GOALS" && m.period === "FT" && m.demargined
  && Math.abs((m.line % 1) - 0.5) < 1e-9); // half-goal lines only
if (!totals.length) { console.log(`No clean half-goal total lines on fixture ${FIXTURE} right now.`); process.exit(0); }

console.log(`Opening ${totals.length} total-goals markets on fixture ${FIXTURE}:`);
for (const m of totals.sort((a, b) => a.line - b.line)) {
  const over = m.outcomes.find((o) => /over/i.test(o.name));
  if (!over?.prob) { console.log(`  over/under ${m.line}: no over price, skipping`); continue; }
  await openTotals(m.line, over.prob);
}
console.log("done");
