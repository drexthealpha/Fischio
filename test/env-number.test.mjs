// Reading a number from a hosted panel's environment.
//
// This exists because of a bug that was written and caught within a minute of each other. The
// keeper's interval was changed to read `process.env.KEEPER_INTERVAL ?? 60000`, which looks right
// and is wrong: `??` falls through on null and undefined but not on the empty string, and a hosted
// panel hands the process an empty value for any variable that exists but was never filled in.
// `Number("")` is 0, so the interval would have become 0, and `setInterval(sweep, 0)` is a tight
// loop issuing getProgramAccounts against the RPC. The change was meant to reduce load from a
// 15 second sweep. It would have made it unbounded.
//
// The rule this pins: a value that does not parse to a positive finite number is not a value.
import test from "node:test";
import assert from "node:assert/strict";

/** The same resolver bot/odds-keeper.mjs uses, with argv and env injected so it can be tested. */
function num(flagValue, envValue, fallback, warn = () => {}) {
  for (const raw of [flagValue, envValue]) {
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    warn(raw);
  }
  return fallback;
}

test("an empty environment variable is absent, not zero", () => {
  // The whole reason this file exists.
  assert.equal(num(undefined, "", 60000), 60000);
  assert.equal(num(undefined, "   ", 60000), 60000);
});

test("a missing variable falls back", () => {
  assert.equal(num(undefined, undefined, 60000), 60000);
  assert.equal(num(undefined, null, 60000), 60000);
});

test("a real value is used", () => {
  assert.equal(num(undefined, "90000", 60000), 90000);
  assert.equal(num(undefined, 90000, 60000), 90000);
});

test("the command line beats the environment", () => {
  assert.equal(num("30000", "90000", 60000), 30000);
});

test("zero is refused, because it means a tight loop", () => {
  assert.equal(num(undefined, "0", 60000), 60000);
  assert.equal(num("0", undefined, 60000), 60000);
});

test("negative and nonsense values are refused", () => {
  for (const bad of ["-1", "abc", "NaN", "Infinity", "{}", "12s"]) {
    assert.equal(num(undefined, bad, 60000), 60000, `${bad} must not be accepted`);
  }
});

test("a refused value is reported rather than swallowed", () => {
  const seen = [];
  num(undefined, "abc", 60000, (raw) => seen.push(raw));
  assert.deepEqual(seen, ["abc"], "an operator who typed a bad value needs to be told");
});

test("a bad flag still lets a good environment value through", () => {
  assert.equal(num("abc", "90000", 60000), 90000);
});

test("fractional values are allowed, because drift is a fraction", () => {
  assert.equal(num(undefined, "0.05", 0.02), 0.05);
});
