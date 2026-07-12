use anchor_lang::prelude::*;

use crate::txoracle::{BinaryExpression, TraderPredicate};

/// Terminal game phases carried inside the proven leaf: 5 = full time, 10 = after ET,
/// 13 = after penalties. Confirmed from real TxLINE data. Mid-match (period 0) and
/// in-play phases (including 12, shootout in progress) are rejected, so a market can
/// only resolve on a finished match.
pub const TERMINAL_PERIODS: [i32; 3] = [5, 10, 13];

/// Six-decimal collateral (test-USDC on devnet), matching Polymarket's unit.
pub const COLLATERAL_DECIMALS: u8 = 6;

pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const YES_MINT_SEED: &[u8] = b"yes";
pub const NO_MINT_SEED: &[u8] = b"no";
pub const LP_MINT_SEED: &[u8] = b"lp";
pub const YES_POOL_SEED: &[u8] = b"yes_pool";
pub const NO_POOL_SEED: &[u8] = b"no_pool";

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Yes,
    No,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketState {
    Trading,  // open for liquidity and trading
    Resolved, // proof settled; winning side redeems 1 collateral per share
    Voided,   // never resolved by expiry; everyone merges shares back to collateral
}

/// The proposition a market is priced on, in txoracle's own vocabulary so the terms
/// translate 1:1 into validate_stat args at resolution. YES wins iff the predicate holds.
/// Example "home beats away in 90'+ET": stat_a_key=1, stat_b_key=Some(2), op=Subtract,
/// predicate={ threshold: 0, comparison: GreaterThan }.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug)]
pub struct MarketTerms {
    pub fixture_id: i64,
    pub stat_a_key: u32,
    pub stat_b_key: Option<u32>,
    pub op: Option<BinaryExpression>, // required iff stat_b_key is set
    pub predicate: TraderPredicate,
}

/// One binary market. Reserves are not stored here: they are the live balances of the
/// YES and NO pool token accounts, and LP supply is the lp_mint supply, so there is a
/// single on-chain source of truth for every number the maker prices on.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub creator: Pubkey,
    pub market_id: u64,
    pub terms: MarketTerms,
    pub terms_hash: [u8; 32], // sha256(borsh(terms)); off-chain reference
    pub collateral_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub close_ts: i64,  // trading and liquidity close (kickoff or later); resolve after
    pub expiry_ts: i64, // if unresolved by here, market voids and shares refund
    pub fee_bps: u16,   // trading fee routed back into the pools, earning it for LPs
    pub state: MarketState,
    pub winning_side: Option<Side>, // set at resolution
    pub bump: u8,
}
