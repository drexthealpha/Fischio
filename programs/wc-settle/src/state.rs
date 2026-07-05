use anchor_lang::prelude::*;

use crate::txoracle::{BinaryExpression, TraderPredicate};

/// Game-phase codes that prove a match is over, all observed in real devnet leaves:
/// 5 = full time (USA-Bosnia), 10 = ended after extra time (Belgium-Senegal),
/// 13 = ended after penalties (Netherlands-Morocco, leaf {key:1,value:1,period:13}).
/// Goals at period 13 are ET-inclusive and EXCLUDE shootout goals, so pens-decided
/// matches settle as an ET draw per the v1 market meaning. period=0 running totals
/// and in-play phases (incl. 12 = shootout in progress) are deliberately absent.
pub const TERMINAL_PERIODS: [i32; 3] = [5, 10, 13];

/// Flat incentive for the permissionless settler, paid from the pot.
pub const SETTLER_TIP_LAMPORTS: u64 = 100_000; // 0.0001 SOL

pub const MIN_STAKE_LAMPORTS: u64 = 1_000_000; // 0.001 SOL keeps the vault rent-exempt

pub const WAGER_SEED: &[u8] = b"wager";
pub const VAULT_SEED: &[u8] = b"vault";

/// What the wager is about, in txoracle's own vocabulary so terms translate 1:1
/// into validate_stat args at settlement. Predicate TRUE ⇒ maker wins, FALSE ⇒ taker.
///
/// v1 MARKET MEANING (locked): a wager is "maker's side of the predicate holds at the
/// final whistle of 90 minutes or extra time" — penalties are EXCLUDED. Goal totals at
/// terminal phases 5/10 include ET goals but never shootout goals, so under
/// { Subtract, GreaterThan 0 } terms an ET draw evaluates FALSE and pays the taker,
/// even if the maker's team later wins the shootout. Encode markets accordingly.
/// Example "P1 beats P2 (90'+ET)": stat_a_key=1, stat_b_key=2, op=Subtract,
/// predicate = { threshold: 0, comparison: GreaterThan }.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug)]
pub struct WagerTerms {
    pub fixture_id: i64,
    pub stat_a_key: u32,
    pub stat_b_key: Option<u32>,
    pub op: Option<BinaryExpression>, // required iff stat_b_key is set
    pub predicate: TraderPredicate,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WagerState {
    Open,     // maker staked, waiting for taker
    Active,   // both staked, settleable by anyone with a terminal proof
    Settled,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct Wager {
    pub maker: Pubkey,
    pub taker: Pubkey, // Pubkey::default() until accepted
    pub stake_lamports: u64, // per side
    pub terms: WagerTerms,
    pub terms_hash: [u8; 32], // sha256(borsh(terms)) commitment for off-chain reference
    pub state: WagerState,
    pub expiry_ts: i64, // unix seconds; refund path opens after this
    pub wager_id: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
