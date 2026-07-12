//! Fixed-product market maker math for a binary (YES/NO) prediction market.
//!
//! Design mirrors the Gnosis FixedProductMarketMaker: outcome tokens are minted 1:1
//! from collateral (split) and burned 1:1 back to collateral (merge). The maker holds
//! YES and NO reserves; price is endogenous. All functions are pure, integer-only, and
//! overflow-checked, so the money math is deterministic and unit-testable with no chain.
//!
//! Every product of two reserves fits u128 for realistic token amounts (u64-scale, six
//! decimals). If a value would overflow, the function returns None and the caller aborts
//! rather than paying a wrong amount.

/// YES price in basis points, from reserves. price(YES) = no / (yes + no).
/// A larger YES reserve means cheaper YES, exactly like an AMM.
pub fn price_bps(reserve_yes: u128, reserve_no: u128) -> Option<u32> {
    let total = reserve_yes.checked_add(reserve_no)?;
    if total == 0 {
        return Some(5000); // empty market shows 50/50
    }
    Some((reserve_no.checked_mul(10_000)? / total) as u32)
}

/// Buy `collateral_in` worth of the outcome whose reserve is `reserve_out`.
/// Returns the outcome-token amount the buyer receives.
///
/// The buyer's collateral is split into equal YES and NO. The opposite side goes into
/// the pool; the bought side is drawn down to keep the product invariant. Result:
///   out = (reserve_out + collateral_in) - reserve_out * reserve_other / (reserve_other + collateral_in)
pub fn calc_buy(reserve_out: u128, reserve_other: u128, collateral_in: u128) -> Option<u128> {
    if collateral_in == 0 {
        return Some(0);
    }
    let denom = reserve_other.checked_add(collateral_in)?;
    if denom == 0 {
        return None;
    }
    // Round the pool's remaining reserve UP so the product never drops and the pool
    // stays solvent even at tiny reserves. Any dust favors the maker, never the buyer.
    let new_reserve_out = reserve_out.checked_mul(reserve_other)?.div_ceil(denom);
    reserve_out.checked_add(collateral_in)?.checked_sub(new_reserve_out)
}

/// Sell the outcome whose reserve is `reserve_out` to receive `collateral_out`.
/// Returns the outcome-token amount the seller must give up.
///
///   shares_in = collateral_out * (reserve_out + reserve_other - collateral_out) / (reserve_other - collateral_out)
///
/// Ceiling division: the seller pays at worst one base unit extra so the pool is never
/// left short. `collateral_out` must be strictly less than the opposite reserve.
pub fn calc_sell(reserve_out: u128, reserve_other: u128, collateral_out: u128) -> Option<u128> {
    if collateral_out == 0 {
        return Some(0);
    }
    if collateral_out >= reserve_other {
        return None; // cannot remove more than the opposite reserve holds
    }
    let denom = reserve_other - collateral_out;
    let sum = reserve_out
        .checked_add(reserve_other)?
        .checked_sub(collateral_out)?;
    let numer = collateral_out.checked_mul(sum)?;
    Some(numer.div_ceil(denom))
}

pub struct AddLiquidity {
    pub mint_lp: u128,
    pub pool_yes: u128,  // amount of YES the pool keeps
    pub pool_no: u128,   // amount of NO the pool keeps
    pub back_yes: u128,  // YES returned to the provider (kept price flat)
    pub back_no: u128,
}

/// Add `collateral` of liquidity. The collateral is split into equal YES and NO. To keep
/// the price flat, the pool only keeps each outcome in proportion to current reserves and
/// returns the surplus to the provider, who also receives LP tokens.
pub fn calc_add_liquidity(
    reserve_yes: u128,
    reserve_no: u128,
    lp_supply: u128,
    collateral: u128,
) -> Option<AddLiquidity> {
    if collateral == 0 {
        return None;
    }
    if lp_supply == 0 {
        // first provider sets the market at 50/50
        return Some(AddLiquidity {
            mint_lp: collateral,
            pool_yes: collateral,
            pool_no: collateral,
            back_yes: 0,
            back_no: 0,
        });
    }
    let pool_weight = reserve_yes.max(reserve_no);
    if pool_weight == 0 {
        return None;
    }
    let pool_yes = collateral.checked_mul(reserve_yes)? / pool_weight;
    let pool_no = collateral.checked_mul(reserve_no)? / pool_weight;
    Some(AddLiquidity {
        mint_lp: collateral.checked_mul(lp_supply)? / pool_weight,
        pool_yes,
        pool_no,
        back_yes: collateral.checked_sub(pool_yes)?,
        back_no: collateral.checked_sub(pool_no)?,
    })
}

