// The tournament layer decides which of 105 matches get capital. Getting it wrong either strands
// money on matches three weeks out or drains the wallet before the ones being played today.
//
// The duplicate case is measured, not invented: the live feed lists USA v Paraguay under ids
// 17588394 and 17588396, three hours apart, one pairing out of 105.
import test from "node:test";
import assert from "node:assert/strict";
import { kickoffMs, stateOf, dedupeFixtures, allocationPlan } from "../lib/tournament.mjs";

const H = 3600_000;
const NOW = 1784400000000;
const fx = (id, p1, p2, koMs) => ({ FixtureId: id, Participant1: p1, Participant2: p2, StartTime: koMs });

test("kickoff reads both second and millisecond timestamps", () => {
  assert.equal(kickoffMs({ StartTime: 1784400000000 }), 1784400000000);
  assert.equal(kickoffMs({ StartTime: 1784400000 }), 1784400000000);
  assert.equal(kickoffMs({ StartTime: 0 }), null);
  assert.equal(kickoffMs({}), null);
});

test("state is decided by time, because the feed's GameState never changes", () => {
  assert.equal(stateOf(fx(1, "A", "B", NOW + H), NOW), "upcoming");
  assert.equal(stateOf(fx(1, "A", "B", NOW - H), NOW), "live");        // inside the match window
  assert.equal(stateOf(fx(1, "A", "B", NOW - 5 * H), NOW), "finished");
  assert.equal(stateOf({}, NOW), "unknown");
});

test("the duplicate listing collapses to one match, keeping the earlier id", () => {
  const out = dedupeFixtures([
    fx(17588396, "USA", "Paraguay", NOW + 3 * H),
    fx(17588394, "USA", "Paraguay", NOW),
    fx(17588308, "Qatar", "Switzerland", NOW + H),
  ]);
  assert.equal(out.length, 2, "two real matches, not three listings");
  const usa = out.find((f) => f.Participant1 === "USA");
  assert.equal(usa.FixtureId, 17588394, "the earlier id is the one the odds rows are keyed to");
});

test("the same pairing far apart is two real matches, not a duplicate", () => {
  // Group stage and a later knockout meeting are genuinely different fixtures.
  const out = dedupeFixtures([
    fx(1, "Spain", "Brazil", NOW),
    fx(2, "Spain", "Brazil", NOW + 20 * 24 * H),
  ]);
  assert.equal(out.length, 2);
});

test("live matches are funded before upcoming ones", () => {
  const p = allocationPlan([
    fx(1, "A", "B", NOW + 2 * H),   // upcoming
    fx(2, "C", "D", NOW - H),       // live
  ], { now: NOW, budget: 100, perMatch: 100, maxConcurrent: 1 });

  assert.equal(p.fund.length, 1);
  assert.equal(p.fund[0].fixture.FixtureId, 2, "the match being played wins the last slot");
  assert.match(p.skip[0].why, /ceiling/);
});

test("nearest kickoff wins among upcoming matches", () => {
  const p = allocationPlan([
    fx(1, "A", "B", NOW + 40 * H),
    fx(2, "C", "D", NOW + 2 * H),
    fx(3, "E", "F", NOW + 10 * H),
  ], { now: NOW, budget: 200, perMatch: 100, leadHours: 48 });

  assert.deepEqual(p.fund.map((r) => r.fixture.FixtureId), [2, 3]);
  assert.equal(p.skip.length, 1);
});

test("a match beyond the lead window is not funded, and says so", () => {
  const p = allocationPlan([fx(1, "A", "B", NOW + 200 * H)], { now: NOW, budget: 1e9, perMatch: 1, leadHours: 48 });
  assert.equal(p.fund.length, 0);
  assert.match(p.skip[0].why, /beyond the 48h funding window/);
});

test("a finished match is never funded", () => {
  const p = allocationPlan([fx(1, "A", "B", NOW - 10 * H)], { now: NOW, budget: 1e9, perMatch: 1 });
  assert.equal(p.fund.length, 0);
  assert.match(p.skip[0].why, /already played/);
});

test("the budget is a real ceiling, and the shortfall is named", () => {
  const p = allocationPlan([
    fx(1, "A", "B", NOW + H), fx(2, "C", "D", NOW + 2 * H), fx(3, "E", "F", NOW + 3 * H),
  ], { now: NOW, budget: 250, perMatch: 100 });

  assert.equal(p.fund.length, 2);
  assert.equal(p.spent, 200);
  assert.match(p.skip[0].why, /would need 300 of a 250 budget/);
});

test("every unfunded match carries a reason, so a quiet board is explainable", () => {
  const many = Array.from({ length: 105 }, (_, i) => fx(i, `T${i}a`, `T${i}b`, NOW + (i + 1) * H));
  const p = allocationPlan(many, { now: NOW, budget: 500, perMatch: 100, leadHours: 48 });

  assert.equal(p.fund.length, 5);
  assert.equal(p.fund.length + p.skip.length, 105, "no match is silently dropped");
  for (const s of p.skip) assert.ok(s.why && s.why.length > 0, `match ${s.fixture.FixtureId} has no reason`);
});

test("a full tournament with a real budget funds a sane slice", () => {
  // 105 matches spread over 40 days, 20000 collateral, 11 markets a match at 1000 each.
  const all = Array.from({ length: 105 }, (_, i) => fx(i, `T${i}a`, `T${i}b`, NOW + i * 9 * H));
  const p = allocationPlan(all, { now: NOW, budget: 20000, perMatch: 11000, leadHours: 48 });

  assert.equal(p.fund.length, 1, "one match at a time is what 20000 actually buys");
  assert.ok(p.skip.length === 104);
  assert.ok(p.spent <= p.budget);
});

test("junk in the schedule never throws", () => {
  assert.deepEqual(dedupeFixtures(null), []);
  assert.deepEqual(dedupeFixtures([null, {}, { Participant1: "A" }]), []);
  const p = allocationPlan(null, { now: NOW, budget: 100, perMatch: 10 });
  assert.deepEqual(p.fund, []);
});
