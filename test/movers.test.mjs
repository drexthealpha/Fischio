// The movers board reduces a window of odds updates to the markets that moved. It is display
// data, so no money depends on it, but a movement figure that is quietly wrong is worse than no
// movement figure at all: it tells a trader a line travelled when it did not.
//
// Each case here is written so that a plausible naive implementation fails it. The first version
// of this code, which lived inline in the ingestion service, failed the first two.
import test from "node:test";
import assert from "node:assert/strict";
import { computeMovers } from "../lib/movers.mjs";

// One raw odds row in the shape the TxLINE window endpoint returns.
const row = ({
  fixture = 18257739, type = "1X2_PARTICIPANT_RESULT", period = "", params = "",
  names = ["part1", "draw", "part2"], pct, ts, messageId = `m${ts}`, inRunning = true,
}) => ({
  FixtureId: fixture,
  SuperOddsType: type,
  MarketPeriod: period,
  MarketParameters: params,
  PriceNames: names,
  // decimal odds scaled by 1000. The board reads Pct, so this only has to be self consistent.
  Prices: pct.map((p) => Math.round((100 / p) * 1000)),
  Pct: pct,
  InRunning: inRunning,
  MessageId: messageId,
  Ts: ts,
});

test("reports the outcome that moved most, not the first one", () => {
  // Home is flat at 45%. The draw drifts 27 -> 35. Reading outcomes[0] reports this market as
  // unmoved and drops it off the board entirely.
  const [m] = computeMovers([
    row({ pct: [45, 27, 28], ts: 1_000_000 }),
    row({ pct: [45, 35, 20], ts: 1_240_000 }),
  ]);

  assert.equal(m.outcome, "draw");
  assert.ok(Math.abs(m.move - 0.08) < 1e-9, `expected +8 points on the draw, got ${m.move}`);
  assert.equal(m.seconds, 240);
});

test("picks first and last by timestamp, not by array order", () => {
  // The window is not sorted. Taking the last element as the latest price reads this move
  // backwards: down 12 points instead of up 12.
  const [m] = computeMovers([
    row({ pct: [52, 24, 24], ts: 2_300_000 }), // latest, listed first
    row({ pct: [40, 30, 30], ts: 2_000_000 }), // earliest, listed last
  ]);

  assert.equal(m.outcome, "part1");
  assert.ok(m.move > 0, `expected an upward move, got ${m.move}`);
  assert.ok(Math.abs(m.move - 0.12) < 1e-9);
  assert.ok(Math.abs(m.from - 0.40) < 1e-9);
  assert.ok(Math.abs(m.to - 0.52) < 1e-9);
});

test("skips quarter lines, which carry no fair price to difference", () => {
  const quarter = (pct, ts) => row({
    type: "ASIANHANDICAP_PARTICIPANT_GOALS", params: "line=-0.25",
    names: ["part1", "part2"], pct, ts,
  });
  // TxODDS sends the string "NA" rather than a percentage on these.
  const out = computeMovers([quarter(["NA", "NA"], 3_000_000), quarter(["NA", "NA"], 3_120_000)]);
  assert.deepEqual(out, []);
});

test("a market with one update in the window is a price, not a move", () => {
  assert.deepEqual(computeMovers([row({ pct: [45, 27, 28], ts: 4_000_000 })]), []);
});

test("sorts by absolute move so the biggest travel leads, in either direction", () => {
  const totals = (line, pct, ts) => row({
    type: "OVERUNDER_PARTICIPANT_GOALS", params: `line=${line}`,
    names: ["over", "under"], pct, ts,
  });
  const out = computeMovers([
    // 2.5 line: over falls 6 points
    totals(2.5, [58, 42], 5_000_000), totals(2.5, [52, 48], 5_180_000),
    // 3.5 line: over falls 15 points, the bigger travel despite being negative
    totals(3.5, [40, 60], 5_000_000), totals(3.5, [25, 75], 5_180_000),
    // 1.5 line: over rises 2 points
    totals(1.5, [70, 30], 5_000_000), totals(1.5, [72, 28], 5_180_000),
  ]);

  assert.equal(out.length, 3);
  assert.deepEqual(out.map((m) => m.line), [3.5, 2.5, 1.5]);
  assert.ok(out[0].move < 0, "the leading row here is a fall, and it should still lead");
});

test("counts ticks, which separate a repricing from a market being pushed", () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(row({ pct: [40 + i, 30, 30 - i], ts: 6_000_000 + i * 10_000 }));
  const [m] = computeMovers(rows);

  assert.equal(m.ticks, 12);
  // home 40 -> 51 and away 30 -> 19 are the same size in opposite directions. The tie breaks to
  // feed order, so the headline is home rising rather than away falling.
  assert.equal(m.outcome, "part1");
  assert.ok(Math.abs(m.move - 0.11) < 1e-9);
});

test("carries the messageId of the closing price, so the move can be proven on-chain", () => {
  const [m] = computeMovers([
    row({ pct: [45, 27, 28], ts: 7_000_000, messageId: "open" }),
    row({ pct: [49, 27, 24], ts: 7_120_000, messageId: "close" }),
  ]);
  assert.equal(m.messageId, "close");
  assert.equal(m.ts, 7_120_000);
});

test("reports every outcome's move, not only the headline one", () => {
  const [m] = computeMovers([
    row({ pct: [45, 27, 28], ts: 8_000_000 }),
    row({ pct: [49, 30, 21], ts: 8_120_000 }),
  ]);

  assert.deepEqual(m.outcomes.map((o) => o.outcome), ["part1", "draw", "part2"]);
  const away = m.outcomes.find((o) => o.outcome === "part2");
  assert.ok(Math.abs(away.move + 0.07) < 1e-9, "away fell 7 points and that should be visible");
  assert.equal(m.outcome, "part2", "the 7 point fall is the largest travel on this line");
});

test("minMove drops noise, and limit caps the board", () => {
  const totals = (line, pct, ts) => row({
    type: "OVERUNDER_PARTICIPANT_GOALS", params: `line=${line}`,
    names: ["over", "under"], pct, ts,
  });
  const rows = [];
  for (let i = 0; i < 8; i++) {
    // half these lines move 1 point, half move 10
    const jump = i % 2 === 0 ? 1 : 10;
    rows.push(totals(i, [50, 50], 9_000_000), totals(i, [50 + jump, 50 - jump], 9_060_000));
  }

  assert.equal(computeMovers(rows, { minMove: 0.05 }).length, 4, "only the 10 point moves survive");
  assert.equal(computeMovers(rows, { limit: 3 }).length, 3);
  assert.equal(computeMovers(rows, { limit: 0 }).length, 8, "limit 0 returns the whole board");
});

test("survives junk in the window without throwing", () => {
  const out = computeMovers([
    null, undefined, {}, { SuperOddsType: "1X2_PARTICIPANT_RESULT" }, // no prices, no Ts
    row({ pct: [45, 27, 28], ts: 10_000_000 }),
    row({ pct: [50, 27, 23], ts: 10_060_000 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].outcome, "part1");
});

test("an empty or missing window is an empty board, never a throw", () => {
  assert.deepEqual(computeMovers([]), []);
  assert.deepEqual(computeMovers(null), []);
  assert.deepEqual(computeMovers(undefined), []);
});
