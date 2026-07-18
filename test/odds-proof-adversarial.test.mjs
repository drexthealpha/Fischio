// Adversarial tests for the price proof.
//
// WHY THIS FILE IS THE POINT
//
// A proof that accepts everything proves nothing. It is easy to write a validator that logs
// "SUCCESS" and returns true, and easy to write a test that calls it with good data and
// watches it pass. Neither tells you the check is real.
//
// So these tests do the opposite. Each one takes a genuine, on-chain-verified odds package and
// breaks exactly one thing about it, then asserts the oracle REJECTS it. If any of these pass
// validation, fischio's price proof is decoration and the tests should fail loudly.
//
// The happy-path test is here too, and it runs first, because a rejection test that passes
// because the RPC is down or the package is malformed is a false negative. We prove the real
// package verifies before we trust any rejection.
//
// These run against the real deployed oracle on devnet, not a mock. A mock of a Merkle
// verifier that we wrote ourselves would only prove our mock matches our assumptions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { txlineClient, parseMarkets } from "../lib/txline.mjs";
import { validateOddsArgs, oddsRootsPda, oddsEpochDayOf, TXORACLE_ID } from "../lib/odds-proof.mjs";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const FIXTURE = Number(process.env.PROOF_FIXTURE ?? 18257739);

// The suite needs a funded devnet signer and the live feed. Without either it skips rather
// than passing, because a green tick you did not earn is worse than a skip you can see.
function signer() {
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.KEYPAIR_JSON ?? readFileSync("local/devnet-wallet.json", "utf8")))); }
  catch { return null; }
}

const payer = signer();
const connection = new Connection(RPC, "confirmed");
let oracle = null, pkg = null, roots = null;

// Deep clone that survives BN and arrays, so each test mutates its own copy.
const clone = (o) => JSON.parse(JSON.stringify(o), (_, v) =>
  v && typeof v === "object" && v.type === "Buffer" ? Buffer.from(v.data) : v);

/** Send one validate_odds and report whether the chain accepted it. */
async function submit(args) {
  try {
    const sig = await oracle.methods.validateOdds(...args)
      .accountsPartial({ dailyOddsMerkleRoots: roots })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    return { accepted: true, sig };
  } catch (e) {
    return { accepted: false, reason: String(e.message ?? e).slice(0, 120), logs: e.logs ?? [] };
  }
}

/** Rebuild the args from a (possibly tampered) package. */
const argsFor = (p) => validateOddsArgs(p);

test("setup: fetch a real odds package and the roots account", async (t) => {
  if (!payer) return t.skip("no devnet signer (set KEYPAIR_JSON)");
  const tx = txlineClient();
  const board = parseMarkets((await tx.oddsSnapshot(FIXTURE)) ?? []);
  const m = board.find((x) => x.type === "1X2_PARTICIPANT_RESULT" && x.period === "FT") ?? board[0];
  assert.ok(m, "the feed returned no markets for this fixture");
  pkg = await tx.oddsValidation({ fixtureId: FIXTURE, messageId: m.messageId, ts: m.ts });
  assert.ok(pkg?.odds, "no validation package for this market");
  roots = oddsRootsPda(oddsEpochDayOf(pkg));
  const info = await connection.getAccountInfo(roots);
  assert.ok(info, "the daily odds roots account is not on chain for this day");
  assert.equal(info.owner.toBase58(), TXORACLE_ID.toBase58(), "roots account is not owned by the oracle");

  const idl = JSON.parse(readFileSync("local/txoracle-devnet-idl.json", "utf8"));
  oracle = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
});

test("the genuine package verifies on-chain", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const r = await submit(argsFor(pkg));
  assert.ok(r.accepted, `a real TxLINE package was rejected: ${r.reason}`);
});

// ---- each test below breaks exactly one thing ----

test("a tampered price is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Move the home team from 42.2% to roughly 50% by shortening the odds. This is the attack
  // that matters: a market operator quoting a better line than the book actually offered.
  const bad = clone(pkg);
  bad.odds.Prices = [...bad.odds.Prices];
  bad.odds.Prices[0] = Math.round(bad.odds.Prices[0] * 0.8);
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a price that TxLINE never published");
});

test("a tampered price by one unit is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The smallest possible lie: one thousandth of a decimal point. A hash either covers the
  // field or it does not, so this must fail exactly as hard as the obvious one.
  const bad = clone(pkg);
  bad.odds.Prices = [...bad.odds.Prices];
  bad.odds.Prices[0] += 1;
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a price off by one unit");
});

