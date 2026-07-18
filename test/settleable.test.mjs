// Which lines settle on-chain, and on exactly what terms.
//
// This is a money path. A wrong answer here does not show a bad number on a screen, it settles a
// market on the wrong proposition and pays the wrong side. So each case is written so that a
// plausible naive implementation fails it, and the two that matter most are the push line and the
// handicap collision, because both look correct right up until someone is owed a refund.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isHalfLine, lineKind, termsOfFeedMarket, settleabilityOf, termsKey, onChainMarketsOf, STAT_KEYS,
} from "../lib/settleable.mjs";

const mk = (type, period, line, fixtureId = 18257739) => ({
  key: `${fixtureId}:${type}:${period}:${line ?? "-"}`,
  fixtureId, type, period, line,
});
const RESULT = "1X2_PARTICIPANT_RESULT";
const TOTALS = "OVERUNDER_PARTICIPANT_GOALS";
const HCAP = "ASIANHANDICAP_PARTICIPANT_GOALS";

test("only half lines are two-way", () => {
  for (const l of [0.5, 1.5, 2.5, -0.5, -1.5, 5.5]) assert.equal(isHalfLine(l), true, `${l} is a half line`);
  for (const l of [0, 1, 2, 3, -1, -2]) assert.equal(isHalfLine(l), false, `${l} is an integer line`);
  for (const l of [0.25, 0.75, 1.25, -0.25, -1.75]) assert.equal(isHalfLine(l), false, `${l} is a quarter line`);
  assert.equal(isHalfLine(null), false);
});

test("an integer totals line does not settle, because it pushes", () => {
  // Over 2.0 with exactly two goals returns the stake to both sides. A binary market cannot express
  // that, and paying YES in full would take money that is owed back.
  const s = settleabilityOf(mk(TOTALS, "FT", 2));
  assert.equal(s.settleable, false);
  assert.match(s.reason, /pushes|stake is returned/);
  assert.equal(termsOfFeedMarket(mk(TOTALS, "FT", 2)), null);
});

test("an integer handicap does not settle, because it pushes", () => {
  // Home -1.0 with a one goal win is a push. Same trap as the totals line above.
  assert.equal(settleabilityOf(mk(HCAP, "FT", -1)).settleable, false);
  assert.equal(termsOfFeedMarket(mk(HCAP, "FT", -1)), null);
  // Handicap 0 is draw-no-bet, which pushes on a draw.
  assert.equal(settleabilityOf(mk(HCAP, "FT", 0)).settleable, false);
});

test("a quarter line does not settle, because the stake splits", () => {
  for (const l of [-1.25, -0.75, 0.25, 1.75]) {
    const s = settleabilityOf(mk(HCAP, "FT", l));
    assert.equal(s.settleable, false, `handicap ${l}`);
    assert.match(s.reason, /splits the stake/);
  }
});

test("every threshold produced is an integer, because the on-chain field is an i32", () => {
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, -0.5, -1.5, -2.5];
  for (const period of ["FT", "H1"]) {
    for (const l of lines) {
      for (const type of [TOTALS, HCAP]) {
        const t = termsOfFeedMarket(mk(type, period, l));
        assert.ok(t, `${type} ${period} ${l} should map`);
        assert.ok(Number.isInteger(t.threshold), `${type} ${period} ${l} gave threshold ${t.threshold}`);
      }
    }
  }
});

test("totals thresholds mean what the line says", () => {
  // Over 2.5 is "more than two goals", so the threshold is 2 and not 2.5 or 3.
  assert.deepEqual(termsOfFeedMarket(mk(TOTALS, "FT", 2.5)),
    { statAKey: 1, statBKey: 2, op: "add", comparison: "greaterThan", threshold: 2 });
  assert.equal(termsOfFeedMarket(mk(TOTALS, "FT", 0.5)).threshold, 0);
  assert.equal(termsOfFeedMarket(mk(TOTALS, "FT", 5.5)).threshold, 5);
});

test("handicap thresholds mean what the line says", () => {
  // Home -1.5 is "home won by two or more".
  assert.equal(termsOfFeedMarket(mk(HCAP, "FT", -1.5)).threshold, 1);
  // Home -0.5 is "home won".
  assert.equal(termsOfFeedMarket(mk(HCAP, "FT", -0.5)).threshold, 0);
  // Home +0.5 is "home did not lose", so home - away > -1.
  assert.equal(termsOfFeedMarket(mk(HCAP, "FT", 0.5)).threshold, -1);
  assert.equal(termsOfFeedMarket(mk(HCAP, "FT", 1.5)).threshold, -2);
});

