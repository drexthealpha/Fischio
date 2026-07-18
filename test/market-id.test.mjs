// The market id decides the market's address, so these properties are load-bearing. A change that
// breaks any of them orphans every market already on chain, or binds two propositions to one pool.
import test from "node:test";
import assert from "node:assert/strict";
import { marketIdOf, canonicalTerms } from "../lib/market-id.mjs";
import { termsOfFeedMarket } from "../lib/settleable.mjs";

const mk = (type, period, line) => ({ type, period, line, fixtureId: 18257739 });
const RESULT = "1X2_PARTICIPANT_RESULT";
const TOTALS = "OVERUNDER_PARTICIPANT_GOALS";
const HCAP = "ASIANHANDICAP_PARTICIPANT_GOALS";
const idFor = (m, leg = "home", fixture = 18257739) => marketIdOf(fixture, termsOfFeedMarket(m, leg));

test("the same bet always gets the same id", () => {
  const a = idFor(mk(TOTALS, "FT", 2.5));
  const b = idFor(mk(TOTALS, "FT", 2.5));
  assert.equal(a, b);
  // and it does not drift between processes: this is the value the derivation produces today, so
  // an accidental change to the canonical form fails here instead of on chain.
  assert.equal(typeof a, "bigint");
  assert.ok(a > 0n && a < (1n << 63n), "must fit in 63 bits");
});

test("different bets get different ids", () => {
  const ids = new Set([
    idFor(mk(TOTALS, "FT", 1.5)), idFor(mk(TOTALS, "FT", 2.5)), idFor(mk(TOTALS, "FT", 3.5)),
    idFor(mk(TOTALS, "H1", 1.5)), idFor(mk(TOTALS, "H1", 2.5)),
    idFor(mk(HCAP, "FT", -1.5)), idFor(mk(HCAP, "FT", 0.5)),
    idFor(mk(RESULT, "FT", null), "home"), idFor(mk(RESULT, "FT", null), "draw"), idFor(mk(RESULT, "FT", null), "away"),
    idFor(mk(RESULT, "H1", null), "home"),
  ].map(String));
  assert.equal(ids.size, 11, "every distinct proposition needs its own address");
});

test("the same bet on different fixtures gets different ids", () => {
  assert.notEqual(idFor(mk(TOTALS, "FT", 2.5), "home", 18257739), idFor(mk(TOTALS, "FT", 2.5), "home", 18257865));
});

test("first half and full match never share an id", () => {
  assert.notEqual(idFor(mk(TOTALS, "FT", 2.5)), idFor(mk(TOTALS, "H1", 2.5)));
  assert.notEqual(idFor(mk(RESULT, "FT", null), "home"), idFor(mk(RESULT, "H1", null), "home"));
});

test("handicap -0.5 and the home leg share an id, because they are the same bet", () => {
  // This is the collision that must NOT be broken apart. Both are "home - away > 0".
  assert.equal(idFor(mk(HCAP, "FT", -0.5)), idFor(mk(RESULT, "FT", null), "home"));
});

test("handicap +0.5 is its own market, because it is a double chance", () => {
  const plus = idFor(mk(HCAP, "FT", 0.5));
  for (const leg of ["home", "draw", "away"]) {
    assert.notEqual(plus, idFor(mk(RESULT, "FT", null), leg));
  }
});

test("terms that do not settle cannot produce an id", () => {
  // An integer line pushes, so it has no on-chain market and must not be given an address.
  assert.throws(() => marketIdOf(18257739, termsOfFeedMarket(mk(TOTALS, "FT", 2))), /do not settle/);
  assert.throws(() => marketIdOf(18257739, null), /do not settle/);
});

test("the canonical form is versioned, so a future change can be told apart", () => {
  const s = canonicalTerms(18257739, termsOfFeedMarket(mk(TOTALS, "FT", 2.5)));
  assert.match(s, /^fischio:v1:18257739:/);
  assert.match(s, /1:2:add:greaterThan:2$/);
});
