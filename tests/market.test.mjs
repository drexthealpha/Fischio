// Integration + adversarial suite for fischio-market, run against a local validator
// with the real cloned txoracle and daily-roots accounts. It exercises the whole loop
// with real USDC-style tokens and a real captured proof, and checks the solvency
// invariant (vault == YES supply == NO supply) after every state change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { summaryOf, statA, statB, nodes, rootsPda, epochDayOf, TXORACLE_ID } from "../lib/proof-marshal.mjs";

const BN = anchor.BN;
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_market.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PROGRAM_ID = program.programId;

const USA_BOSNIA = 18172379;
const finals = JSON.parse(readFileSync("test-fixtures/final-proofs.json", "utf8"));
const FINAL = finals["18172379:1054"]; // USA 2-0 Bosnia, period 5 -> YES (USA wins) resolves true
const MID = JSON.parse(readFileSync("test-fixtures/proof-mid-446.json", "utf8")); // period 0, mid-match

const U = 1_000_000; // 1 USDC at 6 decimals
let usdc; // test collateral mint

const pdas = (creator, marketId) => {
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), creator.toBuffer(), new BN(marketId).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
  const p = (s) => PublicKey.findProgramAddressSync([Buffer.from(s), market.toBuffer()], PROGRAM_ID)[0];
  return { market, yesMint: p("yes"), noMint: p("no"), lpMint: p("lp"), vault: p("vault"), yesPool: p("yes_pool"), noPool: p("no_pool") };
};

async function fundedActor(usdcAmount = 0) {
  const kp = Keypair.generate();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: LAMPORTS_PER_SOL }));
  await provider.sendAndConfirm(tx);
  if (usdcAmount > 0) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, usdc, kp.publicKey);
    await mintTo(connection, payer, usdc, ata.address, payer, usdcAmount);
  }
  return kp;
}
const ata = async (mint, owner) => (await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner, true)).address;
const bal = async (acc) => Number((await getAccount(connection, acc)).amount);
const supply = async (mint) => Number((await getMint(connection, mint)).supply);

async function assertInvariant(P, label) {
  const v = await bal(P.vault);
  const ys = await supply(P.yesMint);
  const ns = await supply(P.noMint);
  assert.equal(v, ys, `${label}: vault (${v}) must equal YES supply (${ys})`);
  assert.equal(v, ns, `${label}: vault (${v}) must equal NO supply (${ns})`);
}

const goalsTerms = () => ({
  fixtureId: new BN(USA_BOSNIA), statAKey: 1, statBKey: 2,
  op: { subtract: {} }, predicate: { threshold: 0, comparison: { greaterThan: {} } },
});

