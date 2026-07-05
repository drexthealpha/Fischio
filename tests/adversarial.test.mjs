// Adversarial suite for wc-settle. Every negative test models a PLAUSIBLE wrong
// implementation and would pass money to the wrong party if the guard were missing:
//   - no state machine      -> settle-before-accept, double-settle, settle-after-refund
//   - no fixture/key check  -> genuine proof for the WRONG match settles
//   - no finality guard     -> genuine mid-match period-0 proof settles on a temporary lead
//   - no event-root binding -> final leaf of stat A paired with another event's stat B
//   - no PDA check          -> submitter chooses which roots account "verifies" the proof
// Proofs are REAL TxLINE devnet proofs (test-fixtures/), verified against the cloned
// oracle program + cloned daily-roots accounts on a local validator.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STAKE, TIP, makeActor, fund, programFor, p1WinsTerms, createWager, acceptWager,
  settle, refund, expectError, balance, sleep, waitForChainTime, statA, statB, rootsPda, b32, nodes,
} from "./helpers.mjs";

const finals = JSON.parse(readFileSync("test-fixtures/final-proofs.json", "utf8"));
const USA_FINAL = finals["18172379:1054"];   // period 5, USA 2-0 Bosnia
const ENGLAND_FINAL = finals["18179764:1161"]; // period 5, England 2-1 Congo DR
const BELGIUM_ET = finals["18179550:1312"];  // period 10, Belgium 3-2 Senegal (after ET)
const USA_MID = JSON.parse(readFileSync("test-fixtures/proof-mid-446.json", "utf8")); // period 0, 1-0, 49th minute
const USA_CORNERS = JSON.parse(readFileSync("test-fixtures/proof-usa-corners.json", "utf8")); // keys 7/8, period 5, 4-3
const PENS_FINAL = JSON.parse(readFileSync("test-fixtures/proof-pens-final.json", "utf8")); // NED-MAR 1-1, period 13 (after pens)
const PENS_MID = JSON.parse(readFileSync("test-fixtures/proof-pens-mid.json", "utf8"));     // same match, period 12 (shootout LIVE)
const NETHERLANDS = 18172280;

const USA = 18172379, ENGLAND = 18179764, BELGIUM = 18179550;

const maker = makeActor(), taker = makeActor(), settler = makeActor();
const program = programFor(maker);
const parties = { maker: maker.publicKey, taker: taker.publicKey };

before(async () => {
  await fund(maker, taker, settler);
});

async function activeWager(fixtureId, opts = {}) {
  const { wagerId } = await createWager(program, maker, p1WinsTerms(fixtureId), opts);
  await acceptWager(program, taker, maker, wagerId);
  return { ...parties, wagerId };
}