test("a swapped outcome order is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Same numbers, different teams. If only the multiset of prices were hashed, this would pass
  // and you could pay out the wrong side at the right-looking odds.
  const bad = clone(pkg);
  bad.odds.Prices = [bad.odds.Prices[1], bad.odds.Prices[0], ...bad.odds.Prices.slice(2)];
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted prices attached to the wrong outcomes");
});

test("a different fixture id on the same proof is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Claim the final's price belongs to another match.
  const bad = clone(pkg);
  bad.odds.FixtureId = Number(bad.odds.FixtureId) + 1;
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a price re-labelled onto another fixture");
});

test("a shifted timestamp is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Replay a real price as if it were newer. This is how a stale line gets passed off as live.
  const bad = clone(pkg);
  bad.odds.Ts = Number(bad.odds.Ts) + 60_000;
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a price replayed under a newer timestamp");
});

test("a changed market period is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Market identity is the type, the period and the parameters together. A full-match line
  // relabelled as a first-half line is a different market at the same numbers.
  const bad = clone(pkg);
  bad.odds.MarketPeriod = bad.odds.MarketPeriod ? null : "half=1";
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a line moved to a different period");
});

test("a changed bookmaker is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The demargined feed is the one fischio prices from. Passing another book's name over the
  // same numbers would let an operator claim a source it never used.
  const bad = clone(pkg);
  bad.odds.Bookmaker = "SomeOtherBook";
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a price attributed to the wrong book");
});

test("a tampered sub-tree root is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Attack the summary rather than the record: forge the root the record folds into.
  const bad = clone(pkg);
  const root = Buffer.from(bad.summary.oddsSubTreeRoot);
  root[0] ^= 0xff;
  bad.summary.oddsSubTreeRoot = root;
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a forged sub-tree root");
});

test("a flipped sibling direction is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The proof path folds left or right at each node: hash(running, sibling) one way round or
  // hash(sibling, running) the other. Reverse the order and you get a different root.
  //
  // Except at one node, and this cost a red run to learn. Flipping a single bit is a no-op
  // whenever the sibling happens to equal the running hash, because swapping two identical
  // values changes nothing. That is not exotic: a Merkle tree with an odd number of leaves at
  // some level pads it by duplicating the last one, and any leaf landing in that position gets
  // a proof whose first sibling is itself.
  //
  // This test used to flip only the first bit. It passed all morning and went red in the
  // afternoon, on the same market, because the tree had reshaped around a new batch. The proof
  // was never weaker: you still cannot prove a different price this way, since the root is
  // unchanged and the root is what commits to your leaf. The test was just asserting something
  // that is not always true.
  //
  // So flip every bit. A whole path of symmetric folds would be needed to hide it, and with six
  // nodes that will not happen.
  const bad = clone(pkg);
  assert.ok(bad.subTreeProof?.length, "package has no sub-tree proof to flip");
  for (const n of bad.subTreeProof) n.isRightSibling = !n.isRightSibling;
  for (const n of bad.mainTreeProof) n.isRightSibling = !n.isRightSibling;
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a proof folded in the wrong direction at every node");
});

test("a substituted sibling hash is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The direction test above depends on the shape of the tree on the day. This one does not.
  // Changing a sibling hash always changes the root, whatever position the leaf sits in, so
  // this is the check that the path is genuinely being folded and not waved through.
  const bad = clone(pkg);
  const h = Buffer.from(bad.subTreeProof[0].hash);
  h[0] ^= 0xff;
  bad.subTreeProof[0].hash = Array.from(h);
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a proof with a sibling that is not in the tree");
});

test("a truncated proof path is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  const bad = clone(pkg);
  bad.mainTreeProof = bad.mainTreeProof.slice(0, -1);
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a proof that stops short of the root");
});

test("an empty proof path is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The degenerate case: claim the record is the root.
  const bad = clone(pkg);
  bad.subTreeProof = [];
  const r = await submit(argsFor(bad));
  assert.equal(r.accepted, false, "the oracle accepted a record with no proof at all");
});

test("a proof against the wrong day's roots account is rejected", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // Right price, right proof, wrong root set. The account is what ties the proof to the day
  // TxODDS actually published, so pointing at another day must fail even though the package is
  // internally consistent.
  const otherDay = oddsEpochDayOf(pkg) - 1;
  const otherRoots = oddsRootsPda(otherDay);
  const info = await connection.getAccountInfo(otherRoots);
  if (!info) return t.skip("no roots account for the previous day to test against");
  const saved = roots;
  roots = otherRoots;
  const r = await submit(argsFor(pkg));
  roots = saved;
  assert.equal(r.accepted, false, "the oracle accepted a proof checked against another day's roots");
});

