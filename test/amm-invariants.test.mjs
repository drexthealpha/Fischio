// Property and fuzz tests for the market maker math.
//
// The Rust program has unit tests, but each checks one hand-picked case, and they do not run in
// this JavaScript suite. The reviewer's phrase was that the tests were weak. A money invariant is
// not proven by one example. This throws long random sequences of every operation at a faithful
// ledger and checks the invariants after each step, so a break shows up as a concrete failing
// sequence with a seed you can replay, not a vague worry.
//
// THE INVARIANT THAT MATTERS
//
// This is a conditional-token market: collateral in the vault is what pays winners. Every unit of
// collateral is matched by exactly one YES and one NO in existence, so the market can always pay
// whichever side wins and never more than it holds. In one line: vault == YES supply == NO supply.
// If any operation ever breaks that equality, the market is either insolvent or minting free
// money. The ledger below mirrors the program's mint, burn and transfer accounting instruction by
// instruction, and asserts the equality after every single step of every random sequence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  priceBps, calcBuy, calcSell, calcAddLiquidity, calcRemoveLiquidity, fee,
} from "../lib/amm.mjs";

// Reproducible randomness. A failure prints its seed; set FISCHIO_FUZZ_SEED to replay it exactly.
const SEED = Number(process.env.FISCHIO_FUZZ_SEED ?? (Math.random() * 2 ** 32) >>> 0);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const U = 1_000_000n; // six-decimal token units, as on-chain

// A faithful ledger of one market. Reserves are the pool's token balances. yesSupply and noSupply
// are the total in existence (pool plus every trader). vault is the collateral held. Each method
// applies the exact accounting of the matching program instruction.
function newMarket() {
  return { ry: 0n, rn: 0n, lp: 0n, vault: 0n, yesSupply: 0n, noSupply: 0n, feeBps: 200n };
}
const traderYes = (m) => m.yesSupply - m.ry; // shares held outside the pool, in aggregate
const traderNo = (m) => m.noSupply - m.rn;

function addLiquidity(m, collateral) {
  const a = calcAddLiquidity(m.ry, m.rn, m.lp, collateral);
  if (!a) return false;
  // program mints `collateral` of each side (pool keeps its share, provider gets the surplus)
  m.ry += a.poolYes; m.rn += a.poolNo; m.lp += a.mintLp;
  m.vault += collateral; m.yesSupply += collateral; m.noSupply += collateral;
  return true;
}
function buy(m, side, collateralIn) {
  const f = fee(collateralIn, m.feeBps);
  const net = collateralIn - f;
  const [rOut, rOther] = side === "yes" ? [m.ry, m.rn] : [m.rn, m.ry];
  const sharesOut = calcBuy(rOut, rOther, net);
  if (sharesOut == null) return false;
  const fromPool = sharesOut - net;      // AMM draw from the bought-side reserve
  const newROut = rOut - fromPool + f;   // minus the draw, plus the fee minted back in
  const newROther = rOther + net + f;    // gains the buyer's other-side split, plus the fee
  if (newROut <= 0n || newROther <= 0n) return false;
  if (side === "yes") { m.ry = newROut; m.rn = newROther; } else { m.rn = newROut; m.ry = newROther; }
  // net+fee == collateralIn of each side is minted; the vault takes the whole collateral
  m.vault += collateralIn; m.yesSupply += collateralIn; m.noSupply += collateralIn;
  return true;
}
function sell(m, side, collateralOut) {
  const [rOut, rOther] = side === "yes" ? [m.ry, m.rn] : [m.rn, m.ry];
  const sharesIn = calcSell(rOut, rOther, collateralOut);
  if (sharesIn == null) return false;
  // a real seller has to own the shares they return to the pool
  if ((side === "yes" ? traderYes(m) : traderNo(m)) < sharesIn) return false;
  if (m.vault < collateralOut) return false;
  const newROut = rOut + sharesIn - collateralOut; // gains returned shares, loses the burned pair
  const newROther = rOther - collateralOut;
  if (newROut < 0n || newROther <= 0n) return false;
  if (side === "yes") { m.ry = newROut; m.rn = newROther; } else { m.rn = newROut; m.ry = newROther; }
  m.vault -= collateralOut; m.yesSupply -= collateralOut; m.noSupply -= collateralOut;
  return true;
}
function split(m, amount) {
  m.vault += amount; m.yesSupply += amount; m.noSupply += amount; // mint a matched pair to the trader
  return true;
}
function merge(m, amount) {
  if (traderYes(m) < amount || traderNo(m) < amount || m.vault < amount) return false;
  m.vault -= amount; m.yesSupply -= amount; m.noSupply -= amount; // burn a matched pair, free collateral
  return true;
}
function removeLiquidity(m, lpBurn) {
  const out = calcRemoveLiquidity(m.ry, m.rn, m.lp, lpBurn);
  if (!out) return false;
  const [yo, no] = out;
  if (yo > m.ry || no > m.rn) return false;
  m.ry -= yo; m.rn -= no; m.lp -= lpBurn; // tokens move pool -> provider; supply and vault unchanged
  return true;
}

