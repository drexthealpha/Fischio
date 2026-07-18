// When is an old line dangerous, and when is it just quiet?
//
// This decides whether real orders rest on a price nobody has revisited. Getting it wrong in one
// direction leaves quotes out during a feed outage, where anyone watching the match can lift them.
// Getting it wrong the other way refuses to quote perfectly good markets, which is what left the
// handicap +0.5 market as the only proposition on fixture 18257739 with no order book.
//
// The numbers in these cases are measured, not invented. One snapshot of that fixture, ages in
// minutes: 1X2 FT 6, handicap FT 0 6, handicap FT -0.5 31, totals FT 2.5 29, handicap FT +0.5 478,
// totals FT 3 662, totals FT 1.25 812. The feed was healthy throughout.
import test from "node:test";
import assert from "node:assert/strict";
import { ageVerdict } from "../lib/staleness.mjs";

const MIN = 60;

test("a fresh line before kickoff is quoted at normal width", () => {
  const v = ageVerdict(6 * MIN, 6 * MIN, false);
  assert.equal(v.quote, true);
  assert.equal(v.widen, 1);
});

test("a quiet line is still quoted, because the feed is alive", () => {
  // handicap FT +0.5 at 478 minutes, while the board's freshest market is 6 minutes old.
  // The bookmaker has not revisited this line. The price is still the price.
  const v = ageVerdict(478 * MIN, 6 * MIN, false);
  assert.equal(v.quote, true, "refusing this is what left the market with no book");
  assert.ok(v.widen > 1, "but it must be quoted wider than a line that is being maintained");
  assert.match(v.reason, /feed is live/);
});

test("the whole board going quiet is a feed problem, and pulls everything", () => {
  // Every market old together means we are blind, not that every line is unpopular.
  const v = ageVerdict(30 * MIN, 30 * MIN, false);
  assert.equal(v.quote, false);
  assert.match(v.reason, /feed itself has gone quiet/);
});

test("a feed outage overrides freshness of an individual reading", () => {
  // Even a market whose own timestamp looks recent is not trustworthy when nothing else on the
  // board has moved, because that reading is the only thing keeping the board alive.
  const v = ageVerdict(60, 40 * MIN, false);
  assert.equal(v.quote, false);
  assert.match(v.reason, /feed itself/);
});

test("in play, a line that has missed more than one repricing is pulled", () => {
  // The line has to track the match. A price from before the goal went in is exactly what gets
  // lifted, and the feed being alive elsewhere does not make that price safe.
  //
  // 15 minutes is three of the feed's 300 second repricing intervals, so this line has missed at
  // least two updates while the match moved on.
  const v = ageVerdict(15 * MIN, 30, true);
  assert.equal(v.quote, false);
  assert.match(v.reason, /in-play/);
});

test("in play, the limit is set from what the feed actually does, not from a guess", () => {
  // Measured live on fixture 18257865, France against England at the 71st minute: the feed reprices
  // a live match every 300 seconds. Nine repricings observed, min 195s, median 300s, max 300s.
  //
  // The limit used to be 180 seconds. Against a 300 second cadence that is not strict, it is
  // unsatisfiable: every line is stale by definition and the maker quotes nothing in play, ever.
  // Both ages below were read off the live board while the bot sat refusing to quote anything.
  for (const age of [247, 269]) {
    const v = ageVerdict(age, 30, true);
    assert.equal(v.quote, true, `${age}s is inside one repricing interval and must be quotable`);
    assert.equal(v.widen, 1, `${age}s is normal, not a widening case`);
  }
});

test("in play, a line between one and two repricings is quoted wider rather than refused", () => {
  // Refusing outright makes the bot useless on this tier. Quoting tight on a price that has missed
  // an update is how it gets picked off. So it quotes, and is paid for the risk.
  const fresh = ageVerdict(299, 30, true);
  const missed = ageVerdict(450, 30, true);
  const nearly = ageVerdict(650, 30, true);

  assert.equal(fresh.widen, 1);
  assert.ok(missed.widen > fresh.widen, "a missed update must cost more spread");
  assert.ok(nearly.widen > missed.widen, "and the cost keeps rising toward the cutoff");
  assert.ok(nearly.widen <= 4, "but it is capped rather than growing without bound");
  assert.match(missed.reason, /repricing cadence/);
});

test("in play, a line that is tracking the match is quoted normally", () => {
  const v = ageVerdict(90, 30, true);
  assert.equal(v.quote, true);
  assert.equal(v.widen, 1);
});

test("a line with no timestamp is never quoted", () => {
  const v = ageVerdict(null, 60, false);
  assert.equal(v.quote, false);
  assert.match(v.reason, /no timestamp/);
});

test("an empty board is treated as a feed problem, not as freshness", () => {
  // boardAge null means nothing on the board carried a timestamp at all.
  const v = ageVerdict(60, null, false);
  assert.equal(v.quote, false);
  assert.match(v.reason, /feed itself/);
});

test("the widen factor grows the spread rather than replacing it", () => {
  // A quiet line and a normal line differ only by the multiplier, so a caller multiplying by
  // widen gets a wider quote around the same fair value rather than a different price.
  const quiet = ageVerdict(600 * MIN, MIN, false);
  const normal = ageVerdict(MIN, MIN, false);
  assert.ok(quiet.widen > normal.widen);
  assert.equal(normal.widen, 1);
});
