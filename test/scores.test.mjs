// Tests for reading the scores feed.
//
// These are written against the mistakes that are easy to make and impossible to see. Every
// trap below was found by reading the live feed, and each has the same shape: the wrong code
// parses cleanly, never throws, and returns a plausible number.
//
// The synthetic tests pin the logic. The live tests pin the assumptions the logic rests on, so
// that if TxLINE changes the feed underneath us a test says so, rather than a market settling
// on the wrong scoreline.
import test from "node:test";
import assert from "node:assert/strict";
import {
  readScore, fullTimeRow, endRow, rowAtStatus, isFinal, isInPlay, isOver, clockOf, latest, latestScored,
  statusNow, outcomeOf, stat, statKey, hasKickedOff, STAT, PERIOD, STATUS, TERMINAL,
} from "../lib/scores.mjs";
import { TERMINAL_PERIODS } from "../lib/proof-marshal.mjs";
import { txlineClient } from "../lib/txline.mjs";

// A finished match, shaped the way the feed really shapes one: Stats as a map with the period
// folded into the key, GameState stuck on "scheduled", StatusId on only some rows, and updates
// still arriving after the whistle.
const PLAYED = [
  { Seq: 3, Action: "venue", GameState: "scheduled", StatusId: 1, Ts: 100, FixtureId: 1 },
  { Seq: 12, Action: "kickoff", GameState: "scheduled", Ts: 200, FixtureId: 1, Stats: { 1: 0, 2: 0 } },
  { Seq: 425, Action: "halftime_finalised", GameState: "scheduled", StatusId: 3, Ts: 2000, FixtureId: 1, Stats: { 1: 0, 2: 0, 1001: 0, 1002: 0 } },
  { Seq: 872, Action: "goal", GameState: "scheduled", StatusId: 4, Ts: 3000, FixtureId: 1, Stats: { 1: 1, 2: 2 } },
  { Seq: 959, Action: "status", GameState: "scheduled", StatusId: 5, Ts: 4000, FixtureId: 1, Stats: { 1: 1, 2: 2, 7: 3, 8: 6, 1001: 1, 1002: 0 } },
  { Seq: 961, Action: "clock_adjustment", GameState: "scheduled", StatusId: 5, Ts: 4100, FixtureId: 1, Stats: { 1: 1, 2: 2, 7: 3, 8: 6, 1001: 1, 1002: 0 } },
  { Seq: 962, Action: "game_finalised", GameState: "scheduled", StatusId: 100, Ts: 5000, FixtureId: 1, Stats: { 1: 1, 2: 2, 7: 3, 8: 6, 1001: 1, 1002: 0 } },
  { Seq: 963, Action: "disconnected", GameState: "scheduled", Ts: 6000, FixtureId: 1, Stats: { 1: 1, 2: 2, 7: 3, 8: 6, 1001: 1, 1002: 0 } },
];

test("settlement proves the full-time row, not the finalisation and not the newest row", () => {
  // The trap that costs money. Sequences 959, 962 and 963 all carry the correct score of 1-2,
  // so every one of them looks right. Only 959 is at a terminal status, so only 959 produces a
  // proof settlement will accept. The other two fail on-chain, far away from the code that
  // chose them.
  const s = readScore(PLAYED);
  assert.equal(s.seq, 961, "settled from the wrong sequence");
  assert.equal(s.status, STATUS.FULL_TIME);
  assert.ok(TERMINAL_PERIODS.includes(s.status), "the chosen sequence must sit at a period the chain accepts");
  assert.equal(latest(PLAYED).Seq, 963, "there really are later rows, so this is a live trap and not a hypothetical");
  assert.equal(latestScored(PLAYED).Seq, 963, "and the newest row really does carry the right score, which is why it is tempting");
});