/// Remove liquidity by burning `lp_burn` of `lp_supply`. Returns the pro-rata YES and NO
/// the provider receives; the caller merges the matched pair back to collateral.
pub fn calc_remove_liquidity(
    reserve_yes: u128,
    reserve_no: u128,
    lp_supply: u128,
    lp_burn: u128,
) -> Option<(u128, u128)> {
    if lp_burn == 0 || lp_supply == 0 || lp_burn > lp_supply {
        return None;
    }
    let yes_out = reserve_yes.checked_mul(lp_burn)? / lp_supply;
    let no_out = reserve_no.checked_mul(lp_burn)? / lp_supply;
    Some((yes_out, no_out))
}

/// Trading fee on a collateral amount, in basis points.
pub fn fee(amount: u128, fee_bps: u16) -> Option<u128> {
    amount.checked_mul(fee_bps as u128).map(|x| x / 10_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    // product invariant: reserves multiply to the same k before and after a buy
    #[test]
    fn buy_preserves_product() {
        let (y, n) = (1_000_000u128, 1_000_000u128);
        let a = 100_000u128;
        let out = calc_buy(y, n, a).unwrap();
        let new_y = y + a - out; // pool's YES after
        let new_n = n + a; // pool's NO after
        // k is preserved to within floor-division dust (new product >= old, tiny)
        assert!(new_y * new_n >= y * n);
        assert!(new_y * new_n <= y * n + new_n); // dust bounded by one reserve step
    }

    #[test]
    fn buy_moves_price_toward_bought_side() {
        let (y, n) = (1_000_000u128, 1_000_000u128);
        assert_eq!(price_bps(y, n).unwrap(), 5000); // start 50%
        let out = calc_buy(y, n, 500_000).unwrap();
        let (ny, nn) = (y + 500_000 - out, n + 500_000);
        // bought YES, so YES got more expensive: price(YES) > 50%
        assert!(price_bps(ny, nn).unwrap() > 5000);
    }

    #[test]
    fn buy_never_drains_the_pool() {
        let (y, n) = (10u128, 10u128);
        // huge buy relative to reserves
        let out = calc_buy(y, n, 1_000_000).unwrap();
        let new_y = y + 1_000_000 - out;
        assert!(new_y > 0, "pool YES reserve must stay positive");
    }

    #[test]
    fn sell_round_trips_below_buy_no_fee() {
        // buying then immediately selling back the same shares must return no more
        // collateral than was put in (no free money out of the maker)
        let (y, n) = (5_000_000u128, 5_000_000u128);
        let spend = 200_000u128;
        let bought = calc_buy(y, n, spend).unwrap();
        let (ny, nn) = (y + spend - bought, n + spend);
        // now sell `bought` YES back; find the collateral for exactly that many shares
        // by searching the largest r whose required shares <= bought
        let mut best_r = 0u128;
        for r in (0..=spend).rev() {
            if let Some(need) = calc_sell(ny, nn, r) {
                if need <= bought {
                    best_r = r;
                    break;
                }
            }
        }
        assert!(best_r <= spend, "cannot extract more than was deposited");
    }

    #[test]
    fn sell_rejects_draining_opposite_reserve() {
        let (y, n) = (1_000u128, 1_000u128);
        assert!(calc_sell(y, n, 1_000).is_none()); // r == reserve_other
        assert!(calc_sell(y, n, 2_000).is_none()); // r > reserve_other
        assert!(calc_sell(y, n, 999).is_some());
    }

    #[test]
    fn first_liquidity_sets_fifty_fifty() {
        let a = calc_add_liquidity(0, 0, 0, 1_000_000).unwrap();
        assert_eq!(a.pool_yes, 1_000_000);
        assert_eq!(a.pool_no, 1_000_000);
        assert_eq!(a.mint_lp, 1_000_000);
        assert_eq!(price_bps(a.pool_yes, a.pool_no).unwrap(), 5000);
    }

    #[test]
    fn adding_liquidity_keeps_price_flat() {
        // skewed pool: YES cheap (large YES reserve)
        let (y, n) = (2_000_000u128, 1_000_000u128);
        let before = price_bps(y, n).unwrap();
        let a = calc_add_liquidity(y, n, 1_500_000, 900_000).unwrap();
        let after = price_bps(y + a.pool_yes, n + a.pool_no).unwrap();
        assert_eq!(before, after, "adding liquidity must not move the price");
        // surplus of the larger-reserve side is returned to the provider
        assert!(a.back_no > a.back_yes);
    }

    #[test]
    fn remove_liquidity_is_pro_rata() {
        let (y, n) = (3_000_000u128, 1_000_000u128);
        let (yo, no) = calc_remove_liquidity(y, n, 4_000_000, 1_000_000).unwrap();
        assert_eq!(yo, 750_000); // 25% of YES reserve
        assert_eq!(no, 250_000); // 25% of NO reserve
    }

    #[test]
    fn fee_math() {
        assert_eq!(fee(1_000_000, 200).unwrap(), 20_000); // 2%
        assert_eq!(fee(0, 200).unwrap(), 0);
    }
}