async function createMarket(creator, { feeBps = 200 } = {}) {
  const marketId = Date.now() % 1_000_000 + Math.floor(Math.random() * 1000);
  const P = pdas(creator.publicKey, marketId);
  const now = Math.floor(Date.now() / 1000);
  await program.methods
    .createMarket(new BN(marketId), goalsTerms(), new BN(now + 3600), new BN(now + 7200), feeBps)
    .accountsPartial({
      creator: creator.publicKey, market: P.market, collateralMint: usdc,
      yesMint: P.yesMint, noMint: P.noMint, lpMint: P.lpMint, vault: P.vault, yesPool: P.yesPool, noPool: P.noPool,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([creator])
    .rpc();
  return { marketId, ...P, creator };
}

async function addLiquidity(m, provider_, amount) {
  await program.methods.addLiquidity(new BN(amount))
    .accountsPartial({
      provider: provider_.publicKey, market: m.market, yesMint: m.yesMint, noMint: m.noMint, lpMint: m.lpMint,
      vault: m.vault, yesPool: m.yesPool, noPool: m.noPool,
      providerCollateral: await ata(usdc, provider_.publicKey), providerYes: await ata(m.yesMint, provider_.publicKey),
      providerNo: await ata(m.noMint, provider_.publicKey), providerLp: await ata(m.lpMint, provider_.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([provider_]).rpc();
}

const tradeAccounts = async (m, trader) => ({
  trader: trader.publicKey, market: m.market, yesMint: m.yesMint, noMint: m.noMint, vault: m.vault,
  yesPool: m.yesPool, noPool: m.noPool, traderCollateral: await ata(usdc, trader.publicKey),
  traderYes: await ata(m.yesMint, trader.publicKey), traderNo: await ata(m.noMint, trader.publicKey),
  tokenProgram: TOKEN_PROGRAM_ID,
});

async function resolveWith(m, pkg, resolver) {
  await program.methods
    .resolve(summaryOf(pkg), nodes(pkg.subTreeProof), nodes(pkg.mainTreeProof), statA(pkg), statB(pkg))
    .accountsPartial({
      resolver: resolver.publicKey, market: m.market,
      dailyScoresRoots: rootsPda(epochDayOf(pkg)), txoracleProgram: TXORACLE_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([resolver]).rpc();
}

const expectErr = async (p, code) => {
  try { await p; } catch (e) {
    const s = `${e}${e.logs ? e.logs.join("") : ""}`;
    if (s.includes(code)) return;
    throw new Error(`expected ${code}, got: ${s.slice(0, 200)}`);
  }
  throw new Error(`expected ${code}, but it succeeded`);
};

test("setup: mint test-USDC", async () => {
  usdc = await createMint(connection, payer, payer.publicKey, null, 6);
  assert.ok(usdc);
});

test("create + first liquidity opens at 50/50 and holds the invariant", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U);
  assert.equal(await bal(m.yesPool), 1000 * U);
  assert.equal(await bal(m.noPool), 1000 * U); // equal reserves == 50%
  assert.equal(await bal(await ata(m.lpMint, lp.publicKey)), 1000 * U);
  await assertInvariant(m, "after add_liquidity");
});

test("split mints a complete set, merge burns it back, invariant held throughout", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U); // vault, YES, and NO all at 1000
  const trader = await fundedActor(500 * U);
  const acc = {
    user: trader.publicKey, market: m.market, yesMint: m.yesMint, noMint: m.noMint, vault: m.vault,
    userYes: await ata(m.yesMint, trader.publicKey), userNo: await ata(m.noMint, trader.publicKey),
    userCollateral: await ata(usdc, trader.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
  };

  // split 200 USDC into a complete set: 200 YES + 200 NO
  await program.methods.split(new BN(200 * U)).accountsPartial(acc).signers([trader]).rpc();
  assert.equal(await bal(acc.userYes), 200 * U, "got 200 YES");
  assert.equal(await bal(acc.userNo), 200 * U, "got 200 NO");
  assert.equal(await bal(acc.userCollateral), 300 * U, "paid 200 of 500 USDC");
  await assertInvariant(m, "after split");

  // merge 150 of the set back into 150 USDC
  await program.methods.merge(new BN(150 * U)).accountsPartial(acc).signers([trader]).rpc();
  assert.equal(await bal(acc.userYes), 50 * U, "50 YES left");
  assert.equal(await bal(acc.userNo), 50 * U, "50 NO left");
  assert.equal(await bal(acc.userCollateral), 450 * U, "got 150 USDC back");
  await assertInvariant(m, "after merge");
});

test("buy YES moves the price up and delivers shares; invariant holds", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U);

  const trader = await fundedActor(500 * U);
  const acc = await tradeAccounts(m, trader);
  const yBefore = await bal(m.yesPool), nBefore = await bal(m.noPool);
  await program.methods.buy(new BN(200 * U), { yes: {} }, new BN(0))
    .accountsPartial(acc).signers([trader]).rpc();

  const traderYes = await bal(acc.traderYes);
  assert.ok(traderYes > 0, "trader received YES shares");
  // bought YES, so YES got scarcer relative to NO: price(YES)=no/(yes+no) rose
  const yAfter = await bal(m.yesPool), nAfter = await bal(m.noPool);
  const priceBefore = nBefore / (yBefore + nBefore);
  const priceAfter = nAfter / (yAfter + nAfter);
  assert.ok(priceAfter > priceBefore, `YES price rose (${priceBefore.toFixed(3)} -> ${priceAfter.toFixed(3)})`);
  await assertInvariant(m, "after buy");
});

test("sell YES returns collateral and holds the invariant", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U);
  const trader = await fundedActor(500 * U);
  const acc = await tradeAccounts(m, trader);
  await program.methods.buy(new BN(200 * U), { yes: {} }, new BN(0)).accountsPartial(acc).signers([trader]).rpc();

  const usdcBefore = await bal(acc.traderCollateral);
  const yesBefore = await bal(acc.traderYes);
  await program.methods.sell(new BN(50 * U), { yes: {} }, new BN(yesBefore))
    .accountsPartial(acc).signers([trader]).rpc();
  assert.equal(await bal(acc.traderCollateral), usdcBefore + 50 * U, "seller received the collateral asked for");
  assert.ok(await bal(acc.traderYes) < yesBefore, "seller gave up YES shares");
  await assertInvariant(m, "after sell");
});