describe("happy paths (the mechanism actually works)", () => {
  it("FT win pays maker the pot minus tip; settler gets the tip; vault drains", async () => {
    const w = await activeWager(USA);
    const [m0, s0] = [await balance(maker.publicKey), await balance(settler.publicKey)];
    await settle(programFor(settler), settler, w, USA_FINAL);
    const [m1, s1] = [await balance(maker.publicKey), await balance(settler.publicKey)];
    assert.equal(m1 - m0, 2 * STAKE - TIP, "maker receives pot minus tip");
    assert.ok(s1 - s0 >= TIP - 20_000, "settler nets the tip minus tx fee");
  });

  it("after-ET win (period 10) settles — second terminal phase accepted", async () => {
    const w = await activeWager(BELGIUM);
    const m0 = await balance(maker.publicKey);
    await settle(programFor(settler), settler, w, BELGIUM_ET);
    assert.equal((await balance(maker.publicKey)) - m0, 2 * STAKE - TIP);
  });

  it("pens-decided match settles at period 13 as an ET draw — taker collects", async () => {
    // Netherlands-Morocco went to a shootout; the terminal leaf is 1-1 at period 13
    // (shootout goals excluded). Under "P1 wins in 90'+ET" terms the predicate is
    // FALSE, so the taker is paid even though someone won the shootout. This is the
    // documented v1 market meaning, proven against the real proof.
    const w = await activeWager(NETHERLANDS);
    const t0 = await balance(taker.publicKey);
    await settle(programFor(settler), settler, w, PENS_FINAL);
    assert.equal((await balance(taker.publicKey)) - t0, 2 * STAKE - TIP, "taker paid on pens-decided match");
  });

  it("predicate FALSE pays the taker (ET-draw-pays-taker semantics)", async () => {
    // maker bets P2 (Bosnia) beats P1 on the same real 2-0 USA win: keys swapped,
    // (Bosnia - USA) > 0 is FALSE at the final whistle -> taker collects.
    const terms = {
      ...p1WinsTerms(USA), statAKey: 2, statBKey: 1,
    };
    const { wagerId } = await createWager(program, maker, terms);
    await acceptWager(program, taker, maker, wagerId);
    const w = { ...parties, wagerId };
    const t0 = await balance(taker.publicKey);
    // proof marshalled with stats swapped to match the stored keys
    await settle(programFor(settler), settler, w, USA_FINAL, {
      statA: statB(USA_FINAL), statB: statA(USA_FINAL),
    });
    assert.equal((await balance(taker.publicKey)) - t0, 2 * STAKE - TIP, "taker paid on false predicate");
  });
});

describe("state machine (double-pay class)", () => {
  it("settle before accept is rejected (Open != Active)", async () => {
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA));
    await expectError(
      settle(programFor(settler), settler, { ...parties, wagerId }, USA_FINAL),
      "WagerNotActive"
    );
  });

  it("double-settle is rejected and pays nothing twice", async () => {
    const w = await activeWager(USA);
    await settle(programFor(settler), settler, w, USA_FINAL);
    const m1 = await balance(maker.publicKey);
    await expectError(settle(programFor(settler), settler, w, USA_FINAL), "WagerNotActive");
    assert.equal(await balance(maker.publicKey), m1, "no second payout");
  });

  it("settle after refund is rejected", async () => {
    const expiryTs = Math.floor(Date.now() / 1000) + 8;
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA), { expiryTs });
    await acceptWager(program, taker, maker, wagerId);
    await waitForChainTime(expiryTs);
    await refund(program, { ...parties, wagerId });
    await expectError(
      settle(programFor(settler), settler, { ...parties, wagerId }, USA_FINAL),
      "WagerNotActive"
    );
  });
});

describe("proof-substitution attacks", () => {
  it("genuine final proof for the WRONG fixture is rejected before the CPI", async () => {
    // Would settle in an implementation that trusts any oracle-valid proof:
    // England's 2-1 is a real, verifiable win — just not the match wagered on.
    const w = await activeWager(USA);
    await expectError(
      settle(programFor(settler), settler, w, ENGLAND_FINAL),
      "FixtureMismatch"
    );
  });

  it("THE exploit: genuine mid-match period-0 proof (1-0, 49th minute) is rejected", async () => {
    const w = await activeWager(USA);
    await expectError(
      settle(programFor(settler), settler, w, USA_MID),
      "NonTerminalPeriod"
    );
  });

  it("mid-SHOOTOUT proof (period 12, pens in progress) is rejected as non-terminal", async () => {
    // Genuine leaf captured while Netherlands-Morocco pens were being taken. The
    // score it proves (1-1) equals the final, but the match was not over — a settle
    // here would race the shootout's own feed updates. Must bounce.
    const w = await activeWager(NETHERLANDS);
    await expectError(
      settle(programFor(settler), settler, w, PENS_MID),
      "NonTerminalPeriod"
    );
  });

  it("stat_b from a different event with forged terminal period is rejected", async () => {
    const w = await activeWager(USA);
    const forgedB = {
      statToProve: { ...USA_MID.statToProve2, period: 5 }, // claims finality
      eventStatRoot: b32(USA_MID.eventStatRoot),           // ...of the wrong event
      statProof: nodes(USA_MID.statProof2),
    };
    await expectError(
      settle(programFor(settler), settler, w, USA_FINAL, { statB: forgedB }),
      "EventRootMismatch"
    );
  });

  it("wrong daily-roots account (valid PDA, wrong day) is rejected", async () => {
    const w = await activeWager(USA);
    await expectError(
      settle(programFor(settler), settler, w, USA_FINAL, { roots: rootsPda(20635) }),
      "WrongDailyRootsAccount"
    );
  });

  it("genuine terminal proof for the WRONG STAT (corners, not goals) is rejected", async () => {
    // USA also won corners 4-3 — a real period-5 proof that would pay the maker on
    // a goals wager in an implementation that only checks fixture + finality.
    const w = await activeWager(USA);
    await expectError(
      settle(programFor(settler), settler, w, USA_CORNERS),
      "StatKeyMismatch"
    );
  });

  it("tampered VALUE with intact period dies inside txoracle (layered defense)", async () => {
    // 3-0 instead of 2-0 passes every wc-settle guard by design; the oracle's own
    // Merkle check must kill it. Proves the CPI is a real verification, not decor.
    const w = await activeWager(USA);
    const forged = { ...statA(USA_FINAL), statToProve: { ...USA_FINAL.statToProve, value: 3 } };
    await expectError(
      settle(programFor(settler), settler, w, USA_FINAL, { statA: forged }),
      "InvalidStatProof"
    );
  });
});