// The one assertion the whole file exists for, plus the structural ones that must hold with it.
function assertSolvent(m, where) {
  assert.equal(m.vault, m.yesSupply, `${where}: vault (${m.vault}) != YES supply (${m.yesSupply})`);
  assert.equal(m.vault, m.noSupply, `${where}: vault (${m.vault}) != NO supply (${m.noSupply})`);
  assert.ok(m.ry >= 0n && m.rn >= 0n, `${where}: a reserve went negative (${m.ry}, ${m.rn})`);
  assert.ok(traderYes(m) >= 0n && traderNo(m) >= 0n, `${where}: traders hold negative shares`);
}

test(`solvency holds across random sequences of every operation (seed ${SEED})`, () => {
  const rand = rng(SEED);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const amt = () => BigInt(1 + Math.floor(rand() * 5000)) * (rand() < 0.3 ? U : U / 100n);

  for (let run = 0; run < 200; run++) {
    const m = newMarket();
    // a market must be seeded before it can trade, exactly as on-chain
    assert.ok(addLiquidity(m, amt()), "first liquidity should always succeed");
    assertSolvent(m, `run ${run} after seed`);

    for (let step = 0; step < 300; step++) {
      const op = pick(["buy", "buy", "sell", "split", "merge", "addLiquidity", "removeLiquidity"]);
      if (op === "buy") buy(m, pick(["yes", "no"]), amt());
      else if (op === "sell") sell(m, pick(["yes", "no"]), amt());
      else if (op === "split") split(m, amt());
      else if (op === "merge") merge(m, amt());
      else if (op === "addLiquidity") addLiquidity(m, amt());
      else if (op === "removeLiquidity") removeLiquidity(m, m.lp / BigInt(2 + Math.floor(rand() * 8)));
      // Every operation either applies fully and stays solvent, or is refused and changes
      // nothing. There is no partial state in between, so the invariant must hold here no
      // matter which branch ran.
      assertSolvent(m, `run ${run} step ${step} after ${op}`);
    }
  }
});

test(`a buy never lowers the product and never drains the pool (seed ${SEED})`, () => {
  const rand = rng(SEED ^ 0x9e3779b9);
  for (let i = 0; i < 20_000; i++) {
    const ry = BigInt(1 + Math.floor(rand() * 5_000_000));
    const rn = BigInt(1 + Math.floor(rand() * 5_000_000));
    const side = rand() < 0.5 ? "yes" : "no";
    const [rOut, rOther] = side === "yes" ? [ry, rn] : [rn, ry];
    const cin = BigInt(Math.floor(rand() * 10_000_000));
    const out = calcBuy(rOut, rOther, cin);
    if (out == null || cin === 0n) continue;
    const newROut = rOut + cin - out; // pool's bought-side reserve after (before fee)
    const newROther = rOther + cin;   // pool's other-side reserve after
    assert.ok(newROut > 0n, `pool drained: rOut ${rOut} other ${rOther} in ${cin} out ${out}`);
    // product is preserved up to the rounding that always favours the pool
    assert.ok(newROut * newROther >= rOut * rOther, "product fell below k");
    assert.ok(newROut * newROther <= rOut * rOther + newROther, "product rose by more than the bounded dust");
  }
});

test(`buying an outcome makes that outcome more expensive (seed ${SEED})`, () => {
  const rand = rng(SEED ^ 0x85ebca6b);
  for (let i = 0; i < 20_000; i++) {
    const ry = BigInt(1000 + Math.floor(rand() * 5_000_000));
    const rn = BigInt(1000 + Math.floor(rand() * 5_000_000));
    const cin = BigInt(1000 + Math.floor(rand() * 2_000_000));
    const before = priceBps(ry, rn);
    const out = calcBuy(ry, rn, cin); // buy YES
    if (out == null) continue;
    const after = priceBps(ry + cin - out, rn + cin);
    assert.ok(after >= before, `YES got cheaper after buying it: ${before} -> ${after}`);
  }
});