test("the finalisation row is not a settlement target", () => {
  // game_finalised arrives with StatusId 100. It reads like the end of the match, and it is the
  // obvious thing to key on, but a proof taken there carries period 100 and is rejected.
  const finalised = PLAYED.find((r) => r.Action === "game_finalised");
  assert.equal(finalised.StatusId, STATUS.FINALISED);
  assert.ok(!TERMINAL_PERIODS.includes(STATUS.FINALISED), "100 must never be treated as terminal");
  assert.notEqual(readScore(PLAYED).seq, finalised.Seq);
});

test("the terminal states we accept are exactly the ones the chain accepts", () => {
  // These two lists live in different files and are enforced in different languages. If they
  // drift, settlement starts rejecting proofs that this module happily produced.
  assert.deepEqual([...TERMINAL].sort(), [...TERMINAL_PERIODS].sort());
});

test("a 1X2 market settles on ninety minutes, even when the match went to extra time", () => {
  // The World Cup final can go to extra time. If it does, full time and the end of the match
  // are different moments with different scores, and both are terminal. Settling a 1X2 market
  // on the later one pays out the wrong side of a drawn match.
  const wentToEt = [
    { Seq: 12, Action: "kickoff", GameState: "scheduled", Ts: 200, FixtureId: 2, Stats: { 1: 0, 2: 0 } },
    { Seq: 900, Action: "goal", GameState: "scheduled", StatusId: 4, Ts: 3000, FixtureId: 2, Stats: { 1: 2, 2: 2 } },
    { Seq: 970, Action: "status", GameState: "scheduled", StatusId: 5, Ts: 7000, FixtureId: 2, Stats: { 1: 2, 2: 2 } },
    { Seq: 1100, Action: "status", GameState: "scheduled", StatusId: 10, Ts: 8000, FixtureId: 2, Stats: { 1: 3, 2: 2, 7001: 1, 7002: 0 } },
  ];
  const ninety = readScore(wentToEt);
  assert.deepEqual([ninety.p1, ninety.p2], [2, 2], "the 1X2 market is about the score at ninety minutes");
  assert.equal(outcomeOf(ninety), "DRAW", "a match level at ninety minutes is a draw for 1X2, whoever won later");
  assert.equal(ninety.wentToExtraTime, true, "and the reader should know the match did not stop there");

  const ended = readScore(wentToEt, { at: STATUS.AFTER_ET });
  assert.deepEqual([ended.p1, ended.p2], [3, 2], "a market about who won overall reads the later state");
  assert.equal(outcomeOf(ended), "P1");
  assert.notEqual(ninety.seq, ended.seq, "the two markets settle at different sequences");
});

test("a result corrected after the whistle settles on the corrected score", () => {
  // A goal ruled out after full time does not edit the old row. It arrives as a new row that
  // restates full time with a different score. Both rows are at a terminal status and both are
  // genuinely provable, so a proof of the withdrawn scoreline would still verify on-chain. The
  // newest statement has to win, or a corrected match pays out the side that did not win.
  const corrected = [...PLAYED, { Seq: 968, Action: "action_amend", GameState: "scheduled", StatusId: 5, Ts: 4500, FixtureId: 1, Stats: { 1: 1, 2: 1 } }];
  const s = readScore(corrected);
  assert.equal(s.seq, 968, "settled on the withdrawn scoreline");
  assert.deepEqual([s.p1, s.p2], [1, 1]);
  assert.equal(outcomeOf(s), "DRAW", "the correction changes who won");
  assert.equal(outcomeOf(readScore(PLAYED)), "P2", "and without the correction it still reads the old way");
});

test("a match with no full-time row is not finished, however many updates it has", () => {
  const stillPlaying = PLAYED.filter((r) => Number(r.StatusId ?? 0) < STATUS.FULL_TIME);
  assert.equal(isFinal(stillPlaying), false);
  assert.equal(fullTimeRow(stillPlaying), null);
  const s = readScore(stillPlaying);
  assert.equal(s.final, false, "an unfinished match must never report a final score");
  assert.equal(s.p1, 1, "but it should still report the running score");
});

