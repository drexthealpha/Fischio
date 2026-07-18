// Retire the markets the old seeders left behind.
//
// WHY THEY EXIST
//
// scripts/seed-*.mjs assigned each market a random id (`Date.now() << 6 | random()`), so their
// markets sit at addresses nobody can re-derive from the terms. bot/market-factory.mjs derives the
// id from the terms instead, and when it looked for an existing market at the derived address it
// found nothing and opened its own. Fixture 18257739 ended up with 16 accounts for 11 propositions.
//
// Two pools on one bet is not cosmetic. Liquidity splits across them, they quote different prices
// with no way to arbitrage between them, and a reader has no way to tell which one is the market.
//
// WHAT THIS DOES
//
// Withdraws the liquidity from every non-canonical market on a fixture and hands the collateral
// back. A market with no liquidity has no price and no depth, so it stops competing with the real
// one. The account itself stays on chain, because the program has no close instruction and inventing
// one for tidiness would be a change to a money path for no benefit.
//
// WHAT IT REFUSES TO DO
//
// It only ever touches a market whose stored id differs from the id derived from its own terms. A
// canonical market fails that test by definition, so this cannot drain the live board even if
// pointed at the wrong fixture. It also refuses to touch a market that is already resolved, since
// holders still need to redeem against it.
//
//   node bot/retire-legacy-markets.mjs --fixture 18257739 --dry-run
//   node bot/retire-legacy-markets.mjs --fixture 18257739

import "../lib/env.mjs";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { marketIdOf } from "../lib/market-id.mjs";
import { normalizeTerms, termsKey } from "../lib/market-link.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FIXTURE = Number(flag("fixture", process.env.FIXTURE ?? 18257739));
const DRY = argv.includes("--dry-run") || argv.includes("--shadow");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const connection = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  process.env.KEYPAIR_JSON ?? readFileSync("local/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
const PID = program.programId;
const BN = anchor.BN;
const CU = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const seed = (s, m) => PublicKey.findProgramAddressSync([Buffer.from(s), m.toBuffer()], PID)[0];
const U = 1_000_000;

const all = await program.account.market.all();
const mine = all.filter(({ account }) => Number(account.terms.fixtureId) === FIXTURE);
log(`fixture ${FIXTURE}: ${mine.length} market accounts`);

const legacy = [];
for (const { publicKey, account } of mine) {
  const terms = normalizeTerms(account.terms);
  const tk = termsKey(terms);
  let derived = null;
  try { derived = marketIdOf(FIXTURE, terms); } catch { /* terms that do not settle have no derived id */ }
  const stored = BigInt(account.marketId.toString());
  const canonical = derived != null && stored === derived;
  if (canonical) continue;
  // A resolved market still has holders redeeming against it, so its pools stay where they are.
  const state = account.state ? Object.keys(account.state)[0] : "unknown";
  legacy.push({ address: publicKey, account, termsKey: tk, state, derivable: derived != null });
}

if (!legacy.length) { log("no legacy markets on this fixture, nothing to retire"); process.exit(0); }
log(`${legacy.length} legacy market(s) to retire:`);

let retired = 0, skipped = 0, failed = 0;
for (const l of legacy) {
  const lpMint = seed("lp", l.address);
  const yesPool = seed("yes_pool", l.address);
  const noPool = seed("no_pool", l.address);
  const y = BigInt((await connection.getTokenAccountBalance(yesPool).catch(() => ({ value: { amount: "0" } }))).value.amount);
  const n = BigInt((await connection.getTokenAccountBalance(noPool).catch(() => ({ value: { amount: "0" } }))).value.amount);

  if (l.state !== "trading") {
    log(`  skip ${l.address.toBase58().slice(0, 8)} ${l.termsKey}: state is ${l.state}, holders still redeem against it`);
    skipped++; continue;
  }
  if (y + n === 0n) {
    log(`  already empty ${l.address.toBase58().slice(0, 8)}  ${l.termsKey}`);
    skipped++; continue;
  }

  const lpAta = (await getOrCreateAssociatedTokenAccount(connection, payer, lpMint, payer.publicKey)).address;
  const lpHeld = BigInt((await connection.getTokenAccountBalance(lpAta).catch(() => ({ value: { amount: "0" } }))).value.amount);
  if (lpHeld === 0n) {
    // Someone else provided this liquidity. Draining it is not ours to do.
    log(`  skip ${l.address.toBase58().slice(0, 8)} ${l.termsKey}: we hold no LP, liquidity is someone else's`);
    skipped++; continue;
  }

  log(`  retire ${l.address.toBase58().slice(0, 8)}  ${l.termsKey}  pools ${Number(y + n) / 2 / U}, our LP ${Number(lpHeld) / U}`);
  if (DRY) { retired++; continue; }

  try {
    const yesMint = seed("yes", l.address), noMint = seed("no", l.address);
    const yesAta = (await getOrCreateAssociatedTokenAccount(connection, payer, yesMint, payer.publicKey)).address;
    const noAta = (await getOrCreateAssociatedTokenAccount(connection, payer, noMint, payer.publicKey)).address;
    await program.methods.removeLiquidity(new BN(lpHeld.toString()))
      .accountsPartial({
        provider: payer.publicKey, market: l.address, lpMint, yesPool, noPool,
        providerLp: lpAta, providerYes: yesAta, providerNo: noAta, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU]).rpc();
    const y2 = BigInt((await connection.getTokenAccountBalance(yesPool)).value.amount);
    const n2 = BigInt((await connection.getTokenAccountBalance(noPool)).value.amount);
    log(`    withdrawn, pools now ${Number(y2 + n2) / 2 / U}`);
    retired++;
  } catch (e) {
    log(`    FAILED: ${String(e.message ?? e).slice(0, 160)}`);
    failed++;
  }
}

log(`${DRY ? "DRY RUN. would retire" : "retired"} ${retired}, skipped ${skipped}, failed ${failed}`);
if (failed) process.exitCode = 1;