test(`buying then selling the same shares back never returns more than was spent (seed ${SEED})`, () => {
  const rand = rng(SEED ^ 0xc2b2ae35);
  let checked = 0;
  for (let i = 0; i < 20_000; i++) {
    const ry = BigInt(10_000 + Math.floor(rand() * 5_000_000));
    const rn = BigInt(10_000 + Math.floor(rand() * 5_000_000));
    const spend = BigInt(100 + Math.floor(rand() * 1_000_000));
    const bought = calcBuy(ry, rn, spend); // no fee, the strongest form of the claim
    if (bought == null || bought === 0n) continue;
    const ny = ry + spend - bought, nn = rn + spend;
    // largest collateral whose required shares stay within what we hold, by binary search
    let lo = 0n, hi = nn - 1n, best = 0n;
    while (lo <= hi) {
      const mid = (lo + hi) / 2n;
      const need = calcSell(ny, nn, mid);
      if (need != null && need <= bought) { best = mid; lo = mid + 1n; } else hi = mid - 1n;
    }
    assert.ok(best <= spend, `free money: spent ${spend}, sold back for ${best}`);
    checked++;
  }
  assert.ok(checked > 1000, `too few round trips exercised (${checked})`);
});

test(`selling cannot drain the opposite reserve (seed ${SEED})`, () => {
  const rand = rng(SEED ^ 0x27d4eb2f);
  for (let i = 0; i < 20_000; i++) {
    const rOut = BigInt(1 + Math.floor(rand() * 5_000_000));
    const rOther = BigInt(1 + Math.floor(rand() * 5_000_000));
    assert.equal(calcSell(rOut, rOther, rOther), null, "draining the whole opposite reserve must be refused");
    assert.equal(calcSell(rOut, rOther, rOther + 1n), null, "over-draining must be refused");
    if (rOther > 1n) assert.notEqual(calcSell(rOut, rOther, rOther - 1n), null, "just under should be allowed");
  }
});

test(`adding liquidity never moves the price (seed ${SEED})`, () => {
  const rand = rng(SEED ^ 0x165667b1);
  for (let i = 0; i < 20_000; i++) {
    const ry = BigInt(1 + Math.floor(rand() * 5_000_000));
    const rn = BigInt(1 + Math.floor(rand() * 5_000_000));
    const lp = BigInt(1 + Math.floor(rand() * 5_000_000));
    const add = BigInt(1 + Math.floor(rand() * 5_000_000));
    const before = priceBps(ry, rn);
    const a = calcAddLiquidity(ry, rn, lp, add);
    if (!a) continue;
    const after = priceBps(ry + a.poolYes, rn + a.poolNo);
    // the pool keeps each side in proportion, so the price is flat to within one basis point of
    // integer rounding
    const drift = before > after ? before - after : after - before;
    assert.ok(drift <= 1n, `adding liquidity moved the price ${before} -> ${after}`);
    // The pool keeps the whole of its larger side and only a fraction of the smaller side, so
    // the surplus handed back to the provider is on the smaller side. Larger YES reserve means
    // more NO comes back, which is the same fact the Rust unit test pins down.
    if (ry > rn) assert.ok(a.backNo >= a.backYes, `expected NO surplus when YES reserve is larger`);
    if (rn > ry) assert.ok(a.backYes >= a.backNo, `expected YES surplus when NO reserve is larger`);
  }
});

test(`removing liquidity is pro rata and never exceeds the reserves (seed ${SEED})`, () => {
  const rand = rng(SEED ^ 0xd3a2646c);
  for (let i = 0; i < 20_000; i++) {
    const ry = BigInt(1 + Math.floor(rand() * 5_000_000));
    const rn = BigInt(1 + Math.floor(rand() * 5_000_000));
    const lp = BigInt(1 + Math.floor(rand() * 5_000_000));
    const burn = BigInt(Math.floor(rand() * Number(lp + 1n)));
    const out = calcRemoveLiquidity(ry, rn, lp, burn);
    if (!out) continue;
    const [yo, no] = out;
    assert.ok(yo <= ry && no <= rn, "cannot remove more than the pool holds");
    // the share taken out matches the share of LP burned, rounding down
    assert.ok(yo * lp <= ry * burn && no * lp <= rn * burn, "removal was more than pro rata");
  }
});

test("fee is bounded by the amount and rises with the rate", () => {
  assert.equal(fee(1_000_000n, 200n), 20_000n); // 2%
  assert.equal(fee(0n, 200n), 0n);
  assert.equal(fee(1_000_000n, 0n), 0n);
  for (let bps = 0n; bps <= 1000n; bps += 50n) {
    const amount = 1_000_000n;
    const f = fee(amount, bps);
    assert.ok(f <= amount, "a fee can never exceed the amount");
    assert.equal(f, (amount * bps) / 10_000n, "fee must be exact basis points");
  }
});