// ---- cost, which is a correctness problem here and not a performance one ----

/** Simulate one package and report the compute it burned and whether it verified. */
async function costOf(p, units) {
  const m = oracle.methods.validateOdds(...argsFor(p)).accountsPartial({ dailyOddsMerkleRoots: roots });
  if (units) m.preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units })]);
  const sim = await m.simulate().catch((e) => ({ raw: e.simulationResponse?.logs ?? [] }));
  const logs = sim?.raw ?? [];
  return {
    used: Number(logs.find((l) => l.includes("consumed"))?.match(/consumed (\d+)/)?.[1] ?? 0),
    verified: logs.some((l) => l.includes("Fully Successful")),
  };
}

test("verifying costs real compute, so the oracle is not rubber-stamping", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // A validator that returned true without hashing would cost a few thousand units. Folding a
  // proof path costs six figures. This is a cheap, blunt check that the work is being done, and
  // it would catch the verifier being swapped for a stub in a way the tamper tests might not.
  const { used, verified } = await costOf(pkg, 400_000);
  assert.ok(verified, "the genuine package failed to verify during simulation");
  assert.ok(used > 100_000, `verification used only ${used} CU, which is too cheap to be folding a Merkle path`);
});

test("the default compute budget is not enough, which is why prove-odds raises it", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // This is the test that stops someone deleting the budget bump as clutter.
  //
  // Solana gives a transaction 200,000 CU unless it asks for more. Measured across all 29
  // markets on the World Cup final, a real proof costs between 165,440 and 254,993 CU, because
  // the cost scales with how deep the record sits in that interval's tree. The default covers
  // 12 of the 29. The other 17 fail on cost while carrying a perfectly valid proof.
  //
  // That is worse than an outright break. Proof depth grows with update volume, so a market
  // that proves at breakfast can stop proving at kickoff, and the error says nothing about
  // prices being wrong. Find a market the default cannot afford and pin the failure.
  const tx = txlineClient();
  const board = parseMarkets((await tx.oddsSnapshot(FIXTURE)) ?? []);
  let deep = null;
  for (const m of board) {
    const p = await tx.oddsValidation({ fixtureId: FIXTURE, messageId: m.messageId, ts: m.ts });
    if ((p?.subTreeProof?.length ?? 0) >= 6) { deep = p; break; }
  }
  if (!deep) return t.skip("no deep-proof market on the board right now");

  const saved = pkg;
  pkg = deep;
  const withDefault = await costOf(deep, 0);      // no budget instruction: the 200k default
  const withBump = await costOf(deep, 400_000);   // what prove-odds actually sends
  pkg = saved;

  assert.equal(withDefault.verified, false, "the default budget now covers a deep proof; re-measure before trusting this");
  assert.ok(withBump.verified, `the same package failed even at 400k CU (used ${withBump.used})`);
  assert.ok(withBump.used < 400_000, `a deep proof used ${withBump.used} CU, so the 400k prove-odds requests is no longer enough`);
});

test("every market on the board can be proven, not just the headline one", async (t) => {
  if (!oracle) return t.skip("setup did not run");
  // The reason this exists: it is easy to prove the full-match 1X2 and call the feature done.
  // The full-match 1X2 happens to have a shallow proof and a simple shape. Quarter lines,
  // handicaps and first-half totals are where the optional fields and the deep paths live. If
  // fischio quotes 29 markets it should be able to prove 29 markets.
  const tx = txlineClient();
  const board = parseMarkets((await tx.oddsSnapshot(FIXTURE)) ?? []);
  assert.ok(board.length > 1, "the board has one market, so this test is not proving anything");
  const saved = pkg, savedRoots = roots;
  const failures = [];
  for (const m of board) {
    const p = await tx.oddsValidation({ fixtureId: FIXTURE, messageId: m.messageId, ts: m.ts });
    const label = `${m.type.split("_")[0]} ${m.period}${m.line != null ? ` ${m.line}` : ""}`;
    if (!p?.odds) { failures.push(`${label}: no package`); continue; }
    pkg = p;
    roots = oddsRootsPda(oddsEpochDayOf(p));
    const { verified, used } = await costOf(p, 400_000);
    if (!verified) failures.push(`${label} (${used} CU)`);
  }
  pkg = saved; roots = savedRoots;
  assert.deepEqual(failures, [], `markets fischio quotes but cannot prove: ${failures.join(", ")}`);
});
