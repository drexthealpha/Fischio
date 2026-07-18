// Adversarial tests for the fixture proof.
//
// WHY A FIXTURE NEEDS PROVING AT ALL
//
// Proving the score of a match is worth nothing if the match was invented. An operator can list
// "Spain v Argentina" that no governing body ever scheduled, take the stakes, and settle it
// from a real, verifying proof of an entirely different game. Every hash checks out and you
// still lose your money. That attack needs no forgery, only a fixture nobody checked.
//
// So each test below takes a genuine fixture package and changes one thing about the match:
// its teams, its kickoff, its competition, its identity. Every one must be rejected. If any
// pass, fischio cannot claim it knows what you are betting on.
//
// These run against the real deployed oracle on devnet, not a mock.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { txlineClient } from "../lib/txline.mjs";
import { validateFixtureArgs, fixturesRootsPda, fixtureEpochDayOf, TXORACLE_ID, TEN_DAY_BLOCK } from "../lib/fixture-proof.mjs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const FIXTURE = Number(process.env.PROOF_FIXTURE ?? 18257739); // the World Cup final

function signer() {
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? readFileSync("local/devnet-wallet.json", "utf8")))); }
  catch { return null; }
}

const payer = signer();
const connection = new Connection(RPC, "confirmed");
let oracle = null, pkg = null, roots = null;

const clone = (o) => JSON.parse(JSON.stringify(o));

async function submit(p, account = roots) {
  try {
    const sig = await oracle.methods.validateFixture(...validateFixtureArgs(p))
      .accountsPartial({ tenDailyFixturesRoots: account })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    return { accepted: true, sig };
  } catch (e) {
    return { accepted: false, reason: String(e.message ?? e).slice(0, 120) };
  }
}

test("setup: fetch a real fixture package and the roots account", async (t) => {
  if (!payer) return t.skip("no devnet signer (set KEYPAIR_JSON)");
  const tx = txlineClient();
  pkg = await tx.fixturesValidation(FIXTURE);
  assert.ok(pkg?.snapshot, "no fixture package for this match");
  roots = fixturesRootsPda(fixtureEpochDayOf(pkg));
  const info = await connection.getAccountInfo(roots);
  assert.ok(info, "the fixtures roots account is not on chain for this ten-day block");
  assert.equal(info.owner.toBase58(), TXORACLE_ID.toBase58(), "roots account is not owned by the oracle");

  const idl = JSON.parse(readFileSync("local/txoracle-devnet-idl.json", "utf8"));
  oracle = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
});

test("the genuine fixture verifies on-chain", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const r = await submit(pkg);
  assert.ok(r.accepted, `a real TxLINE fixture was rejected: ${r.reason}`);
});

test("the roots account is derived per ten-day block, not per day", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // "ten daily" is the whole seed. Every day inside a block has to resolve to one account, and
  // the block boundary has to fall where the name says. Getting this wrong silently sends the
  // proof at a neighbouring block, which fails with a seeds error that says nothing about days.
  const day = fixtureEpochDayOf(pkg);
  const block = Math.floor(day / TEN_DAY_BLOCK) * TEN_DAY_BLOCK;
  assert.equal(fixturesRootsPda(block).toBase58(), roots.toBase58(), "the block's first day must give the same account");
  assert.equal(fixturesRootsPda(block + 9).toBase58(), roots.toBase58(), "the block's last day must give the same account");
  assert.notEqual(fixturesRootsPda(block + 10).toBase58(), roots.toBase58(), "the next block must be a different account");
  assert.notEqual(fixturesRootsPda(block - 1).toBase58(), roots.toBase58(), "the previous block must be a different account");
});

// ---- each test below changes exactly one thing about the match ----

test("a swapped team name is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The attack this exists to stop: list a match with a team that is not playing in it.
  const bad = clone(pkg);
  bad.snapshot.Participant2 = "Brazil";
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a match against a team that is not playing");
});

test("swapping the two teams around is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Same two teams, reversed. If only the set of names were hashed this would pass, and every
  // home and away market on the fixture would be backwards.
  const bad = clone(pkg);
  [bad.snapshot.Participant1, bad.snapshot.Participant2] = [bad.snapshot.Participant2, bad.snapshot.Participant1];
  [bad.snapshot.Participant1Id, bad.snapshot.Participant2Id] = [bad.snapshot.Participant2Id, bad.snapshot.Participant1Id];
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted the fixture with the teams reversed");
});

test("a changed participant id is rejected even when the name is right", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The name is what a person reads and the id is what the code joins on. Both have to be
  // covered, or a fixture could display correctly and resolve against another team's data.
  const bad = clone(pkg);
  bad.snapshot.Participant1Id = Number(bad.snapshot.Participant1Id) + 1;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a fixture whose team id was swapped under the same name");
});

