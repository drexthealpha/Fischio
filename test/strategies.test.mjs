// Two strategies that must genuinely disagree, and a scorer that must not flatter either.
//
// The contest only means something if the two agents take opposite sides of the same signal. If a
// bug ever let them agree, the arena would look like a contest while proving nothing, and that is
// the kind of failure that reads fine in a demo.
import test from "node:test";
import assert from "node:assert/strict";
import { detectMove, follower, fader, scorePositions, DEFAULTS } from "../lib/strategies.mjs";

const NOW = 1784400000000;
const S = 1000;
const hist = (...pairs) => pairs.map(([secsAgo, prob]) => ({ ts: NOW - secsAgo * S, prob }));

test("a move is measured oldest to newest by timestamp, not array order", () => {
  // Deliberately out of order. Reading the ends of the array gets the direction backwards.
  const m = detectMove([
    { ts: NOW - 10 * S, prob: 0.50 },
    { ts: NOW - 200 * S, prob: 0.40 },
    { ts: NOW - 100 * S, prob: 0.45 },
  ], { now: NOW });
  assert.equal(m.moved, true);
  assert.ok(Math.abs(m.delta - 0.10) < 1e-9, `expected +10 points, got ${m.delta}`);
  assert.ok(m.from < m.to, "from must be the older observation");
});

test("observations outside the window are ignored", () => {
  const m = detectMove(hist([3600, 0.20], [10, 0.50]), { windowSeconds: 300, now: NOW });
  assert.equal(m.moved, false, "the 0.20 point is an hour old and must not count as the start");
});

test("a move under the threshold is not a signal", () => {
  const m = detectMove(hist([200, 0.50], [10, 0.51]), { minMove: 0.03, now: NOW });
  assert.equal(m.moved, false);
  assert.match(m.reason, /under the 3.0 threshold/);
});

test("one observation is never a move", () => {
  assert.equal(detectMove(hist([10, 0.5]), { now: NOW }).moved, false);
  assert.equal(detectMove([], { now: NOW }).moved, false);
  assert.equal(detectMove(null, { now: NOW }).moved, false);
});

test("on a rising line the two strategies take opposite sides", () => {
  const history = hist([200, 0.40], [10, 0.50]);
  const f = follower.decide({ history, now: NOW });
  const d = fader.decide({ history, now: NOW });

  assert.equal(f.action, "buy");
  assert.equal(d.action, "buy");
  assert.equal(f.side, "yes", "the follower buys what the line moved toward");
  assert.equal(d.side, "no", "the fader buys what it moved away from");
  assert.notEqual(f.side, d.side);
});

test("on a falling line they also take opposite sides", () => {
  const history = hist([200, 0.60], [10, 0.48]);
  const f = follower.decide({ history, now: NOW });
  const d = fader.decide({ history, now: NOW });
  assert.equal(f.side, "no");
  assert.equal(d.side, "yes");
  assert.notEqual(f.side, d.side);
});

test("they never agree on any signal, over a spread of moves", () => {
  // The property that makes the contest meaningful, checked rather than assumed.
  for (let delta = -0.40; delta <= 0.40; delta += 0.01) {
    if (Math.abs(delta) < DEFAULTS.minMove) continue;
    const start = 0.5 - delta / 2;
    const history = hist([200, start], [10, start + delta]);
    const f = follower.decide({ history, now: NOW });
    const d = fader.decide({ history, now: NOW });
    if (f.action !== "buy") continue;
    assert.equal(d.action, "buy", `fader should also act on a ${delta} move`);
    assert.notEqual(f.side, d.side, `both took ${f.side} on a ${delta.toFixed(2)} move`);
  }
});

test("both hold when there is no signal", () => {
  const history = hist([200, 0.50], [10, 0.505]);
  assert.equal(follower.decide({ history, now: NOW }).action, "hold");
  assert.equal(fader.decide({ history, now: NOW }).action, "hold");
});

test("an existing position stops the same signal being taken again", () => {
  const history = hist([200, 0.40], [10, 0.50]);
  const fresh = follower.decide({ history, position: 0, now: NOW });
  const held = follower.decide({ history, position: 50, params: { size: 50, maxPositions: 1 }, now: NOW });
  assert.equal(fresh.action, "buy");
  assert.equal(held.action, "hold", "a ticking line must not build an ever growing position");
  assert.match(held.reason, /position limit/);
});

test("a short position also counts toward the limit", () => {
  const history = hist([200, 0.40], [10, 0.50]);
  const held = fader.decide({ history, position: -50, params: { size: 50, maxPositions: 1 }, now: NOW });
  assert.equal(held.action, "hold");
});

test("scoring pays a binary share one or nothing", () => {
  // YES bought at 0.42 that wins earns 0.58 a share; the same bet losing costs 0.42.
  const s = scorePositions([
    { side: "yes", size: 100, entryPrice: 0.42, won: true },
    { side: "yes", size: 100, entryPrice: 0.42, won: false },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.hitRate, 0.5);
  assert.ok(Math.abs(s.realised - (58 - 42)) < 1e-6, `expected 16, got ${s.realised}`);
});

test("drawdown is the worst peak to trough actually lived through", () => {
  // +50, then -30, then -30, then +40. Peak 50, trough -10, so the worst drawdown is 60.
  const s = scorePositions([
    { side: "yes", size: 100, entryPrice: 0.5, won: true },   // +50
    { side: "yes", size: 100, entryPrice: 0.3, won: false },  // -30
    { side: "yes", size: 100, entryPrice: 0.3, won: false },  // -30
    { side: "yes", size: 100, entryPrice: 0.6, won: true },   // +40
  ]);
  assert.equal(s.realised, 30);
  assert.equal(s.maxDrawdown, 60);
});

test("unsettled positions are excluded rather than counted as losses", () => {
  const s = scorePositions([
    { side: "yes", size: 100, entryPrice: 0.5, won: true },
    { side: "yes", size: 100, entryPrice: 0.5 },              // no result yet
    null,
  ]);
  assert.equal(s.n, 1, "a position with no proven result is not scored either way");
});

test("an empty record scores as nothing rather than as zero profit", () => {
  const s = scorePositions([]);
  assert.equal(s.n, 0);
  assert.equal(s.hitRate, null, "no hit rate exists on no trades, and 0% would be a lie");
});
