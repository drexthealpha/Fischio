// Integration + adversarial suite for the multi-outcome (NegRisk) market. Runs on a local
// validator with the cloned txoracle. It builds a real 3-way match-result market
// (home / draw / away), splits, runs a NegRisk convert to show the capital efficiency
// on-chain, resolves with the real USA 2-0 Bosnia proof (home wins), redeems winners, and
// checks the solvency invariant that the vault always covers every outcome's payout.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { summaryOf, statA, statB, nodes, rootsPda, epochDayOf, TXORACLE_ID } from "../lib/proof-marshal.mjs";

const BN = anchor.BN;
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_multi.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;

const USA_BOSNIA = 18172379;
const FINAL = JSON.parse(readFileSync("test-fixtures/final-proofs.json", "utf8"))["18172379:1054"]; // USA 2-0, period 5
const U = 1_000_000;
let usdc;

const seedU8 = (s, market, i) =>
  PublicKey.findProgramAddressSync([Buffer.from(s), market.toBuffer(), Buffer.from([i])], PID)[0];
const seed = (s, market) => PublicKey.findProgramAddressSync([Buffer.from(s), market.toBuffer()], PID)[0];

function marketPda(creator, marketId) {
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("multi"), creator.toBuffer(), new BN(marketId).toArrayLike(Buffer, "le", 8)], PID)[0];
  return { market, vault: seed("vault", market) };
}

async function actor(usdcAmt) {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 2 * LAMPORTS_PER_SOL })));
  const usdcAta = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, kp.publicKey)).address;
  if (usdcAmt) await mintTo(connection, payer, usdc, usdcAta, payer, usdcAmt);
  return { kp, usdcAta };
}
const ata = async (mint, owner) => (await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner, true)).address;
const bal = async (a) => Number((await getAccount(connection, a)).amount);
const supply = async (m) => Number((await getMint(connection, m)).supply);