test("a moved kickoff is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Kickoff is what every countdown, every close time and every in-play window keys on. Moving
  // it by an hour changes when a market stops taking bets.
  const bad = clone(pkg);
  bad.snapshot.StartTime = Number(bad.snapshot.StartTime) + 3_600_000;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a fixture with a kickoff that was moved");
});

test("a changed competition is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Passing a friendly off as a World Cup match is a real way to dress up a fixture nobody cares
  // about as one people will stake on.
  const bad = clone(pkg);
  bad.snapshot.Competition = "Friendlies";
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a fixture relabelled into another competition");
});

test("a changed competition id is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const bad = clone(pkg);
  bad.snapshot.CompetitionId = 430; // Friendlies
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a fixture with another competition's id");
});

test("a changed fixture id is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const bad = clone(pkg);
  bad.snapshot.FixtureId = Number(bad.snapshot.FixtureId) + 1;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a fixture under a different id");
});

test("the untagged fixture id is rejected, which is the tempting mistake", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The snapshot carries a tagged id: for the final the summary says 18257739 and the snapshot
  // says 281474994968395, exactly 2^48 higher. Anyone writing this marshaller reaches for the
  // id they already know, and that number hashes to a different leaf. This pins the difference
  // so nobody "fixes" the tag away.
  const tagged = Number(pkg.snapshot.FixtureId);
  const plain = Number(pkg.summary.fixtureId);
  assert.notEqual(tagged, plain, "the snapshot id is no longer tagged; re-check the marshaller");
  assert.equal(tagged - plain, 2 ** 48, "the tag is no longer a 2^48 offset; re-check the marshaller");

  const bad = clone(pkg);
  bad.snapshot.FixtureId = plain;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted the untagged id, so the tag may not be covered by the hash");
});

test("switching which team is at home is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const bad = clone(pkg);
  bad.snapshot.Participant1IsHome = !bad.snapshot.Participant1IsHome;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a fixture with home advantage moved to the other team");
});

test("a forged sub-tree root is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const bad = clone(pkg);
  const root = Buffer.from(bad.summary.updateSubTreeRoot);
  root[0] ^= 0xff;
  bad.summary.updateSubTreeRoot = Array.from(root);
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a forged sub-tree root");
});

test("a truncated proof path is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const bad = clone(pkg);
  assert.ok(bad.mainTreeProof?.length, "package has no main-tree proof to truncate");
  bad.mainTreeProof = bad.mainTreeProof.slice(0, -1);
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a proof that stops short of the root");
});

test("a flipped sibling direction is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Flip every bit, not just the first. Flipping one is a no-op whenever that sibling equals
  // the running hash, which happens to any leaf sitting in a duplicated slot where a tree pads
  // an odd level. The odds suite learned this the hard way: the single-bit version passed for
  // hours and then went red when the tree reshaped. See odds-proof-adversarial.test.mjs.
  const bad = clone(pkg);
  for (const n of bad.subTreeProof ?? []) n.isRightSibling = !n.isRightSibling;
  for (const n of bad.mainTreeProof ?? []) n.isRightSibling = !n.isRightSibling;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a proof folded in the wrong direction at every node");
});

test("a substituted sibling hash is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Independent of how the tree is shaped on the day: a sibling that is not in the tree always
  // produces a different root.
  const bad = clone(pkg);
  const h = Buffer.from(bad.mainTreeProof[0].hash);
  h[0] ^= 0xff;
  bad.mainTreeProof[0].hash = Array.from(h);
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a proof with a sibling that is not in the tree");
});

test("a proof against another ten-day block is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Right fixture, right proof, wrong block of the calendar.
  const other = fixturesRootsPda(fixtureEpochDayOf(pkg) - TEN_DAY_BLOCK);
  const info = await connection.getAccountInfo(other);
  if (!info) return t.skip("no roots account for the previous block to test against");
  const r = await submit(pkg, other);
  assert.equal(r.accepted, false, "the oracle accepted a proof checked against another block's roots");
});

test("an invented fixture is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The end-to-end version of the attack: a match that was never scheduled, wearing a real
  // proof. Nothing about this package is internally inconsistent. It is simply not true.
  const bad = clone(pkg);
  bad.snapshot.Participant1 = "Atlantis";
  bad.snapshot.Participant2 = "El Dorado";
  bad.snapshot.Participant1Id = 99998;
  bad.snapshot.Participant2Id = 99999;
  bad.snapshot.StartTime = Number(bad.snapshot.StartTime) + 86_400_000;
  const r = await submit(bad);
  assert.equal(r.accepted, false, "the oracle accepted a match that does not exist");
});