test("GameState is not a signal and must not be read", () => {
  // Every row of a finished match says "scheduled". Any branch on this field is wrong in a way
  // that testing the happy path will never reveal.
  assert.ok(PLAYED.every((r) => r.GameState === "scheduled"));
  assert.equal(isFinal(PLAYED), true, "the match is over despite every row claiming to be scheduled");
  assert.equal(statusNow(PLAYED), STATUS.FINALISED, "StatusId is where the real state lives");
});

test("rows are ordered by sequence, not by position in the array", () => {
  const shuffled = [PLAYED[7], PLAYED[0], PLAYED[4], PLAYED[3], PLAYED[6], PLAYED[1], PLAYED[5], PLAYED[2]];
  assert.equal(readScore(shuffled).seq, 961);
  assert.equal(latest(shuffled).Seq, 963);
  assert.equal(statusNow(shuffled), STATUS.FINALISED);
});

test("rows carrying no stats cannot be a settlement target", () => {
  // A status row with no score is real. Proving it would prove nothing about the scoreline.
  const noScore = [{ Seq: 980, Action: "status", GameState: "scheduled", StatusId: 5, Ts: 1, FixtureId: 2 }];
  assert.equal(fullTimeRow(noScore), null);
  assert.equal(readScore(noScore), null);
});

test("period is encoded in the key, not carried beside it", () => {
  assert.equal(statKey(STAT.P1_GOALS), 1);
  assert.equal(statKey(STAT.P1_GOALS, PERIOD.FIRST_HALF), 1001);
  assert.equal(statKey(STAT.P2_GOALS, PERIOD.PENALTIES), 6002);
  const row = fullTimeRow(PLAYED);
  assert.equal(stat(row, STAT.P1_GOALS), 1);
  assert.equal(stat(row, STAT.P1_GOALS, PERIOD.FIRST_HALF), 1, "first-half goals live under key 1001");
  assert.equal(stat(row, STAT.P1_CORNERS), 3);
  assert.equal(stat(row, STAT.P2_CORNERS), 6);
  assert.equal(stat(row, STAT.P1_GOALS, PERIOD.PENALTIES), null, "a stat the feed never sent reads as null, not zero");
});

test("a statistic that was never published reads as null and not as nil-nil", () => {
  // Zero and "not reported" are different facts. A market that conflates them settles corners
  // at nil-nil for a match where corners were simply never sent.
  const sparse = [{ Seq: 5, Action: "status", GameState: "scheduled", StatusId: 5, Ts: 1, FixtureId: 1, Stats: { 1: 2, 2: 0 } }];
  const s = readScore(sparse);
  assert.equal(s.corners.p1, null);
  assert.equal(s.p2, 0, "an actual nil is still a nil");
});

test("outcome is read in the terms the market settles on", () => {
  assert.equal(outcomeOf(readScore(PLAYED)), "P2");
  assert.equal(outcomeOf({ p1: 3, p2: 1 }), "P1");
  assert.equal(outcomeOf({ p1: 0, p2: 0 }), "DRAW");
  assert.equal(outcomeOf(null), null);
});

test("in-play and kicked-off are separate questions", () => {
  assert.equal(hasKickedOff(PLAYED), true);
  assert.equal(isInPlay(PLAYED), false, "a finished match is not in play");
  const live = PLAYED.filter((r) => r.Seq <= 872);
  assert.equal(isInPlay(live), true);
  assert.equal(hasKickedOff(PLAYED.filter((r) => r.Action !== "kickoff")), false);
});

