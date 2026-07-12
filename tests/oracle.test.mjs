// Adversarial suite for the optimistic oracle. Runs on a local validator. Covers the
// undisputed path (asserter reclaims the bond), both disputed outcomes (winner takes both
// bonds), the attacks (a non-arbiter cannot resolve, a loser cannot claim), and the
// curation layer: the protocol-wide arbiter is set once and cannot be chosen per assertion,
// and every proposer carries an on-chain accuracy record updated on each resolution.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const BN = anchor.BN;
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("day1/devnet-wallet.json", "utf8"))));
const idl = JSON.parse(readFileSync("target/idl/fischio_oracle.json", "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const PID = program.programId;
const U = 1_000_000;
let usdc;
let arbiter; // the single protocol-wide arbiter, set once in setup

const rand32 = () => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256); return [...b]; };
const seed = (s, ...extra) => PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], PID)[0];
const configPda = seed("config");
const proposerPda = (pk) => seed("proposer", pk.toBuffer());

async function actor(fund, initStats = false) {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: LAMPORTS_PER_SOL })));
  const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, usdc, kp.publicKey)).address;
  if (fund) await mintTo(connection, payer, usdc, ata, payer, fund);
  const a = { kp, ata };
  if (initStats) {
    await program.methods.initProposerStats()
      .accountsPartial({ proposer: kp.publicKey, stats: proposerPda(kp.publicKey), systemProgram: SystemProgram.programId })
      .signers([kp]).rpc();
  }
  return a;
}
const bal = async (a) => Number((await getAccount(connection, a)).amount);
const stats = (pk) => program.account.proposerStats.fetch(proposerPda(pk));

