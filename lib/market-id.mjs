// The market id, derived from the terms rather than from the clock.
//
// The market PDA is seeded with [MARKET_SEED, creator, market_id], so the id decides the address.
// The seeders picked it as `Date.now() << 6 | random()`, which makes every run produce a new
// address for the same bet. That forces idempotency to be handled by scanning every market on the
// program and comparing fields by hand, which is what scripts/seed-final-totals.mjs does at line 64.
// That scan is O(all markets), it only knows the shapes its author thought of (it checks statAKey
// is 1 and statBKey is 2), and it silently opens a duplicate market the moment it meets terms it
// does not recognise. Two pools on one proposition split the liquidity and quote two prices for the
// same bet.
//
// Deriving the id from the terms fixes all of it at once:
//
//   the same bet always lands on the same address, so a second create fails on the account already
//   existing rather than opening a rival pool
//
//   anyone can compute the address for a proposition without reading our records, which is what
//   makes the market catalogue independently auditable
//
//   the check costs one account read instead of a full program scan
//
// The id is the first 63 bits of a SHA-256 over the canonical terms. 63 rather than 64 because the
// on-chain type is a u64 but the client side moves it through BN and a JS number in places, and a
// value above 2^63 is where those disagree. Collision risk at 63 bits over a few thousand markets
// is not a practical concern, and a collision fails closed anyway: the create reverts because the
// account exists, rather than silently binding two propositions to one pool.

import { createHash } from "node:crypto";
import { termsKey } from "./settleable.mjs";

/**
 * Canonical string for one market's terms. Order is fixed here and must never be rearranged,
 * because changing it changes every derived address and orphans every market already on chain.
 */
export const canonicalTerms = (fixtureId, terms) => `fischio:v1:${fixtureId}:${termsKey(terms)}`;

/** Deterministic market id for one proposition on one fixture. */
export function marketIdOf(fixtureId, terms) {
  const key = termsKey(terms);
  if (key == null) throw new Error("cannot derive a market id from terms that do not settle");
  const digest = createHash("sha256").update(canonicalTerms(fixtureId, terms)).digest();
  return digest.readBigUInt64BE(0) & ((1n << 63n) - 1n); // clear the top bit
}