test("a market maker must stop on a finished match, including the finalisation state", () => {
  // The bug this pins. A market maker asking "is the current status terminal" gets false on a
  // match that ended two days ago, because the current status is 100 and the terminal list is
  // [5, 10, 13]. It then finds the status is not in the in-play list either, concludes the game
  // has not kicked off, applies the pre-match staleness window, and keeps quoting both sides of
  // a result anyone can already look up.
  //
  // isOver has to be true for every state from full time onward, which is a wider question than
  // "can this be settled". Knowable and provable are different instants and the gap is the leak.
  assert.equal(statusNow(PLAYED), STATUS.FINALISED, "the current status of a finished match is the finalisation");
  assert.equal(TERMINAL.includes(STATUS.FINALISED), false, "which is deliberately not in the terminal list");
  assert.equal(isInPlay(PLAYED), false, "and is not in play either, so a status check finds nothing to act on");
  assert.equal(isOver(PLAYED), true, "so this is the check a quoting bot has to use");

  // Every state from full time onward stops quoting, and nothing before it does.
  const at = (s) => [{ Seq: 1, Action: "status", GameState: "scheduled", StatusId: s, Ts: 1, FixtureId: 9, Stats: { 1: 1, 2: 0 } }];
  for (const s of [STATUS.FULL_TIME, STATUS.AFTER_ET, STATUS.PENALTIES, STATUS.AFTER_PENALTIES, STATUS.FINALISED])
    assert.equal(isOver(at(s)), true, `status ${s} must stop a market maker`);
  for (const s of [STATUS.PRE_MATCH, STATUS.FIRST_HALF, STATUS.HALF_TIME, STATUS.SECOND_HALF, STATUS.ET_FIRST, STATUS.ET_SECOND])
    assert.equal(isOver(at(s)), false, `status ${s} must not stop a market maker`);
  assert.equal(isOver([]), false, "and an empty feed is not a finished match");
});

test("the clock says whether play is actually happening", () => {
  // Running is the direct answer, and it goes false the instant the game stops.
  const live = [
    { Seq: 800, Action: "shot", GameState: "scheduled", StatusId: 4, Ts: 1, FixtureId: 1, Stats: { 1: 1, 2: 0 }, Clock: { Running: true, Seconds: 3661 } },
    { Seq: 810, Action: "injury", GameState: "scheduled", StatusId: 4, Ts: 2, FixtureId: 1, Stats: { 1: 1, 2: 0 }, Clock: { Running: false, Seconds: 3700 } },
  ];
  const c = clockOf(live);
  assert.equal(c.running, false, "the newest clock row wins, and play has stopped");
  assert.equal(c.minute, 61);
  assert.equal(clockOf(live.slice(0, 1)).running, true);
  assert.equal(clockOf([]), null, "no clock is not a clock at zero");
  assert.equal(clockOf([{ Seq: 1, Action: "comment", Ts: 1 }]), null, "most rows carry no clock at all");
});

test("an empty or missing snapshot is handled and not guessed at", () => {
  for (const empty of [[], null, undefined]) {
    assert.equal(readScore(empty), null);
    assert.equal(isFinal(empty), false);
    assert.equal(latest(empty), null);
    assert.equal(statusNow(empty), null);
  }
});

// ---- the assumptions above, checked against the real feed ----

test("live: a played semi-final settles on the score it really ended on", async (t) => {
  const c = txlineClient();
  if (!c.creds?.jwt) return t.skip("no feed credentials");
  const snap = await c.scoresSnapshot(18241006).catch(() => null); // England v Argentina, a real 1-2
  if (!snap) return t.skip("feed unreachable");
  const s = readScore(snap);
  assert.ok(s, "no score read from a match that has been played");
  assert.equal(s.final, true, "a played semi-final must read as final");
  assert.deepEqual([s.p1, s.p2], [1, 2], "the score of this match is a fact, and it is 1-2");
  assert.equal(outcomeOf(s), "P2", "Argentina won, which is why they are in the final");
  assert.ok(TERMINAL_PERIODS.includes(s.status), "the sequence chosen must be provable on-chain");
});