// 3-way result market on USA-Bosnia: outcome 0 home (a-b>0), 1 draw (a-b==0), 2 away (a-b<0)
async function makeMarket(creator) {
  const marketId = Date.now() % 1_000_000 + Math.floor(Math.random() * 1000);
  const P = marketPda(creator.kp.publicKey, marketId);
  const now = Math.floor(Date.now() / 1000);
  const predicates = [
    { threshold: 0, comparison: 0 }, // home: a-b > 0
    { threshold: 0, comparison: 2 }, // draw: a-b == 0
    { threshold: 0, comparison: 1 }, // away: a-b < 0
  ];
  await program.methods
    .createMultiMarket(new BN(marketId), new BN(USA_BOSNIA), 3, 1, 2, true, predicates, new BN(now + 3600), new BN(now + 7200))
    .accountsPartial({
      creator: creator.kp.publicKey, market: P.market, collateralMint: usdc, vault: P.vault,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).signers([creator.kp]).rpc();
  for (let i = 0; i < 3; i++) {
    await program.methods.initOutcome(i)
      .accountsPartial({
        creator: creator.kp.publicKey, market: P.market, yesMint: seedU8("yes", P.market, i), noMint: seedU8("no", P.market, i),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      }).signers([creator.kp]).rpc();
  }
  return { marketId, ...P };
}

async function split(m, u, index, amount) {
  await program.methods.split(index, new BN(amount))
    .accountsPartial({
      user: u.kp.publicKey, market: m.market, yesMint: seedU8("yes", m.market, index), noMint: seedU8("no", m.market, index),
      vault: m.vault, userCollateral: u.usdcAta,
      userYes: await ata(seedU8("yes", m.market, index), u.kp.publicKey),
      userNo: await ata(seedU8("no", m.market, index), u.kp.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([u.kp]).rpc();
}

async function assertSolvent(m, label) {
  const vault = await bal(m.vault);
  // for each possible winner w: payout = YES_w supply + sum of other outcomes' NO supply
  let worst = Infinity;
  for (let w = 0; w < 3; w++) {
    let payout = await supply(seedU8("yes", m.market, w));
    for (let i = 0; i < 3; i++) if (i !== w) payout += await supply(seedU8("no", m.market, i));
    worst = Math.min(worst, vault - payout);
  }
  assert.ok(worst >= 0, `${label}: vault must cover every outcome (worst slack ${worst})`);
}

test("setup: mint test-USDC", async () => { usdc = await createMint(connection, payer, payer.publicKey, null, 6); assert.ok(usdc); });

test("create 3-way market, split, and the solvency invariant holds", async () => {
  const creator = await actor(0);
  const u = await actor(300 * U);
  const m = await makeMarket(creator);
  for (let i = 0; i < 3; i++) await split(m, u, i, 100 * U);
  assert.equal(await bal(m.vault), 300 * U);
  for (let i = 0; i < 3; i++) {
    assert.equal(await supply(seedU8("yes", m.market, i)), 100 * U);
    assert.equal(await supply(seedU8("no", m.market, i)), 100 * U);
  }
  await assertSolvent(m, "after split");
});

test("NegRisk convert: burn NO on {1,2}, get 1x collateral + YES on {0}; stays solvent", async () => {
  const creator = await actor(0);
  const u = await actor(300 * U);
  const m = await makeMarket(creator);
  for (let i = 0; i < 3; i++) await split(m, u, i, 100 * U); // hold NO on all three
  const usdcBefore = await bal(u.usdcAta);
  const yes0Before = await bal(await ata(seedU8("yes", m.market, 0), u.kp.publicKey));

  // convert {1,2}: remaining = [no_1, user_no_1, no_2, user_no_2, yes_0, user_yes_0]
  const remaining = [
    { pubkey: seedU8("no", m.market, 1), isWritable: true, isSigner: false },
    { pubkey: await ata(seedU8("no", m.market, 1), u.kp.publicKey), isWritable: true, isSigner: false },
    { pubkey: seedU8("no", m.market, 2), isWritable: true, isSigner: false },
    { pubkey: await ata(seedU8("no", m.market, 2), u.kp.publicKey), isWritable: true, isSigner: false },
    { pubkey: seedU8("yes", m.market, 0), isWritable: true, isSigner: false },
    { pubkey: await ata(seedU8("yes", m.market, 0), u.kp.publicKey), isWritable: true, isSigner: false },
  ];
  await program.methods.convert(Buffer.from([1, 2]), new BN(40 * U))
    .accountsPartial({ user: u.kp.publicKey, market: m.market, vault: m.vault, userCollateral: u.usdcAta, tokenProgram: TOKEN_PROGRAM_ID })
    .remainingAccounts(remaining).signers([u.kp]).rpc();

  // (k-1)*amount = 1*40 collateral released; 40 YES_0 minted; 40 NO_1 and 40 NO_2 burned
  assert.equal(await bal(u.usdcAta), usdcBefore + 40 * U, "released (k-1)=1 x 40 collateral");
  assert.equal(await bal(await ata(seedU8("yes", m.market, 0), u.kp.publicKey)), yes0Before + 40 * U, "minted YES on the complement");
  assert.equal(await supply(seedU8("no", m.market, 1)), 60 * U, "burned NO_1");
  assert.equal(await supply(seedU8("no", m.market, 2)), 60 * U, "burned NO_2");
  await assertSolvent(m, "after convert");
});

test("resolve with the real USA 2-0 proof: home wins; winners redeem, losers are worthless", async () => {
  const creator = await actor(0);
  const u = await actor(300 * U);
  const m = await makeMarket(creator);
  for (let i = 0; i < 3; i++) await split(m, u, i, 100 * U);

  await program.methods
    .resolve(summaryOf(FINAL), nodes(FINAL.subTreeProof), nodes(FINAL.mainTreeProof), statA(FINAL), statB(FINAL))
    .accountsPartial({ resolver: u.kp.publicKey, market: m.market, dailyScoresRoots: rootsPda(epochDayOf(FINAL)), txoracleProgram: TXORACLE_ID })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).signers([u.kp]).rpc();

  const st = await program.account.multiMarket.fetch(m.market);
  assert.deepEqual(st.state, { resolved: {} });
  assert.equal(st.winningOutcome, 0, "USA (home, a-b>0) is the winning outcome");

  // redeem YES_0 (winner) pays 1:1
  const before = await bal(u.usdcAta);
  await program.methods.redeem(0, true, new BN(100 * U))
    .accountsPartial({
      redeemer: u.kp.publicKey, market: m.market, outcomeMint: seedU8("yes", m.market, 0),
      redeemerOutcome: await ata(seedU8("yes", m.market, 0), u.kp.publicKey), vault: m.vault, redeemerCollateral: u.usdcAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([u.kp]).rpc();
  assert.equal(await bal(u.usdcAta), before + 100 * U, "winning YES redeemed 1:1");

  // redeem NO_1 (a losing outcome, so its NO pays) 1:1
  const before2 = await bal(u.usdcAta);
  await program.methods.redeem(1, false, new BN(100 * U))
    .accountsPartial({
      redeemer: u.kp.publicKey, market: m.market, outcomeMint: seedU8("no", m.market, 1),
      redeemerOutcome: await ata(seedU8("no", m.market, 1), u.kp.publicKey), vault: m.vault, redeemerCollateral: u.usdcAta, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([u.kp]).rpc();
  assert.equal(await bal(u.usdcAta), before2 + 100 * U, "NO on a losing outcome redeemed 1:1");

  // redeem YES_1 (a losing outcome's YES) is worthless
  try {
    await program.methods.redeem(1, true, new BN(1))
      .accountsPartial({
        redeemer: u.kp.publicKey, market: m.market, outcomeMint: seedU8("yes", m.market, 1),
        redeemerOutcome: await ata(seedU8("yes", m.market, 1), u.kp.publicKey), vault: m.vault, redeemerCollateral: u.usdcAta, tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([u.kp]).rpc();
    assert.fail("losing YES should be worthless");
  } catch (e) {
    assert.ok(`${e}${e.logs?.join("") ?? ""}`.includes("WorthlessShare"), "rejected as WorthlessShare");
  }
});