test("resolve by real proof (USA 2-0), YES wins, winner redeems 1:1, loser pays 0", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U);
  const trader = await fundedActor(500 * U);
  const acc = await tradeAccounts(m, trader);
  await program.methods.buy(new BN(200 * U), { yes: {} }, new BN(0)).accountsPartial(acc).signers([trader]).rpc();
  const traderYes = await bal(acc.traderYes);

  await resolveWith(m, FINAL, trader);
  const state = await program.account.market.fetch(m.market);
  assert.deepEqual(state.state, { resolved: {} });
  assert.deepEqual(state.winningSide, { yes: {} }, "USA won, so YES is the winning side");

  // redeem winning YES 1:1
  const usdcBefore = await bal(acc.traderCollateral);
  await program.methods.redeem(new BN(traderYes))
    .accountsPartial({
      redeemer: trader.publicKey, market: m.market, outcomeMint: m.yesMint,
      redeemerOutcome: acc.traderYes, vault: m.vault, redeemerCollateral: acc.traderCollateral, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([trader]).rpc();
  assert.equal(await bal(acc.traderCollateral), usdcBefore + traderYes, "winning shares paid 1 collateral each");

  // a losing NO share pays nothing: try to redeem NO -> LosingShare
  // (trader has no NO, but the error fires on the side check before balance)
  await expectErr(
    program.methods.redeem(new BN(1)).accountsPartial({
      redeemer: trader.publicKey, market: m.market, outcomeMint: m.noMint,
      redeemerOutcome: acc.traderNo, vault: m.vault, redeemerCollateral: acc.traderCollateral, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([trader]).rpc(),
    "LosingShare",
  );
});

test("ATTACK: a mid-match proof (period 0) cannot resolve the market", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U);
  await expectErr(resolveWith(m, MID, lp), "NonTerminalPeriod");
});

test("ATTACK: redeem before resolve is rejected", async () => {
  const lp = await fundedActor(1000 * U);
  const m = await createMarket(lp);
  await addLiquidity(m, lp, 1000 * U);
  const trader = await fundedActor(200 * U);
  const acc = await tradeAccounts(m, trader);
  await program.methods.buy(new BN(50 * U), { yes: {} }, new BN(0)).accountsPartial(acc).signers([trader]).rpc();
  await expectErr(
    program.methods.redeem(new BN(1)).accountsPartial({
      redeemer: trader.publicKey, market: m.market, outcomeMint: m.yesMint,
      redeemerOutcome: acc.traderYes, vault: m.vault, redeemerCollateral: acc.traderCollateral, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([trader]).rpc(),
    "MarketNotResolved",
  );
});
