// A faithful JavaScript mirror of programs/market/src/math.rs.
//
// WHY A MIRROR EXISTS
//
// The money math lives in the Rust program. Its unit tests are good, but they run under
// `cargo test`, so they never run in the JavaScript continuous-integration gate, and they check
// one hand-picked case per property. This file re-expresses the exact same integer math so the
// fuzzer in test/amm-invariants.test.mjs can throw hundreds of thousands of random sequences at
// it on every push, with no validator and no chain.
//
// Everything is BigInt, because the program is u128 and the whole point is to match it to the
// base unit. A number that would overflow or underflow in the program returns null here, exactly
// where the program returns None and aborts. If this file and math.rs ever disagree, one of them
// is wrong and a trade settles for the wrong amount, so they are meant to be read side by side.
const BPS = 10_000n;

const asBig = (x) => (typeof x === "bigint" ? x : BigInt(Math.trunc(Number(x))));
// Ceiling division for positive integers, matching u128::div_ceil.
const divCeil = (a, b) => (a + b - 1n) / b;

/** YES price in basis points. price(YES) = no / (yes + no). Empty market is 50/50. */
export function priceBps(reserveYes, reserveNo) {
  const y = asBig(reserveYes), n = asBig(reserveNo);
  const total = y + n;
  if (total === 0n) return 5000n;
  return (n * BPS) / total;
}

/**
 * Buy `collateralIn` worth of the outcome whose reserve is `reserveOut`. Returns the number of
 * outcome shares the buyer receives, or null on a degenerate input.
 *
 * The pool's remaining reserve is rounded up, so the product never falls and the pool cannot be
 * drained below one unit. Any rounding dust is kept by the pool, never handed to the buyer.
 */
export function calcBuy(reserveOut, reserveOther, collateralIn) {
  const rOut = asBig(reserveOut), rOther = asBig(reserveOther), cin = asBig(collateralIn);
  if (cin === 0n) return 0n;
  const denom = rOther + cin;
  if (denom === 0n) return null;
  const newReserveOut = divCeil(rOut * rOther, denom);
  const out = rOut + cin - newReserveOut;
  return out < 0n ? null : out;
}

/**
 * Sell the outcome whose reserve is `reserveOut` to receive `collateralOut`. Returns the shares
 * the seller must give up, rounded up so the pool is never left short, or null when the sale
 * would drain the opposite reserve.
 */
export function calcSell(reserveOut, reserveOther, collateralOut) {
  const rOut = asBig(reserveOut), rOther = asBig(reserveOther), r = asBig(collateralOut);
  if (r === 0n) return 0n;
  if (r >= rOther) return null; // cannot remove more than the opposite reserve holds
  const denom = rOther - r;
  const sum = rOut + rOther - r;
  return divCeil(r * sum, denom);
}

/**
 * Add `collateral` of liquidity. The collateral is split into equal YES and NO; the pool keeps
 * each side in proportion to current reserves so the price does not move, and the surplus of the
 * larger side is returned to the provider along with LP tokens.
 * Returns { mintLp, poolYes, poolNo, backYes, backNo } or null.
 */
export function calcAddLiquidity(reserveYes, reserveNo, lpSupply, collateral) {
  const y = asBig(reserveYes), n = asBig(reserveNo), lp = asBig(lpSupply), c = asBig(collateral);
  if (c === 0n) return null;
  if (lp === 0n) return { mintLp: c, poolYes: c, poolNo: c, backYes: 0n, backNo: 0n };
  const weight = y > n ? y : n;
  if (weight === 0n) return null;
  const poolYes = (c * y) / weight;
  const poolNo = (c * n) / weight;
  return { mintLp: (c * lp) / weight, poolYes, poolNo, backYes: c - poolYes, backNo: c - poolNo };
}

/** Remove liquidity by burning `lpBurn` of `lpSupply`. Returns [yesOut, noOut] pro rata, or null. */
export function calcRemoveLiquidity(reserveYes, reserveNo, lpSupply, lpBurn) {
  const y = asBig(reserveYes), n = asBig(reserveNo), lp = asBig(lpSupply), burn = asBig(lpBurn);
  if (burn === 0n || lp === 0n || burn > lp) return null;
  return [(y * burn) / lp, (n * burn) / lp];
}

/** Trading fee on a collateral amount, in basis points. */
export function fee(amount, feeBps) {
  return (asBig(amount) * asBig(feeBps)) / BPS;
}