async function assertOutcome(asserter, outcome, bond, windowSecs) {
  const qid = rand32();
  const assertion = seed("assertion", Buffer.from(qid));
  const vault = seed("bond_vault", assertion.toBuffer());
  await program.methods.assertOutcome(qid, outcome, new BN(bond), new BN(windowSecs))
    .accountsPartial({
      asserter: asserter.kp.publicKey, proposerStats: proposerPda(asserter.kp.publicKey),
      assertion, bondMint: usdc, vault, asserterToken: asserter.ata,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).signers([asserter.kp]).rpc();
  return { qid, assertion, vault, asserter: asserter.kp.publicKey };
}
const dispute = (d, A) => program.methods.dispute()
  .accountsPartial({ disputer: d.kp.publicKey, assertion: A.assertion, vault: A.vault, disputerToken: d.ata, tokenProgram: TOKEN_PROGRAM_ID })
  .signers([d.kp]).rpc();
// arbitrate now always goes through the protocol arbiter + config; the caller cannot choose one
const arbitrate = (signer, A, outcome) => program.methods.arbitrate(outcome)
  .accountsPartial({ arbiter: signer.publicKey, config: configPda, assertion: A.assertion, proposerStats: proposerPda(A.asserter) })
  .signers([signer]).rpc();
const settle = (A) => program.methods.settle()
  .accountsPartial({ assertion: A.assertion, proposerStats: proposerPda(A.asserter) }).rpc();
const claim = (c, A) => program.methods.claim()
  .accountsPartial({ claimant: c.kp.publicKey, assertion: A.assertion, vault: A.vault, claimantToken: c.ata, tokenProgram: TOKEN_PROGRAM_ID })
  .signers([c.kp]).rpc();

test("setup: mint, and set the protocol arbiter once", async () => {
  usdc = await createMint(connection, payer, payer.publicKey, null, 6);
  arbiter = Keypair.generate();
  await program.methods.initConfig(arbiter.publicKey)
    .accountsPartial({ payer: payer.publicKey, arbiter: arbiter.publicKey, config: configPda, systemProgram: SystemProgram.programId })
    .rpc();
  const c = await program.account.oracleConfig.fetch(configPda);
  assert.equal(c.arbiter.toBase58(), arbiter.publicKey.toBase58(), "arbiter recorded");
});

test("the protocol arbiter is immutable: a second init_config fails", async () => {
  const attacker = Keypair.generate();
  try {
    await program.methods.initConfig(attacker.publicKey)
      .accountsPartial({ payer: payer.publicKey, arbiter: attacker.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .rpc();
    assert.fail("second init_config should fail");
  } catch (e) {
    assert.ok(`${e}`.includes("already in use") || `${e}`.toLowerCase().includes("allocate"), "config PDA already initialized");
  }
});

test("disputed, arbiter sides with the asserter: asserter takes both bonds", async () => {
  const asserter = await actor(10 * U, true);
  const disputer = await actor(10 * U);
  const A = await assertOutcome(asserter, 1, 10 * U, 3600);
  await dispute(disputer, A);
  assert.equal(await bal(A.vault), 20 * U, "both bonds escrowed");
  await arbitrate(arbiter, A, 1); // asserter proposed 1, arbiter confirms 1
  const before = await bal(asserter.ata);
  await claim(asserter, A);
  assert.equal(await bal(asserter.ata), before + 20 * U, "asserter took both bonds");
  const s = await stats(asserter.kp.publicKey);
  assert.equal(s.total, 1, "one resolution recorded");
  assert.equal(s.correct, 1, "arbiter upheld the proposal, so it counts correct");
});

test("disputed, arbiter sides with the disputer: disputer takes both bonds; proposer marked wrong", async () => {
  const asserter = await actor(10 * U, true);
  const disputer = await actor(10 * U);
  const A = await assertOutcome(asserter, 1, 10 * U, 3600);
  await dispute(disputer, A);
  await arbitrate(arbiter, A, 0); // asserter said 1, arbiter says 0 -> disputer was right
  const before = await bal(disputer.ata);
  await claim(disputer, A);
  assert.equal(await bal(disputer.ata), before + 20 * U, "disputer took both bonds");
  const s = await stats(asserter.kp.publicKey);
  assert.equal(s.total, 1, "one resolution recorded");
  assert.equal(s.correct, 0, "arbiter overturned the proposal, so it does not count correct");
});

test("ATTACK: a non-arbiter cannot resolve a dispute, even one the asserter would prefer", async () => {
  const asserter = await actor(10 * U, true);
  const disputer = await actor(10 * U);
  const A = await assertOutcome(asserter, 1, 10 * U, 3600);
  await dispute(disputer, A);
  try {
    await arbitrate(disputer.kp, A, 0); // disputer tries to self-arbitrate through the config path
    assert.fail("non-arbiter should not arbitrate");
  } catch (e) {
    assert.ok(`${e}${e.logs?.join("") ?? ""}`.includes("NotArbiter"), "rejected as NotArbiter");
  }
});

test("ATTACK: the loser cannot claim", async () => {
  const asserter = await actor(10 * U, true);
  const disputer = await actor(10 * U);
  const A = await assertOutcome(asserter, 1, 10 * U, 3600);
  await dispute(disputer, A);
  await arbitrate(arbiter, A, 1); // asserter wins
  try {
    await claim(disputer, A); // loser tries to claim
    assert.fail("loser should not claim");
  } catch (e) {
    assert.ok(`${e}${e.logs?.join("") ?? ""}`.includes("NotWinner"), "rejected as NotWinner");
  }
});

test("undisputed: after the window the assertion stands, asserter reclaims the bond, proposer credited", async () => {
  const asserter = await actor(10 * U, true);
  const A = await assertOutcome(asserter, 1, 10 * U, 60); // 60s window
  const before = await bal(asserter.ata);
  // wait out the window on the validator clock
  const deadline = Date.now() + 75_000;
  for (;;) {
    const info = await connection.getParsedAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY, "confirmed");
    const now = info.value?.data?.parsed?.info?.unixTimestamp ?? 0;
    const acct = await program.account.assertion.fetch(A.assertion);
    if (now >= acct.proposeTs.toNumber() + 60) break;
    if (Date.now() > deadline) throw new Error("clock never passed the window");
    await new Promise((r) => setTimeout(r, 2000));
  }
  await settle(A);
  const acct = await program.account.assertion.fetch(A.assertion);
  assert.deepEqual(acct.state, { resolved: {} });
  assert.equal(acct.resolvedOutcome, 1, "resolved to the proposed outcome");
  await claim(asserter, A);
  assert.equal(await bal(asserter.ata), before + 10 * U, "asserter reclaimed the single bond");
  const s = await stats(asserter.kp.publicKey);
  assert.equal(s.correct, 1, "an unchallenged stand counts as a correct proposal");
  assert.equal(s.total, 1);
});