describe("expiry semantics (documented, not accidental)", () => {
  it("settle still works after expiry while Active — refund is opt-in, first valid tx wins", async () => {
    const expiryTs = Math.floor(Date.now() / 1000) + 6;
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA), { expiryTs });
    await acceptWager(program, taker, maker, wagerId);
    await waitForChainTime(expiryTs);
    const m0 = await balance(maker.publicKey);
    await settle(programFor(settler), settler, { ...parties, wagerId }, USA_FINAL);
    assert.equal((await balance(maker.publicKey)) - m0, 2 * STAKE - TIP);
  });
});

describe("timeout / refund", () => {
  it("refund before expiry is rejected", async () => {
    const w = await activeWager(USA);
    await expectError(refund(program, w), "NotExpired");
  });

  it("refund after expiry returns both stakes exactly", async () => {
    const expiryTs = Math.floor(Date.now() / 1000) + 8;
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA), { expiryTs });
    await acceptWager(program, taker, maker, wagerId);
    const [m0, t0] = [await balance(maker.publicKey), await balance(taker.publicKey)];
    await waitForChainTime(expiryTs);
    await refund(programFor(settler), { ...parties, wagerId }); // permissionless caller
    assert.equal((await balance(maker.publicKey)) - m0, STAKE, "maker stake back");
    assert.equal((await balance(taker.publicKey)) - t0, STAKE, "taker stake back");
  });

  it("refund of an unaccepted wager returns the maker stake only", async () => {
    const expiryTs = Math.floor(Date.now() / 1000) + 6;
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA), { expiryTs });
    const m0 = await balance(maker.publicKey);
    await waitForChainTime(expiryTs);
    // settler pays the tx fee so the maker's delta is exactly the stake
    await refund(programFor(settler), { ...parties, wagerId });
    assert.equal((await balance(maker.publicKey)) - m0, STAKE);
  });

  it("double-refund is rejected", async () => {
    const expiryTs = Math.floor(Date.now() / 1000) + 6;
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA), { expiryTs });
    await waitForChainTime(expiryTs);
    await refund(program, { ...parties, wagerId });
    await expectError(refund(program, { ...parties, wagerId }), "WagerNotRefundable");
  });

  it("accept after expiry is rejected (no accept/refund race)", async () => {
    const expiryTs = Math.floor(Date.now() / 1000) + 5;
    const { wagerId } = await createWager(program, maker, p1WinsTerms(USA), { expiryTs });
    await waitForChainTime(expiryTs);
    await expectError(acceptWager(program, taker, maker, wagerId), "ExpiryInPast");
  });
});