test("live: the proof's period is the row's StatusId, which is what pins a proof to a moment", async (t) => {
  const c = txlineClient();
  if (!c.creds?.jwt) return t.skip("no feed credentials");
  const snap = await c.scoresSnapshot(18241006).catch(() => null);
  if (!snap) return t.skip("feed unreachable");
  const ft = fullTimeRow(snap);
  assert.ok(ft, "no full-time row on a finished match");
  const pkg = await c.statValidation({ fixtureId: 18241006, seq: ft.Seq, statKey: STAT.P1_GOALS, statKey2: STAT.P2_GOALS }).catch(() => null);
  if (!pkg?.statToProve) return t.skip("validation feed unreachable");
  // The whole model rests on this. If it stops holding, choosing a sequence stops meaning
  // choosing a settlement moment, and everything above needs rethinking.
  assert.equal(pkg.statToProve.period, Number(ft.StatusId), "period no longer mirrors StatusId");
  assert.ok(TERMINAL_PERIODS.includes(pkg.statToProve.period), "the full-time proof is no longer terminal");
  assert.equal(pkg.statToProve.value, 1, "the proof should carry the score it settles");
  assert.equal(pkg.statToProve2.value, 2);
});

test("live: the settlement timestamp is the batch's, not the update's", async (t) => {
  const c = txlineClient();
  if (!c.creds?.jwt) return t.skip("no feed credentials");
  const snap = await c.scoresSnapshot(18241006).catch(() => null);
  if (!snap) return t.skip("feed unreachable");
  const ft = fullTimeRow(snap);
  const pkg = await c.statValidation({ fixtureId: 18241006, seq: ft.Seq, statKey: STAT.P1_GOALS, statKey2: STAT.P2_GOALS }).catch(() => null);
  if (!pkg?.summary) return t.skip("validation feed unreachable");

  // validate_stat builds the roots account seed from the timestamp it is handed, so that
  // timestamp has to identify the batch. The batch's identity is its minTimestamp, which is the
  // same figure epochDayOf reads. Handing it the update's own Ts fails with TimestampMismatch.
  //
  // The reason this needs a test rather than a comment: the two are equal whenever a batch holds
  // a single update, and most batches do. This one holds 26, because a batch at full time is
  // busy. Code that passes the wrong field works everywhere except the moment that settles money.
  assert.ok(pkg.summary.updateStats.updateCount > 1,
    "this batch now holds one update, where both timestamps agree; find a busier sequence or this test proves nothing");
  assert.notEqual(Number(pkg.ts), Number(pkg.summary.updateStats.minTimestamp),
    "the update timestamp and the batch timestamp now agree here, so the trap is not being exercised");
});

test("live: the traps this module works around are still in the feed", async (t) => {
  const c = txlineClient();
  if (!c.creds?.jwt) return t.skip("no feed credentials");
  const snap = await c.scoresSnapshot(18241006).catch(() => null);
  if (!snap) return t.skip("feed unreachable");
  const rows = Array.isArray(snap) ? snap : [snap];

  // If any of these fail, the feed changed. The workaround should then be revisited rather than
  // carried forward out of habit.
  assert.ok(rows.every((r) => r.GameState === "scheduled"),
    "GameState now varies; it may have become usable, so re-check before trusting it");
  const scored = rows.filter((r) => r.Stats && Object.keys(r.Stats).length);
  assert.ok(scored.length && !Array.isArray(scored[0].Stats),
    "Stats became a list; the period-in-the-key encoding may have changed");
  const ft = fullTimeRow(rows), newest = latest(rows);
  assert.ok(Number(newest.Seq) > Number(ft.Seq),
    "this match no longer has updates after full time, so pick another fixture to keep testing the trap");
  assert.ok(rows.some((r) => Number(r.StatusId) === STATUS.FINALISED),
    "the post-match finalisation row is gone, so the period-100 trap may no longer exist");

  // Every scored row repeats the whole stat map rather than sending what changed. That is what
  // makes it safe to take the newest row in a state and read any statistic off it. If these
  // ever became deltas, doing so would silently report null for anything that did not change in
  // that instant, and a corners market would settle at nil-nil.
  const counts = new Set(scored.map((r) => Object.keys(r.Stats).length));
  assert.equal(counts.size, 1, `scored rows now carry differing stat counts (${[...counts].join(", ")}); the feed may have moved to deltas`);
});