test("the three result legs are three distinct comparisons on the same expression", () => {
  const legs = ["home", "draw", "away"].map((l) => termsOfFeedMarket(mk(RESULT, "FT", null), l));
  assert.deepEqual(legs.map((t) => t.comparison), ["greaterThan", "equalTo", "lessThan"]);
  for (const t of legs) {
    assert.equal(t.op, "subtract");
    assert.equal(t.threshold, 0);
    assert.equal(t.statAKey, 1);
    assert.equal(t.statBKey, 2);
  }
  assert.equal(new Set(legs.map(termsKey)).size, 3, "the three legs must not collapse into one market");
});

test("first half uses the 1001/1002 keys and is otherwise identical", () => {
  assert.deepEqual(STAT_KEYS.H1, [1001, 1002]);
  const ft = termsOfFeedMarket(mk(TOTALS, "FT", 2.5));
  const h1 = termsOfFeedMarket(mk(TOTALS, "H1", 2.5));
  assert.equal(h1.statAKey, 1001);
  assert.equal(h1.statBKey, 1002);
  assert.equal(h1.threshold, ft.threshold);
  assert.equal(h1.op, ft.op);
  assert.notEqual(termsKey(h1), termsKey(ft), "a half and a full match market must never collapse");
});

test("handicap -0.5 IS the home result leg, and collapses to one market", () => {
  // Both say "home - away > 0", which is just "home wins". The feed quotes them as two markets.
  // Keeping them apart on chain would put the same bet in two books at two prices.
  const home = termsOfFeedMarket(mk(RESULT, "FT", null), "home");
  const hcap = termsOfFeedMarket(mk(HCAP, "FT", -0.5));
  assert.equal(termsKey(hcap), termsKey(home));

  const out = onChainMarketsOf([mk(RESULT, "FT", null), mk(HCAP, "FT", -0.5)]);
  const collapsed = out.filter((o) => o.termsKey === termsKey(home));
  assert.equal(collapsed.length, 1, "one market, not two");
  assert.equal(collapsed[0].sources.length, 2, "and it records both feed lines that price it");
});

test("handicap +0.5 does NOT collapse, because it is a double chance", () => {
  // "home - away > -1" means home won or drew. No single result leg says that.
  const plus = termsOfFeedMarket(mk(HCAP, "FT", 0.5));
  const legs = ["home", "draw", "away"].map((l) => termsKey(termsOfFeedMarket(mk(RESULT, "FT", null), l)));
  assert.ok(!legs.includes(termsKey(plus)), "double chance must stay its own market");
});

test("a period with no stat keys does not settle", () => {
  const s = settleabilityOf(mk(TOTALS, "H2", 2.5));
  assert.equal(s.settleable, false);
  assert.match(s.reason, /no stat key/);
  assert.equal(termsOfFeedMarket(mk(TOTALS, "H2", 2.5)), null);
});

test("a real catalogue collapses to the expected board", () => {
  // Fixture 18257739 as the feed actually served it: 9 settleable lines out of 29.
  const catalogue = [
    mk(RESULT, "FT", null), mk(RESULT, "H1", null),
    mk(HCAP, "FT", -1.25), mk(HCAP, "FT", -1), mk(HCAP, "FT", -0.75), mk(HCAP, "FT", -0.5),
    mk(HCAP, "FT", -0.25), mk(HCAP, "FT", 0), mk(HCAP, "FT", 0.25), mk(HCAP, "FT", 0.5), mk(HCAP, "FT", 0.75),
    mk(HCAP, "H1", -0.5), mk(HCAP, "H1", -0.25), mk(HCAP, "H1", 0), mk(HCAP, "H1", 0.25), mk(HCAP, "H1", 0.5),
    mk(TOTALS, "FT", 1.25), mk(TOTALS, "FT", 1.5), mk(TOTALS, "FT", 1.75), mk(TOTALS, "FT", 2),
    mk(TOTALS, "FT", 2.25), mk(TOTALS, "FT", 2.5), mk(TOTALS, "FT", 2.75), mk(TOTALS, "FT", 3), mk(TOTALS, "FT", 3.25),
    mk(TOTALS, "H1", 0.5), mk(TOTALS, "H1", 0.75), mk(TOTALS, "H1", 1), mk(TOTALS, "H1", 1.25),
  ];
  assert.equal(catalogue.length, 29, "this is the real 29 market catalogue");
  assert.equal(catalogue.filter((m) => settleabilityOf(m).settleable).length, 9);

  const onChain = onChainMarketsOf(catalogue);
  // 3 result legs FT + 3 result legs H1 + 2 handicap FT + 2 handicap H1 + 2 totals FT + 1 totals H1
  // = 13, minus the two handicap -0.5 lines that collapse into the home legs = 11.
  assert.equal(onChain.length, 11);
  for (const o of onChain) assert.ok(Number.isInteger(o.terms.threshold));
});

