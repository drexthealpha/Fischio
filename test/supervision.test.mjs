// Restart policy for the always-on box. Timing bugs in a supervisor are otherwise found in
// production, at night, by nobody.
//
// The first two cases are the defects the previous supervisor had: backoff that never came back
// down, and a restart loop that never gave up.
import test from "node:test";
import assert from "node:assert/strict";
import { restartDecision, newState, healthOf, DEFAULTS } from "../lib/supervision.mjs";

test("a healthy run resets the backoff", () => {
  // The old supervisor doubled forever. A service that ran six hours then died came back carrying
  // a delay earned by unrelated failures, with no way down.
  const s = newState();
  for (let i = 0; i < 5; i++) restartDecision(s, { code: 1, ranForMs: 500 });
  assert.ok(s.delayMs > DEFAULTS.baseDelayMs, "backoff should have grown while crashing");

  const d = restartDecision(s, { code: 0, ranForMs: 10 * 60_000 });
  assert.equal(d.restart, true);
  assert.equal(d.delayMs, DEFAULTS.baseDelayMs, "a run that worked starts from the bottom again");
  assert.equal(s.rapidCrashes, 0);
  assert.match(d.reason, /backoff resets/);
});

test("a service that cannot stay up eventually gives up rather than looping forever", () => {
  const s = newState();
  let last;
  for (let i = 0; i < DEFAULTS.maxRapidCrashes; i++) last = restartDecision(s, { code: 1, ranForMs: 200 });
  assert.equal(last.restart, false, "restarting forever hides a broken service");
  assert.match(last.reason, /needs a person/);
});

test("backoff grows but is capped", () => {
  const s = newState();
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(restartDecision(s, { code: 1, ranForMs: 100 }).delayMs);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], "must not shrink while crashing");
  assert.ok(Math.max(...delays) <= DEFAULTS.maxDelayMs);
});

test("the healthy threshold is what separates a crash loop from a normal exit", () => {
  const justUnder = restartDecision(newState(), { code: 1, ranForMs: DEFAULTS.healthyAfterMs - 1 });
  const justOver = restartDecision(newState(), { code: 1, ranForMs: DEFAULTS.healthyAfterMs });
  assert.equal(justUnder.healthy, false);
  assert.equal(justOver.healthy, true);
});

test("a clean exit that was short still counts as a crash", () => {
  // Exit code 0 after two seconds is not success, it is a service that refuses to run.
  const d = restartDecision(newState(), { code: 0, ranForMs: 2000 });
  assert.equal(d.healthy, false);
  assert.equal(d.restart, true);
});

test("health can report not ok, which is the whole point of it", () => {
  const services = new Map([
    ["ingest", { startedAt: Date.now() - 60_000, restarts: 0 }],
    ["arena", { startedAt: null, givenUp: true, restarts: 8, lastExit: 1 }],
  ]);
  const h = healthOf(services);
  assert.equal(h.ok, false, "a supervisor reporting ok while a child gave up is the defect");
  assert.deepEqual(h.givenUp, ["arena"]);
  assert.match(h.summary, /gave up and need attention/);
});

test("health is ok only when every service is actually up", () => {
  const now = Date.now();
  const h = healthOf(new Map([
    ["ingest", { startedAt: now - 60_000 }],
    ["maker", { startedAt: now - 30_000 }],
  ]), now);
  assert.equal(h.ok, true);
  assert.match(h.summary, /all 2 service\(s\) running/);
  assert.equal(h.services.find((s) => s.name === "ingest").uptimeSeconds, 60);
});

test("a service between restarts is down but not given up", () => {
  const h = healthOf(new Map([["maker", { startedAt: null, restarts: 2 }]]));
  assert.equal(h.ok, false);
  assert.deepEqual(h.down, ["maker"]);
  assert.deepEqual(h.givenUp, []);
  assert.match(h.summary, /restarting/);
});

test("an empty supervisor is not silently healthy", () => {
  const h = healthOf(new Map());
  assert.equal(h.ok, true);
  assert.match(h.summary, /all 0 service/);
});
