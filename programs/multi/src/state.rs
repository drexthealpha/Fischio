use anchor_lang::prelude::*;

pub const MAX_OUTCOMES: usize = 16;
pub const TERMINAL_PERIODS: [i32; 3] = [5, 10, 13];
pub const COLLATERAL_DECIMALS: u8 = 6;

pub const MARKET_SEED: &[u8] = b"multi";
pub const VAULT_SEED: &[u8] = b"vault";
pub const YES_SEED: &[u8] = b"yes";
pub const NO_SEED: &[u8] = b"no";

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MultiState {
    Trading,
    Resolved,
    Voided,
}

/// How one outcome resolves: the combined stat (a, or a op b) compared to a threshold.
/// The same two stats feed every outcome; only the comparison differs, so a 3-way match
/// result is {a-b > 0}, {a-b == 0}, {a-b < 0}.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug)]
pub struct OutcomePredicate {
    pub threshold: i32,
    pub comparison: u8, // 0 = GreaterThan, 1 = LessThan, 2 = EqualTo
}

impl OutcomePredicate {
    pub fn holds(&self, value: i64) -> bool {
        let t = self.threshold as i64;
        match self.comparison {
            0 => value > t,
            1 => value < t,
            _ => value == t,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct MultiMarket {
    pub creator: Pubkey,
    pub market_id: u64,
    pub fixture_id: i64,
    pub num_outcomes: u8,
    pub stat_a_key: u32,
    pub stat_b_key: u32,      // 0 = single-stat (no b)
    pub op_is_subtract: bool, // when b is present: a - b if true, else a + b
    pub collateral_mint: Pubkey,
    pub close_ts: i64,
    pub expiry_ts: i64,
    pub state: MultiState,
    pub winning_outcome: u8, // valid when Resolved; 255 = unset
    #[max_len(16)]
    pub predicates: Vec<OutcomePredicate>,
    pub bump: u8,
}