test("junk in the catalogue never throws", () => {
  assert.deepEqual(onChainMarketsOf(null), []);
  assert.deepEqual(onChainMarketsOf([null, undefined, {}, mk("UNKNOWN_TYPE", "FT", 1.5)]), []);
  assert.equal(settleabilityOf(null).settleable, false);
  assert.equal(termsOfFeedMarket(null), null);
  assert.equal(termsKey(null), null);
});

// ---- resolution: does the proposition hold on the proven score? --------------------------------
//
// This is what decides who won, so it has to agree with the on-chain resolve exactly. The arena
// scoreboard was briefly wrong here in a way that looked completely plausible: it read a field
// name that does not exist on the score object, so every first-half market resolved as nil-nil and
// the half-time draw won every time.

import { predicateHolds } from "../lib/settleable.mjs";

// England 1, Argentina 2, goalless at the break. The real fixture 18241006.
const SCORE = { p1: 1, p2: 2, firstHalf: { p1: 0, p2: 0 } };

test("the match result resolves on the full-time score", () => {
  const leg = (l) => predicateHolds(termsOfFeedMarket(mk(RESULT, "FT", null), l), SCORE);
  assert.equal(leg("home"), false, "England did not win");
  assert.equal(leg("draw"), false, "it was not a draw");
  assert.equal(leg("away"), true, "Argentina won");
});

test("the first half resolves on the half-time score, not the full-time one", () => {
  // This is the case that was silently broken. Full time was 1-2 and half time was 0-0, so a
  // resolver reading the wrong field gets the away leg right by luck and the draw leg wrong.
  const leg = (l) => predicateHolds(termsOfFeedMarket(mk(RESULT, "H1", null), l), SCORE);
  assert.equal(leg("home"), false);
  assert.equal(leg("draw"), true, "it was 0-0 at the break");
  assert.equal(leg("away"), false, "Argentina led at full time, not at half time");
});

test("totals resolve against the goals actually scored in that period", () => {
  assert.equal(predicateHolds(termsOfFeedMarket(mk(TOTALS, "FT", 2.5)), SCORE), true, "3 goals is over 2.5");
  assert.equal(predicateHolds(termsOfFeedMarket(mk(TOTALS, "FT", 3.5)), SCORE), false, "3 goals is under 3.5");
  assert.equal(predicateHolds(termsOfFeedMarket(mk(TOTALS, "H1", 0.5)), SCORE), false, "no goals in the first half");
});

test("handicaps resolve on the goal difference", () => {
  // England -1.5 needed a two goal win. Argentina +0.5 needed England not to win.
  assert.equal(predicateHolds(termsOfFeedMarket(mk(HCAP, "FT", -1.5)), SCORE), false);
  assert.equal(predicateHolds(termsOfFeedMarket(mk(HCAP, "FT", 0.5)), SCORE), false, "England lost, so did not cover +0.5");
});

test("a missing statistic returns null rather than being read as zero", () => {
  // The exact failure mode that broke the scoreboard: absent data must not resolve as nil-nil.
  assert.equal(predicateHolds(termsOfFeedMarket(mk(RESULT, "H1", null), "draw"), { p1: 1, p2: 2 }), null);
  assert.equal(predicateHolds(termsOfFeedMarket(mk(RESULT, "FT", null), "home"), {}), null);
  assert.equal(predicateHolds(null, SCORE), null);
  assert.equal(predicateHolds(termsOfFeedMarket(mk(RESULT, "FT", null), "home"), null), null);
});
